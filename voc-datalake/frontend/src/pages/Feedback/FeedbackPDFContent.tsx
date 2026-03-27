/**
 * @fileoverview PDF content component for feedback list export.
 * Renders a print-friendly table of feedback items.
 * @module pages/Feedback/FeedbackPDFContent
 */

import type { FeedbackItem } from '../../api/types'

export interface FeedbackPDFProps {
  readonly items: readonly FeedbackItem[]
  readonly timeRange: string
  readonly filters?: {
    source?: string
    sentiment?: string
    category?: string
    search?: string
    urgentOnly?: boolean
  }
}

function getSentimentStyle(label: string): {
  bg: string;
  color: string
} {
  if (label === 'positive') return {
    bg: '#dcfce7',
    color: '#166534',
  }
  if (label === 'negative') return {
    bg: '#fef2f2',
    color: '#991b1b',
  }
  if (label === 'mixed') return {
    bg: '#fef9c3',
    color: '#854d0e',
  }
  return {
    bg: '#f3f4f6',
    color: '#374151',
  }
}

function formatDate(dateString: string | null | undefined): string {
  if ((dateString == null || dateString === '')) return '—'
  try {
    return new Date(dateString).toLocaleDateString()
  } catch {
    return '—'
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '…'
}

function isActiveFilter(value: string | undefined, defaultValue = 'all'): boolean {
  return value != null && value !== defaultValue
}

function buildActiveFilters(filters: FeedbackPDFProps['filters']): string[] {
  if (!filters) return []
  const result: string[] = []
  if (isActiveFilter(filters.source)) result.push(`Source: ${filters.source}`)
  if (isActiveFilter(filters.sentiment)) result.push(`Sentiment: ${filters.sentiment}`)
  if (isActiveFilter(filters.category)) result.push(`Category: ${filters.category}`)
  if (filters.search != null && filters.search !== '') result.push(`Search: "${filters.search}"`)
  if (filters.urgentOnly === true) result.push('Urgent only')
  return result
}

function computeHeaderStats(items: readonly FeedbackItem[]) {
  const urgentCount = items.filter((i) => i.urgency === 'high').length
  const avgSentiment = items.length > 0
    ? items.reduce((sum, i) => sum + i.sentiment_score, 0) / items.length
    : 0
  return {
    urgentCount,
    avgSentiment,
  }
}

function HeaderSection({
  items, timeRange, filters,
}: FeedbackPDFProps) {
  const activeFilters = buildActiveFilters(filters)
  const {
    urgentCount, avgSentiment,
  } = computeHeaderStats(items)

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h1 style={{
        fontSize: '28px',
        fontWeight: 'bold',
        margin: '0 0 4px 0',
        color: '#111827',
      }}>
        Feedback Report
      </h1>
      <p style={{
        fontSize: '14px',
        color: '#6b7280',
        margin: '0 0 16px 0',
      }}>
        Time range: {timeRange}
        {activeFilters.length > 0 && ` • ${activeFilters.join(' • ')}`}
      </p>
      <div style={{
        display: 'flex',
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        {[
          {
            label: 'Items',
            value: String(items.length),
            bg: '#f0f9ff',
            color: '#1d4ed8',
          },
          {
            label: 'Urgent',
            value: String(urgentCount),
            bg: '#fef2f2',
            color: '#991b1b',
          },
          {
            label: 'Avg Sentiment',
            value: avgSentiment.toFixed(2),
            bg: '#f0fdf4',
            color: '#166534',
          },
        ].map((stat) => (
          <div key={stat.label} style={{
            padding: '12px 20px',
            backgroundColor: stat.bg,
            borderRadius: '8px',
            minWidth: '120px',
          }}>
            <p style={{
              fontSize: '12px',
              color: stat.color,
              fontWeight: '500',
              margin: '0 0 4px 0',
            }}>{stat.label}</p>
            <p style={{
              fontSize: '22px',
              fontWeight: 'bold',
              color: stat.color,
              margin: 0,
            }}>{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function FeedbackTable({ items }: { readonly items: readonly FeedbackItem[] }) {
  return (
    <div data-pdf-section>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#1e293b',
        marginBottom: '12px',
      }}>📋 Feedback Items</h2>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '12px',
      }}>
        <thead>
          <tr style={{
            borderBottom: '2px solid #e5e7eb',
            backgroundColor: '#f8fafc',
          }}>
            <th style={{
              textAlign: 'left',
              padding: '8px 6px',
              color: '#6b7280',
              fontWeight: '600',
            }}>Date</th>
            <th style={{
              textAlign: 'left',
              padding: '8px 6px',
              color: '#6b7280',
              fontWeight: '600',
            }}>Source</th>
            <th style={{
              textAlign: 'left',
              padding: '8px 6px',
              color: '#6b7280',
              fontWeight: '600',
            }}>Category</th>
            <th style={{
              textAlign: 'left',
              padding: '8px 6px',
              color: '#6b7280',
              fontWeight: '600',
            }}>Sentiment</th>
            <th style={{
              textAlign: 'center',
              padding: '8px 6px',
              color: '#6b7280',
              fontWeight: '600',
              width: '50px',
            }}>Rating</th>
            <th style={{
              textAlign: 'left',
              padding: '8px 6px',
              color: '#6b7280',
              fontWeight: '600',
            }}>Feedback</th>
            <th style={{
              textAlign: 'left',
              padding: '8px 6px',
              color: '#6b7280',
              fontWeight: '600',
            }}>Problem</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => {
            const sentStyle = getSentimentStyle(item.sentiment_label)
            return (
              <tr key={item.feedback_id} style={{
                borderBottom: '1px solid #f3f4f6',
                backgroundColor: i % 2 === 0 ? '#ffffff' : '#f9fafb',
              }}>
                <td style={{
                  padding: '6px',
                  whiteSpace: 'nowrap',
                  color: '#6b7280',
                  fontSize: '11px',
                }}>
                  {formatDate(item.source_created_at)}
                </td>
                <td style={{
                  padding: '6px',
                  textTransform: 'capitalize',
                  color: '#374151',
                  fontSize: '11px',
                }}>
                  {item.source_platform.replaceAll('_', ' ')}
                </td>
                <td style={{
                  padding: '6px',
                  textTransform: 'capitalize',
                  color: '#374151',
                  fontSize: '11px',
                }}>
                  {item.category.replaceAll('_', ' ')}
                </td>
                <td style={{ padding: '6px' }}>
                  <span style={{
                    padding: '2px 8px',
                    backgroundColor: sentStyle.bg,
                    color: sentStyle.color,
                    borderRadius: '10px',
                    fontSize: '10px',
                    fontWeight: '500',
                    whiteSpace: 'nowrap',
                  }}>
                    {item.sentiment_label} ({item.sentiment_score.toFixed(2)})
                  </span>
                </td>
                <td style={{
                  padding: '6px',
                  textAlign: 'center',
                  color: '#374151',
                  fontSize: '11px',
                }}>
                  {item.rating == null ? '—' : `${item.rating}/5`}
                </td>
                <td style={{
                  padding: '6px',
                  color: '#374151',
                  fontSize: '11px',
                  maxWidth: '250px',
                }}>
                  {truncateText(item.original_text, 150)}
                </td>
                <td style={{
                  padding: '6px',
                  color: '#6b7280',
                  fontSize: '11px',
                  fontStyle: 'italic',
                  maxWidth: '180px',
                }}>
                  {item.problem_summary != null && item.problem_summary !== '' ? truncateText(item.problem_summary, 100) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function FeedbackPDFContent(props: FeedbackPDFProps) {
  return (
    <div style={{
      padding: '30px',
      backgroundColor: 'white',
    }}>
      <HeaderSection {...props} />
      <hr style={{
        border: 'none',
        borderTop: '2px solid #e5e7eb',
        marginBottom: '24px',
      }} />
      <FeedbackTable items={props.items} />
      <div data-pdf-section>
        <hr style={{
          border: 'none',
          borderTop: '1px solid #e5e7eb',
          marginTop: '32px',
          marginBottom: '16px',
        }} />
        <p style={{
          fontSize: '11px',
          color: '#9ca3af',
          textAlign: 'center',
        }}>
          Generated on {new Date().toLocaleDateString()} • VoC Analytics — Feedback Report
        </p>
      </div>
    </div>
  )
}
