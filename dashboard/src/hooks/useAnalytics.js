import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * WHY POLLING INSTEAD OF SSE
 * --------------------------
 * The /analytics endpoint returns a pre-aggregated snapshot: 60 one-minute
 * buckets, totals, and top-5 keys.  This is computed fresh on every call
 * and represents a point-in-time view, not a stream of individual events.
 *
 * SSE would make sense if we were pushing raw request events to the client
 * and aggregating in the browser — but we'd still end up sending the full
 * aggregated payload on every meaningful change, which is exactly what
 * polling does, with less infrastructure:
 *
 *   Polling: fetch → JSON → setState                       ✅ simple
 *   SSE:     EventSource → reconnect logic → parse frames  ❌ needless complexity
 *
 * At 5-second poll intervals the chart feels live, and any interval > 1s
 * means the extra latency of opening a new connection is negligible.
 *
 * @param {number} intervalMs - How often to re-fetch (default: 5 000 ms)
 * @returns {{ data, error, loading, lastUpdated, refresh }}
 */
export function useAnalytics(intervalMs = 5_000) {
  const [data,        setData]        = useState(null)
  const [error,       setError]       = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)

  // Track whether we've ever completed a fetch so we only show the
  // full-screen spinner on the very first load.
  const hasFetched = useRef(false)

  const fetchData = useCallback(async (windowMs) => {
    try {
      // In production the dashboard is a static site on a different origin from
      // the backend.  VITE_API_URL is injected at build time by Render so every
      // fetch goes to the correct instance.  In local dev it is empty ('') and
      // the Vite proxy forwards /analytics to localhost:3000 as before.
      const BASE = import.meta.env.VITE_API_URL ?? ''
      const url = windowMs
        ? `${BASE}/analytics?window=${Math.round(windowMs / 60_000)}`
        : `${BASE}/analytics`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      setError(null)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      if (!hasFetched.current) {
        hasFetched.current = true
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(() => fetchData(), intervalMs)
    return () => clearInterval(id)
  }, [fetchData, intervalMs])

  // Exposed so the header "Refresh" button can trigger an immediate re-fetch
  const refresh = useCallback(() => fetchData(), [fetchData])

  return { data, error, loading, lastUpdated, refresh }
}
