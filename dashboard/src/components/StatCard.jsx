/**
 * A single stat card displayed in the top row.
 *
 * @param {string}  label   - Small uppercase label (e.g. "Total Requests")
 * @param {string}  value   - Formatted value (e.g. "1,847" or "7.96%")
 * @param {'red'|'green'} [accent] - Optional colour override for the value
 * @param {boolean} [small] - Reduce font size for longer values
 */
export default function StatCard({ label, value, accent, small }) {
  const valueClass = ['stat-value', accent, small && 'small']
    .filter(Boolean)
    .join(' ')

  return (
    <div className="card stat-card">
      <div className="stat-label">{label}</div>
      <div className={valueClass}>{value ?? '—'}</div>
    </div>
  )
}
