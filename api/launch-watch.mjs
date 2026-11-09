/**
 * $EARN go-live, automated: watches the operator's launch wallet and, the moment it SIGNS a pump.fun create for the
 * platform ticker, lists that coin as EARN's own token and OPENS launching for everyone. No message, no command.
 *
 * Fast by design (seconds, not minutes):
 *   - a websocket `logsSubscribe` on the wallet is the trigger (~1 s after confirmation); a slow poll (60 s) is only the
 *     safety net for a dropped socket, so idle cost stays tiny (memory: dont-waste-paid-api-credits);
 *   - everything is read from CHAIN (the create instruction, the bonding curve's creator, the Token-2022 metadata), never
 *     from pump.fun's API, which can take minutes to index a fresh coin;
 *   - the image is STAGED (the site's own copy of the logo), so nothing is fetched from IPFS at go-live.
 *
 * ⛔ An address index lists mere mentions: the wallet must be a SIGNER of the create (memory: watcher-must-check-signer).
 * ⛔ Fails closed: anything unexpected (wrong ticker, wrong creator, failed tx) is logged and ignored, the gate stays shut.
 */
import { PublicKey } from '@solana/web3.js'
import { getTokenMetadata } from '@solana/spl-token'
import bs58 from 'bs58'
import { PUMP, TOKEN_2022, bondingCurveAddress, decodeBondingCurve, pumpIdl } from '../lib/pump.mjs'
import { kvGet, kvSet } from './db.mjs'

const CREATE = Object.fromEntries(pumpIdl.instructions.filter((i) => i.name === 'create' || i.name === 'create_v2')
  .map((i) => [Buffer.from(i.discriminator).toString('hex'), i.name]))

/** { mint, via, sig } when the jsonParsed transaction holds a pump.fun create signed by `wallet` (top level or inner). */
export function pumpCreateBy(tx, wallet) {
  const keys = tx?.transaction?.message?.accountKeys ?? []
  if (!tx || tx.meta?.err || !keys.some((k) => (k.pubkey ?? k) === wallet && k.signer)) return null
  const all = [...(tx.transaction.message.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions ?? [])]
  for (const ix of all) {
    if (ix.programId !== PUMP.toBase58() || typeof ix.data !== 'string' || !ix.accounts?.length) continue
    let d; try { d = Buffer.from(bs58.decode(ix.data)) } catch { continue }
    const via = CREATE[d.subarray(0, 8).toString('hex')]
    if (via) return { mint: ix.accounts[0], via, sig: tx.transaction.signatures[0] }
  }
  return null
}

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
/** { name, symbol, uri } from a Metaplex metadata account (legacy pump.fun `create`), or null. */
export async function readMetaplexMetadata(conn, mint) {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)
  const info = await conn.getAccountInfo(pda, 'confirmed')
  if (!info) return null
  const d = info.data; let o = 1 + 32 + 32 // key, update authority, mint
  const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + n).toString('utf8').replace(/\0+$/, '').trim(); o += n; return s }
  return { name: str(), symbol: str(), uri: str() }
}

/** Name, ticker, URI and creator straight from chain. Throws (fails closed) when it is not the platform token. */
export async function readCoinFromChain(conn, mint, { wallet, symbol }) {
  const pk = new PublicKey(mint)
  const [curveInfo, md2022, mdLegacy] = await Promise.all([
    conn.getAccountInfo(bondingCurveAddress(pk), 'confirmed'),
    getTokenMetadata(conn, pk, 'confirmed', TOKEN_2022).catch(() => null),
    readMetaplexMetadata(conn, pk).catch(() => null),
  ])
  // create_v2 coins carry Token-2022 metadata; a legacy `create` coin carries a Metaplex metadata account instead.
  const md = md2022 ?? mdLegacy
  if (!curveInfo) throw new Error('no pump.fun bonding curve yet')
  const creator = decodeBondingCurve(curveInfo.data).creator.toBase58()
  if (creator !== wallet) throw new Error(`creator is ${creator}, not ${wallet}`)
  if (!md) throw new Error('token metadata not readable yet')
  if (String(md.symbol).trim().toUpperCase() !== symbol) throw new Error(`ticker is ${md.symbol}, not ${symbol}`)
  return { mint, name: md.name, symbol: md.symbol, uri: md.uri, creator }
}

/**
 * Starts the watcher unless the platform token is already set. `goLive({ mint, coin })` does the listing + gate.
 * Returns a stop function.
 */
export function startLaunchWatcher({ db, conn, wallet, symbol = 'EARN', goLive, pollMs = 60_000, log = console }) {
  if (!wallet) { log.info?.('launch watcher: no LAUNCH_WALLET set, not watching'); return () => {} }
  const owner = new PublicKey(wallet)
  const startedAt = Math.floor(Date.now() / 1000)
  // Creates older than the watcher (minus 10 min) are history, not the launch.
  const since = Number(kvGet(db, 'launch_watch_since') ?? 0) || startedAt - 600
  if (!kvGet(db, 'launch_watch_since')) kvSet(db, 'launch_watch_since', String(since))
  const seen = new Set()
  let done = false, busy = Promise.resolve(), subId = null, timer = null

  const already = () => { try { return !!JSON.parse(kvGet(db, 'platform') ?? 'null')?.mint } catch { return false } }
  if (already()) { log.info?.('launch watcher: platform token already set, not watching'); return () => {} }

  const examine = (sig, via) => {
    if (done || seen.has(sig)) return busy
    busy = busy.then(async () => {
      if (done || seen.has(sig)) return
      const t0 = Date.now()
      // ⛔ web3.js 1.98 cannot read version-1 txs: the raw request with jsonParsed (memory: solana-web3js-cannot-read-v1).
      let tx = null
      for (let i = 0; i < 6 && !tx; i++) {
        tx = (await conn._rpcRequest('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null))?.result ?? null
        if (!tx) await new Promise((r) => setTimeout(r, 500))
      }
      if (!tx) { log.error?.(`launch watcher: ${sig.slice(0, 12)}… not readable, the poll will retry`); return }
      seen.add(sig)
      if ((tx.blockTime ?? startedAt) < since) return
      const c = pumpCreateBy(tx, wallet)
      if (!c) return
      let coin = null
      for (let i = 0; i < 10 && !coin; i++) {
        try { coin = await readCoinFromChain(conn, c.mint, { wallet, symbol }) } catch (e) {
          if (/creator is|ticker is/.test(e.message)) { log.error?.(`launch watcher: ${c.mint} ignored: ${e.message}`); return }
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      if (!coin) { seen.delete(sig); log.error?.(`launch watcher: ${c.mint} not readable yet, will retry`); return }
      try { await goLive({ mint: c.mint, coin, sig }) } catch (e) {
        seen.delete(sig) // not done: the next poll (or event) tries again
        throw e
      }
      done = true
      kvSet(db, 'launch_watch_done', JSON.stringify({ mint: c.mint, sig, via, ms: Date.now() - t0, at: Date.now() }))
      log.info?.(`launch watcher: ✅ ${coin.name} (${coin.symbol}) ${c.mint} listed and launching OPEN, ${Date.now() - t0} ms after the ${via} saw ${sig.slice(0, 12)}…`)
      stop()
    }).catch((e) => log.error?.(`launch watcher: ${e.message}`))
    return busy
  }

  const poll = async () => {
    if (done) return
    try {
      const sigs = await conn.getSignaturesForAddress(owner, { limit: 15 }, 'confirmed')
      for (const s of sigs.reverse()) if (!s.err && (s.blockTime ?? startedAt) >= since) await examine(s.signature, 'poll')
      kvSet(db, 'launch_watch_poll', String(Date.now()))
    } catch (e) { log.error?.(`launch watcher poll: ${String(e.message).slice(0, 120)}`) }
    if (!done) timer = setTimeout(poll, pollMs)
  }

  try {
    subId = conn.onLogs(owner, (l) => { if (!l.err) examine(l.signature, 'websocket') }, 'confirmed')
  } catch (e) { log.error?.(`launch watcher: websocket not started (${e.message}), polling only`) }
  function stop() { done = true; clearTimeout(timer); if (subId != null) conn.removeOnLogsListener(subId).catch(() => {}); subId = null }
  log.info?.(`launch watcher: watching ${wallet} for a pump.fun create of ${symbol} (websocket + ${pollMs / 1000}s poll)`)
  poll()
  return stop
}
