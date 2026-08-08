import { useState, useEffect } from 'react'
import { useAnalytics }   from './hooks/useAnalytics'
import StatCard           from './components/StatCard'
import RequestsChart      from './components/RequestsChart'
import RatioWidget        from './components/RatioWidget'
import TopKeysTable       from './components/TopKeysTable'

const POLL_MS = 5_000  // re-fetch every 5 seconds

/** Format "X seconds ago" label for the header. */
function timeAgo(date) {
  if (!date) return ''
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 2)  return 'just now'
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ago`
}

export default function App() {
  const { data, error, loading, lastUpdated, refresh } = useAnalytics(POLL_MS)

  // Tick every second to keep the "X seconds ago" label fresh
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // ── Status indicator ────────────────────────────────────────────────────
  const isOk       = !error && !!data
  const statusDot  = error ? 'dot-red' : loading ? 'dot-gray' : 'dot-green'
  const statusText = error
    ? `Error: ${error}`
    : loading
      ? 'Connecting…'
      : `Updated ${timeAgo(lastUpdated)}`

  // ── Derived stats (safe-guard against nulls) ───────────────────────────
  const total    = data?.totalRequests   ?? 0
  const blocked  = data?.blockedRequests ?? 0
  const allowed  = data?.allowedRequests ?? 0
  const latency  = data?.avgLatencyMs    ?? 0
  const bRate    = data?.blockRate       ?? '—'
  const window   = data?.window          ?? '—'

  return (
    <div className="app">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-brand">
          <h1>Rate Limiter Analytics</h1>
          <span className="sub">live gateway dashboard</span>
        </div>

        <div className="header-status">
          <span className={`dot ${statusDot}`} aria-hidden="true" />
          <span>{statusText}</span>
          <button
            className="btn-refresh"
            onClick={refresh}
            aria-label="Refresh now"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* ── Full-screen loading state (first fetch only) ────────────────── */}
      {loading && (
        <div className="loading-state" role="status">
          <span>Loading analytics…</span>
        </div>
      )}

      {/* ── Error state (no data at all) ────────────────────────────────── */}
      {!loading && error && !data && (
        <div className="error-state" role="alert">
          <p>Could not load analytics data.</p>
          <p className="hint">
            Make sure the gateway server is running on port 3000
            and Redis is reachable.
          </p>
          <p className="hint" style={{ marginTop: '0.25rem' }}>
            Detail: {error}
          </p>
        </div>
      )}

      {/* ── Main dashboard ──────────────────────────────────────────────── */}
      {!loading && (data || isOk) && (
        <main className="main" aria-label="Analytics dashboard">

          {/* ── Stat cards ────────────────────────────────────────────── */}
          <div className="stats-row">
            <StatCard label="Total Requests" value={total.toLocaleString()} />
            <StatCard label="Allowed"        value={allowed.toLocaleString()} accent="green" />
            <StatCard label="Blocked"        value={blocked.toLocaleString()} accent="red"   />
            <StatCard label="Block Rate"     value={bRate}                    accent={parseFloat(bRate) > 0 ? 'red' : undefined} />
          </div>

          {/* ── Requests-per-minute chart ─────────────────────────────── */}
          <section className="card" aria-labelledby="chart-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 className="card-title" id="chart-title" style={{ marginBottom: 0 }}>
                Requests per Minute
              </h2>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-3)' }}>
                {window} · polling every {POLL_MS / 1000}s
              </span>
            </div>
            <RequestsChart data={data?.requestsPerMinute} />
          </section>

          {/* ── Bottom row: ratio + top consumers ────────────────────── */}
          <div className="bottom-row">

            <section className="card" aria-labelledby="ratio-title">
              <h2 className="card-title" id="ratio-title">Allowed vs Blocked</h2>
              <RatioWidget
                allowed={allowed}
                blocked={blocked}
                total={total}
                blockRate={bRate}
              />
            </section>

            <section className="card" aria-labelledby="top-title">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 className="card-title" id="top-title" style={{ marginBottom: 0 }}>
                  Top Consumers
                </h2>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-3)' }}>
                  avg latency&nbsp; <strong style={{ color: 'var(--text-1)' }}>{latency}ms</strong>
                </span>
              </div>
              <TopKeysTable keys={data?.topKeys} />
            </section>

          </div>
        </main>
      )}

    </div>
  )
}
