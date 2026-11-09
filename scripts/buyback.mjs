/**
 * $EARN buyback + burn, run BY THE OPERATOR (deploy/buyback.sh <SOL>): buys $EARN on its pump.fun curve with <SOL> from
 * the buyback wallet (keys/mainnet/buyback.key), then burns EXACTLY the tokens that buy received, then records both with
 * the site (it re-checks them on chain) so /analytics shows them.
 *
 *   node scripts/buyback.mjs <SOL> [--slippage 15]          simulate on mainnet only: nothing is sent
 *   node scripts/buyback.mjs <SOL> --send                   buy + burn + record (deploy/buyback.sh requires CONFIRM=BUY)
 *   node scripts/buyback.mjs --burn-only <buySig> --send    burn what an earlier buy received (if its burn step failed)
 *
 * ⛔ Burns the buy's OWN received amount (read from that transaction's token balances), never the wallet's whole balance.
 * ⛔ A transaction counts as failed/expired only on a POSITIVE chain answer (memory: tx-expiry-needs-positive-answer).
 */
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createCloseAccountInstruction, createSyncNativeInstruction } from '@solana/spl-token'
import { AnchorProvider, BN, BorshCoder, Program } from '@coral-xyz/anchor'
import bs58 from 'bs58'
import { readFileSync } from 'node:fs'
import { TOKEN_2022, WSOL, ata, bondingCurveAddress, buyExactSolInIx, decodeBondingCurve, decodePool, loadGlobal, pumpAmmIdl, pumpProgram } from '../lib/pump.mjs'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const SEND = flag('--send')
const MINT = new PublicKey(process.env.EARN_MINT || 'ARGGnM1zK12eYCzRYbULJECFsMh4DM7hKgxNk97Pearn')
const DECIMALS = 6
const SLIPPAGE = Number(opt('--slippage', '15'))
const SITE = process.env.SITE || 'https://earnrewards.fun'
const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed')
const die = (m) => { console.error(`✗ ${m}`); process.exit(1) }
const fmt = (raw) => (Number(raw) / 10 ** DECIMALS).toLocaleString('en-US', { maximumFractionDigits: 2 })

function loadWallet(path = process.env.BUYBACK_KEY || 'keys/mainnet/buyback.key') {
  let text
  try { text = readFileSync(path, 'utf8') } catch { die(`no key file at ${path}`) }
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  if (!line) die(`${path} has no key yet: paste the private key into it and save`)
  try {
    if (line.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(line)))
    return Keypair.fromSecretKey(bs58.decode(line))
  } catch { die(`${path}: not a private key (expected base58 or a [..] array of 64 numbers)`) }
}

/** Sends and waits for a POSITIVE answer: confirmed, failed, or the blockhash provably expired with no record. */
async function sendAndConfirm(ixs, signer, label) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
  tx.sign([signer])
  const sig = bs58.encode(tx.signatures[0])
  console.log(`  ${label}: sending ${sig}`)
  const raw = tx.serialize()
  for (;;) {
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    let st = null, height = null
    try { st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0]; height = await conn.getBlockHeight('confirmed') } catch { continue } // RPC trouble: ask again, never assume
    if (st?.err) die(`${label} FAILED on chain: ${JSON.stringify(st.err)} (${sig})`)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig
    if (height != null && height > lastValidBlockHeight + 5 && !st) {
      // one last look with history before calling it expired
      const again = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => ({ value: [undefined] }))).value[0]
      if (again === null) return null // positively absent after expiry: not landed
    }
  }
}

/** Exact raw $EARN the owner gained in a landed transaction (its own token balances, version-1 safe). */
async function receivedIn(sig, owner) {
  for (let i = 0; i < 20; i++) {
    const r = (await conn._rpcRequest('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null))?.result
    if (r) {
      if (r.meta?.err) die(`buy ${sig} failed on chain`)
      const sum = (list) => (list ?? []).filter((b) => b.owner === owner.toBase58() && b.mint === MINT.toBase58()).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n)
      return sum(r.meta.postTokenBalances) - sum(r.meta.preTokenBalances)
    }
    await new Promise((res) => setTimeout(res, 1000))
  }
  die(`could not read ${sig} yet: rerun with --burn-only ${sig} --send`)
}

async function burn(wallet, amount, buySig) {
  if (amount <= 0n) die(`nothing to burn (the buy received ${amount})`)
  const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    createBurnCheckedInstruction(ata(wallet.publicKey, MINT, TOKEN_2022), MINT, wallet.publicKey, amount, DECIMALS, [], TOKEN_2022)]
  const sig = await sendAndConfirm(ixs, wallet, `burn ${fmt(amount)} $EARN`)
  if (!sig) die(`burn expired without landing: rerun  CONFIRM=BUY deploy/buyback.sh --burn-only ${buySig}`)
  return sig
}

async function record(body) {
  const token = (() => { try { return readFileSync('keys/mainnet/admin.token', 'utf8').trim() } catch { return '' } })()
  if (!token) return console.log('  (no admin token here: not recorded on the site)')
  const r = await fetch(`${SITE}/api/admin/buyback`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).catch((e) => ({ ok: false, statusText: e.message }))
  const out = r.json ? await r.json().catch(() => ({})) : {}
  console.log(r.ok ? `  recorded on ${SITE}/analytics` : `  ⚠ not recorded (${r.status ?? ''} ${out.error ?? r.statusText}); the buy and burn are on chain regardless`)
}

// SIM_AS=<address>: simulate as any funded wallet without its key (tests the path; it can never send).
const SIM_AS = process.env.SIM_AS ? new PublicKey(process.env.SIM_AS) : null
if (SIM_AS && SEND) die('SIM_AS only simulates; it cannot send')
const wallet = SIM_AS ? { publicKey: SIM_AS } : loadWallet()
console.log(`Buyback wallet ${wallet.publicKey.toBase58()}  balance ${(await conn.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL} SOL`)
console.log(`$EARN          ${MINT.toBase58()}`)

if (flag('--burn-only')) {
  const buySig = opt('--burn-only')
  const amount = await receivedIn(buySig, wallet.publicKey)
  console.log(`That buy received ${fmt(amount)} $EARN`)
  if (!SEND) { console.log('(dry: add --send to burn it)'); process.exit(0) }
  const burnSig = await burn(wallet, amount, buySig)
  console.log(`✓ burned ${fmt(amount)} $EARN  ${burnSig}`)
  await record({ buySig, burnSig, tokens: amount.toString() })
  process.exit(0)
}

const sol = Number(args[0])
if (!(sol > 0)) die('usage: buyback.mjs <SOL amount, e.g. 0.5> [--slippage 15] [--send]  (there is no "all": always an amount)')
// A typo guard: one run spends at most MAX_SOL (default 3, set by the operator 9 Nov). A bigger buyback is a deliberate MAX_SOL=<n> on the command line.
const MAX_SOL = Number(process.env.MAX_SOL || 3)
if (sol > MAX_SOL) die(`${sol} SOL is over the per-run cap of ${MAX_SOL} SOL. If you mean it, run again with MAX_SOL=${Math.ceil(sol)} in front.`)
const lamports = BigInt(Math.round(sol * LAMPORTS_PER_SOL))
const bal = BigInt(await conn.getBalance(wallet.publicKey))
if (bal < lamports + 10_000_000n) die(`the wallet holds ${Number(bal) / 1e9} SOL; ${sol} SOL plus ~0.01 for fees and the token account is needed`)

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const userAta = ata(wallet.publicKey, MINT, TOKEN_2022)
const budget = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })]

/** Simulates `ixs` signed by the wallet; returns the $EARN the wallet would gain (fails loudly if the tx would fail). */
async function simulateGain(ixs) {
  const { blockhash } = await conn.getLatestBlockhash()
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
  if (!SIM_AS) tx.sign([wallet])
  const before = await conn.getTokenAccountBalance(userAta).then((b) => BigInt(b.value.amount)).catch(() => 0n)
  const sim = await conn.simulateTransaction(tx, { sigVerify: !SIM_AS, replaceRecentBlockhash: !!SIM_AS, accounts: { encoding: 'base64', addresses: [userAta.toBase58()] } })
  if (sim.value.err) die(`the buy would FAIL: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-8).join('\n')}`)
  const after = sim.value.accounts?.[0] ? Buffer.from(sim.value.accounts[0].data[0], 'base64').readBigUInt64LE(64) : 0n
  return after - before
}

const curveInfo = await conn.getAccountInfo(bondingCurveAddress(MINT))
if (!curveInfo) die('no pump.fun curve for $EARN')
const curve = decodeBondingCurve(curveInfo.data)
let buildBuy // (minOut) → instructions
if (!curve.complete) {
  // still on the bonding curve: buy_exact_sol_in
  const pump = pumpProgram(conn), global = await loadGlobal(conn)
  buildBuy = async (minOut) => [...budget,
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userAta, wallet.publicKey, MINT, TOKEN_2022),
    await buyExactSolInIx(pump, global, { mint: MINT, user: wallet.publicKey, creator: curve.creator, lamports, minTokensOut: minOut })]
  console.log('Market: pump.fun bonding curve')
} else {
  // graduated: PumpSwap buy_exact_quote_in, paying with wrapped SOL (wrapped and unwrapped in the same transaction)
  const poolAddr = new PublicKey(process.env.EARN_POOL || (await fetch(`${SITE}/api/platform`).then((r) => r.json()).then((p) => p?.token?.pool).catch(() => null)) || '3AMfwEYwjzHMziMATPhbuV9vaQpAbbYDMJC1FCz2kmRJ')
  const poolInfo = await conn.getAccountInfo(poolAddr)
  if (!poolInfo) die(`PumpSwap pool ${poolAddr.toBase58()} not found`)
  const pool = decodePool(poolInfo.data)
  if (!pool.base_mint.equals(MINT) || !pool.quote_mint.equals(WSOL)) die(`pool ${poolAddr.toBase58()} is not the $EARN/SOL pool`)
  const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
  const gc = new BorshCoder(pumpAmmIdl).accounts.decode('GlobalConfig', (await conn.getAccountInfo(GLOBAL_CONFIG)).data)
  const protocolFeeRecipient = gc.protocol_fee_recipients.find((k) => !k.equals(PublicKey.default))
  const amm = new Program(pumpAmmIdl, new AnchorProvider(conn, { publicKey: wallet.publicKey, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, {}))
  const userWsol = ata(wallet.publicKey, WSOL, TOKEN)
  const buybackRecipient = (await loadGlobal(conn)).buyback_fee_recipients.find((k) => !k.equals(PublicKey.default))
  buildBuy = async (minOut) => [...budget,
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userAta, wallet.publicKey, MINT, TOKEN_2022),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userWsol, wallet.publicKey, WSOL, TOKEN),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userWsol, lamports }),
    createSyncNativeInstruction(userWsol, TOKEN),
    await amm.methods.buyExactQuoteIn(new BN(lamports.toString()), new BN(minOut.toString()), { 0: true })
      .accountsPartial({ pool: poolAddr, user: wallet.publicKey, globalConfig: GLOBAL_CONFIG, baseMint: MINT, quoteMint: WSOL,
        userBaseTokenAccount: userAta, userQuoteTokenAccount: userWsol, poolBaseTokenAccount: pool.pool_base_token_account, poolQuoteTokenAccount: pool.pool_quote_token_account,
        protocolFeeRecipient, baseTokenProgram: TOKEN_2022, quoteTokenProgram: TOKEN })
      // Newer PumpSwap requires remaining accounts the vendored IDL lacks (read off real $EARN buys, 9 Nov 2026):
      // pool_v2 = PDA ["pool-v2", base mint] (read-only, may not exist yet), ONE buyback fee recipient from pump.fun's
      // Global list, and that recipient's WSOL account (writable).
      .remainingAccounts([
        { pubkey: PublicKey.findProgramAddressSync([Buffer.from('pool-v2'), MINT.toBuffer()], new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'))[0], isSigner: false, isWritable: false },
        { pubkey: buybackRecipient, isSigner: false, isWritable: false },
        { pubkey: ata(buybackRecipient, WSOL, TOKEN), isSigner: false, isWritable: true },
      ])
      .instruction(),
    createCloseAccountInstruction(userWsol, wallet.publicKey, wallet.publicKey, [], TOKEN)] // leftover SOL back to the wallet
  console.log(`Market: PumpSwap pool ${poolAddr.toBase58()} ($EARN has graduated)`)
}

// The exact amount, from a mainnet simulation (no guessing at reserves), then the floor from the slippage.
const quoted = await simulateGain(await buildBuy(1n))
if (quoted <= 0n) die('the simulated buy received no $EARN')
const minOut = quoted * BigInt(Math.round((100 - SLIPPAGE) * 100)) / 10000n
console.log(`Quote: ${sol} SOL → ${fmt(quoted)} $EARN now (at least ${fmt(minOut)} at ${SLIPPAGE}% slippage), then burn exactly what arrives`)
const buyIxs = await buildBuy(minOut)

if (!SEND) {
  const check = await simulateGain(buyIxs)
  console.log(`DRY RUN (simulated on mainnet, nothing sent): the buy would receive ${fmt(check)} $EARN, and the burn would destroy exactly that.`)
  console.log(`To do it:  CONFIRM=BUY ~/earn/deploy/buyback.sh ${sol}`)
  process.exit(0)
}

const buySig = await sendAndConfirm(buyIxs, wallet, `buy with ${sol} SOL`)
if (!buySig) die('the buy expired without landing: nothing was bought, nothing to burn. Run it again.')
const received = await receivedIn(buySig, wallet.publicKey)
console.log(`  bought ${fmt(received)} $EARN`)
const burnSig = await burn(wallet, received, buySig)
console.log(`✓ bought back and burned ${fmt(received)} $EARN for ${sol} SOL\n  buy  ${buySig}\n  burn ${burnSig}`)
await record({ buySig, burnSig, lamports: lamports.toString(), tokens: received.toString() })
