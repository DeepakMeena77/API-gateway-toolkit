/**
 * Truncates an API key for display: keeps the prefix + first 8 hex chars.
 * "sk_994f22df3060..." → "sk_994f22df…"
 */
function truncateKey(key) {
  if (!key || key.length <= 16) return key
  // Keep "sk_" prefix + 8 chars of the UUID portion
  return key.slice(0, 14) + '\u2026'
}

function TierBadge({ tier }) {
  return (
    <span className={`badge ${tier === 'pro' ? 'badge-pro' : 'badge-free'}`}>
      {tier}
    </span>
  )
}

/**
 * Table of top API key consumers in the current window.
 * Columns: Key · Tier · Algorithm · Requests · Blocked · Block Rate
 *
 * @param {{ key, tier, algorithm, requests, blocked, blockRate }[]} keys
 */
export default function TopKeysTable({ keys }) {
  if (!keys || keys.length === 0) {
    return (
      <p className="table-empty">
        No API keys have made requests in this window.
      </p>
    )
  }

  return (
    <table className="top-keys-table" aria-label="Top API consumers">
      <thead>
        <tr>
          <th>Key</th>
          <th>Tier</th>
          <th>Algorithm</th>
          <th className="num">Requests</th>
          <th className="num">Blocked</th>
          <th className="num">Block&nbsp;Rate</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => {
          const rateVal = parseFloat(k.blockRate)
          return (
            <tr key={k.key}>
              <td>
                <span className="key-mono" title={k.key}>
                  {truncateKey(k.key)}
                </span>
              </td>
              <td><TierBadge tier={k.tier} /></td>
              <td style={{ color: 'var(--text-2)' }}>{k.algorithm}</td>
              <td className="num">{k.requests.toLocaleString()}</td>
              <td className="num">{k.blocked.toLocaleString()}</td>
              <td className={`num ${rateVal > 0 ? 'rate-red' : ''}`}>
                {k.blockRate}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
