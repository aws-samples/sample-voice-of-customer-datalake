/**
 * @fileoverview PDF content component for dashboard export.
 * Renders a print-friendly summary of dashboard metrics, trends, and breakdowns.
 * @module pages/Dashboard/DashboardPDFContent
 */

import { sentimentHexColor } from '../../lib/sentiment'
import { BreakdownTable } from './BreakdownTable'
import type { FeedbackItem } from '../../api/types'

interface DailyTotal {
  readonly date: string;
  readonly count: number
}
interface BreakdownEntry {
  readonly name: string;
  readonly value: number
}

export interface DashboardPDFProps {
  readonly timeRange: string
  readonly totalFeedback: number
  readonly avgSentiment: number
  readonly urgentCount: number
  readonly sourcesCount: number
  readonly dailyTotals: DailyTotal[]
  readonly sentimentBreakdown: BreakdownEntry[]
  readonly categoryBreakdown: BreakdownEntry[]
  readonly sourceBreakdown: BreakdownEntry[]
  readonly urgentItems: readonly FeedbackItem[]
}

function getHeaderSentimentColor(avgSentiment: number): string {
  if (avgSentiment > 0) return '#166534'
  if (avgSentiment < 0) return '#991b1b'
  return '#374151'
}

const sectionHeading = {
  fontSize: '18px',
  fontWeight: '600' as const,
  color: '#1e293b',
  marginBottom: '12px',
}

function HeaderSection({
  timeRange, totalFeedback, avgSentiment, urgentCount, sourcesCount,
}: DashboardPDFProps) {
  const sentimentColor = getHeaderSentimentColor(avgSentiment)
  const stats = [
    {
      label: 'Total Feedback',
      value: String(totalFeedback),
      bg: '#f0f9ff',
      color: '#1d4ed8',
    },
    {
      label: 'Avg Sentiment',
      value: avgSentiment.toFixed(2),
      bg: '#f0fdf4',
      color: sentimentColor,
    },
    {
      label: 'Urgent Issues',
      value: String(urgentCount),
      bg: '#fef2f2',
      color: '#991b1b',
    },
    {
      label: 'Sources Active',
      value: String(sourcesCount),
      bg: '#f5f3ff',
      color: '#5b21b6',
    },
  ]
  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h1 style={{
        fontSize: '28px',
        fontWeight: 'bold',
        margin: '0 0 4px 0',
        color: '#111827',
      }}>Dashboard Report</h1>
      <p style={{
        fontSize: '14px',
        color: '#6b7280',
        margin: '0 0 16px 0',
      }}>Time range: {timeRange}</p>
      <div style={{
        display: 'flex',
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        {stats.map((stat) => (
          <div key={stat.label} style={{
            padding: '12px 20px',
            backgroundColor: stat.bg,
            borderRadius: '8px',
            minWidth: '130px',
          }}>
            <p style={{
              fontSize: '12px',
              color: stat.color,
              fontWeight: '500',
              margin: '0 0 4px 0',
            }}>{stat.label}</p>
            <p style={{
              fontSize: '24px',
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

function TrendSection({ dailyTotals }: { readonly dailyTotals: DailyTotal[] }) {
  if (dailyTotals.length === 0) return null
  const sorted = [...dailyTotals].sort((a, b) => a.date.localeCompare(b.date))
  const maxCount = Math.max(...sorted.map((d) => d.count), 1)
  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <h2 style={sectionHeading}>📈 Feedback Volume Trend</h2>
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: '2px',
        height: '120px',
        padding: '0 4px',
      }}>
        {sorted.map((day) => {
          const height = Math.max(4, (day.count / maxCount) * 100)
          return (
            <div key={day.date} style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
            }}>
              <span style={{
                fontSize: '9px',
                color: '#6b7280',
              }}>{day.count > 0 ? day.count : ''}</span>
              <div style={{
                width: '100%',
                maxWidth: '24px',
                height: `${height}px`,
                backgroundColor: '#3b82f6',
                borderRadius: '2px 2px 0 0',
              }} />
            </div>
          )
        })}
      </div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: '4px',
        fontSize: '10px',
        color: '#9ca3af',
      }}>
        <span>{sorted[0]?.date}</span>
        <span>{sorted.at(-1)?.date}</span>
      </div>
    </div>
  )
}

function SentimentSection({ sentimentBreakdown }: { readonly sentimentBreakdown: BreakdownEntry[] }) {
  if (sentimentBreakdown.length === 0) return null
  const total = sentimentBreakdown.reduce((sum, s) => sum + s.value, 0)
  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <h2 style={sectionHeading}>😊 Sentiment Distribution</h2>
      <div style={{
        display: 'flex',
        gap: '12px',
        flexWrap: 'wrap',
      }}>
        {sentimentBreakdown.map((s) => {
          const pct = total > 0 ? ((s.value / total) * 100).toFixed(1) : '0'
          return (
            <div key={s.name} data-pdf-section style={{
              padding: '12px 20px',
              borderRadius: '8px',
              border: '1px solid #e5e7eb',
              flex: '1',
              minWidth: '100px',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '4px',
              }}>
                <span style={{
                  display: 'inline-block',
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: sentimentHexColor(s.name),
                }} />
                <span style={{
                  fontSize: '13px',
                  fontWeight: '500',
                  color: '#374151',
                  textTransform: 'capitalize',
                }}>{s.name}</span>
              </div>
              <p style={{
                fontSize: '22px',
                fontWeight: 'bold',
                color: '#1f2937',
                margin: '0 0 2px 0',
              }}>{s.value}</p>
              <p style={{
                fontSize: '12px',
                color: '#6b7280',
                margin: 0,
              }}>{pct}%</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UrgentSection({ urgentItems }: { readonly urgentItems: readonly FeedbackItem[] }) {
  if (urgentItems.length === 0) return null
  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <h2 style={{
        ...sectionHeading,
        color: '#dc2626',
      }}>🚨 Urgent Issues</h2>
      {urgentItems.map((item) => (
        <UrgentItem key={item.feedback_id} item={item} />
      ))}
    </div>
  )
}

function UrgentItem({ item }: { readonly item: FeedbackItem }) {
  const dateStr = item.source_created_at === '' ? '' : new Date(item.source_created_at).toLocaleDateString()
  const text = item.original_text.length > 200 ? item.original_text.slice(0, 200) + '…' : item.original_text
  return (
    <div data-pdf-section style={{
      padding: '10px 14px',
      borderLeft: '3px solid #ef4444',
      marginBottom: '8px',
      backgroundColor: '#fef2f2',
      borderRadius: '0 6px 6px 0',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '4px',
      }}>
        <span style={{
          fontSize: '12px',
          fontWeight: '500',
          color: '#374151',
          textTransform: 'capitalize',
        }}>
          {item.source_platform.replaceAll('_', ' ')} • {item.category.replaceAll('_', ' ')}
        </span>
        <span style={{
          fontSize: '11px',
          color: '#6b7280',
        }}>{dateStr}</span>
      </div>
      <p style={{
        fontSize: '12px',
        color: '#374151',
        margin: '0 0 4px 0',
        lineHeight: '1.5',
      }}>{text}</p>
      {item.problem_summary != null && item.problem_summary !== '' ? (
        <p style={{
          fontSize: '11px',
          color: '#6b7280',
          margin: 0,
          fontStyle: 'italic',
        }}>Problem: {item.problem_summary}</p>
      ) : null}
    </div>
  )
}

export default function DashboardPDFContent(props: DashboardPDFProps) {
  return (
    <div style={{
      padding: '40px',
      backgroundColor: 'white',
    }}>
      <HeaderSection {...props} />
      <hr style={{
        border: 'none',
        borderTop: '2px solid #e5e7eb',
        marginBottom: '24px',
      }} />
      <TrendSection dailyTotals={props.dailyTotals} />
      <SentimentSection sentimentBreakdown={props.sentimentBreakdown} />
      <div style={{
        display: 'flex',
        gap: '24px',
        flexWrap: 'wrap',
      }}>
        <BreakdownTable title="Categories" emoji="📊" entries={props.categoryBreakdown} />
        <BreakdownTable title="Sources" emoji="🔗" entries={props.sourceBreakdown} colorFn={() => '#8b5cf6'} />
      </div>
      <UrgentSection urgentItems={props.urgentItems} />
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
          Generated on {new Date().toLocaleDateString()} • VoC Analytics — Dashboard Report
        </p>
      </div>
    </div>
  )
}
