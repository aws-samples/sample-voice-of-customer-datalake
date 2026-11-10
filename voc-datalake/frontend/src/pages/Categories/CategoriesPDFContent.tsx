/**
 * @fileoverview PDF content component for categories analysis export.
 * Renders a print-friendly view of category breakdown, sentiment, and keywords.
 * @module pages/Categories/CategoriesPDFContent
 */

import { ChartColumn, KeyRound, Smile } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '../../api/types'
import { PdfIcon, PdfReport, PdfReportHeader, PdfSectionHeading, PdfShareCards, PdfShareTable } from '../../components/PdfParts/pdfParts'
import { PDF_TONES } from '../../components/PdfParts/pdfTones'
import { FeedbackTableSection } from './FeedbackPDFContent'
import { formatDate } from '../../utils/dateUtils'
import { formatCount, formatDecimal } from '../../utils/numberFormat'

interface CategoryDataPDF {
  readonly name: string
  readonly value: number
  readonly color: string
}

interface SentimentDataPDF {
  readonly name: string
  readonly value: number
  readonly percentage: number
  readonly color: string
}

interface WordCloudItemPDF {
  readonly word: string
  readonly count: number
}

export interface CategoriesPDFProps {
  readonly categoryData: CategoryDataPDF[]
  readonly sentimentData: SentimentDataPDF[]
  readonly wordCloudData: WordCloudItemPDF[]
  readonly totalIssues: number
  readonly avgSentiment: number
  readonly timeRange: string
  readonly selectedSource?: string | null
  /** Currently filtered feedback items, appended as a table after the analytics sections. */
  readonly items?: readonly FeedbackItem[]
}

function getSentimentLabel(avgSentiment: number, t: (key: string) => string): string {
  if (avgSentiment > 20) return t('positive')
  if (avgSentiment < -20) return t('negative')
  return t('neutral')
}

function getSentimentHeaderColor(avgSentiment: number): string {
  if (avgSentiment > 20) return PDF_TONES.ok.color
  if (avgSentiment < -20) return PDF_TONES.danger.color
  return PDF_TONES.muted.color
}

function HeaderSection({
  categoryData, totalIssues, avgSentiment, timeRange, selectedSource,
}: CategoriesPDFProps) {
  const { t, i18n } = useTranslation('categories')
  const sentimentLabel = getSentimentLabel(avgSentiment, t)
  const stats = [
    {
      label: t('pdf.categoriesLabel'),
      value: formatCount(categoryData.length, i18n.language),
      bg: '#f1e9ff',
      color: '#723acc',
    },
    {
      label: t('pdf.totalFeedback'),
      value: formatCount(totalIssues, i18n.language),
      ...PDF_TONES.ok,
    },
    {
      label: t('pdf.sentimentLabel'),
      value: `${sentimentLabel} (${formatDecimal(avgSentiment, i18n.language, 0)}%)`,
      bg: '#f1e9ff',
      color: getSentimentHeaderColor(avgSentiment),
    },
  ]
  const subtitle = selectedSource != null && selectedSource !== ''
    ? t('pdf.timeRangeWithSource', {
      range: timeRange,
      source: selectedSource,
    })
    : t('pdf.timeRange', { range: timeRange })

  return (
    <PdfReportHeader
      title={t('pdf.title')}
      subtitle={subtitle}
      stats={stats}
      statMinWidth="140px"
      statValueSize="20px"
    />
  )
}

function CategoryBreakdownSection({
  categoryData, totalIssues,
}: {
  readonly categoryData: CategoryDataPDF[];
  readonly totalIssues: number
}) {
  const { t, i18n } = useTranslation('categories')
  const labels = {
    name: t('pdf.category'),
    count: t('pdf.count'),
    share: t('pdf.share'),
    bar: t('pdf.distribution'),
  }
  return (
    <PdfShareTable
      heading={<><PdfIcon icon={ChartColumn} />{t('pdf.categoryBreakdown')}</>}
      labels={labels}
      rows={categoryData}
      total={totalIssues}
      variant="regular"
      locale={i18n.language}
    />
  )
}

function SentimentSection({ sentimentData }: { readonly sentimentData: SentimentDataPDF[] }) {
  const { t, i18n } = useTranslation('categories')
  const cards = sentimentData.map((s) => ({
    name: s.name,
    value: s.value,
    percentage: s.percentage,
    color: s.color,
  }))
  return <PdfShareCards heading={<><PdfIcon icon={Smile} />{t('pdf.sentimentDistribution')}</>} cards={cards} minWidth="120px" locale={i18n.language} />
}

function KeywordsSection({ wordCloudData }: { readonly wordCloudData: WordCloudItemPDF[] }) {
  const { t, i18n } = useTranslation('categories')

  if (wordCloudData.length === 0) return null

  const maxCount = wordCloudData[0]?.count ?? 1

  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <PdfSectionHeading><PdfIcon icon={KeyRound} />{t('pdf.topKeywords')}</PdfSectionHeading>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
      }}>
        {wordCloudData.map((item) => {
          const intensity = Math.max(0.3, item.count / maxCount)
          const fontSize = 11 + Math.round(intensity * 8)
          return (
            <span key={item.word} style={{
              padding: '4px 10px',
              backgroundColor: `rgba(59, 130, 246, ${intensity * 0.15})`,
              color: `rgba(30, 64, 175, ${0.5 + intensity * 0.5})`,
              borderRadius: '6px',
              fontSize: `${fontSize}px`,
              fontWeight: intensity > 0.6 ? '600' : '400',
            }}>
              {item.word} ({formatCount(item.count, i18n.language)})
            </span>
          )
        })}
      </div>
    </div>
  )
}

export default function CategoriesPDFContent(props: CategoriesPDFProps) {
  const { t, i18n } = useTranslation('categories')

  return (
    <PdfReport
      header={<HeaderSection {...props} />}
      footer={t('pdf.generatedOn', { date: formatDate(new Date(), i18n.language) })}
    >
      <CategoryBreakdownSection categoryData={props.categoryData} totalIssues={props.totalIssues} />
      <SentimentSection sentimentData={props.sentimentData} />
      <KeywordsSection wordCloudData={props.wordCloudData} />
      <FeedbackTableSection items={props.items ?? []} />
    </PdfReport>
  )
}
