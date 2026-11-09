/**
 * EARN API. Plain node:http + node:sqlite, same shape as ~/fees/api.
 *
 * Reads come from the store (a cache of the chain) plus live on-chain balances; writes are the
 * launch builder, the withdrawal relayer, sign-in and opt-out. See DESIGN.md.
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { openDb, upsertCreator, now, kvGet, kvSet } from './db.mjs'
import { addressesOf, CLAIMABLE, isProvider, pageProvider } from './identity.mjs'
import { buildLaunch, composeDescription, confirmLaunch, LaunchError, TICKER_FEE_LAMPORTS, tickerTaken, uploadMetadata, validateLaunch } from './launch.mjs'
import { lamportsToUsd, refreshMarket, solUsd } from './market.mjs'
import { buildSolWithdraw, buildUsdcWithdraw, owedLamports } from './payout.mjs'
import { pendingFor, programs, sendAndRecord } from './keeper.mjs'
import { freshCount, startGrinder } from './vanity.mjs'
import { loadGlobal, pumpProgram } from '../lib/pump.mjs'
import { EARN, canonicalSplit, configAddress, feeAddress as feeAddressOf, tokenLedgerAddress, vaultAuthority } from '../lib/earn.mjs'
import BN from 'bn.js'
import { xProvider } from './providers/x.mjs'
import { githubProvider } from './providers/github.mjs'
import { twitchProvider } from './providers/twitch.mjs'
import { spotifyProvider } from './providers/spotify.mjs'
import { fomoProvider } from './providers/fomo.mjs'
import { stubProvider } from './providers/stub.mjs'
import { clearPlatformToken, platformState, PlatformError, setPlatformToken, verifyPlatformToken } from './platform.mjs'
import { cacheImage, imageType, squareLogo, storeImage } from './images.mjs'
import { startLaunchWatcher } from './launch-watch.mjs'
import { createLiveFees } from './fees-live.mjs'
import { burnCardPng, burnPageHtml, burnStats, readIndex } from './burn-card.mjs'
import { ensurePairLut, pairList, pairsEnabled, quotePriceUsd, resolvePair } from './pairs-launch.mjs'

const env = process.env
const PORT = Number(env.PORT ?? 8820)
const PUBLIC_URL = env.PUBLIC_URL ?? 'http://localhost:5270'
// Where the sign-in apps send people back. It can be an OLD domain that only redirects /api/auth/* here (justearn.money
// → earnrewards.fun keeps the registered X/GitHub/Twitch/Spotify callbacks). The code exchange must name this exact URL.
const OAUTH_CALLBACK_BASE = env.OAUTH_CALLBACK_BASE || PUBLIC_URL
const DATA_DIR = env.DATA_DIR ?? './data'
const LOGO_DIR = join(DATA_DIR, 'logos')
mkdirSync(LOGO_DIR, { recursive: true })
const db = openDb(env.DB_PATH ?? join(DATA_DIR, 'earn.db'))
// Every RPC request is counted per method and logged hourly, so a wasteful path shows up in the journal.
const rpcCounts = new Map()
const conn = new Connection(env.RPC_URL ?? 'https://solana-rpc.publicnode.com', {
  commitment: 'confirmed',
  fetchMiddleware: (url, options, fetch) => {
    try { for (const r of [].concat(JSON.parse(options.body))) rpcCounts.set(r.method, (rpcCounts.get(r.method) ?? 0) + 1) } catch {}
    return fetch(url, options)
  },
})
setInterval(() => { if (rpcCounts.size) { console.log('rpc calls last hour:', JSON.stringify(Object.fromEntries(rpcCounts))); rpcCounts.clear() } }, 3600_000).unref()
// Earned-but-unclaimed fees (EARN coins) and $EARN's pending buybacks, read from chain on demand (api/fees-live.mjs).
const live = createLiveFees({ db, conn })
// Also every 2 minutes in the background (one batched read): the $EARN "collected" total grows by noticing pending drop,
// so a collect between two site visits must not hide the fees that accrued in between.
setInterval(() => { live.refresh().catch((e) => console.error('live fees:', e.message)) }, 120_000).unref()

/** A tiny TTL cache for chain reads that public pages repeat: a crawler must not turn into RPC credits. */
const memoStore = new Map()
async function memo(key, ttlMs, fn) {
  const hit = memoStore.get(key)
  if (hit && hit.until > Date.now()) return hit.value
  const value = await fn()
  memoStore.set(key, { value, until: Date.now() + ttlMs })
  if (memoStore.size > 5000) for (const [k, v] of memoStore) if (v.until < Date.now()) memoStore.delete(k)
  return value
}
const readKey = (p) => p && existsSync(p) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')))) : null
const signer = readKey(env.SIGNER_KEY)     // co-signs withdrawals; the program checks it is config.signer
const relayer = readKey(env.RELAYER_KEY)   // pays withdrawal fees and receives the SOL it swaps
const keeper = readKey(env.KEEPER_KEY)     // custom pairs: creates a pair token's lookup table the first time it is used
const pump = pumpProgram(conn)
let global = null
const lookupTables = []
// The operator's wallet: $EARN's fee recipient, the only CA the platform slot accepts.
const FOUNDER = env.FOUNDER ?? 'fomosZ2wByGHXygzSzDg1J7uFVCiAj9KbZVjr342hnX'
// Ticker protection fees go to the wallet that deployed the EARN program (the deployer / upgrade authority).
const TICKER_FEE_WALLET = new PublicKey(env.TICKER_FEE_WALLET || 'CFRaGWCs3yPjccMSFojccoVzW3YcTWF5bjr2Bk4KfqMj')
const ADMIN_TOKEN = env.ADMIN_TOKEN ?? ''
const MIN_WITHDRAW_LAMPORTS = BigInt(env.MIN_WITHDRAW_LAMPORTS ?? 10_000_000)
const WITHDRAW_COOLDOWN_S = Number(env.WITHDRAW_COOLDOWN_S ?? 600)
// How $EARN's creator is SHOWN (its fees go to FOUNDER directly, never through the EARN program).
// The platform's own X account, shown as $EARN's creator. Set PLATFORM_X_HANDLE (and PLATFORM_X_ID) per deployment.
const EARN_ACCOUNT = { provider: 'x', id: process.env.PLATFORM_X_ID ?? '', handle: process.env.PLATFORM_X_HANDLE ?? '', name: 'Earn', avatar: null, verified: false }

/** Lists `mint` as $EARN and opens launching, from what the watcher read on chain. Nothing slow happens before the gate
 *  opens: the image is the staged logo (api/assets/earn-token.png), market cap and the X avatar fill in afterwards. */
async function platformGoLive({ mint, coin, sig }) {
  let image = ''
  try { image = storeImage({ logoDir: LOGO_DIR, publicUrl: PUBLIC_URL }, readFileSync(new URL('./assets/earn-token.png', import.meta.url))) } catch (e) { console.error('staged $EARN image not stored:', e.message) }
  const stored = EARN_ACCOUNT.handle ? db.prepare("SELECT * FROM creators WHERE provider = 'x' AND (id = ? OR lower(handle) = lower(?))").get(EARN_ACCOUNT.id, EARN_ACCOUNT.handle) : null
  // No X account configured: still list $EARN (under a plain "Earn" identity) rather than fail the go-live.
  const base = EARN_ACCOUNT.id ? EARN_ACCOUNT : { ...EARN_ACCOUNT, id: 'earn-platform', handle: EARN_ACCOUNT.handle || 'earn' }
  const display = stored ? { ...base, id: stored.id, handle: stored.handle ?? base.handle, name: stored.name ?? base.name, avatar: stored.avatar, verified: !!stored.verified } : base
  setPlatformToken(db, { mint, coin: { name: coin.name, symbol: coin.symbol, image_uri: image, description: '', metadata_uri: coin.uri, created_timestamp: Date.now() }, creator: coin.creator, displayIdentity: display })
  db.prepare("DELETE FROM kv WHERE k = 'launches_closed'").run()
  console.log(`$EARN live: ${mint} (create ${sig}), launching OPEN`)
  // after the gate: market data, and the X profile picture if it was not stored yet
  solUsd().then((price) => refreshMarket(db, conn, mint, price)).catch((e) => console.error('market refresh after go-live:', e.message))
  const x = providers.get('x')
  if (!stored?.avatar && x && !x.isStub && EARN_ACCOUNT.handle) x.lookup(EARN_ACCOUNT.handle).then((found) => { if (found?.id) remember({ ...found, provider: 'x' }) }).catch(() => {})
}

// ─── providers ────────────────────────────────────────────────────────────────────────────────
const providers = new Map()
if (env.X_CLIENT_ID) providers.set('x', xProvider(env.X_CLIENT_ID, env.X_CLIENT_SECRET, env.X_BEARER, env.TWITTERAPI_IO_KEY))
if (env.GITHUB_CLIENT_ID) providers.set('github', githubProvider(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET))
if (env.TWITCH_CLIENT_ID) providers.set('twitch', twitchProvider(env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET))
if (env.SPOTIFY_CLIENT_ID) providers.set('spotify', spotifyProvider(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET))
const fomo = fomoProvider(env.FOMO_LOOKUP)
if (fomo.configured) providers.set('fomo', fomo)
// ⛔ DEV ONLY: stand-in sign-in and lookups for a local stack with no OAuth apps. Refused on https,
// where it would let anyone sign in as anyone.
const DEV = env.DEV_STUBS === '1'
if (DEV && PUBLIC_URL.startsWith('https:')) throw new Error('DEV_STUBS=1 is refused on an https site')
if (DEV) for (const [n, l] of [['x', 'X'], ['twitch', 'Twitch'], ['github', 'GitHub']]) if (!providers.has(n)) providers.set(n, stubProvider(n, l))

/** A destination that is a program's account or a token account cannot receive SOL usefully. */
async function isProgramOwnedWallet(pk) {
  const info = await conn.getAccountInfo(pk).catch(() => null)
  return !!info && !info.owner.equals(SystemProgram.programId)
}

/** fomoapi.io's free tier is 1,000 calls a month; EARN spends at most this many. */
const FOMO_MONTHLY_BUDGET = Number(env.FOMO_MONTHLY_BUDGET ?? 800)
function overFomoBudget() {
  const month = new Date().toISOString().slice(0, 7)
  const n = Number(kvGet(db, `fomo:${month}`) ?? 0) + 1
  kvSet(db, `fomo:${month}`, n)
  return n > FOMO_MONTHLY_BUDGET
}
/** A recent row for this exact handle: no provider call needed. */
const cachedCreator = (provider, handle) => db.prepare(`SELECT * FROM creators WHERE (provider = ? OR provider LIKE ?) AND lower(handle) = lower(?) AND looked_up_at > ?`)
  .get(provider, `${provider}:%`, handle.replace(/^@/, ''), now() - 7 * 86400)

/** Paid lookups per UTC day, across all callers. The key was drained once before by a poller. */
const LOOKUP_BUDGET = Number(env.LOOKUP_BUDGET ?? 2000)
function overLookupBudget() {
  const day = new Date().toISOString().slice(0, 10)
  const n = Number(kvGet(db, `lookups:${day}`) ?? 0) + 1
  kvSet(db, `lookups:${day}`, n)
  return n > LOOKUP_BUDGET
}

/** The site says `spotify` + `artist:ID` / `user:ID`; identities say `spotify:artist` + `ID`. */
function fromSite(provider, id) {
  if (provider === 'spotify') {
    const [kind, ...rest] = String(id).split(':')
    if ((kind === 'artist' || kind === 'user') && rest.length) return { provider: `spotify:${kind}`, id: rest.join(':') }
    return null
  }
  return isProvider(provider) ? { provider, id: String(id) } : null
}
function toSite(row) {
  const spotify = row.provider.startsWith('spotify:')
  return {
    provider: pageProvider(row.provider),
    id: spotify ? `${row.provider.split(':')[1]}:${row.id}` : row.id,
    handle: row.handle ?? row.id, name: row.name ?? row.handle ?? row.id, avatar: row.avatar ?? '', verified: !!row.verified,
  }
}
function remember(identity) {
  const a = addressesOf(identity)
  upsertCreator(db, { ...identity, ...a })
  return db.prepare('SELECT * FROM creators WHERE provider = ? AND id = ?').get(identity.provider, String(identity.id))
}

// ─── http helpers ─────────────────────────────────────────────────────────────────────────────
export { imageType }

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new LaunchError('Too large', 413)); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
const readJson = async (req) => { try { return JSON.parse((await readBody(req)).toString() || '{}') } catch { throw new LaunchError('Bad JSON') } }
const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1] ?? null
const secure = PUBLIC_URL.startsWith('https:')
const setCookie = (res, name, value, maxAge) =>
  res.setHeader('set-cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`)

const hits = new Map()
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600_000)) hits.delete(k) }, 600_000).unref()
/** A query integer, clamped; NaN and negatives fall back to the default. */
const int = (q, name, dflt, max) => { const n = Number(q.get(name) ?? dflt); return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : dflt }
function limited(req, bucket, perHour) {
  // ⛔ LAST entry: Caddy appends the real client ip; the first entries are whatever the client sent.
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',').pop().trim()
  const k = `${bucket}:${ip}`, t = Date.now()
  const list = (hits.get(k) ?? []).filter((x) => t - x < 3600_000)
  list.push(t); hits.set(k, list)
  return list.length > perHour
}

// ─── sessions ─────────────────────────────────────────────────────────────────────────────────
const SESSION_DAYS = 7
function session(req) {
  const id = cookie(req, 'earn_sid')
  if (!id) return null
  const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, now())
  if (!s) return null
  s.accounts = db.prepare(`SELECT c.* FROM session_accounts sa JOIN creators c ON c.provider = sa.provider AND c.id = sa.id WHERE sa.session_id = ?`).all(id)
  return s
}
function ensureSession(req, res) {
  const existing = session(req)
  if (existing) return existing.id
  const id = randomBytes(24).toString('base64url')
  db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(id, now(), now() + SESSION_DAYS * 86400)
  setCookie(res, 'earn_sid', id, SESSION_DAYS * 86400)
  return id
}
const pendingAuth = new Map() // state → { provider, verifier, returnTo, at }
/** A same-site path only. `//host`, `/\\host` (browsers read `\` as `/`) and control characters all fall back to /claim. */
export const safeReturnPath = (ret) => (/^\/(?![\/\\])[\x21-\x7e]*$/.test(ret) && !ret.includes('\\') ? ret : '/claim')

// ─── view builders ────────────────────────────────────────────────────────────────────────────
const creatorByKey = (k) => db.prepare('SELECT * FROM creators WHERE key_hex = ?').get(k)
/** A token's fees. A split's fee address is its own, so its figure is exact; a single creator's fees are
 *  pooled across their tokens, so a token gets an equal share of the creator's total. */
function tokenFeesLamports(t) {
  // Claims the keeper attributed to this coin (claim_tokens: swept fee exact, the rest in proportion), plus an equal
  // share of any older claim of its fee address that carries no attribution.
  const source = t.split_key ?? t.creator_key
  const mine = db.prepare('SELECT COALESCE(SUM(lamports), 0) AS l FROM claim_tokens WHERE mint = ?').get(t.mint).l
  const loose = db.prepare('SELECT COALESCE(SUM(gross), 0) AS g FROM claims c WHERE source_key_hex = ? AND NOT EXISTS (SELECT 1 FROM claim_tokens ct WHERE ct.signature = c.signature)').get(source).g
  const siblings = t.split_key ? 1 : db.prepare('SELECT count(*) AS n FROM tokens WHERE creator_key = ? AND split_key IS NULL AND platform = 0').get(t.creator_key).n
  return mine + (siblings > 1 ? loose / siblings : loose)
}
/** Custom pairs: a paired coin's fees IN Q (claimed, equal share among the fee address's coins in Q, + waiting now). */
function pairFees(t) {
  if (!t.quote_mint) return null
  const source = t.split_key ?? t.creator_key
  const claimed = db.prepare('SELECT amount FROM token_claims WHERE source_key_hex = ? AND quote_mint = ?').all(source, t.quote_mint).reduce((n, r) => n + BigInt(r.amount), 0n)
  const siblings = t.split_key ? 1n : BigInt(db.prepare('SELECT count(*) n FROM tokens WHERE creator_key = ? AND split_key IS NULL AND quote_mint = ?').get(t.creator_key, t.quote_mint).n || 1)
  const units = claimed / siblings + live.waitingQ(t.mint)
  const dec = t.quote_decimals ?? 6, price = live.priceQ(t.quote_mint)
  return { mint: t.quote_mint, symbol: t.quote_symbol ?? '', decimals: dec, amount: Number(units) / 10 ** dec, waiting: Number(live.waitingQ(t.mint)) / 10 ** dec, usd: Number(units) / 10 ** dec * price, waitingUsd: Number(live.waitingQ(t.mint)) / 10 ** dec * price }
}
/** Custom pairs: what a creator is owed in each pair token, read from their on-chain ledgers. */
async function tokensOwed(row) {
  const mints = db.prepare(`SELECT DISTINCT quote_mint, quote_decimals, quote_symbol, quote_program FROM tokens WHERE quote_mint IS NOT NULL AND (creator_key = ? OR mint IN (SELECT mint FROM token_recipients WHERE key_hex = ?))`).all(row.key_hex, row.key_hex)
  const out = []
  for (const m of mints) {
    const l = await memo(`tledger:${row.key_hex}:${m.quote_mint}`, 15_000, () => programs(conn, relayer?.publicKey ?? PublicKey.default).earn.account.tokenLedger.fetchNullable(tokenLedgerAddress(Buffer.from(row.key_hex, 'hex'), m.quote_mint))).catch(() => null)
    if (!l) continue
    const owed = BigInt(l.credited.toString()) - BigInt(l.paid.toString())
    if (owed <= 0n) continue
    const dec = m.quote_decimals ?? 6
    out.push({ mint: m.quote_mint, symbol: m.quote_symbol ?? '', decimals: dec, owedUnits: owed.toString(), owed: Number(owed) / 10 ** dec, owedUsd: Number(owed) / 10 ** dec * live.priceQ(m.quote_mint) })
  }
  return out
}
/** All pair-token fees ever harvested, in USD at today's prices. */
function pairClaimsUsd() {
  return db.prepare('SELECT quote_mint, amount FROM token_claims').all().reduce((s, r) => {
    const dec = db.prepare('SELECT quote_decimals d FROM tokens WHERE quote_mint = ? LIMIT 1').get(r.quote_mint)?.d ?? 6
    return s + Number(r.amount) / 10 ** dec * live.priceQ(r.quote_mint)
  }, 0)
}
function recipientsOf(mint) {
  return db.prepare('SELECT c.*, r.bps FROM token_recipients r JOIN creators c ON c.key_hex = r.key_hex WHERE r.mint = ? ORDER BY r.bps DESC, c.key_hex').all(mint)
    .map((c) => ({ creator: toSite(c), bps: c.bps }))
}
function platformFees(t, price) {
  const p = live.platform()
  const pending = p?.mint === t.mint ? p.pendingLamports : 0, collected = p?.mint === t.mint ? p.collectedLamports : 0
  const spent = db.prepare('SELECT COALESCE(SUM(lamports), 0) AS l FROM buybacks').get().l
  return { platform: true, feeRecipient: t.fee_recipient, feesUsd: lamportsToUsd(pending + collected, price), accruingUsd: lamportsToUsd(pending, price),
    pendingBuybackUsd: lamportsToUsd(Math.max(0, pending + collected - spent), price) }
}
function tokenView(t, price) {
  const c = creatorByKey(t.creator_key)
  const recipients = recipientsOf(t.mint)
  return {
    recipients: recipients.length ? recipients : [{ creator: toSite(c), bps: 10000 }],
    mint: t.mint, name: t.name, symbol: t.symbol, image: t.image ?? '', description: t.description ?? '',
    createdAt: t.created_at, graduated: !!t.graduated, marketCapUsd: t.market_cap_usd ?? 0,
    // Earned = claimed (per coin) + waiting right now on chain (live), so a trading coin never reads $0.00.
    feesUsd: lamportsToUsd(tokenFeesLamports(t) + live.waiting(t.mint), price),
    accruingUsd: lamportsToUsd(live.waiting(t.mint), price), launchTx: t.launch_sig ?? '', creator: recipients[0]?.creator ?? toSite(c),
    // $EARN: its fees go to the operator's wallet (pump.fun pays them directly) and fund buybacks: collected + pending.
    ...(t.platform ? platformFees(t, price) : {}),
    // custom pair: fees accrue in the pair token
    ...(t.quote_mint ? (() => { const f = pairFees(t); return { pair: { mint: f.mint, symbol: f.symbol, decimals: f.decimals, feesAmount: f.amount }, feesUsd: f.usd, accruingUsd: f.waitingUsd } })() : {}),
  }
}
const claimView = (r) => ({ signature: r.signature, time: r.time, grossUsd: lamportsToUsd(r.gross, r.sol_usd), recipientUsd: lamportsToUsd(r.to_recipient, r.sol_usd), treasuryUsd: lamportsToUsd(r.to_treasury, r.sol_usd), creator: toSite(creatorByKey(r.key_hex)) })
// The image of the newest token paying this creator: shown beside payouts, which are per account, not per token.
const tokenImageOf = (keyHex) => db.prepare(`SELECT t.image FROM tokens t WHERE (t.creator_key = ? OR EXISTS (SELECT 1 FROM token_recipients r WHERE r.mint = t.mint AND r.key_hex = ?)) AND t.image IS NOT NULL AND t.image != '' ORDER BY t.created_at DESC LIMIT 1`).get(keyHex, keyHex)?.image ?? ''
const payoutView = (r) => ({ signature: r.signature, time: r.time, usd: r.usdc_out != null ? r.usdc_out / 1e6 : lamportsToUsd(r.lamports, r.sol_usd), mode: r.mode, creator: toSite(creatorByKey(r.key_hex)), tokenImage: tokenImageOf(r.key_hex) })

async function creatorDetail(row, price, { earn }) {
  const tokens = db.prepare('SELECT t.* FROM tokens t WHERE t.creator_key = ? OR EXISTS (SELECT 1 FROM token_recipients r WHERE r.mint = t.mint AND r.key_hex = ?) ORDER BY t.created_at DESC').all(row.key_hex, row.key_hex)
  const onChain = await memo(`owed:${row.key_hex}`, 15_000, () => owedLamports(earn, row.key_hex))
  const pending = await memo(`pending:${row.fee_address}`, 30_000, () => pendingFor(conn, row.fee_address)).catch(() => ({ atFeeAddress: 0, inCurveVault: 0, inAmmVault: 0 }))
  const payouts = db.prepare('SELECT * FROM payouts WHERE key_hex = ? ORDER BY time DESC LIMIT 50').all(row.key_hex)
  return {
    creator: toSite(row),
    tokens: tokens.map((t) => tokenView(t, price)),
    owedUsd: lamportsToUsd(onChain.owed, price),
    settlingUsd: lamportsToUsd(pending.atFeeAddress, price),
    accruingUsd: lamportsToUsd(pending.inCurveVault + pending.inAmmVault, price),
    paidUsd: payouts.reduce((s, p) => s + payoutView(p).usd, 0),
    lastPaidAt: payouts[0]?.time ?? null,
    payouts: payouts.map(payoutView),
    claims: db.prepare('SELECT * FROM claims WHERE key_hex = ? ORDER BY time DESC LIMIT 50').all(row.key_hex).map(claimView),
    fomoWallet: row.provider === 'fomo' && row.wallet ? { address: row.wallet, status: row.wallet_confirmed ? 'confirmed' : 'pending' } : null,
    feeAddress: row.fee_address,
  }
}

function sinceFor(range) {
  return { '24h': now() - 86400, '7d': now() - 7 * 86400, '30d': now() - 30 * 86400 }[range] ?? 0
}

// ─── routes ───────────────────────────────────────────────────────────────────────────────────
/** $EARN's fees (the operator's wallet is its creator): pending = PENDING BUYBACKS, plus what was collected so far. */
function buybackView(price) {
  const p = live.platform()
  if (!p) return { buyback: null }
  const rows = db.prepare('SELECT * FROM buybacks ORDER BY time DESC').all()
  const burned = rows.reduce((n, r) => n + BigInt(r.tokens), 0n), spent = rows.reduce((n, r) => n + r.lamports, 0)
  // PENDING BUYBACKS = every $EARN creator fee earned (collected + still waiting) minus the SOL already spent buying back.
  const available = Math.max(0, p.pendingLamports + p.collectedLamports - spent)
  return { buyback: { mint: p.mint, wallet: p.wallet, pendingUsd: lamportsToUsd(available, price), pendingSol: available / 1e9,
    unclaimedSol: p.pendingLamports / 1e9,
    collectedUsd: lamportsToUsd(p.collectedLamports, price), totalUsd: lamportsToUsd(p.pendingLamports + p.collectedLamports, price),
    // done so far: SOL spent buying $EARN back, and $EARN burned (pump.fun supply: 1,000,000,000 at 6 decimals)
    count: rows.length, boughtBackSol: spent / 1e9, boughtBackUsd: rows.reduce((s, r) => s + lamportsToUsd(r.lamports, r.sol_usd), 0),
    burnedTokens: Number(burned) / 1e6, burnedPct: Number(burned) / 1e15 * 100,
    recent: rows.slice(0, 10).map((r) => ({ time: r.time, sol: r.lamports / 1e9, tokens: Number(r.tokens) / 1e6, buySig: r.buy_sig, burnSig: r.burn_sig })) } }
}
async function route(req, res, url) {
  const path = url.pathname
  const q = url.searchParams
  const price = await solUsd().catch(() => 0)
  const progs = programs(conn, relayer?.publicKey ?? PublicKey.default)
  if (/^\/api\/(stats|analytics|tokens|token\/|creator|creators|platform|search|home)/.test(path)) await live.ensure()

  if (path === '/api/health') return json(res, 200, { ok: true })

  // ── $EARN burn tracker ──
  if (path === '/api/burns') {
    const st = burnStats(db), b = buybackView(price).buyback
    return json(res, 200, { ...st, mint: b?.mint ?? platformState(db).mint, pendingSol: b?.pendingSol ?? 0, pendingUsd: b?.pendingUsd ?? 0 })
  }
  if (path === '/api/og/burn.png') {
    try {
      const file = burnCardPng(burnStats(db), { dataDir: DATA_DIR, logo: new URL('./assets/earn-token.png', import.meta.url).pathname })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' })
      return res.end(readFileSync(file))
    } catch (e) { console.error('burn card:', e.message); return json(res, 500, { error: 'card unavailable' }) }
  }
  // /burn itself (Caddy routes it here): the site's index.html with link-preview tags carrying the live numbers.
  if (path === '/burn' || path === '/burn/') {
    try {
      const html = burnPageHtml(readIndex(env.WEB_DIST ?? '/root/earn-web/dist'), burnStats(db), PUBLIC_URL)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      return res.end(html)
    } catch (e) { console.error('burn page:', e.message); res.writeHead(302, { location: '/' }); return res.end() }
  }

  if (path === '/api/stats') {
    const c = db.prepare('SELECT COALESCE(SUM(gross),0) g, COALESCE(SUM(to_treasury),0) t, COALESCE(SUM(to_recipient),0) r FROM claims').get()
    const paid = db.prepare('SELECT * FROM payouts').all().reduce((s, p) => s + payoutView(p).usd, 0)
    const cfg = await memo('config', 60_000, () => progs.earn.account.config.fetchNullable(configAddress())).catch(() => null)
    const owedLam = Number(c.r) - db.prepare('SELECT COALESCE(SUM(lamports),0) l FROM payouts').get().l
    return json(res, 200, {
      feesAllTimeUsd: lamportsToUsd(c.g + live.waitingTotal(), price) + pairClaimsUsd() + live.waitingQUsd(), claimedAllTimeUsd: lamportsToUsd(c.g, price) + pairClaimsUsd(), accruingUsd: lamportsToUsd(live.waitingTotal(), price) + live.waitingQUsd(),
      ...buybackView(price), paidAllTimeUsd: paid, owedUsd: lamportsToUsd(Math.max(0, owedLam), price),
      readyToSendUsd: lamportsToUsd(Math.max(0, owedLam), price), protocolAllTimeUsd: lamportsToUsd(c.t, price),
      recipientsPaid: db.prepare('SELECT count(DISTINCT key_hex) n FROM payouts').get().n,
      launches: db.prepare('SELECT count(*) n FROM tokens').get().n,
      programId: EARN.toBase58(), treasury: cfg?.treasury?.toBase58() ?? '', recipientBps: cfg?.recipientBps ?? 10000,
    })
  }

  if (path === '/api/tokens') {
    const sort = { fees: 'fees DESC', mcap: 'market_cap_usd DESC', recent: 'created_at DESC' }[q.get('sort')] ?? 'fees DESC'
    const provider = q.get('provider')
    const limit = int(q, 'limit', 30, 100), offset = int(q, 'offset', 0, 1e6)
    // A platform filter matches a token paying ANY account on that platform.
    const conds = [], args = []
    if (provider && provider !== 'all') {
      conds.push(`(EXISTS (SELECT 1 FROM token_recipients r JOIN creators c ON c.key_hex = r.key_hex WHERE r.mint = t.mint AND (c.provider = ? OR c.provider LIKE ?))
         OR (t.split_key IS NULL AND (c0.provider = ? OR c0.provider LIKE ?)))`)
      args.push(provider, `${provider}:%`, provider, `${provider}:%`)
    }
    // Graduated EARN tokens, $EARN included: it is shown everywhere an EARN launch is.
    if (q.get('graduated') === '1') conds.push('t.graduated = 1')
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT count(*) n FROM tokens t JOIN creators c0 ON c0.key_hex = t.creator_key ${where}`).get(...args).n
    if (sort === 'fees DESC') {
      // By fees EARNED (claimed per coin + accruing on chain now), the figure every card shows: computed per token, so
      // sorted here rather than in SQL. $EARN stays first.
      const all = db.prepare(`SELECT t.* FROM tokens t JOIN creators c0 ON c0.key_hex = t.creator_key ${where}`).all(...args)
        .map((t) => ({ t, f: t.platform ? Infinity : t.quote_mint ? (pairFees(t)?.usd ?? 0) : lamportsToUsd(tokenFeesLamports(t) + live.waiting(t.mint), price) }))
        .sort((a, b) => b.f - a.f || b.t.created_at - a.t.created_at)
      return json(res, 200, { items: all.slice(offset, offset + limit).map(({ t }) => tokenView(t, price)), total })
    }
    const rows = db.prepare(`
      SELECT t.* FROM tokens t JOIN creators c0 ON c0.key_hex = t.creator_key ${where} ORDER BY t.platform DESC, ${sort} LIMIT ? OFFSET ?`).all(...args, limit, offset)
    return json(res, 200, { items: rows.map((t) => tokenView(t, price)), total })
  }

  let m
  if ((m = path.match(/^\/api\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) {
    const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(m[1])
    if (!t) return json(res, 404, { error: 'Not an EARN token' })
    if (now() - (t.market_at ?? 0) > 60) { await refreshMarket(db, conn, t.mint, price); Object.assign(t, db.prepare('SELECT * FROM tokens WHERE mint = ?').get(t.mint)) }
    const row = creatorByKey(t.creator_key)
    let d
    if (t.platform) d = { owedUsd: null, paidUsd: null, accruingUsd: 0, claims: [], payouts: [] }
    else if (t.split_key) {
      // A split token: its claims are the rows attributed to its split (one per recipient per harvest);
      // owed/received are per account, not per token, so they live on each recipient's page.
      const splitFee = feeAddressOf(Buffer.from(t.split_key, 'hex')).toBase58()
      const pending = await memo(`pending:${splitFee}`, 30_000, () => pendingFor(conn, splitFee)).catch(() => ({ atFeeAddress: 0, inCurveVault: 0, inAmmVault: 0 }))
      d = { owedUsd: null, paidUsd: null, accruingUsd: lamportsToUsd(pending.atFeeAddress + pending.inCurveVault + pending.inAmmVault, price),
        claims: db.prepare('SELECT * FROM claims WHERE source_key_hex = ? ORDER BY time DESC, gross DESC LIMIT 60').all(t.split_key).map(claimView), payouts: [] }
    } else d = await creatorDetail(row, price, progs)
    return json(res, 200, {
      ...tokenView(t, price), priceUsd: t.price_usd ?? 0, change24h: t.change_24h ?? 0, volume24hUsd: t.volume_24h_usd ?? 0,
      holders: t.holders ?? 0, trades24h: t.trades_24h ?? 0, curveProgress: t.curve_progress ?? 0,
      owedUsd: d.owedUsd, receivedUsd: d.paidUsd, accruingUsd: d.accruingUsd, claims: d.claims, payouts: d.payouts,
    })
  }

  if ((m = path.match(/^\/api\/creator\/(x|twitch|github|spotify|fomo)\/([^/]+)$/))) {
    const handle = decodeURIComponent(m[2])
    let row
    if (m[1] === 'spotify') { const id = fromSite('spotify', handle); row = id && db.prepare('SELECT * FROM creators WHERE provider = ? AND id = ?').get(id.provider, id.id) }
    else row = db.prepare('SELECT * FROM creators WHERE provider = ? AND lower(handle) = lower(?)').get(m[1], handle.replace(/^@/, ''))
    if (!row && providers.has(m[1]) && m[1] !== 'spotify') {
      // A miss costs a paid lookup (X): rate limited, negative-cached for an hour, daily budget.
      const negKey = `nolookup:${m[1]}:${handle.toLowerCase()}`
      if (Number(kvGet(db, negKey) ?? 0) > now() - 3600) return json(res, 404, { error: 'Unknown account' })
      if (limited(req, 'lookup', 300) || overLookupBudget() || (m[1] === 'fomo' && overFomoBudget())) return json(res, 429, { error: 'Too many lookups' })
      const found = await providers.get(m[1]).lookup(handle).catch(() => null)
      const one = Array.isArray(found) ? found[0] : found
      if (one) row = remember({ ...one, provider: one.provider ?? m[1] })
      else kvSet(db, negKey, now())
    }
    if (!row) return json(res, 404, { error: 'Unknown account' })
    return json(res, 200, await creatorDetail(row, price, progs))
  }

  if (path === '/api/payments') {
    const min = int(q, 'minUsd', 0, 1e9), limit = int(q, 'limit', 30, 100), offset = int(q, 'offset', 0, 1e6)
    const all = db.prepare('SELECT * FROM payouts ORDER BY time DESC').all().map(payoutView).filter((p) => p.usd >= min)
    return json(res, 200, { items: all.slice(offset, offset + limit), total: all.length })
  }
  if (path === '/api/claims') {
    const limit = int(q, 'limit', 30, 100)
    const items = db.prepare('SELECT * FROM claims ORDER BY time DESC LIMIT ?').all(limit).map(claimView)
    return json(res, 200, { items, total: db.prepare('SELECT count(*) n FROM claims').get().n })
  }
  if (path === '/api/creators/top') {
    const rows = db.prepare(`
      SELECT c.*, (SELECT count(*) FROM tokens WHERE creator_key = c.key_hex) tokens,
             (SELECT COALESCE(SUM(gross),0) FROM claims WHERE key_hex = c.key_hex) fees
      FROM creators c WHERE EXISTS (SELECT 1 FROM tokens WHERE creator_key = c.key_hex) ORDER BY fees DESC LIMIT 20`).all()
    // fees earned = claimed + what their coins have accruing on chain now (same as the token cards)
    const accruing = (key) => db.prepare('SELECT mint FROM tokens WHERE creator_key = ? AND split_key IS NULL AND platform = 0').all(key).reduce((n, t) => n + live.waiting(t.mint), 0)
    for (const r of rows) r.fees += accruing(r.key_hex)
    rows.sort((a, b) => b.fees - a.fees)
    return json(res, 200, { items: rows.map((r) => ({
      creator: toSite(r), tokens: r.tokens, feesUsd: lamportsToUsd(r.fees, price), tokenImage: tokenImageOf(r.key_hex),
      paidUsd: db.prepare('SELECT * FROM payouts WHERE key_hex = ?').all(r.key_hex).reduce((s, p) => s + payoutView(p).usd, 0),
    })) })
  }
  if (path === '/api/analytics') {
    const since = sinceFor(q.get('range'))
    const claims = db.prepare('SELECT * FROM claims WHERE time >= ?').all(since)
    const payouts = db.prepare('SELECT * FROM payouts WHERE time >= ?').all(since)
    const days = new Map()
    for (const c of claims) { const d = new Date(c.time * 1000).toISOString().slice(0, 10); const e = days.get(d) ?? { day: d, feesUsd: 0, launches: 0 }; e.feesUsd += lamportsToUsd(c.gross, c.sol_usd); days.set(d, e) }
    for (const t of db.prepare('SELECT created_at FROM tokens WHERE created_at >= ?').all(since)) { const d = new Date(t.created_at * 1000).toISOString().slice(0, 10); const e = days.get(d) ?? { day: d, feesUsd: 0, launches: 0 }; e.launches++; days.set(d, e) }
    { // earned-but-unclaimed fees are today's: the chart then adds up to the headline
      const today = new Date().toISOString().slice(0, 10), e = days.get(today) ?? { day: today, feesUsd: 0, launches: 0 }
      e.feesUsd += lamportsToUsd(live.waitingTotal(), price); days.set(today, e)
    }
    const credited = claims.reduce((s, c) => s + c.to_recipient, 0), paidLam = payouts.reduce((s, p) => s + p.lamports, 0)
    return json(res, 200, {
      // claimed in the range, plus what is earned and waiting right now (unclaimed fees belong to "now")
      feesUsd: claims.reduce((s, c) => s + lamportsToUsd(c.gross, c.sol_usd), 0) + lamportsToUsd(live.waitingTotal(), price) + pairClaimsUsd() + live.waitingQUsd(),
      claimedUsd: claims.reduce((s, c) => s + lamportsToUsd(c.gross, c.sol_usd), 0) + pairClaimsUsd(),
      accruingUsd: lamportsToUsd(live.waitingTotal(), price) + live.waitingQUsd(),
      ...buybackView(price),
      protocolUsd: claims.reduce((s, c) => s + lamportsToUsd(c.to_treasury, c.sol_usd), 0),
      paidUsd: payouts.reduce((s, p) => s + payoutView(p).usd, 0),
      owedUsd: lamportsToUsd(Math.max(0, credited - paidLam), price),
      daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    })
  }
  if (path === '/api/search') {
    const s = `%${String(q.get('q') ?? '').trim()}%`
    if (s.length < 3) return json(res, 200, { tokens: [], creators: [] })
    const tokens = db.prepare('SELECT * FROM tokens WHERE name LIKE ? OR symbol LIKE ? OR mint = ? LIMIT 8').all(s, s, q.get('q')).map((t) => tokenView(t, price))
    const creators = db.prepare('SELECT * FROM creators WHERE handle LIKE ? OR name LIKE ? LIMIT 8').all(s, s).map(toSite)
    return json(res, 200, { tokens, creators })
  }

  if (path === '/api/platform') {
    const p = platformState(db)
    const t = p.mint ? db.prepare('SELECT * FROM tokens WHERE mint = ?').get(p.mint) : null
    return json(res, 200, { launchesOpen: p.launchesOpen, token: t ? tokenView(t, price) : null })
  }
  if (path === '/api/admin/platform' && req.method === 'POST') {
    const auth = String(req.headers.authorization ?? '')
    const given = Buffer.from(auth.replace(/^Bearer /, '')), want = Buffer.from(ADMIN_TOKEN)
    // Unknown to anyone without the token: answer exactly like a missing route.
    if (!ADMIN_TOKEN || given.length !== want.length || !timingSafeEqual(given, want)) return json(res, 404, { error: 'Not found' })
    const body = await readJson(req)
    if (body.clear) { clearPlatformToken(db); return json(res, 200, { ok: true, launchesOpen: false }) }
    if (body.launching === 'close' || body.launching === 'open') {
      if (body.launching === 'close') kvSet(db, 'launches_closed', '1'); else db.prepare("DELETE FROM kv WHERE k = 'launches_closed'").run()
      return json(res, 200, { ok: true, launchesOpen: platformState(db).launchesOpen })
    }
    try {
      const mint = String(body.mint ?? '').trim()
      const { coin, creator } = await verifyPlatformToken({ conn, mint, founder: FOUNDER, suffix: env.PLATFORM_SUFFIX ?? "" })
      if (body.dry) return json(res, 200, { ok: true, dry: true, name: coin.name, symbol: coin.symbol, creator })
      // The platform X account as stored (resolved ahead of go-live); a live lookup only if it is missing, capped at 5 s.
      let display = EARN_ACCOUNT
      const stored = db.prepare("SELECT * FROM creators WHERE provider = 'x' AND (id = ? OR lower(handle) = lower(?))").get(EARN_ACCOUNT.id, EARN_ACCOUNT.handle)
      const x = providers.get('x')
      if (stored?.avatar) display = { ...EARN_ACCOUNT, id: stored.id, handle: stored.handle ?? EARN_ACCOUNT.handle, name: stored.name ?? EARN_ACCOUNT.name, avatar: stored.avatar, verified: !!stored.verified }
      else if (x && !x.isStub && EARN_ACCOUNT.handle) {
        const found = await Promise.race([x.lookup(EARN_ACCOUNT.handle), new Promise((r) => setTimeout(() => r(null), 5000))]).catch(() => null)
        if (found?.id) display = { ...found, provider: 'x' }
      }
      // Our own copy of the coin's image: pump.fun's ipfs.io links do not serve outside a browser.
      const cached = await cacheImage({ logoDir: LOGO_DIR, publicUrl: PUBLIC_URL }, coin.image_uri, { log: console })
      setPlatformToken(db, { mint, coin: { ...coin, image_uri: cached ?? coin.image_uri ?? '' }, creator, displayIdentity: display })
      await refreshMarket(db, conn, mint, price)
      return json(res, 200, { ok: true, launchesOpen: true, mint, name: coin.name, symbol: coin.symbol })
    } catch (e) {
      if (e instanceof PlatformError) return json(res, e.status, { error: e.message })
      throw e
    }
  }

  if (path === '/api/admin/buyback' && req.method === 'POST') {
    const auth = String(req.headers.authorization ?? '')
    const given = Buffer.from(auth.replace(/^Bearer /, '')), want = Buffer.from(ADMIN_TOKEN)
    if (!ADMIN_TOKEN || given.length !== want.length || !timingSafeEqual(given, want)) return json(res, 404, { error: 'Not found' })
    const body = await readJson(req)
    const sigOk = (x) => /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(String(x))
    if (!sigOk(body.buySig) || !sigOk(body.burnSig)) return json(res, 400, { error: 'buySig and burnSig are required' })
    const p = live.platform()
    const mint = p?.mint ?? platformState(db).mint
    if (!mint) return json(res, 409, { error: 'No $EARN set' })
    const read = async (sig) => {
      for (let i = 0; i < 10; i++) {
        const r = (await conn._rpcRequest('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null))?.result
        if (r) return r
        await new Promise((ok) => setTimeout(ok, 1000))
      }
      return null
    }
    const [buy, burnTx] = await Promise.all([read(body.buySig), read(body.burnSig)])
    if (!buy || !burnTx) return json(res, 409, { error: 'Transaction not found yet' })
    if (buy.meta?.err || burnTx.meta?.err) return json(res, 400, { error: 'A transaction failed on chain' })
    const ixs = [...burnTx.transaction.message.instructions, ...(burnTx.meta.innerInstructions ?? []).flatMap((x) => x.instructions)]
    const b = ixs.find((ix) => ix.parsed && /^burn/.test(ix.parsed.type) && ix.parsed.info?.mint === mint)
    if (!b) return json(res, 400, { error: 'No $EARN burn in that transaction' })
    const wallet = b.parsed.info.authority ?? b.parsed.info.multisigAuthority
    const burned = BigInt(b.parsed.info.tokenAmount?.amount ?? b.parsed.info.amount)
    const signer = (tx) => tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey)
    if (!signer(buy).includes(wallet) || !signer(burnTx).includes(wallet)) return json(res, 400, { error: 'The buy and the burn are not from the same wallet' })
    const gain = (list) => (list ?? []).filter((x) => x.owner === wallet && x.mint === mint).reduce((n, x) => n + BigInt(x.uiTokenAmount.amount), 0n)
    if (gain(buy.meta.postTokenBalances) - gain(buy.meta.preTokenBalances) <= 0n) return json(res, 400, { error: 'That buy received no $EARN' })
    const wi = buy.transaction.message.accountKeys.findIndex((k) => k.pubkey === wallet)
    const spent = /^\d+$/.test(String(body.lamports ?? '')) ? Number(body.lamports) : Math.max(0, buy.meta.preBalances[wi] - buy.meta.postBalances[wi] - buy.meta.fee)
    db.prepare('INSERT OR REPLACE INTO buybacks (buy_sig, burn_sig, wallet, lamports, tokens, time, sol_usd) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(body.buySig, body.burnSig, wallet, spent, burned.toString(), burnTx.blockTime ?? now(), price)
    return json(res, 200, { ok: true, wallet, lamports: spent, tokens: burned.toString() })
  }
  if ((m = path.match(/^\/api\/lookup\/(x|twitch|github|spotify|fomo)$/))) {
    if (limited(req, 'lookup', 300) || overLookupBudget()) return json(res, 429, { error: 'Too many lookups' })
    const p = providers.get(m[1])
    if (!p) return json(res, 503, { error: `${m[1]} lookups are not set up yet` })
    // People paste "@name" or a profile link: reduce it to the handle (same rule as the site's cleanHandle).
    let term = String(q.get('q') ?? '').trim()
    const host = { x: /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i, twitch: /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})/i, github: /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})/i }[m[1]]
    const hm = host?.exec(term)
    if (hm) term = hm[1]
    else if (host) term = term.replace(/^@+/, '')
    if (term.length < 2) return json(res, 200, { items: [] })
    // Exact-handle providers: answer from a recent row, or a recent miss, before spending a call.
    if (m[1] !== 'spotify') {
      const hit = cachedCreator(m[1], term)
      if (hit) return json(res, 200, { items: [toSite(hit)] })
      if (Number(kvGet(db, `nolookup:${m[1]}:${term.toLowerCase()}`) ?? 0) > now() - 3600) return json(res, 200, { items: [] })
    }
    if (m[1] === 'fomo' && overFomoBudget()) return json(res, 429, { error: 'FOMO lookups are used up for this month' })
    try {
      const found = await p.lookup(term)
      if (m[1] !== 'spotify' && (!found || (Array.isArray(found) && !found.length))) kvSet(db, `nolookup:${m[1]}:${term.toLowerCase()}`, now())
      const list = (Array.isArray(found) ? found : found ? [found] : []).map((i) => ({ ...i, provider: i.provider ?? m[1] }))
      // Looking an account up registers its fee address — Cashed's "unknown account" rule.
      return json(res, 200, { items: list.map((i) => toSite(remember(i))) })
    } catch (e) { return json(res, 502, { error: e.message }) }
  }

  if (path === '/api/upload' && req.method === 'POST') {
    if (limited(req, 'upload', 30)) return json(res, 429, { error: 'Too many uploads' })
    const form = await new Request('http://x', { method: 'POST', headers: req.headers, body: await readBody(req, 4.5 * 1024 * 1024), duplex: 'half' }).formData()
    const file = form.get('image')
    if (!file || typeof file === 'string') throw new LaunchError('No image')
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.length > 4 * 1024 * 1024) throw new LaunchError('Up to 4 MB')
    const type = imageType(bytes)
    if (!type) throw new LaunchError('PNG, JPG, GIF or WebP')
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}${{ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[type]}`
    writeFileSync(join(LOGO_DIR, name), bytes)
    return json(res, 200, { imageUrl: `${PUBLIC_URL}/api/logos/${name}` })
  }
  if (path.startsWith("/api/logos/")) {
    const name = path.slice(11)
    if (!/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(name) || !existsSync(join(LOGO_DIR, name))) return json(res, 404, { error: 'Not found' })
    // Shown as a 512×512 square (images.mjs squareLogo); the original only when that cannot be made.
    const sq = squareLogo(LOGO_DIR, name)
    res.writeHead(200, { 'content-type': sq ? 'image/webp' : { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[extname(name)], 'cache-control': 'public, max-age=31536000, immutable' })
    return res.end(readFileSync(sq ?? join(LOGO_DIR, name)))
  }

  // ── custom pairs ──
  if (path === '/api/pairs') {
    if (!pairsEnabled()) return json(res, 200, { enabled: false, items: [] })
    return json(res, 200, { enabled: true, items: await memo('pairlist', 600_000, () => pairList(conn)) })
  }
  if (path === '/api/pair') {
    if (!pairsEnabled()) return json(res, 200, { ok: false, reason: 'Custom pairs are not open yet' })
    const r = await memo(`pair:${q.get('mint')}`, 60_000, () => resolvePair(conn, String(q.get('mint') ?? ''))).catch((e) => ({ ok: false, reason: e.message }))
    return json(res, 200, r.ok ? { ok: true, mint: r.mint, symbol: r.symbol, name: r.name, image: r.image, kind: r.kind, decimals: r.decimals, priceUsd: r.priceUsd } : { ok: false, reason: r.reason })
  }
  if (path === '/api/ticker') {
    const taken = tickerTaken(db, q.get('symbol'))
    return json(res, 200, taken ? { taken: true, feeSol: Number(TICKER_FEE_LAMPORTS) / 1e9, ...taken } : { taken: false, feeSol: 0 })
  }
  if (path === '/api/launch/prepare' && req.method === 'POST') {
    // ⛔ The gate is enforced HERE, not only by the site's popup.
    if (!platformState(db).launchesOpen) return json(res, 403, { error: 'Launching is currently disabled.' })
    if (limited(req, 'launch', 20)) return json(res, 429, { error: 'Too many launches' })
    const body = await readJson(req)
    const form = validateLaunch(body)
    // Recipients: `recipients: [{provider, id, bps}]` (1 to 8, shares totalling 100%), or the older single `creator`.
    const wanted = Array.isArray(body.recipients) && body.recipients.length ? body.recipients : [{ ...(body.creator ?? {}), bps: 10000 }]
    if (wanted.length > 8) throw new LaunchError('At most 8 accounts can share the fees')
    // Spotify sign-in is refused by Spotify (403) right now: nobody could ever claim, so no new launch may name it.
    if (env.SPOTIFY_LAUNCH !== '1' && wanted.some((w) => String(w?.provider ?? '').startsWith('spotify'))) throw new LaunchError('Spotify accounts cannot be named right now')
    const rows = []
    for (const w of wanted) {
      const who = fromSite(w?.provider, w?.id)
      if (!who) throw new LaunchError('Pick who the fees go to')
      const r = db.prepare('SELECT * FROM creators WHERE provider = ? AND id = ?').get(who.provider, who.id)
      if (!r) throw new LaunchError('Look the account up first')
      if (db.prepare('SELECT 1 FROM optout WHERE key_hex = ?').get(r.key_hex)) throw new LaunchError(`${r.handle ?? r.id} asked not to be named`)
      const bps = Number(w.bps)
      if (!Number.isInteger(bps) || bps <= 0 || bps > 10000 || bps % 100 !== 0) throw new LaunchError('Each share is a whole percentage above zero')
      if (rows.some((x) => x.key_hex === r.key_hex)) throw new LaunchError('The same account is listed twice')
      rows.push({ ...r, bps })
    }
    if (rows.reduce((s, r) => s + r.bps, 0) !== 10000) throw new LaunchError(`The shares must add up to 100% (now ${rows.reduce((s, r) => s + r.bps, 0) / 100}%)`)
    rows.sort((a, b) => b.bps - a.bps)
    const row = rows[0] // the largest share is the token's headline creator
    let split = null
    if (rows.length > 1) {
      const c = canonicalSplit(rows.map((r) => ({ key: Buffer.from(r.key_hex, 'hex'), bps: r.bps })))
      split = { splitKeyHex: c.splitKey.toString('hex'), recipients: c.recipients.map((cr) => { const r = rows.find((x) => x.key_hex === cr.key.toString('hex')); return { identity: { provider: r.provider, id: r.id, handle: r.handle }, keyHex: r.key_hex, bps: cr.bps } }) }
    }
    const name = String(form.imageUrl).split("/api/logos/")[1]
    if (!name || !/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(name) || !existsSync(join(LOGO_DIR, name))) throw new LaunchError('Upload an image first')
    const identity = { provider: row.provider, id: row.id, handle: row.handle }
    const description = composeDescription(form.description, identity, split)
    const creatorPage = `${PUBLIC_URL}/${pageProvider(row.provider)}/${encodeURIComponent(row.provider.startsWith('spotify') ? toSite(row).id : row.handle)}`
    const meta = DEV ? { metadataUri: `${PUBLIC_URL}/api/logos/${name}` } : await uploadMetadata({
      image: readFileSync(join(LOGO_DIR, name)), imageType: { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[name.split('.')[1]],
      name: form.name, symbol: form.symbol, description, website: form.website || creatorPage, twitter: form.twitter, telegram: form.telegram,
    })
    global ??= await loadGlobal(conn)
    // Custom pair (optional): resolved against pump.fun's rules, with its lookup table so the launch fits one transaction.
    let pair = null, luts = lookupTables
    if (body.pair) {
      if (!pairsEnabled()) throw new LaunchError('Custom pairs are not open yet')
      const r = await resolvePair(conn, String(body.pair))
      if (!r.ok) throw new LaunchError(r.reason ?? 'That token cannot be a pair')
      if (!keeper) throw new LaunchError('Custom pairs are not set up yet', 503)
      pair = r
      luts = [...lookupTables, await ensurePairLut(conn, db, keeper, r)]
    }
    const taken = tickerTaken(db, form.symbol)
    const tickerFee = taken ? { to: TICKER_FEE_WALLET, lamports: TICKER_FEE_LAMPORTS } : null
    const out = await buildLaunch({ db, conn, program: pump, global, creator: identity, split, form: { ...form, description }, metadataUri: meta.metadataUri, lookupTables: luts, tickerFee, pair })
    return json(res, 200, { mint: out.mint, transaction: out.transaction, tickerFee: taken ? { sol: Number(TICKER_FEE_LAMPORTS) / 1e9, to: TICKER_FEE_WALLET.toBase58(), ...taken } : null })
  }
  if (path === '/api/launch/confirm' && req.method === 'POST') {
    if (limited(req, 'confirm', 60)) return json(res, 429, { error: 'Too many requests' })
    const { mint, signature } = await readJson(req)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(mint))) throw new LaunchError('Not a mint address')
    if (signature != null && !/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(String(signature))) throw new LaunchError('Not a transaction signature')
    for (let i = 0; i < 10; i++) {
      try { return json(res, 200, await confirmLaunch({ db, conn, mint, signature })) }
      catch (e) { if (e.status !== 409 || i === 9) throw e; await new Promise((r) => setTimeout(r, 1500)) }
    }
  }

  // ── sign-in ──
  if ((m = path.match(/^\/api\/auth\/(x|twitch|github|spotify)\/start$/))) {
    const p = providers.get(m[1])
    if (!p) return json(res, 503, { error: `${m[1]} sign-in is not set up yet` })
    const redirect = `${OAUTH_CALLBACK_BASE}/api/auth/${m[1]}/callback`
    const { url: to, state, verifier } = p.begin(redirect, DEV ? q.get('as') : undefined)
    const ret = q.get('return') ?? '/claim'
    pendingAuth.set(state, { provider: m[1], verifier, returnTo: safeReturnPath(ret), at: Date.now() })
    for (const [k, v] of pendingAuth) if (Date.now() - v.at > 600_000) pendingAuth.delete(k)
    setCookie(res, 'earn_auth', state, 600) // the callback must come back in the browser that started
    res.writeHead(302, { location: to }); return res.end()
  }
  if ((m = path.match(/^\/api\/auth\/(x|twitch|github|spotify)\/callback$/))) {
    const state = q.get('state'), code = q.get('code')
    const p = pendingAuth.get(state)
    // The state is consumed only by the browser that started the flow; a replay elsewhere is refused
    // and leaves the real sign-in able to complete.
    if (!p || p.provider !== m[1] || !code || cookie(req, 'earn_auth') !== state) { res.writeHead(302, { location: '/claim?error=signin' }); return res.end() }
    pendingAuth.delete(state)
    try {
      const identity = await providers.get(m[1]).complete(code, p.verifier, `${OAUTH_CALLBACK_BASE}/api/auth/${m[1]}/callback`)
      const row = remember({ ...identity, provider: identity.provider ?? m[1] })
      const sid = ensureSession(req, res)
      db.prepare('INSERT OR REPLACE INTO session_accounts (session_id, provider, id) VALUES (?, ?, ?)').run(sid, row.provider, row.id)
      res.writeHead(302, { location: p.returnTo }); return res.end()
    } catch (e) {
      res.writeHead(302, { location: `/claim?error=${encodeURIComponent(e.message.slice(0, 120))}` }); return res.end()
    }
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    const id = cookie(req, 'earn_sid')
    if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    setCookie(res, 'earn_sid', '', 0)
    return json(res, 200, { ok: true })
  }
  if (path === '/api/me') {
    const s = session(req)
    if (!s || !s.accounts.length) return json(res, 401, { error: 'Not signed in' })
    const accounts = []
    for (const row of s.accounts) {
      const o = await memo(`owed:${row.key_hex}`, 15_000, () => owedLamports(progs.earn, row.key_hex))
      accounts.push({ creator: toSite(row), owedUsd: lamportsToUsd(o.owed, price), owedLamports: Number(o.owed), tokens: await tokensOwed(row) })
    }
    return json(res, 200, { accounts })
  }

  if (path === '/api/withdraw' && req.method === 'POST') {
    if (limited(req, 'withdraw', 20)) return json(res, 429, { error: 'Too many withdrawals' })
    if (!signer || !relayer) return json(res, 503, { error: 'Withdrawals are not set up yet' })
    const s = session(req)
    const body = await readJson(req)
    const row = s?.accounts.find((a) => pageProvider(a.provider) === body.provider && CLAIMABLE.has(a.provider))
    if (!row) return json(res, 401, { error: 'Sign in with the account the token named' })
    let destination
    try { destination = new PublicKey(String(body.destination)) } catch { throw new LaunchError('Not a Solana address') }
    if (!PublicKey.isOnCurve(destination.toBytes()) || destination.equals(EARN)) throw new LaunchError('Send to a wallet address, not a program account')
    if (await isProgramOwnedWallet(destination)) throw new LaunchError('Send to a wallet address, not a program or token account')
    if (body.mode === 'token') {
      // Custom pairs: pay a pair token out of EARN's vault. Same sign-in, cooldown and on-chain owed check as SOL.
      if (!pairsEnabled()) throw new LaunchError('Token withdrawals are not open yet')
      const t = db.prepare('SELECT quote_mint, quote_program, quote_decimals FROM tokens WHERE quote_mint = ? LIMIT 1').get(String(body.mint ?? ''))
      if (!t) throw new LaunchError('Not a pair token')
      const Q = new PublicKey(t.quote_mint), prog = new PublicKey(t.quote_program), key = Buffer.from(row.key_hex, 'hex')
      const ledger = await progs.earn.account.tokenLedger.fetchNullable(tokenLedgerAddress(key, Q))
      const owedQ = ledger ? BigInt(ledger.credited.toString()) - BigInt(ledger.paid.toString()) : 0n
      let amount
      try { amount = body.amount === 'all' || body.amount == null ? owedQ : BigInt(body.amount) } catch { throw new LaunchError('Not an amount') }
      if (amount <= 0n || amount > owedQ) throw new LaunchError('Nothing to withdraw')
      const usd = Number(amount) / 10 ** (t.quote_decimals ?? 6) * (await quotePriceUsd(t.quote_mint))
      if (usd < Number(env.MIN_TOKEN_WITHDRAW_USD ?? 1)) throw new LaunchError('The minimum withdrawal is $1 worth')
      const lastKey = `withdraw:${row.key_hex}`
      if (now() - Number(kvGet(db, lastKey) ?? 0) < WITHDRAW_COOLDOWN_S) throw new LaunchError('One withdrawal every 10 minutes. Try again shortly.')
      const { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } = await import('@solana/spl-token')
      const destAta = getAssociatedTokenAddressSync(Q, destination, false, prog)
      const vault = getAssociatedTokenAddressSync(Q, vaultAuthority(), true, prog)
      const ixs = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, destAta, destination, Q, prog),
        await progs.earn.methods.withdrawToken([...key], new BN(amount.toString()))
          .accountsPartial({ config: configAddress(), ledger: tokenLedgerAddress(key, Q), mint: Q, vault, destination: destAta, signer: signer.publicKey, relayer: relayer.publicKey, tokenProgram: prog }).instruction(),
      ]
      try {
        const signature = await sendAndRecord({ conn, db, payer: relayer, extraSigners: [signer], ixs, solUsd: price })
        kvSet(db, lastKey, now())
        db.prepare('INSERT OR IGNORE INTO token_payouts (signature, key_hex, quote_mint, amount, destination, time) VALUES (?, ?, ?, ?, ?, ?)').run(signature, row.key_hex, t.quote_mint, amount.toString(), destination.toBase58(), now())
        return json(res, 200, { signature })
      } catch (e) {
        if (e.signature && e.landed) { kvSet(db, lastKey, now()); return json(res, 200, { signature: e.signature, recorded: false }) }
        if (/transaction failed/.test(e.message)) throw new LaunchError('The withdrawal was refused on chain. Nothing was sent.', 409)
        throw e
      }
    }
    const { owed } = await owedLamports(progs.earn, row.key_hex)
    let lamports
    try { lamports = body.lamports === 'all' ? owed : BigInt(body.lamports) } catch { throw new LaunchError('Not an amount') }
    if (lamports <= 0n || lamports > owed) throw new LaunchError('Nothing to withdraw')
    // The relayer pays the network fee and the USDC account rent, so a payout must be worth more than
    // it costs to send: dust withdrawals to fresh wallets would drain the relayer. One every 10 minutes.
    if (lamports < MIN_WITHDRAW_LAMPORTS) throw new LaunchError(`The minimum withdrawal is ${Number(MIN_WITHDRAW_LAMPORTS) / 1e9} SOL`)
    const lastKey = `withdraw:${row.key_hex}`
    if (now() - Number(kvGet(db, lastKey) ?? 0) < WITHDRAW_COOLDOWN_S) throw new LaunchError('One withdrawal every 10 minutes. Try again shortly.')
    const built = body.mode === 'sol'
      ? await buildSolWithdraw({ earn: progs.earn, keyHex: row.key_hex, lamports, destination, signer: signer.publicKey, relayer: relayer.publicKey })
      : await buildUsdcWithdraw({ conn, earn: progs.earn, keyHex: row.key_hex, lamports, owner: destination, signer: signer.publicKey, relayer: relayer.publicKey })
    try {
      const signature = await sendAndRecord({ conn, db, payer: relayer, extraSigners: [signer], ixs: built.ixs, lookupTables: built.lookupTables, solUsd: price })
      kvSet(db, lastKey, now()) // the cooldown starts only once a payout actually went out
      return json(res, 200, { signature })
    } catch (e) {
      // Landed but not yet readable: the money moved, so say so; reconciliation records it later.
      if (e.signature && e.landed) { kvSet(db, lastKey, now()); return json(res, 200, { signature: e.signature, recorded: false }) }
      if (/transaction failed/.test(e.message)) throw new LaunchError('The withdrawal was refused on chain. Nothing was sent.', 409)
      throw e
    }
  }

  if (path === '/api/optout' && req.method === 'POST') {
    const s = session(req)
    const body = await readJson(req)
    // {provider, id} names one account; a bare provider (older site builds) still matches the first one.
    const row = s?.accounts.find((a) => pageProvider(a.provider) === body.provider && (body.id == null || String(a.id) === String(body.id) || toSite(a).id === String(body.id)))
    if (!row) return json(res, 401, { error: 'Sign in with the account this concerns' })
    db.prepare('INSERT OR IGNORE INTO optout (key_hex, requested_at, note) VALUES (?, ?, ?)').run(row.key_hex, now(), 'self-service')
    return json(res, 200, { ok: true })
  }

  return json(res, 404, { error: 'Not found' })
}

const SITE_ORIGIN = new URL(PUBLIC_URL).origin
export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'POST') {
    // SameSite=Lax already keeps the cookie off cross-site POSTs; this refuses them outright.
    const origin = req.headers.origin
    if ((origin && origin !== SITE_ORIGIN) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request refused' })
  }
  try { await route(req, res, url) }
  catch (e) {
    const status = e instanceof LaunchError ? e.status : 500
    if (status >= 500) console.error(`${req.method} ${url.pathname}:`, e)
    if (!res.headersSent) json(res, status, { error: status >= 500 && !(e instanceof LaunchError) ? 'Something went wrong' : e.message })
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  // A launch is listed when the launcher's page calls /api/launch/confirm. If that page closed after signing,
  // the coin is on chain but unlisted, so every minute the server checks recent pending launches itself.
  // A launch transaction's blockhash expires within ~2 minutes: one still missing after 10 minutes never landed.
  setInterval(async () => {
    const rows = db.prepare(`SELECT k, v FROM kv WHERE k LIKE 'pending:%'`).all()
    for (const { k, v } of rows) {
      const mint = k.slice('pending:'.length)
      const age = now() - (JSON.parse(v).at ?? 0)
      if (age < 30) continue
      try { await confirmLaunch({ db, conn, mint }); console.log(`launch ${mint} listed by the sweep`) }
      catch (e) {
        // Only a definite answer drops it: never landed, or landed but paying someone else. RPC errors retry for a day.
        const refused = /does not pay|Unknown launch/.test(e.message)
        if (refused || (/not landed/.test(e.message) && age > 600) || age > 86_400) {
          db.prepare('DELETE FROM kv WHERE k = ?').run(k)
          if (refused) console.log(`launch ${mint} refused by the sweep: ${e.message}`)
        }
      }
    }
  }, 60_000).unref()
  server.listen(PORT, '127.0.0.1', () => console.log(`earn api on :${PORT}, program ${EARN.toBase58()}, providers ${[...providers.keys()].join(',') || 'none'}`))
  if (env.VANITY_DIR) startGrinder(db, { workDir: env.VANITY_DIR, bin: env.GRIND_BIN ?? 'earn-grind', target: Number(env.VANITY_TARGET ?? 50), threads: Number(env.VANITY_THREADS ?? 2) })
  // $EARN go-live, automated: the operator's launch wallet signing a pump.fun create of EARN lists it + opens launching.
  startLaunchWatcher({ db, conn, wallet: env.LAUNCH_WALLET, symbol: 'EARN', goLive: platformGoLive })
  if (env.LAUNCH_LUT) conn.getAddressLookupTable(new PublicKey(env.LAUNCH_LUT)).then((r) => r.value && lookupTables.push(r.value)).catch((e) => console.error('lookup table not loaded:', e.message))
}
