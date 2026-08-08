const fmt = (n) => Number(n).toLocaleString()

/**
 * Shows the allowed / blocked split as a coloured bar and two counters.
 *
 * @param {number} allowed
 * @param {number} blocked
 * @param {number} total
 * @param {string} blockRate  e.g. "7.96%"
 */
export default function RatioWidget({ allowed, blocked, total, blockRate }) {
  if (!total) {
    return (
      <p className="ratio-empty">
        No requests recorded in this window.<br />
        Make some API calls to see data here.
      </p>
    )
  }

  const allowedPct = ((allowed / total) * 100).toFixed(1)
  const blockedPct = ((blocked / total) * 100).toFixed(1)

  return (
    <>
      {/* Coloured split bar */}
      <div className="ratio-bar" aria-label={`${allowedPct}% allowed, ${blockedPct}% blocked`}>
        <div
          className="ratio-allowed"
          style={{ width: `${allowedPct}%` }}
          title={`Allowed ${allowedPct}%`}
        />
        <div
          className="ratio-blocked"
          style={{ width: `${blockedPct}%` }}
          title={`Blocked ${blockedPct}%`}
        />
      </div>

      {/* Two counters */}
      <div className="ratio-items">
        <div className="ratio-item">
          <span className="dot dot-blue" aria-hidden="true" />
          <div>
            <div className="ratio-count">{fmt(allowed)}</div>
            <div className="ratio-item-label">Allowed ({allowedPct}%)</div>
          </div>
        </div>

        <div className="ratio-item">
          <span className="dot dot-red" aria-hidden="true" />
          <div>
            <div className="ratio-count red">{fmt(blocked)}</div>
            <div className="ratio-item-label">Blocked ({blockedPct}%)</div>
          </div>
        </div>
      </div>

      <div className="ratio-footer">
        {fmt(total)} total requests &nbsp;·&nbsp; {blockRate} block rate
      </div>
    </>
  )
}
