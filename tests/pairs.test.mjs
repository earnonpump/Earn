// Custom pairs end to end against the REAL pump.fun programs cloned onto the local validator (./run-tests.sh):
// launch a coin paired with a pump coin Q (fee address as creator, dev buy SOL → Q → coin) → a trader buys →
// creator fees accrue IN Q → the keeper's claim sweeps, collects and harvests → the creator's ledger holds them.
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor'
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import * as pairs from '../lib/pairs.mjs'
import { creatorKey, earnIdl, feeAddress, tokenLedgerAddress, vaultAuthority } from '../lib/earn.mjs'
import { buildTokenClaim } from '../api/pairs-keeper.mjs'

const conn = new Connection(`http://127.0.0.1:${process.env.LOCAL_RPC_PORT ?? 8997}`, 'confirmed')
const CURVE_Q = '3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump' // a real pump coin still on its curve (cloned)
const LISTED_Q = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn' // PUMP, on pump.fun's custom pair list (cloned)
const keeper = Keypair.generate(), launcher = Keypair.generate(), trader = Keypair.generate()
const key = creatorKey('x', 'pairs-e2e'), fee = feeAddress(key)
let earn, global, q, mint
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function airdrop(to, sol) { const s = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
async function send(payer, ixs, signers = [], luts = []) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts))
  tx.sign([payer, ...signers])
  const bytes = tx.serialize().length
  const sig = await conn.sendTransaction(tx, { skipPreflight: true })
  const st = await conn.confirmTransaction(sig, 'confirmed')
  if (st.value.err) {
    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    throw new Error(`${JSON.stringify(st.value.err)} ${(t?.meta?.logMessages ?? []).slice(-8).join(' | ')}`)
  }
  return { sig, bytes }
}
async function lutFor(authority, ixs, skip = []) {
  const keys = [...new Set(ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.filter((k) => !k.isSigner).map((k) => k.pubkey.toBase58())]))].filter((k) => !skip.includes(k))
  const slot = await conn.getSlot('finalized')
  const [create, addr] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: Math.max(0, slot - 1) })
  await send(authority, [create])
  for (let i = 0; i < keys.length; i += 20) await send(authority, [AddressLookupTableProgram.extendLookupTable({ lookupTable: addr, authority: authority.publicKey, payer: authority.publicKey, addresses: keys.slice(i, i + 20).map((k) => new PublicKey(k)) })])
  await sleep(1200)
  return (await conn.getAddressLookupTable(addr)).value
}

before(async () => {
  for (const k of [keeper, launcher, trader]) await airdrop(k.publicKey, 30)
  earn = new Program(earnIdl, new AnchorProvider(conn, new Wallet(keeper), {}))
  global = await pairs.loadGlobal(conn)
})

test('a pump coin on its curve and a listed token both resolve as pairs; SOL and USDC do not', async () => {
  q = await pairs.resolveQuote(conn, CURVE_Q)
  assert.equal(q.ok, true, q.reason); assert.equal(q.kind, 'curve')
  const listed = await pairs.resolveQuote(conn, LISTED_Q)
  assert.equal(listed.ok, true, listed.reason); assert.equal(listed.kind, 'listed')
  assert.equal((await pairs.resolveQuote(conn, 'So11111111111111111111111111111111111111112')).ok, false)
})

test('a paired launch names the EARN fee address as creator, with a dev buy in SOL routed through Q, in one transaction', async () => {
  const m = Keypair.generate(); mint = m.publicKey
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    await pairs.createV2Ix(conn, { mint, user: launcher.publicKey, name: 'W'.repeat(32), symbol: 'WWWWWWWWWW', uri: 'https://gateway.pinata.cloud/ipfs/bafkreif54orioftrk6fvayq6ky4xrx2oqesktvhigmc76ftmyk2n2pjrdu', creator: fee, quote: q }),
    ...(await pairs.firstBuyIxs(conn, global, { mint, user: launcher.publicKey, q, currency: 'sol', amountIn: BigInt(LAMPORTS_PER_SOL / 2), minOut: 1n }))]
  const lut = await lutFor(keeper, ixs, [mint.toBase58()])
  const { bytes } = await send(launcher, ixs, [m], [lut])
  console.log(`paired launch with dev buy: ${bytes} bytes (with a lookup table)`)
  assert.ok(bytes <= 1232)
  const st = await pairs.coinState(conn, mint, { quoteMint: q.mint, quoteDecimals: q.decimals })
  assert.equal(st.creator, fee.toBase58(), 'creator fees go to the EARN fee address')
  assert.equal(st.quoteMint, q.mint, 'paired with Q')
})

test('trading accrues creator fees in Q, and the keeper claim sweeps, collects and credits them 100% to the creator', async () => {
  for (let i = 0; i < 3; i++) await send(trader, [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ...(await pairs.firstBuyIxs(conn, global, { mint, user: trader.publicKey, q, currency: 'sol', amountIn: BigInt(LAMPORTS_PER_SOL), minOut: 1n }))])
  const claim = await buildTokenClaim(conn, earn, { payer: keeper.publicKey, feeAddress: fee.toBase58(), keyHex: Buffer.from(key).toString('hex'), coins: [{ mint: mint.toBase58() }], quote: q })
  assert.ok(claim, 'fees are waiting'); assert.ok(claim.expected > 0n)
  console.log(`waiting in Q before the claim: ${claim.expected} units`)
  await send(keeper, claim.ixs)
  const ledger = await earn.account.tokenLedger.fetch(tokenLedgerAddress(key, q.mint))
  const vault = await conn.getAccountInfo(pairs.ata(vaultAuthority(), new PublicKey(q.mint), new PublicKey(q.tokenProgram)))
  assert.equal(BigInt(ledger.credited.toString()), pairs.tokenAccountAmount(vault.data), 'the ledger holds exactly what reached the vault')
  assert.ok(BigInt(ledger.credited.toString()) >= claim.expected * 99n / 100n, `credited ${ledger.credited} of ${claim.expected} waiting`)
  const after = await buildTokenClaim(conn, earn, { payer: keeper.publicKey, feeAddress: fee.toBase58(), keyHex: Buffer.from(key).toString('hex'), coins: [{ mint: mint.toBase58() }], quote: q })
  assert.equal(after, null, 'nothing left waiting')
})

// ───────────── the server's own path: buildLaunch with a pair, confirm, keeper pass ─────────────
test('server path: a paired launch built by buildLaunch (pair lookup table, SOL dev buy through a GRADUATED pump coin) passes the site check, lands and is recorded with its pair; the keeper pass claims its fees', async () => {
  const { openDb } = await import('../api/db.mjs')
  const { addressesOf } = await import('../api/identity.mjs')
  const { upsertCreator } = await import('../api/db.mjs')
  const { buildLaunch, composeDescription, confirmLaunch, validateLaunch } = await import('../api/launch.mjs')
  const { ensurePairLut } = await import('../api/pairs-launch.mjs')
  const { keeperPass } = await import('../api/keeper.mjs')
  const { pumpProgram, loadGlobal } = await import('../lib/pump.mjs')
  const db = openDb(':memory:')
  const creator = { provider: 'github', id: '583231', handle: 'octocat', name: 'Octo' }
  upsertCreator(db, { ...creator, ...addressesOf(creator) })
  // a real …earn key, as production issues (the site refuses any other)
  const { execFileSync: ex } = await import('node:child_process'); const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'earn-key-'))
  ex(new URL('../tools/grind/target/release/earn-grind', import.meta.url).pathname, ['earn', '1', '6', dir], { stdio: 'ignore', timeout: 240_000 })
  for (const f of fs.readdirSync(dir)) { const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))); db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(kp.publicKey.toBase58(), Buffer.from(kp.secretKey).toString('base64'), 10) }
  fs.rmSync(dir, { recursive: true })
  const POOL_Q = 'Goh59QCfoX53RgJa615vzXx4swR3mv51VgvAN6ZCpump'
  const pq = await pairs.resolveQuote(conn, POOL_Q)
  assert.equal(pq.kind, 'pool', pq.reason)
  const pair = { ...pq, symbol: 'POOLQ' }
  const lut = await ensurePairLut(conn, db, keeper, pair)
  const who = Keypair.generate(); await airdrop(who.publicKey, 20)
  const form = validateLaunch({ name: 'Paired Coin', symbol: 'PAIRD', description: 'x', devBuyLamports: String(LAMPORTS_PER_SOL / 4), launcher: who.publicKey.toBase58() })
  const out = await buildLaunch({ db, conn, program: pumpProgram(conn), global: await loadGlobal(conn), creator, form: { ...form, description: composeDescription(form.description, creator) }, metadataUri: 'https://gateway.pinata.cloud/ipfs/bafkreif54orioftrk6fvayq6ky4xrx2oqesktvhigmc76ftmyk2n2pjrdu', lookupTables: [lut], pair })
  console.log(`server-built paired launch (graduated pair, SOL dev buy): ${out.bytes} bytes`)
  assert.ok(out.bytes <= 1232)
  // the site's own signing check, on the exact bytes the server returns
  const { execFileSync } = await import('node:child_process')
  const bundle = new URL('../web/.txcheck-bundle.mjs', import.meta.url).pathname
  execFileSync('npx', ['esbuild', 'src/lib/txcheck.ts', '--bundle', '--format=esm', '--platform=neutral', `--outfile=${bundle}`, '--log-level=error'], { cwd: new URL('../web/', import.meta.url).pathname })
  const { checkLaunchTransaction } = await import(bundle)
  ;(await import('node:fs')).unlinkSync(bundle)
  checkLaunchTransaction(Buffer.from(out.transaction, 'base64'), { wallet: who.publicKey.toBase58(), mint: out.mint, tickerFee: false })
  const tx = VersionedTransaction.deserialize(Buffer.from(out.transaction, 'base64')); tx.sign([who])
  const sig = await conn.sendTransaction(tx, { skipPreflight: true }); const st = await conn.confirmTransaction(sig, 'confirmed')
  assert.equal(st.value.err, null, JSON.stringify(st.value.err))
  await confirmLaunch({ db, conn, mint: out.mint, signature: sig })
  const row = db.prepare('SELECT quote_mint, quote_kind, quote_symbol FROM tokens WHERE mint = ?').get(out.mint)
  assert.equal(row.quote_mint, POOL_Q); assert.equal(row.quote_kind, 'pool')
  // a trader buys (fees in Q), then one keeper pass claims them through the program
  const trader2 = Keypair.generate(); await airdrop(trader2.publicKey, 10)
  await send(trader2, [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ...(await pairs.firstBuyIxs(conn, global, { mint: new PublicKey(out.mint), user: trader2.publicKey, q: pq, currency: 'sol', amountIn: BigInt(LAMPORTS_PER_SOL), minOut: 1n }))])
  process.env.PAIRS_ENABLED = '1'; process.env.MIN_TOKEN_CLAIM_USD = '0'
  const results = await keeperPass({ conn, db, pump: pumpProgram(conn), payer: keeper, treasury: Keypair.generate().publicKey, solUsd: 150, log: { info: () => {}, error: (m) => console.error(m) } })
  const tokenRes = results.find((r) => r.tokens)
  assert.ok(tokenRes?.signature, `keeper claimed: ${JSON.stringify(results)}`)
  const claimed = db.prepare('SELECT amount FROM token_claims WHERE quote_mint = ?').all(POOL_Q)
  assert.ok(claimed.length && BigInt(claimed[0].amount) > 0n, 'recorded the TokenClaimed event')
})
