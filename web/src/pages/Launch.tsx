import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { IChevron, IClose, PlatformIcon, ISearch, IVerified } from '../components/Icons'
import { Avatar, Ext, Link, SOLSCAN } from '../components/ui'
import { api, usingMock } from '../lib/api'
import { tile } from '../lib/art'
import { fromBase64 } from '../lib/base58'
import { checkLaunchTransaction, isSignature } from '../lib/txcheck'
import { useModal } from '../lib/useModal'
import { at, cleanHandle, HINT, LABEL, LAUNCH_PROVIDERS, splitLine } from '../lib/providers'
import { navigate } from '../lib/router'
import type { Creator, PairItem, Provider } from '../lib/types'
import { useData, usePlatform } from '../lib/useData'
import { useWallet } from '../lib/wallet'

const MAX_IMAGE = 4 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif']
const DESC_MAX = 1000
const MAX_RECIPIENTS = 8

/** One row of the fee split: an account on a platform and its whole-percent share. */
type Row = { id: number; provider: Provider; creator: Creator | null; pct: string }
let rowSeq = 1
const newRow = (provider: Provider = 'x', pct = ''): Row => ({ id: rowSeq++, provider, creator: null, pct })

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; msg: string; summary?: string }
  | { kind: 'error'; msg: string }
  /** The wallet sent it; only the site's confirm step failed. The coin exists, so show where. */
  | { kind: 'sent'; msg: string; mint: string; signature: string }

export function Launch({ prefill }: { prefill?: string }) {
  const w = useWallet()
  // ⛔ Fails closed: launching is only offered once the server says it is open.
  const platform = usePlatform()
  const gated = platform.data?.launchesOpen !== true
  const [gateOpen, setGateOpen] = useState(false)
  const closeGate = useCallback(() => setGateOpen(false), [])
  const gateBox = useModal<HTMLDivElement>(gateOpen, closeGate)

  const [rows, setRows] = useState<Row[]>(() => [newRow('x', '100')])
  const setRow = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [socialOpen, setSocialOpen] = useState(false)
  const [website, setWebsite] = useState('')
  const [twitter, setTwitter] = useState('')
  const [devBuy, setDevBuy] = useState('')
  // Custom pairs (shown only once the server has them on): pair the coin with a token instead of SOL.
  const pairsAvail = useData(() => api.pairs(), [])
  const [pair, setPair] = useState<PairItem | null>(null)
  const [pairQuery, setPairQuery] = useState('')
  const [pairNote, setPairNote] = useState('')
  const pairMatches = (() => {
    const q = pairQuery.trim().toLowerCase(), items = pairsAvail.data?.items ?? []
    if (!q) return items.slice(0, 8)
    return items.filter((p) => p.symbol.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.mint === pairQuery.trim()).slice(0, 8)
  })()
  useEffect(() => {
    // a pasted token address that is not on pump.fun's list: ask whether it can be a pair (a pump coin can)
    const q = pairQuery.trim()
    setPairNote('')
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q) || (pairsAvail.data?.items ?? []).some((p) => p.mint === q)) return
    let live = true
    const t = setTimeout(() => api.pair(q).then((r) => {
      if (!live) return
      if (r.ok && r.mint) { setPair({ mint: r.mint, symbol: r.symbol ?? '', name: r.name ?? '', image: r.image ?? '', priceUsd: r.priceUsd ?? 0, kind: r.kind, decimals: r.decimals }); setPairQuery('') }
      else setPairNote(r.reason ?? 'That token cannot be a pair')
    }).catch(() => {}), 500)
    return () => { live = false; clearTimeout(t) }
  }, [pairQuery, pairsAvail.data])
  const listedPair = !!pair && (pair.kind === 'listed' || (pairsAvail.data?.items ?? []).some((p) => p.mint === pair.mint))
  // Ticker protection: a ticker launched on EARN in the last 7 days costs 1 SOL to launch again (checked as you type).
  const [tickerTaken, setTickerTaken] = useState<{ feeSol: number; name?: string; freeAt?: number } | null>(null)
  useEffect(() => {
    let live = true
    if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) { setTickerTaken(null); return }
    const t = setTimeout(() => api.ticker(symbol).then((r) => { if (live) setTickerTaken(r.taken ? r : null) }).catch(() => {}), 400)
    return () => { live = false; clearTimeout(t) }
  }, [symbol])
  const [agreed, setAgreed] = useState(false)
  const [image, setImage] = useState<{ preview: string; url: string | null; uploading: boolean; error: string | null } | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const fileInput = useRef<HTMLInputElement>(null)

  // "Launch for @h" arrives as ?for=<provider>:<handle>. Pick the exact account it names.
  useEffect(() => {
    if (!prefill) return
    const i = prefill.indexOf(':')
    const p = prefill.slice(0, i) as Provider
    const h = prefill.slice(i + 1)
    if (!LAUNCH_PROVIDERS.includes(p) || !h) return
    setRows((rs) => [{ ...rs[0]!, provider: p, creator: null }, ...rs.slice(1)])
    api.lookup(p, h).then((r) => {
      const exact = r.items.find((c) => c.handle.toLowerCase() === h.toLowerCase() || c.id === h)
      if (exact) setRows((rs) => [{ ...rs[0]!, provider: p, creator: exact }, ...rs.slice(1)])
    }).catch(() => {})
  }, [prefill])

  const pctOf = (r: Row) => (/^\d+$/.test(r.pct) ? Number(r.pct) : 0)
  const total = rows.reduce((s, r) => s + pctOf(r), 0)
  const sameAccount = (a: Creator, b: Creator) => a.provider === b.provider && a.id === b.id
  const duplicate = rows.some((r, i) => r.creator && rows.slice(0, i).some((q) => q.creator && sameAccount(q.creator, r.creator!)))
  const creator = rows.map((r) => r.creator).filter((c): c is Creator => !!c).sort((a, b) => pctOf(rows.find((r) => r.creator === b)!) - pctOf(rows.find((r) => r.creator === a)!))[0] ?? null
  const line = splitLine(rows.map((r) => ({ creator: r.creator, bps: pctOf(r) * 100 })))
  const fullDescription = description.trim() ? `${description.trim()}\n\n${line}` : line

  async function pickImage(file: File | undefined) {
    if (!file) return
    if (!IMAGE_TYPES.includes(file.type)) return setImage({ preview: '', url: null, uploading: false, error: 'PNG, JPG or GIF only.' })
    if (file.size > MAX_IMAGE) return setImage({ preview: '', url: null, uploading: false, error: 'That image is over 4 MB.' })
    if (image?.preview) URL.revokeObjectURL(image.preview)
    const preview = URL.createObjectURL(file)
    setImage({ preview, url: null, uploading: true, error: null })
    try {
      const { imageUrl } = await api.upload(file)
      setImage({ preview, url: imageUrl, uploading: false, error: null })
    } catch (e) {
      setImage({ preview, url: null, uploading: false, error: `Upload failed: ${(e as Error).message}` })
    }
  }

  const previewUrl = image?.preview
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const badShare = rows.some((r) => pctOf(r) < 1 || pctOf(r) > 100)
  const splitProblem = duplicate ? 'The same account appears twice'
    : total !== 100 ? `Shares must add up to 100% (now ${total}%)`
    : badShare ? 'Give each account a share above 0%' : null
  const problems: string[] = []
  if (rows.some((r) => !r.creator)) problems.push(rows.length > 1 ? 'Pick an account for every share' : 'Pick who the fees go to')
  if (duplicate) problems.push('The same account appears twice')
  if (total !== 100 || rows.some((r) => pctOf(r) < 1 || pctOf(r) > 100)) problems.push(`Shares must add up to 100% (now ${total}%)`)
  if (!name.trim()) problems.push('Name the token')
  if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) problems.push('Ticker: 1 to 10 letters or digits')
  if (!image?.url) problems.push(image?.uploading ? 'Wait for the image to upload' : 'Add an image')
  if (devBuy && !(Number(devBuy) >= 0)) problems.push('Dev buy must be a number')
  if (!agreed) problems.push('Agree to the terms')

  async function launch() {
    if (!w.address) return w.openPicker()
    if (problems.length || !creator || !image?.url) return
    try {
      setPhase({ kind: 'busy', msg: 'Preparing the launch' })
      // A listed pair's dev buy is paid in the pair token; otherwise in SOL (routed through the pair when there is one).
      const lamports = listedPair ? '0' : BigInt(Math.round(Number(devBuy || '0') * 1e9)).toString()
      const devBuyQuote = listedPair && devBuy ? BigInt(Math.round(Number(devBuy) * 10 ** (pair?.decimals ?? 6))).toString() : undefined
      const { mint, transaction, tickerFee } = await api.prepareLaunch({
        creator: { provider: creator.provider, id: creator.id },
        recipients: rows.map((r) => ({ provider: r.creator!.provider, id: r.creator!.id, bps: pctOf(r) * 100 })),
        name: name.trim(), symbol: symbol.toUpperCase(), description: fullDescription, imageUrl: image.url,
        website: website.trim(), twitter: twitter.trim(), telegram: '', devBuyLamports: lamports, launcher: w.address,
        ...(pair ? { pair: pair.mint, devBuyQuote } : {}),
      })
      // ⛔ The site refuses to ask for a signature on anything that is not the launch it described.
      const bytes = fromBase64(transaction)
      checkLaunchTransaction(bytes, { wallet: w.address, mint, tickerFee: !!tickerFee })
      const dev = Number(devBuy || '0')
      const summary = `Create $${symbol.toUpperCase()} · mint …${mint.slice(-8)} · dev buy ${dev > 0 ? `${dev} SOL` : 'none'}${tickerFee ? ` · ticker fee ${tickerFee.sol} SOL` : ''}`
      setPhase({ kind: 'busy', msg: 'Approve the transaction in your wallet', summary })
      const signature = await w.signAndSend(bytes)
      if (!isSignature(signature)) throw new Error('The wallet returned an invalid signature')
      // From here the coin may exist even if the site's own confirm step fails: never lose the mint.
      try {
        setPhase({ kind: 'busy', msg: 'Waiting for Solana to confirm', summary })
        await api.confirmLaunch(mint, signature)
        navigate(`/token/${mint}`)
      } catch (e) {
        setPhase({ kind: 'sent', msg: (e as Error).message, mint, signature })
      }
    } catch (e) {
      setPhase({ kind: 'error', msg: (e as Error).message })
    }
  }

  const busy = phase.kind === 'busy'
  return (
    <div className="page">
      <section className="card page-head">
        <h1>Launch a token that pays a creator</h1>
        <p className="muted">Deploy a new token on Pumpfun with its creator fees pointed at an account on X, Twitch, GitHub or FOMO.</p>
      </section>

      <div className="launch-layout">
        <section className="card form">
          <div className="between"><h2>Launch token</h2></div>

          <div className="field-label" id="fees-to">Fee recipients</div>
          <div className="split-rows" aria-labelledby="fees-to">
            {rows.map((r, i) => (
              <RecipientRow key={r.id} row={r} index={i} removable={rows.length > 1}
                onChange={(patch) => setRow(r.id, patch)}
                onRemove={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} />
            ))}
          </div>
          <div className="between split-total">
            {rows.length < MAX_RECIPIENTS
              ? <button type="button" className="btn ghost xs" onClick={() => setRows((rs) => [...rs, newRow('x', String(Math.max(0, 100 - total)))])}>Add another account</button>
              : <span className="muted small">Up to {MAX_RECIPIENTS} accounts</span>}
            <span className={`small ${splitProblem ? 'down' : 'up'}`} role="status">{splitProblem ?? 'Total 100%'}</span>
          </div>

          <div className="grid-name">
            <div><label className="field-label" htmlFor="nm">Name</label><input id="nm" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="Earn Coin" /></div>
            <div><label className="field-label" htmlFor="tk">Ticker</label><input id="tk" maxLength={10} value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} placeholder="EARN" />
              {tickerTaken && <div className="small down" role="status">${symbol} was launched on EARN in the last 7 days{tickerTaken.name ? ` (${tickerTaken.name})` : ''}. Launching it again costs {tickerTaken.feeSol} SOL{tickerTaken.freeAt ? `, free again ${new Date(tickerTaken.freeAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}.</div>}
            </div>
          </div>

          <div className="field-label" id="token-image">Token image</div>
          <div
            className={`drop ${image?.preview ? 'has' : ''}`}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click() } }}
            aria-labelledby="token-image"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); pickImage(e.dataTransfer.files[0]) }}
            role="button"
            tabIndex={0}
          >
            {image?.preview ? <img src={image.preview} alt="" /> : null}
            <div><b>Choose image</b> <span className="muted small">PNG, JPG or GIF up to 4 MB. Drop it here or click.</span>
              {image?.uploading && <div className="muted small">Uploading…</div>}
              {image?.error && <div className="down small">{image.error}</div>}
            </div>
            <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => pickImage(e.target.files?.[0])} />
          </div>

          <label className="field-label" htmlFor="ds">Description</label>
          <textarea id="ds" rows={4} value={description} maxLength={DESC_MAX - line.length - 2} onChange={(e) => setDescription(e.target.value)} placeholder="What is this token about?" />

          <button type="button" className="collapse caps tiny" onClick={() => setSocialOpen((o) => !o)}>Social links (optional) <IChevron dir="down" /></button>
          {socialOpen && (
            <div className="grid-2 tight">
              <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Website" />
              <input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="X link" />
            </div>
          )}
          <hr />
          {pairsAvail.data?.enabled && (
            <>
              <div className="field-label">Paired with</div>
              <div className="chips">
                <button type="button" className={`chip ${!pair ? 'on' : ''}`} onClick={() => { setPair(null); setPairQuery('') }}>SOL</button>
                {pair && <span className="chip on">{pair.image && <img src={pair.image} alt="" width={14} height={14} style={{ borderRadius: 999 }} />} ${pair.symbol} <button type="button" className="icon-btn" aria-label="Remove pair" onClick={() => setPair(null)}><IClose size={12} /></button></span>}
              </div>
              {!pair && (
                <div className="lookup">
                  <div className="input-row"><ISearch size={16} /><input value={pairQuery} onChange={(e) => setPairQuery(e.target.value)} placeholder="Custom pair: search pump.fun's pairs or paste a pump coin address" aria-label="Custom pair" /></div>
                  {pairQuery && pairMatches.length > 0 && (
                    <div className="lookup-list">{pairMatches.map((p) => (
                      <button type="button" key={p.mint} className="palette-row" onClick={() => { setPair({ ...p, kind: 'listed' }); setPairQuery('') }}>
                        {p.image ? <img src={p.image} alt="" width={22} height={22} style={{ borderRadius: 999 }} /> : null} <b>${p.symbol}</b> <span className="muted small">{p.name}</span>
                      </button>))}</div>
                  )}
                  {pairNote && <div className="down small">{pairNote}</div>}
                </div>
              )}
              {pair && <div className="muted small">Creator fees for this coin accrue in ${pair.symbol}, and creators withdraw them in ${pair.symbol}.</div>}
              <hr />
            </>
          )}
          <label className="field-label" htmlFor="db">Dev buy</label>
          <div className="input-row"><input id="db" inputMode="decimal" value={devBuy} onChange={(e) => setDevBuy(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" /><span className="muted">{listedPair ? `$${pair!.symbol}` : 'SOL'}</span></div>
          <div className="muted small">Optional. Buys your own token in the launch transaction, before anyone else.{pair && !listedPair ? ` Paid in SOL, routed through $${pair.symbol}.` : ''}{listedPair ? ` Paid from the $${pair!.symbol} in your wallet.` : ''}</div>
          <hr />
          <label className="check"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I agree to the <Link to="/terms" className="u">Terms of Use</Link> and have read the <Link to="/disclosures" className="u">Disclosures</Link>.</label>

          <button type="button" className="btn white block" disabled={!!splitProblem || (!gated && (busy || (!!w.address && problems.length > 0)))} onClick={gated ? () => setGateOpen(true) : launch}>
            {splitProblem ? splitProblem : gated ? 'Launch' : busy ? phase.msg : !w.address ? 'Connect wallet' : problems.length ? problems[0] : 'Launch'}
          </button>
          {gateOpen && (
            <div className="overlay" onClick={closeGate}>
              <div ref={gateBox} className="dialog" role="dialog" aria-modal="true" aria-label="Launching is disabled" onClick={(e) => e.stopPropagation()}>
                <div className="dialog-head"><h3>Launching is currently disabled.</h3><button type="button" className="icon-btn" aria-label="Close" onClick={closeGate}><IClose /></button></div>
                <button type="button" className="btn ghost block" onClick={closeGate}>Close</button>
              </div>
            </div>
          )}
          {phase.kind === 'busy' && phase.summary && <div className="note">{phase.summary}</div>}
          {phase.kind === 'error' && <div className="note error">{phase.msg}</div>}
          {phase.kind === 'sent' && (
            <div className="note">
              Your transaction was sent, but the site could not confirm it: {phase.msg}<br />
              <Ext href={SOLSCAN('tx', phase.signature)} className="u">View on Solscan</Ext> · <Link to={`/token/${phase.mint}`} className="u">Open the token page</Link>
            </div>
          )}
          {usingMock() && <div className="note">Preview mode: uploads and launches need the EARN server.</div>}
        </section>

        <aside className="launch-side">
          <div className="card preview-token">
            <div className="pill">pump.fun</div>
            <div className="pt-art"><img src={image?.preview || tile(name || 'earn', symbol || '')} alt="" /></div>
            <div><b>{name || 'Token name'}</b> <span className="muted">{symbol || 'TICKER'}</span></div>
            <dl className="kv">
              {rows.length > 1
                ? rows.map((r) => <Fragment key={r.id}><dt>{r.creator ? at(r.creator) : '…'}</dt><dd>{pctOf(r)}%</dd></Fragment>)
                : <><dt>Fee recipients</dt><dd>{creator ? at(creator) : '—'}</dd><dt>Creator share</dt><dd>100%</dd></>}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  )
}


/** Platform chips, account search and a percent box for one share of the split. */
function RecipientRow({ row, index, removable, onChange, onRemove }: { row: Row; index: number; removable: boolean; onChange: (patch: Partial<Row>) => void; onRemove: () => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Creator[]>([])
  // idle | searching | done (with results or none) | error: the box always says what happened
  const [status, setStatus] = useState<{ state: 'idle' | 'searching' | 'done' | 'error'; msg?: string }>({ state: 'idle' })
  const { provider, creator } = row
  const term = cleanHandle(provider, query)
  useEffect(() => {
    if (creator || !term) { setResults([]); setStatus({ state: 'idle' }); return }
    let live = true
    // 700 ms after the last keystroke, and at least 2 characters: fomo and X lookups cost credits per call.
    if (term.length < 2) { setResults([]); setStatus({ state: 'idle' }); return () => { live = false } }
    setStatus({ state: 'searching' })
    const t = setTimeout(() => api.lookup(provider, term)
      .then((r) => { if (live) { setResults(r.items); setStatus({ state: 'done' }) } })
      .catch((e: Error) => { if (live) { setResults([]); setStatus({ state: 'error', msg: e.message }) } }), 700)
    return () => { live = false; clearTimeout(t) }
  }, [provider, term, creator])
  const pctId = `pct-${row.id}`
  return (
    <div className="split-row">
      <div className="between">
        <div className="chips">
          {LAUNCH_PROVIDERS.map((p) => (
            <button key={p} type="button" className={`chip ${provider === p ? 'on' : ''}`} onClick={() => { onChange({ provider: p, creator: null }); setQuery('') }}>
              <PlatformIcon provider={p} size={12} color /> {LABEL[p]}
            </button>
          ))}
        </div>
        {removable && <button type="button" className="icon-btn" aria-label={`Remove account ${index + 1}`} onClick={onRemove}><IClose size={16} /></button>}
      </div>
      <div className="split-pick">
        {creator ? (
          <div className="chosen grow">
            <Avatar src={creator.avatar} label={creator.name} size={36} provider={creator.provider} />
            <div className="grow"><b>{creator.name}</b> {creator.verified && <IVerified />}<br /><span className="muted small">{at(creator)}</span></div>
            <button type="button" className="icon-btn" aria-label="Change" onClick={() => { onChange({ creator: null }); setQuery('') }}><IClose size={16} /></button>
          </div>
        ) : (
          <div className="lookup grow">
            <div className="input-row"><ISearch size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={`Account ${index + 1}`} placeholder={provider === 'x' ? '@ Search X for an account' : `Search ${LABEL[provider]} for an account`} /></div>
            {!results.length && status.state !== 'idle' && (
              <div className="lookup-list"><div className="palette-row muted small" role="status">
                {status.state === 'searching' ? 'Searching…'
                  : status.state === 'error' ? (status.msg || 'Search failed, try again')
                  : provider === 'x' || provider === 'twitch' || provider === 'github' ? `No ${LABEL[provider]} account @${term} found. Use the exact handle.`
                  : `No ${LABEL[provider]} account found for "${term}"`}
              </div></div>
            )}
            {results.length > 0 && (
              <div className="lookup-list">
                {results.map((c) => (
                  <button type="button" key={c.id} className="palette-row" onClick={() => { onChange({ creator: c }); setResults([]) }}>
                    <Avatar src={c.avatar} label={c.name} size={28} /> <span>{c.name}</span> {c.verified && <IVerified />} <span className="muted small">{at(c)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <label className="pct" htmlFor={pctId}><input id={pctId} inputMode="numeric" value={row.pct} onChange={(e) => onChange({ pct: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) })} aria-label={`Share of account ${index + 1} in percent`} /><span className="muted">%</span></label>
      </div>
      <div className="muted small">{HINT[provider]}</div>
    </div>
  )
}
