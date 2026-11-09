/**
 * The $EARN burn tracker's share card: a 1200x630 PNG with the LIVE burn numbers, drawn with ImageMagick on the box
 * (DejaVu Sans Bold, the staged € mark). /burn serves index.html with og/twitter tags pointing at it, so a link to
 * earnrewards.fun/burn unfurls on X with the current figures. Cached on disk per figure set: a new burn = a new file
 * (and a new ?v= in the tag, so X fetches it fresh instead of its cached copy).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
const FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const SUPPLY_RAW = 1e15 // pump.fun: 1,000,000,000 at 6 decimals

/** Totals, per-day series and every burn, from the buybacks table. */
export function burnStats(db) {
  const rows = db.prepare('SELECT * FROM buybacks ORDER BY time ASC').all()
  let burned = 0n, lamports = 0
  const days = new Map()
  for (const r of rows) {
    burned += BigInt(r.tokens); lamports += r.lamports
    const d = new Date(r.time * 1000).toISOString().slice(0, 10)
    const e = days.get(d) ?? { day: d, burned: 0, sol: 0, count: 0 }
    e.burned += Number(r.tokens) / 1e6; e.sol += r.lamports / 1e9; e.count++
    days.set(d, e)
  }
  let cum = 0
  const daily = [...days.values()].map((d) => ({ ...d, cumulative: (cum += d.burned) }))
  return {
    count: rows.length, burnedTokens: Number(burned) / 1e6, burnedPct: Number(burned) / SUPPLY_RAW * 100, boughtBackSol: lamports / 1e9,
    usdSpent: rows.reduce((s, r) => s + (r.lamports / 1e9) * r.sol_usd, 0),
    lastAt: rows.at(-1)?.time ?? null, daily,
    items: rows.slice().reverse().map((r) => ({ time: r.time, sol: r.lamports / 1e9, tokens: Number(r.tokens) / 1e6, buySig: r.buy_sig, burnSig: r.burn_sig })),
  }
}

const n0 = (x) => Math.round(x).toLocaleString('en-US')
const pctText = (p) => `${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
export const cardVersion = (s) => `${s.count}-${Math.round(s.burnedTokens)}`

/** Path of the PNG for these figures (rendered once per figure set). */
export function burnCardPng(s, { dataDir, logo }) {
  const dir = join(dataDir, 'og'); mkdirSync(dir, { recursive: true })
  const out = join(dir, `burn-${cardVersion(s)}.png`)
  if (existsSync(out)) return out
  execFileSync('convert', [
    '-size', '1200x630', 'xc:black',
    '(', logo, '-resize', '300x300', ')', '-geometry', '+100+165', '-composite',
    '-fill', 'white', '-font', FONT, '-pointsize', '150', '-annotate', '+470+300', pctText(s.burnedPct),
    '-fill', '#a1a1aa', '-font', FONT_REG, '-pointsize', '44', '-annotate', '+474+370', 'of the $EARN supply burned',
    '-fill', 'white', '-font', FONT, '-pointsize', '34', '-annotate', '+474+440', `${n0(s.burnedTokens)} $EARN burned`,
    '-fill', '#a1a1aa', '-font', FONT_REG, '-pointsize', '30', '-annotate', '+474+488', `${s.boughtBackSol.toLocaleString('en-US', { maximumFractionDigits: 2 })} SOL bought back in ${s.count} buyback${s.count === 1 ? '' : 's'}`,
    '-fill', '#71717a', '-font', FONT_REG, '-pointsize', '26', '-annotate', '+474+570', 'earnrewards.fun/burn',
    '-strip', `png:${out}.tmp`,
  ], { timeout: 20_000, stdio: 'ignore' })
  execFileSync('mv', [`${out}.tmp`, out])
  return out
}

/** index.html with the link-preview tags rewritten for /burn (title, description, live image, url). */
export function burnPageHtml(indexHtml, s, publicUrl) {
  const title = '$EARN burn tracker'
  const desc = `${n0(s.burnedTokens)} $EARN burned (${pctText(s.burnedPct)} of supply) with ${s.boughtBackSol.toLocaleString('en-US', { maximumFractionDigits: 2 })} SOL of buybacks. Every bought token is burned.`
  const img = `${publicUrl}/api/og/burn.png?v=${cardVersion(s)}`
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const set = (html, attr, key, val) => html.replace(new RegExp(`(<meta ${attr}="${key.replace('$', '\\$')}" content=")[^"]*(")`), `$1${esc(val)}$2`)
  let h = indexHtml
  h = h.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  h = set(h, 'property', 'og:title', title); h = set(h, 'name', 'twitter:title', title)
  h = set(h, 'property', 'og:description', desc); h = set(h, 'name', 'twitter:description', desc)
  h = set(h, 'property', 'og:image', img); h = set(h, 'name', 'twitter:image', img)
  h = set(h, 'property', 'og:url', `${publicUrl}/burn`)
  return h
}

export const readIndex = (webDist) => readFileSync(join(webDist, 'index.html'), 'utf8')
