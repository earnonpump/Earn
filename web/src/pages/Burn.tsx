import { AreaChart } from '../components/Charts'
import { IArrow } from '../components/Icons'
import { Ext, Link, SOLSCAN } from '../components/ui'
import { api } from '../lib/api'
import { ago, usd } from '../lib/format'
import { useData } from '../lib/useData'

const tok = (n: number) => Math.round(n).toLocaleString('en-US')
const sol = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 })

/** The $EARN burn tracker: every buyback bought $EARN with SOL and burned exactly what it bought. */
export function Burn() {
  const b = useData(() => api.burns(), [])
  const d = b.data
  // cumulative $EARN burned after each burn, oldest first
  const series = (() => {
    const items = [...(d?.items ?? [])].reverse()
    let cum = 0
    return items.map((i) => ({ day: new Date(i.time * 1000).toISOString().slice(0, 10), v: (cum += i.tokens) }))
  })()

  return (
    <div className="page">
      <section className="card page-head row-between">
        <h1>$EARN burn tracker</h1>
        {d?.mint && <Link to={`/token/${d.mint}`} className="muted small">$EARN <IArrow /></Link>}
      </section>

      <section className="card">
        <div className="muted small">Of the $EARN supply burned</div>
        <div className="huge-num">{(d?.burnedPct ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</div>
        <div className="muted small">{tok(d?.burnedTokens ?? 0)} $EARN burned for good. Creator fees from $EARN buy it back, and every bought token is burned.</div>
      </section>

      <section className="grid-3">
        <div className="card"><div className="muted small">Bought back</div><div className="big-num">{sol(d?.boughtBackSol ?? 0)} SOL</div><div className="muted small">{usd(d?.usdSpent ?? 0)} at the time of each buyback.</div></div>
        <div className="card"><div className="muted small">Buybacks</div><div className="big-num">{(d?.count ?? 0).toLocaleString('en-US')}</div><div className="muted small">{d?.lastAt ? `Last one ${ago(d.lastAt)}.` : 'None yet.'}</div></div>
        <div className="card"><div className="muted small">Pending Buybacks</div><div className="big-num">{sol(d?.pendingSol ?? 0)} SOL</div><div className="muted small">{usd(d?.pendingUsd ?? 0)} of $EARN fees still to buy back.</div></div>
      </section>

      {series.length > 1 && (
        <section className="dc-grid">
          <div className="dc-card">
            <div className="dc-label">$EARN burned over time</div>
            <div className="dc-value">{tok(d?.burnedTokens ?? 0)}</div>
            <div className="dc-note">Running total after each burn.</div>
            <AreaChart days={series.map((s) => s.day)} values={series.map((s) => s.v)} />
          </div>
        </section>
      )}

      <section className="c-scope">
        <div className="c-head"><h2>Every burn</h2><span className="c-sm c-muted">Bought with SOL, then burned</span></div>
        {d?.items.length
          ? <ul className="c-list">{d.items.map((i) => (
              <li key={i.buySig} className="row-between">
                <span><b>{tok(i.tokens)} $EARN</b> <span className="muted small">for {sol(i.sol)} SOL · {ago(i.time)}</span></span>
                <span className="small"><Ext href={SOLSCAN('tx', i.buySig)}>buy</Ext> · <Ext href={SOLSCAN('tx', i.burnSig)}>burn</Ext></span>
              </li>))}</ul>
          : <div className="c-blank">No burns yet.</div>}
      </section>
    </div>
  )
}
