/**
 * The keeper: for every creator with a token, move accrued pump.fun fees to the fee address and
 * harvest them — one transaction per creator per pass, so each claim is keyed on its signature.
 *
 *   [transfer_creator_fees_to_pump]   only if a graduated coin left WSOL in PumpSwap's creator vault
 *   collect_creator_fee               pump.fun creator vault → fee address (nobody signs for it)
 *   harvest                           fee address → 80% creator account, 20% treasury
 *
 * All three are permissionless. The keeper only pays the transaction fee, so a stolen keeper key
 * can waste its own SOL and nothing else.
 */
import { BorshCoder, EventParser, Program, AnchorProvider } from '@coral-xyz/anchor'
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { WSOL, ammCreatorVaultAuthority, ata, bondingCurveAddress, collectCreatorFeeIx, creatorVaultAddress, curveCreator, curveCreatorFeeWaiting, decodePool, poolCreatorFeesWaiting, pumpAmmIdl, sweepCurveCreatorFeeIx, sweepPoolCreatorFeeIx } from '../lib/pump.mjs'
import { EARN, accountAddress, configAddress, earnIdl, splitAddress } from '../lib/earn.mjs'
import { now } from './db.mjs'

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const readOnlyWallet = (pk) => ({ publicKey: pk, signTransaction: async (t) => t, signAllTransactions: async (t) => t })

export function programs(conn, payer) {
  const provider = new AnchorProvider(conn, readOnlyWallet(payer), {})
  return { earn: new Program(earnIdl, provider), amm: new Program(pumpAmmIdl, provider) }
}

/** What is waiting for one creator, in lamports, from a single batched read. */
let rentFloor = null
export async function pendingFor(conn, feeAddress) {
  const fee = new PublicKey(feeAddress)
  const vault = creatorVaultAddress(fee)
  const ammVault = ata(ammCreatorVaultAuthority(fee), WSOL, TOKEN)
  const [feeInfo, vaultInfo, ammInfo] = await conn.getMultipleAccountsInfo([fee, vault, ammVault])
  const rent0 = rentFloor ??= await conn.getMinimumBalanceForRentExemption(0)
  const ammLamports = ammInfo ? Number(ammInfo.data.readBigUInt64LE(64)) : 0
  return {
    atFeeAddress: Math.max(0, (feeInfo?.lamports ?? 0) - rent0),
    inCurveVault: Math.max(0, (vaultInfo?.lamports ?? 0) - rent0),
    inAmmVault: ammLamports,
  }
}

/** Sweeps per claim transaction: each adds ~3 unique accounts; the largest waiting fees go first, the rest next pass. */
export const MAX_SWEEPS = 4

/**
 * What waits ON each coin of a fee address (new-style trades leave the creator fee on the curve / pool until swept),
 * read in one batch. Only coins whose curve (or pool) names `feeAddress` as creator count.
 */
export async function coinsWaiting(conn, db, feeAddress, { splitKeyHex = null, creatorKeyHex = null } = {}) {
  const fee = new PublicKey(feeAddress)
  const rows = splitKeyHex
    // SOL-paired coins only: a custom pair's fees are in Q and claimed by api/pairs-keeper.mjs
    ? db.prepare('SELECT mint, graduated, pool FROM tokens WHERE split_key = ? AND quote_mint IS NULL').all(splitKeyHex)
    : db.prepare('SELECT mint, graduated, pool FROM tokens WHERE creator_key = ? AND split_key IS NULL AND platform = 0 AND quote_mint IS NULL').all(creatorKeyHex)
  if (!rows.length) return []
  const keys = rows.flatMap((r) => [bondingCurveAddress(new PublicKey(r.mint)), r.pool ? new PublicKey(r.pool) : PublicKey.default])
  const infos = []
  for (let i = 0; i < keys.length; i += 100) infos.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100)))
  return rows.map((r, i) => {
    const curve = infos[2 * i], pool = r.pool ? infos[2 * i + 1] : null
    const curveFee = curve && curveCreator(curve.data)?.equals(fee) ? Number(curveCreatorFeeWaiting(curve.data)) : 0
    let poolFee = 0
    if (pool) { try { if (decodePool(pool.data).coin_creator.equals(fee)) poolFee = Number(poolCreatorFeesWaiting(pool.data)) } catch {} }
    return { mint: r.mint, curveFee, poolFee, pool: r.pool ? new PublicKey(r.pool) : null, poolData: pool?.data ?? null }
  })
}

/** Sweep instructions (pool sweeps first) for the coins with the most waiting, and how much they move. */
async function sweepIxs(conn, coins, { payer, fee }) {
  const pick = coins.filter((c) => c.curveFee + c.poolFee > 0).sort((a, b) => (b.curveFee + b.poolFee) - (a.curveFee + a.poolFee)).slice(0, MAX_SWEEPS)
  const pool = [], curve = []
  for (const c of pick) {
    if (c.poolFee > 0) pool.push(await sweepPoolCreatorFeeIx(conn, { pool: c.pool, poolData: c.poolData, payer, creator: fee }))
    if (c.curveFee > 0) curve.push(await sweepCurveCreatorFeeIx(conn, { mint: new PublicKey(c.mint), payer, creator: fee }))
  }
  return { pool, curve, swept: pick, sweptLamports: pick.reduce((s, c) => s + c.curveFee + c.poolFee, 0) }
}

/**
 * Splits a claim of `total` lamports over the coins it came from: each swept coin gets its swept amount exactly; the
 * rest (fees already in the vault / at the fee address, paid by old-style trades) in proportion to what each coin had
 * waiting, or equally when nothing was waiting.
 */
export function attribute(coins, swept, total) {
  if (!coins.length) return []
  const exact = new Map(swept.map((c) => [c.mint, c.curveFee + c.poolFee]))
  const sweptSum = [...exact.values()].reduce((a, b) => a + b, 0)
  const rest = Math.max(0, total - sweptSum)
  const weights = coins.map((c) => c.curveFee + c.poolFee), wsum = weights.reduce((a, b) => a + b, 0)
  const out = coins.map((c, i) => ({ mint: c.mint, lamports: (exact.get(c.mint) ?? 0) + Math.floor(rest * (wsum ? weights[i] / wsum : 1 / coins.length)) }))
  // rounding dust goes to the largest share so the rows add up to the claim
  const diff = total - out.reduce((s, r) => s + r.lamports, 0)
  if (diff) out.sort((a, b) => b.lamports - a.lamports)[0].lamports += diff
  return out.filter((r) => r.lamports > 0)
}

/**
 * The claim transaction for one split, or null when it is not worth its fee. Creates the on-chain
 * split record and any missing recipient accounts on the way (rent paid by the keeper, once each).
 */
export async function buildSplitClaim({ conn, db, pump, earn, amm, payer, split, minLamports }) {
  const fee = new PublicKey(split.fee_address)
  const p = await pendingFor(conn, split.fee_address)
  const coins = await coinsWaiting(conn, db, split.fee_address, { splitKeyHex: split.split_key_hex })
  const sw = await sweepIxs(conn, coins, { payer, fee })
  const total = p.atFeeAddress + p.inCurveVault + p.inAmmVault + sw.sweptLamports
  if (total < minLamports) return null
  const recipients = JSON.parse(split.recipients_json)
  const splitKey = Buffer.from(split.split_key_hex, 'hex')
  const keys = recipients.map((r) => Buffer.from(r.keyHex, 'hex'))
  const infos = await conn.getMultipleAccountsInfo([splitAddress(splitKey), ...keys.map((k) => accountAddress(k))])

  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })]
  if (!infos[0]) ixs.push(await earn.methods.createSplit([...splitKey], recipients.map((r) => ({ key: [...Buffer.from(r.keyHex, 'hex')], bps: r.bps })))
    .accountsPartial({ split: splitAddress(splitKey), payer }).instruction())
  for (let i = 0; i < keys.length; i++) if (!infos[i + 1]) ixs.push(await earn.methods.initAccount([...keys[i]]).accountsPartial({ account: accountAddress(keys[i]), payer }).instruction())
  ixs.push(...sw.pool)
  if (p.inAmmVault > 0 || sw.pool.length) ixs.push(await amm.methods.transferCreatorFeesToPump().accountsPartial({ wsolMint: WSOL, tokenProgram: TOKEN, coinCreator: fee, pumpCreatorVault: creatorVaultAddress(fee) }).instruction())
  ixs.push(...sw.curve)
  if (p.inCurveVault > 0 || p.inAmmVault > 0 || sw.sweptLamports > 0) ixs.push(await collectCreatorFeeIx(pump, fee))
  ixs.push(await earn.methods.harvestSplit([...splitKey]).accountsPartial({ feeAddress: fee, split: splitAddress(splitKey) })
    .remainingAccounts(keys.map((k) => ({ pubkey: accountAddress(k), isSigner: false, isWritable: true }))).instruction())
  return { ixs, expected: total, attribution: attribute(coins, sw.swept, total) }
}

/** The claim transaction for one creator, or null when it is not worth its fee. */
export async function buildClaim({ conn, db, pump, earn, amm, payer, treasury, creator, minLamports }) {
  const fee = new PublicKey(creator.fee_address)
  const p = await pendingFor(conn, creator.fee_address)
  const coins = db ? await coinsWaiting(conn, db, creator.fee_address, { creatorKeyHex: creator.key_hex }) : []
  const sw = await sweepIxs(conn, coins, { payer, fee })
  const total = p.atFeeAddress + p.inCurveVault + p.inAmmVault + sw.sweptLamports
  if (total < minLamports) return null

  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })]
  ixs.push(...sw.pool)
  if (p.inAmmVault > 0 || sw.pool.length) {
    ixs.push(await amm.methods.transferCreatorFeesToPump().accountsPartial({ wsolMint: WSOL, tokenProgram: TOKEN, coinCreator: fee, pumpCreatorVault: creatorVaultAddress(fee) }).instruction())
  }
  ixs.push(...sw.curve)
  if (p.inCurveVault > 0 || p.inAmmVault > 0 || sw.sweptLamports > 0) ixs.push(await collectCreatorFeeIx(pump, fee))
  ixs.push(await earn.methods.harvest([...Buffer.from(creator.key_hex, 'hex')]).accountsPartial({ config: configAddress(), treasury, payer }).instruction())
  return { ixs, expected: total, attribution: attribute(coins, sw.swept, total) }
}

/** Stores which coins a landed claim came from, scaled to the gross the chain actually recorded for it. */
export function recordAttribution(db, signature, attribution) {
  if (!attribution?.length) return
  const gross = db.prepare('SELECT COALESCE(SUM(gross), 0) AS g FROM claims WHERE signature = ? AND key_hex = source_key_hex').get(signature).g
    || db.prepare('SELECT COALESCE(MAX(gross), 0) AS g FROM claims WHERE signature = ?').get(signature).g
  const planned = attribution.reduce((s, a) => s + a.lamports, 0)
  const ins = db.prepare('INSERT OR REPLACE INTO claim_tokens (signature, mint, lamports) VALUES (?, ?, ?)')
  for (const a of attribution) ins.run(signature, a.mint, gross && planned ? Math.round(a.lamports * gross / planned) : a.lamports)
}

const parser = new EventParser(EARN, new BorshCoder(earnIdl))
export function eventsFromLogs(logs) {
  return [...parser.parseLogs(logs ?? [])].map((e) => ({ name: e.name, data: e.data }))
}

/** Records the Claimed/Paid events of a landed transaction. Keyed on the signature: idempotent. */
export function recordEvents(db, { signature, slot, time, logs, solUsd, usdcOut = null }) {
  // A SplitClaimed event precedes the per-recipient Claimed events of a split harvest; the recipient
  // rows are attributed to that split key. A plain harvest's Claimed is attributed to its own key.
  let source = null
  for (const e of eventsFromLogs(logs)) {
    if (e.name === 'SplitClaimed' || e.name === 'splitClaimed') { source = Buffer.from(e.data.split_key).toString('hex'); continue }
    // Custom pairs: the same, in token Q (TokenSplitClaimed precedes the per-recipient TokenClaimed).
    if (e.name === 'TokenSplitClaimed' || e.name === 'tokenSplitClaimed') { source = Buffer.from(e.data.split_key).toString('hex'); continue }
    if (e.name === 'TokenClaimed' || e.name === 'tokenClaimed') {
      const key = Buffer.from(e.data.key).toString('hex')
      db.prepare('INSERT OR IGNORE INTO token_claims (signature, key_hex, source_key_hex, quote_mint, amount, time) VALUES (?, ?, ?, ?, ?, ?)')
        .run(signature, key, source ?? key, e.data.mint.toBase58(), e.data.gross.toString(), time)
      continue
    }
    if (e.name === 'TokenPaid' || e.name === 'tokenPaid') continue // recorded by the withdrawal endpoint (token_payouts)
    // Only Claimed and Paid carry a key; ConfigChanged (seen by reconciliation) does not.
    if (!e.data?.key) continue
    const key = Buffer.from(e.data.key).toString('hex')
    if (e.name === 'Claimed' || e.name === 'claimed') {
      db.prepare('INSERT OR IGNORE INTO claims (signature, key_hex, source_key_hex, slot, time, gross, to_recipient, to_treasury, sol_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(signature, key, source ?? key, slot, time, Number(e.data.gross), Number(e.data.to_recipient), Number(e.data.to_treasury), solUsd)
    } else if (e.name === 'Paid' || e.name === 'paid') {
      db.prepare('INSERT OR IGNORE INTO payouts (signature, key_hex, slot, time, lamports, mode, destination, usdc_out, sol_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(signature, key, slot, time, Number(e.data.lamports), Object.keys(e.data.mode)[0].toLowerCase(), e.data.destination.toBase58(), usdcOut, solUsd)
    }
  }
}

export async function sendAndRecord({ conn, db, payer, ixs, lookupTables = [], solUsd, extraSigners = [] }) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lookupTables))
  tx.sign([payer, ...extraSigners])
  const signature = await conn.sendTransaction(tx, { maxRetries: 3 })
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  if (res.value.err) throw Object.assign(new Error(`transaction failed: ${JSON.stringify(res.value.err)}`), { signature })
  // A just-confirmed transaction can read back null for a moment; without its logs the claim
  // would never be recorded (the chain keeps the money right, but the ledger would miss it).
  let t = null
  for (let i = 0; i < 20 && !t; i++) {
    t = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    if (!t) await new Promise((r) => setTimeout(r, 500))
  }
  if (!t) throw Object.assign(new Error('landed but could not be read back to record'), { signature, landed: true })
  recordEvents(db, { signature, slot: t.slot, time: t.blockTime ?? now(), logs: t.meta?.logMessages, solUsd })
  return signature
}

/**
 * One keeper pass. Creators on the do-not-pay list are skipped (what is already credited stays
 * theirs). A failure on one creator never stops the others.
 */
export async function keeperPass({ conn, db, pump, payer, treasury, solUsd, minLamports = 5_000_000, log = console }) {
  const { earn, amm } = programs(conn, payer.publicKey)
  const creators = db.prepare(`
    SELECT DISTINCT c.* FROM creators c JOIN tokens t ON t.creator_key = c.key_hex AND t.split_key IS NULL
    WHERE c.key_hex NOT IN (SELECT key_hex FROM optout)
  `).all()
  const results = []
  // Splits: skipped entirely while any recipient is on the do-not-pay list.
  const splits = db.prepare(`
    SELECT s.* FROM splits s WHERE EXISTS (SELECT 1 FROM tokens t WHERE t.split_key = s.split_key_hex)
      AND NOT EXISTS (SELECT 1 FROM token_recipients r JOIN optout o ON o.key_hex = r.key_hex JOIN tokens t ON t.mint = r.mint WHERE t.split_key = s.split_key_hex)
  `).all()
  for (const split of splits) {
    try {
      const claim = await buildSplitClaim({ conn, db, pump, earn, amm, payer: payer.publicKey, split, minLamports })
      if (!claim) continue
      const signature = await sendAndRecord({ conn, db, payer, ixs: claim.ixs, solUsd })
      recordAttribution(db, signature, claim.attribution)
      results.push({ split: split.split_key_hex.slice(0, 12), signature, lamports: claim.expected })
      log.info?.(`claimed ${claim.expected} lamports for split ${split.split_key_hex.slice(0, 12)} ${signature}`)
    } catch (e) {
      results.push({ split: split.split_key_hex.slice(0, 12), error: e.message })
      log.error?.(`split claim failed ${split.split_key_hex.slice(0, 12)}: ${e.message}`)
    }
  }
  for (const creator of creators) {
    try {
      const claim = await buildClaim({ conn, db, pump, earn, amm, payer: payer.publicKey, treasury, creator, minLamports })
      if (!claim) continue
      const signature = await sendAndRecord({ conn, db, payer, ixs: claim.ixs, solUsd })
      recordAttribution(db, signature, claim.attribution)
      results.push({ creator: `${creator.provider}:${creator.handle}`, signature, lamports: claim.expected })
      log.info?.(`claimed ${claim.expected} lamports for ${creator.provider}:${creator.handle} ${signature}`)
    } catch (e) {
      results.push({ creator: `${creator.provider}:${creator.handle}`, error: e.message })
      log.error?.(`claim failed for ${creator.provider}:${creator.handle}: ${e.message}`)
    }
  }
  // Custom pairs: fees in token Q, one claim per (fee address, Q). Only once the program can harvest tokens (PAIRS_ENABLED).
  if (process.env.PAIRS_ENABLED === '1') {
    const { buildTokenClaim } = await import('./pairs-keeper.mjs')
    const { quotePriceUsd } = await import('./pairs-launch.mjs')
    const groups = db.prepare(`
      SELECT t.quote_mint, t.quote_program, t.quote_decimals, t.quote_kind, t.split_key, t.creator_key,
             COALESCE(s.fee_address, c.fee_address) AS fee, s.recipients_json, group_concat(t.mint) AS mints
      FROM tokens t LEFT JOIN splits s ON s.split_key_hex = t.split_key LEFT JOIN creators c ON c.key_hex = t.creator_key
      WHERE t.quote_mint IS NOT NULL AND t.platform = 0 GROUP BY fee, t.quote_mint`).all()
    for (const g of groups) {
      if (!g.fee) continue
      const label = `${g.split_key ? 'split ' + g.split_key.slice(0, 12) : g.creator_key.slice(0, 12)} in ${g.quote_mint.slice(0, 6)}`
      try {
        if (db.prepare('SELECT 1 FROM optout WHERE key_hex = ?').get(g.creator_key)) continue
        const quote = { mint: g.quote_mint, tokenProgram: g.quote_program, decimals: g.quote_decimals, kind: g.quote_kind }
        const split = g.split_key ? { splitKeyHex: g.split_key, recipientKeysHex: JSON.parse(g.recipients_json).map((r) => r.keyHex) } : null
        const claim = await buildTokenClaim(conn, earn, { payer: payer.publicKey, feeAddress: g.fee, keyHex: g.creator_key, split, coins: g.mints.split(',').map((mint) => ({ mint })), quote })
        if (!claim) continue
        // not worth a transaction below ~$1 of Q (the keeper pays the fee and any new account's rent)
        const usd = Number(claim.expected) / 10 ** (g.quote_decimals ?? 6) * await quotePriceUsd(g.quote_mint)
        if (usd < Number(process.env.MIN_TOKEN_CLAIM_USD ?? 1)) continue
        const signature = await sendAndRecord({ conn, db, payer, ixs: claim.ixs, solUsd })
        results.push({ tokens: label, signature, units: claim.expected.toString() })
        log.info?.(`claimed ${claim.expected} units of ${g.quote_mint.slice(0, 6)} for ${label} ${signature}`)
      } catch (e) {
        results.push({ tokens: label, error: e.message })
        log.error?.(`token claim failed ${label}: ${e.message}`)
      }
    }
  }
  return results
}
