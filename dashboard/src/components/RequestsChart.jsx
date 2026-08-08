import {
  AreaChart, Area,
  XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts'

/** Show only every Nth x-axis tick to avoid label crowding. */
function sparseTickFormatter(value, index, interval) {
  return index % interval === 0 ? value : ''
}

/**
 * Area chart of requests per minute (blue) with blocked requests
 * overlaid (red), both drawn from the requestsPerMinute array.
 *
 * @param {{ minute, ts, requests, blocked }[]} data
 */
export default function RequestsChart({ data }) {
  if (!data || data.length === 0) {
    return <p className="chart-empty">No data in this window.</p>
  }

  // Show a tick every 10 minutes for a 60-bucket window (every 5 for 30-bucket)
  const tickInterval = data.length <= 30 ? 5 : 10

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id="gReq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#2563eb" stopOpacity={0.18} />
            <stop offset="95%" stopColor="#2563eb" stopOpacity={0}    />
          </linearGradient>
          <linearGradient id="gBlk" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#dc2626" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#dc2626" stopOpacity={0}    />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />

        <XAxis
          dataKey="minute"
          tick={{ fontSize: 10.5, fill: '#94a3b8' }}
          tickFormatter={(v, i) => sparseTickFormatter(v, i, tickInterval)}
          axisLine={false}
          tickLine={false}
          label={{ value: 'Time (UTC)', position: 'insideBottomRight', offset: -4, fontSize: 10, fill: '#94a3b8' }}
        />
        <YAxis
          tick={{ fontSize: 10.5, fill: '#94a3b8' }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          width={32}
        />

        <Tooltip
          contentStyle={{
            fontSize: 12,
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            background: '#fff',
            boxShadow: '0 2px 6px rgba(0,0,0,.08)',
          }}
          labelStyle={{ fontWeight: 600, color: '#1e293b', marginBottom: 4 }}
          formatter={(value, name) => [value.toLocaleString(), name]}
        />

        <Legend
          iconType="square"
          iconSize={10}
          wrapperStyle={{ fontSize: 11.5, paddingTop: '0.5rem' }}
        />

        {/* Total requests — blue, behind */}
        <Area
          type="monotone"
          dataKey="requests"
          name="Requests"
          stroke="#2563eb"
          strokeWidth={1.8}
          fill="url(#gReq)"
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
        />

        {/* Blocked — red, drawn on top so it always shows within the blue area */}
        <Area
          type="monotone"
          dataKey="blocked"
          name="Blocked"
          stroke="#dc2626"
          strokeWidth={1.8}
          fill="url(#gBlk)"
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
