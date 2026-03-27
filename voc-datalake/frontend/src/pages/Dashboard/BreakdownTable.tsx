/**
 * @fileoverview Breakdown table component for PDF export.
 * @module pages/Dashboard/BreakdownTable
 */

interface BreakdownEntry {
  readonly name: string
  readonly value: number
}

const thStyle = {
  textAlign: 'left' as const,
  padding: '6px 8px',
  color: '#6b7280',
  fontWeight: '600' as const,
}
const thRight = {
  ...thStyle,
  textAlign: 'right' as const,
  width: '60px',
}

export function BreakdownTable({
  title, emoji, entries, colorFn,
}: {
  readonly title: string
  readonly emoji: string
  readonly entries: BreakdownEntry[]
  readonly colorFn?: (name: string) => string
}) {
  if (entries.length === 0) return null
  const total = entries.reduce((sum, e) => sum + e.value, 0)
  return (
    <div data-pdf-section style={{
      marginBottom: '28px',
      flex: '1',
      minWidth: '280px',
    }}>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#1e293b',
        marginBottom: '12px',
      }}>{emoji} {title}</h2>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '13px',
      }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
            <th style={thStyle}>Name</th>
            <th style={thRight}>Count</th>
            <th style={thRight}>Share</th>
            <th style={{
              ...thStyle,
              width: '140px',
            }} />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => {
            const pct = total > 0 ? (entry.value / total) * 100 : 0
            const barColor = colorFn ? colorFn(entry.name) : '#3b82f6'
            return (
              <tr key={entry.name} style={{
                borderBottom: '1px solid #f3f4f6',
                backgroundColor: i % 2 === 0 ? '#ffffff' : '#f9fafb',
              }}>
                <td style={{
                  padding: '6px 8px',
                  textTransform: 'capitalize',
                  fontWeight: '500',
                  color: '#1f2937',
                }}>{entry.name.replaceAll('_', ' ')}</td>
                <td style={{
                  textAlign: 'right',
                  padding: '6px 8px',
                  color: '#374151',
                }}>{entry.value}</td>
                <td style={{
                  textAlign: 'right',
                  padding: '6px 8px',
                  color: '#374151',
                }}>{pct.toFixed(1)}%</td>
                <td style={{ padding: '6px 8px' }}>
                  <div style={{
                    width: '100%',
                    height: '12px',
                    backgroundColor: '#f3f4f6',
                    borderRadius: '6px',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${pct}%`,
                      height: '100%',
                      backgroundColor: barColor,
                      borderRadius: '6px',
                      minWidth: pct > 0 ? '3px' : '0',
                    }} />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
