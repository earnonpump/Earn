/**
 * Live creator fees: what is EARNED but not claimed yet, read from chain, so the site never shows $0.00 for a coin
 * that is trading. Two kinds:
 *
 *   EARN coins   per coin: the fee waiting ON its curve / pool (new-style trades, exact per coin) plus a share of what
 *                already sits in its fee address's creator vault (old-style trades pool all of a creator's coins there;
 *                shared in proportion to what each coin has waiting, or equally).
 *   $EARN        the platform token's creator is the operator's wallet, so its fees never pass through EARN: pending =
 *                curve/pool waiting + the wallet's creator vault. Shown as PENDING BUYBACKS. When the operator collects,
 *                pending drops; the drop is added to a running "collected" total (kv), so all-time $EARN fees stay whole.
 *
 * Read on demand only (memory: dont-waste-paid-api-credits): a request refreshes it when older than REFRESH_MS, in a
 * few batched getMultipleAccounts calls; nothing runs while nobody looks.
 */
import { PublicKey } from '@solana/web3.js'
import { WSOL, ammCreatorVaultAuthority, ata, bondingCurveAddress, creatorVaultAddress, curveCreator, curveCreatorFeeWaiting, decodePool, poolCreatorFeesWaiting } from '../lib/pump.mjs'
import { kvGet, kvSet } from './db.mjs'

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const RENT0 = 890_880 // rent-exempt minimum of a 0-byte account (creator vaults, fee addresses)

export function createLiveFees({ db, conn, refreshMs = 60_000, log = console }) {
  let state = { at: 0, byMint: new Map(), waitingTotal: 0, platform: null, byMintQ: new Map(), prices: new Map(), waitingQUsd: 0 }
  let running = null

  async function refresh() {
    const tokens = db.prepare(`SELECT t.mint, t.platform, t.pool, t.split_key, t.fee_recipient, COALESCE(s.fee_address, c.fee_address) AS fee
      FROM tokens t LEFT JOIN splits s ON s.split_key_hex = t.split_key LEFT JOIN creators c ON c.key_hex = t.creator_key WHERE t.quote_mint IS NULL`).all()
    const groups = new Map() // fee address → coins
    let plat = null
    for (const t of tokens) {
      if (t.platform) { if (t.fee_recipient) plat = t; continue }
      if (!t.fee) continue
      if (!groups.has(t.fee)) groups.set(t.fee, [])
      groups.get(t.fee).push(t)
    }
    // One flat list of accounts to read, remembering where each lands.
    const keys = [], at = (k) => (keys.push(k), keys.length - 1)
    const plan = []
    for (const [fee, coins] of groups) {
      const f = new PublicKey(fee)
      plan.push({ fee: f, coins: coins.map((c) => ({ mint: c.mint, curve: at(bondingCurveAddress(new PublicKey(c.mint))), pool: c.pool ? at(new PublicKey(c.pool)) : -1 })),
        vault: at(creatorVaultAddress(f)), self: at(f), amm: at(ata(ammCreatorVaultAuthority(f), WSOL, TOKEN)) })
    }
    let pplan = null
    if (plat) {
      const w = new PublicKey(plat.fee_recipient)
      pplan = { wallet: w, mint: plat.mint, curve: at(bondingCurveAddress(new PublicKey(plat.mint))), pool: plat.pool ? at(new PublicKey(plat.pool)) : -1,
        vault: at(creatorVaultAddress(w)), amm: at(ata(ammCreatorVaultAuthority(w), WSOL, TOKEN)) }
    }
    const infos = []
    for (let i = 0; i < keys.length; i += 100) infos.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), 'confirmed'))
    const lam = (i) => Math.max(0, (infos[i]?.lamports ?? 0) - RENT0)
    const wsol = (i) => (infos[i]?.data?.length >= 72 ? Number(infos[i].data.readBigUInt64LE(64)) : 0)
    const own = (i, creator, kind) => {
      const a = infos[i]
      if (!a) return 0
      try {
        if (kind === 'curve') return curveCreator(a.data)?.equals(creator) ? Number(curveCreatorFeeWaiting(a.data)) : 0
        return decodePool(a.data).coin_creator.equals(creator) ? Number(poolCreatorFeesWaiting(a.data)) : 0
      } catch { return 0 }
    }

    const byMint = new Map()
    let waitingTotal = 0
    for (const g of plan) {
      const per = g.coins.map((c) => own(c.curve, g.fee, 'curve') + (c.pool >= 0 ? own(c.pool, g.fee, 'pool') : 0))
      const shared = lam(g.vault) + lam(g.self) + wsol(g.amm)
      const wsum = per.reduce((a, b) => a + b, 0)
      g.coins.forEach((c, i) => {
        const v = per[i] + Math.floor(shared * (wsum ? per[i] / wsum : 1 / g.coins.length))
        byMint.set(c.mint, v); waitingTotal += v
      })
    }
    let platform = null
    if (pplan) {
      const pending = own(pplan.curve, pplan.wallet, 'curve') + (pplan.pool >= 0 ? own(pplan.pool, pplan.wallet, 'pool') : 0) + lam(pplan.vault) + wsol(pplan.amm)
      // A drop in pending = the operator collected: add it to the running total (small dust drops are ignored).
      const last = Number(kvGet(db, 'earn_pending_last') ?? pending)
      let collected = Number(kvGet(db, 'earn_collected') ?? 0)
      if (pending < last - 1000) { collected += last - pending; kvSet(db, 'earn_collected', String(collected)) }
      kvSet(db, 'earn_pending_last', String(pending))
      platform = { mint: pplan.mint, wallet: pplan.wallet.toBase58(), pendingLamports: pending, collectedLamports: collected }
    }
    // Custom pairs: what waits IN Q for each paired coin (its own unswept fee exactly, plus a share of the creator's vaults).
    const byMintQ = new Map(), prices = new Map()
    let waitingQUsd = 0
    try {
      const pairs = await import('../lib/pairs.mjs')
      const { quotePriceUsd } = await import('./pairs-launch.mjs')
      const qrows = db.prepare(`SELECT t.mint, t.quote_mint, t.quote_program, t.quote_decimals, COALESCE(s.fee_address, c.fee_address) AS fee
        FROM tokens t LEFT JOIN splits s ON s.split_key_hex = t.split_key LEFT JOIN creators c ON c.key_hex = t.creator_key
        WHERE t.quote_mint IS NOT NULL AND t.platform = 0`).all()
      const qgroups = new Map()
      for (const r of qrows) { if (!r.fee) continue; const k = `${r.fee}|${r.quote_mint}`; if (!qgroups.has(k)) qgroups.set(k, []); qgroups.get(k).push(r) }
      for (const [, rows] of qgroups) {
        const quote = { mint: rows[0].quote_mint, tokenProgram: rows[0].quote_program }
        const per = [], shared0 = { v: 0n }
        for (const r of rows) {
          const p = await pairs.pendingQuoteFees(conn, { mint: r.mint, quote, creator: r.fee })
          per.push(p.curveUnswept + p.poolUnswept)
          shared0.v = p.curve + p.amm // per creator: the same for every coin of this fee address
        }
        const atFee = await conn.getAccountInfo(pairs.ata(new PublicKey(rows[0].fee), new PublicKey(quote.mint), new PublicKey(quote.tokenProgram)))
        const shared = shared0.v + (atFee ? pairs.tokenAccountAmount(atFee.data) : 0n)
        const wsum = per.reduce((a, b) => a + b, 0n)
        if (!prices.has(quote.mint)) prices.set(quote.mint, await quotePriceUsd(quote.mint))
        rows.forEach((r, i) => {
          const v = per[i] + (wsum > 0n ? shared * per[i] / wsum : shared / BigInt(rows.length))
          byMintQ.set(r.mint, v)
          waitingQUsd += Number(v) / 10 ** (r.quote_decimals ?? 6) * prices.get(quote.mint)
        })
      }
      for (const m of new Set(qrows.map((r) => r.quote_mint))) if (!prices.has(m)) prices.set(m, await quotePriceUsd(m))
    } catch (e) { log.error?.(`live pair fees: ${e.message}`) }
    state = { at: Date.now(), byMint, waitingTotal, platform, byMintQ, prices, waitingQUsd }
  }

  /** Fresh enough for this request: refreshes in the background when stale; the very first call waits (up to 4 s). */
  async function ensure() {
    if (Date.now() - state.at > refreshMs && !running) {
      running = refresh().catch((e) => log.error?.(`live fees: ${e.message}`)).finally(() => { running = null })
    }
    if (!state.at && running) await Promise.race([running, new Promise((r) => setTimeout(r, 4000))])
  }

  return {
    ensure,
    refresh,
    waiting: (mint) => state.byMint.get(mint) ?? 0,
    waitingTotal: () => state.waitingTotal,
    platform: () => state.platform,
    /** Custom pairs: Q units waiting for a paired coin, a pair token's USD price, and all of it in USD. */
    waitingQ: (mint) => state.byMintQ.get(mint) ?? 0n,
    priceQ: (quoteMint) => state.prices.get(quoteMint) ?? 0,
    waitingQUsd: () => state.waitingQUsd,
  }
}
