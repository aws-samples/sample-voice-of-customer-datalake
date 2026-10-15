/**
 * @fileoverview Feedback items table section for the Categories PDF export.
 * Renders a print-friendly table of feedback items, embedded in the unified
 * Categories Analysis Report (the standalone Feedback Report PDF was merged
 * into it — one export, one header).
 * @module pages/Categories/FeedbackPDFContent
 */

import type { FeedbackItem } from '../../api/types'

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

/**
 * Coerce a value to a finite number, falling back to `fallback` (default 0).
 *
 * The `/feedback` API can return numeric fields such as `sentiment_score` as
 * JSON strings (records persisted as DynamoDB String attributes), so calling
 * `.toFixed()` on the raw value throws and aborts the whole PDF render. This
 * mirrors the defensive coercion already used by `SentimentBadge`.
 */
function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Feedback items table for the PDF report. Renders nothing when the list is
 * empty (mirrors the other report sections).
 */
export function FeedbackTableSection({ items }: { readonly items: readonly FeedbackItem[] }) {
  if (items.length === 0) return null

  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#1e293b',
        marginBottom: '12px',
      }}>📋 Feedback Items ({items.length})</h2>
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
                    {item.sentiment_label} ({toFiniteNumber(item.sentiment_score).toFixed(2)})
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
