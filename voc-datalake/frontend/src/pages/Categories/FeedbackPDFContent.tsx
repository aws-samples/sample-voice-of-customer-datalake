/**
 * @fileoverview Feedback items table section for the Categories PDF export.
 * Renders a print-friendly table of feedback items, embedded in the unified
 * Categories Analysis Report (the standalone Feedback Report PDF was merged
 * into it — one export, one header).
 * @module pages/Categories/FeedbackPDFContent
 */

import type { CSSProperties } from 'react'
import { ClipboardList } from 'lucide-react'
import type { FeedbackItem } from '../../api/types'
import { PdfIcon, PdfSectionHeading } from '../../components/PdfParts/pdfParts'

function getSentimentStyle(label: string): {
  bg: string;
  color: string
} {
  if (label === 'positive') return {
    bg: '#e0eee7',
    color: '#007038',
  }
  if (label === 'negative') return {
    bg: '#f8e8eb',
    color: '#bd1c3a',
  }
  if (label === 'mixed') return {
    bg: '#f0eee6',
    color: '#6b5900',
  }
  return {
    bg: '#f5f5f5',
    color: '#4a464f',
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

const HEADER_CELL = {
  textAlign: 'left',
  padding: '8px 6px',
  color: '#5e5966',
  fontWeight: '600',
} satisfies CSSProperties

/**
 * Feedback items table for the PDF report. Renders nothing when the list is
 * empty (mirrors the other report sections).
 */
export function FeedbackTableSection({ items }: { readonly items: readonly FeedbackItem[] }) {
  if (items.length === 0) return null

  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <PdfSectionHeading><PdfIcon icon={ClipboardList} />Feedback Items ({items.length})</PdfSectionHeading>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '12px',
      }}>
        <thead>
          <tr style={{
            borderBottom: '2px solid #e4e4e7',
            backgroundColor: '#f5f5f5',
          }}>
            <th style={HEADER_CELL}>Date</th>
            <th style={HEADER_CELL}>Source</th>
            <th style={HEADER_CELL}>Category</th>
            <th style={HEADER_CELL}>Sentiment</th>
            <th style={{
              ...HEADER_CELL,
              textAlign: 'center',
              width: '50px',
            }}>Rating</th>
            <th style={HEADER_CELL}>Feedback</th>
            <th style={HEADER_CELL}>Problem</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => {
            const sentStyle = getSentimentStyle(item.sentiment_label)
            return (
              <tr key={item.feedback_id} style={{
                borderBottom: '1px solid #f5f5f5',
                backgroundColor: i % 2 === 0 ? '#ffffff' : '#f5f5f5',
              }}>
                <td style={{
                  padding: '6px',
                  whiteSpace: 'nowrap',
                  color: '#5e5966',
                  fontSize: '11px',
                }}>
                  {formatDate(item.source_created_at)}
                </td>
                <td style={{
                  padding: '6px',
                  textTransform: 'capitalize',
                  color: '#4a464f',
                  fontSize: '11px',
                }}>
                  {item.source_platform.replaceAll('_', ' ')}
                </td>
                <td style={{
                  padding: '6px',
                  textTransform: 'capitalize',
                  color: '#4a464f',
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
                  color: '#4a464f',
                  fontSize: '11px',
                }}>
                  {item.rating == null ? '—' : `${item.rating}/5`}
                </td>
                <td style={{
                  padding: '6px',
                  color: '#4a464f',
                  fontSize: '11px',
                  maxWidth: '250px',
                }}>
                  {truncateText(item.original_text, 150)}
                </td>
                <td style={{
                  padding: '6px',
                  color: '#5e5966',
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
