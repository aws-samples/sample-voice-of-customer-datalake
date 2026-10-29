/**
 * @fileoverview PDF content component for dashboard export.
 * Renders a print-friendly summary of dashboard metrics, trends, and breakdowns.
 * @module pages/Dashboard/DashboardPDFContent
 */

import { sentimentHexColor } from '../../lib/sentiment'
import { TrendingUp, Smile, Siren, ChartColumn, Link } from 'lucide-react'
import { BreakdownTable } from './BreakdownTable'
import { PDF_REPORT_LOCALE, PdfIcon, PdfReport, PdfReportHeader, PdfSectionHeading, PdfShareCards } from '../../components/PdfParts/pdfParts'
import { PDF_TONES } from '../../components/PdfParts/pdfTones'
import { signedAverage } from '../../components/SentimentWords/sentimentWords'
import { formatDate } from '../../utils/dateUtils'
import { formatCount } from '../../utils/numberFormat'
import type { FeedbackItem } from '../../api/types'
import { cleanReviewText } from '../../utils/cleanReviewText'

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
  if (avgSentiment > 0) return PDF_TONES.ok.color
  if (avgSentiment < 0) return PDF_TONES.danger.color
  return PDF_TONES.muted.color
}

function HeaderSection({
  timeRange, totalFeedback, avgSentiment, urgentCount, sourcesCount,
}: DashboardPDFProps) {
  const stats = [
    {
      label: 'Total Feedback',
      value: formatCount(totalFeedback, PDF_REPORT_LOCALE),
      bg: '#f1e9ff',
      color: '#723acc',
    },
    {
      label: 'Avg Sentiment',
      value: signedAverage(avgSentiment, PDF_REPORT_LOCALE),
      bg: PDF_TONES.ok.bg,
      color: getHeaderSentimentColor(avgSentiment),
    },
    {
      label: 'Urgent Issues',
      value: formatCount(urgentCount, PDF_REPORT_LOCALE),
      ...PDF_TONES.danger,
    },
    {
      label: 'Sources Active',
      value: formatCount(sourcesCount, PDF_REPORT_LOCALE),
      bg: '#f1e9ff',
      color: '#723acc',
    },
  ]
  return (
    <PdfReportHeader
      title="Dashboard Report"
      subtitle={`Time range: ${timeRange}`}
      stats={stats}
      statMinWidth="130px"
    />
  )
}

function TrendSection({ dailyTotals }: { readonly dailyTotals: DailyTotal[] }) {
  if (dailyTotals.length === 0) return null
  const sorted = [...dailyTotals].sort((a, b) => a.date.localeCompare(b.date))
  const maxCount = Math.max(...sorted.map((d) => d.count), 1)
  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <PdfSectionHeading><PdfIcon icon={TrendingUp} />Feedback Volume Trend</PdfSectionHeading>
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
                color: '#5e5966',
              }}>{day.count > 0 ? day.count : ''}</span>
              <div style={{
                width: '100%',
                maxWidth: '24px',
                height: `${height}px`,
                backgroundColor: '#8e48ff',
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
        color: '#5e5966',
      }}>
        <span>{sorted[0]?.date}</span>
        <span>{sorted.at(-1)?.date}</span>
      </div>
    </div>
  )
}

function SentimentSection({ sentimentBreakdown }: { readonly sentimentBreakdown: BreakdownEntry[] }) {
  const total = sentimentBreakdown.reduce((sum, s) => sum + s.value, 0)
  const cards = sentimentBreakdown.map((s) => ({
    name: s.name,
    value: s.value,
    percentage: total > 0 ? (s.value / total) * 100 : 0,
    color: sentimentHexColor(s.name),
  }))
  return <PdfShareCards heading={<><PdfIcon icon={Smile} />Sentiment Distribution</>} cards={cards} minWidth="100px" />
}

function UrgentSection({ urgentItems }: { readonly urgentItems: readonly FeedbackItem[] }) {
  if (urgentItems.length === 0) return null
  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <PdfSectionHeading color={PDF_TONES.danger.color}><PdfIcon icon={Siren} color={PDF_TONES.danger.color} />Urgent Issues</PdfSectionHeading>
      {urgentItems.map((item) => (
        <UrgentItem key={item.feedback_id} item={item} />
      ))}
    </div>
  )
}

function UrgentItem({ item }: { readonly item: FeedbackItem }) {
  const dateStr = formatDate(item.source_created_at, PDF_REPORT_LOCALE)
  const shown = cleanReviewText(item.original_text)
  const text = shown.length > 200 ? shown.slice(0, 200) + '…' : shown
  return (
    <div data-pdf-section style={{
      padding: '10px 14px',
      borderLeft: `3px solid ${PDF_TONES.danger.color}`,
      marginBottom: '8px',
      backgroundColor: PDF_TONES.danger.bg,
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
          color: '#4a464f',
        }}>
          {item.source_platform} • {item.category}
        </span>
        <span style={{
          fontSize: '11px',
          color: '#5e5966',
        }}>{dateStr}</span>
      </div>
      <p style={{
        fontSize: '12px',
        color: '#4a464f',
        margin: '0 0 4px 0',
        lineHeight: '1.5',
      }}>{text}</p>
      {item.problem_summary != null && item.problem_summary !== '' ? (
        <p style={{
          fontSize: '11px',
          color: '#5e5966',
          margin: 0,
          fontStyle: 'italic',
        }}>Problem: {item.problem_summary}</p>
      ) : null}
    </div>
  )
}

export default function DashboardPDFContent(props: DashboardPDFProps) {
  return (
    <PdfReport
      header={<HeaderSection {...props} />}
      footer={`Generated on ${formatDate(new Date(), PDF_REPORT_LOCALE)} • VoC Analytics — Dashboard Report`}
    >
      <TrendSection dailyTotals={props.dailyTotals} />
      <SentimentSection sentimentBreakdown={props.sentimentBreakdown} />
      <div style={{
        display: 'flex',
        gap: '24px',
        flexWrap: 'wrap',
      }}>
        <BreakdownTable title="Categories" icon={ChartColumn} entries={props.categoryBreakdown} />
        <BreakdownTable title="Sources" icon={Link} entries={props.sourceBreakdown} colorFn={() => '#8e48ff'} />
      </div>
      <UrgentSection urgentItems={props.urgentItems} />
    </PdfReport>
  )
}
