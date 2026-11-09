/**
 * Custom pairs, server side: which tokens a coin can be paired with (pump.fun's quote-control list + any pump coin on its
 * curve or on PumpSwap), their names, logos and prices (DexScreener, cached), and one lookup table per pair token so a
 * paired launch with a dev buy fits one transaction (the keeper creates it the first time that pair is used).
 *
 * Gate: PAIRS_ENABLED=1 only after the EARN program upgrade with harvest_token is live, or fees in Q could not be harvested.
 */
import { AddressLookupTableProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import * as pairs from '../lib/pairs.mjs'
import { kvGet, kvSet } from './db.mjs'

export const pairsEnabled = () => process.env.PAIRS_ENABLED === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** DexScreener token info for up to 30 mints per call: { [mint]: { symbol, name, image, priceUsd } } (best-liquidity pair). */
async function dexInfo(mints) {
  const out = {}
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) continue
      for (const p of await r.json()) {
        const m = p?.baseToken?.address
        if (!m || !mints.includes(m)) continue
        const liq = Number(p.liquidity?.usd ?? 0)
        if (out[m] && out[m].liq >= liq) continue
        out[m] = { symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl ?? '', priceUsd: Number(p.priceUsd ?? 0), liq }
      }
    } catch {}
  }
  return out
}

let listCache = { at: 0, items: [] }
/** pump.fun's custom pair list with names, logos and prices, deepest first. Cached 1 hour. */
export async function pairList(conn) {
  if (Date.now() - listCache.at < 3600_000 && listCache.items.length) return listCache.items
  const entries = await pairs.readQuoteControlEntries(conn)
  const mints = entries.map((e) => e.mint)
  const info = await dexInfo(mints)
  const items = mints.map((m) => ({ mint: m, symbol: info[m]?.symbol ?? m.slice(0, 4), name: info[m]?.name ?? '', image: info[m]?.image ?? '', priceUsd: info[m]?.priceUsd ?? 0, liquidityUsd: info[m]?.liq ?? 0 }))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
  listCache = { at: Date.now(), items }
  return items
}

const priceCache = new Map()
/** USD price of one whole Q (0 when unknown), cached 5 minutes. */
export async function quotePriceUsd(mint) {
  const c = priceCache.get(mint)
  if (c && Date.now() - c.at < 300_000) return c.price
  const info = await dexInfo([mint])
  const price = info[mint]?.priceUsd ?? c?.price ?? 0
  priceCache.set(mint, { at: Date.now(), price })
  return price
}

/** A pair the user picked (any mint): the resolved accounts plus a display name, or { ok: false, reason }. */
export async function resolvePair(conn, mint) {
  const q = await pairs.resolveQuote(conn, mint)
  if (!q.ok) return q
  const info = (await dexInfo([q.mint]))[q.mint]
  return { ...q, symbol: info?.symbol ?? q.mint.slice(0, 4), name: info?.name ?? '', image: info?.image ?? '', priceUsd: info?.priceUsd ?? 0 }
}

/** Every non-signer key a launch against q can use (create_v2 + the dev buy routes), from throwaway accounts. */
async function launchKeysFor(conn, q) {
  const global = await pairs.loadGlobal(conn)
  const t = () => ({ mint: Keypair.generate().publicKey, user: Keypair.generate().publicKey })
  const keys = new Set()
  const variants = [null, 'quote', ...(q.kind === 'listed' ? [] : ['sol'])]
  for (const currency of variants) {
    const a = t()
    const ixs = [await pairs.createV2Ix(conn, { mint: a.mint, user: a.user, name: 'x', symbol: 'X', uri: 'https://x', creator: Keypair.generate().publicKey, quote: q })]
    if (currency) ixs.push(...(await pairs.firstBuyIxs(conn, global, { mint: a.mint, user: a.user, q, currency, amountIn: 1n, minOut: 1n })))
    // only keys that do not depend on the throwaway mint, user or creator
    const b = t()
    const ixs2 = [await pairs.createV2Ix(conn, { mint: b.mint, user: b.user, name: 'x', symbol: 'X', uri: 'https://x', creator: Keypair.generate().publicKey, quote: q })]
    if (currency) ixs2.push(...(await pairs.firstBuyIxs(conn, global, { mint: b.mint, user: b.user, q, currency, amountIn: 1n, minOut: 1n })))
    const set2 = new Set(ixs2.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]))
    for (const ix of ixs) for (const k of [ix.programId.toBase58(), ...ix.keys.filter((x) => !x.isSigner).map((x) => x.pubkey.toBase58())]) if (set2.has(k)) keys.add(k)
  }
  return [...keys].map((k) => new PublicKey(k))
}

/** The lookup table for pair q (created by the keeper on first use, ~0.003 SOL), loaded and ready. */
export async function ensurePairLut(conn, db, keeper, q) {
  const k = `pairlut:${q.mint}`
  const saved = kvGet(db, k)
  if (saved) {
    const t = (await conn.getAddressLookupTable(new PublicKey(saved))).value
    if (t) return t
  }
  const addresses = await launchKeysFor(conn, q)
  const send = async (ixs) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
    tx.sign([keeper])
    const sig = await conn.sendRawTransaction(tx.serialize())
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  }
  let create, table
  for (let attempt = 1; ; attempt++) {
    const slot = Math.max(0, (await conn.getSlot('finalized')) - 50)
    ;[create, table] = AddressLookupTableProgram.createLookupTable({ authority: keeper.publicKey, payer: keeper.publicKey, recentSlot: slot })
    try { await send([create]); break } catch (e) { if (attempt >= 4) throw e; await sleep(1500) }
  }
  for (let i = 0; i < addresses.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: keeper.publicKey, payer: keeper.publicKey, addresses: addresses.slice(i, i + 20) })])
  }
  kvSet(db, k, table.toBase58())
  // usable from the slot after the last extension
  const target = (await conn.getSlot('confirmed')) + 1
  while ((await conn.getSlot('confirmed')) <= target) await sleep(400)
  return (await conn.getAddressLookupTable(table)).value
}

/** True when the coin's Q account on its curve already exists (someone pre-created it): create_v2 would fail forever. */
export async function curveQuoteAccountTaken(conn, mint, q) {
  const a = pairs.ata(pairs.bondingCurveAddress(new PublicKey(mint)), new PublicKey(q.mint), new PublicKey(q.tokenProgram))
  return !!(await conn.getAccountInfo(a))
}
