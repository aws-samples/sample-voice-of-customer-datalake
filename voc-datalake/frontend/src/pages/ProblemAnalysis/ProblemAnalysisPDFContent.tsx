/**
 * @fileoverview PDF content component for problem analysis export.
 * Renders a print-friendly view of the problem analysis tree.
 * @module pages/ProblemAnalysis/ProblemAnalysisPDFContent
 */

import { sentimentLabelFromScore } from '../../lib/sentiment'
import { CircleCheck, TriangleAlert, Lightbulb } from 'lucide-react'
import { PDF_REPORT_LOCALE, PdfIcon, PdfReport, PdfReportHeader } from '../../components/PdfParts/pdfParts'
import { PDF_TONES, pdfToneStyle } from '../../components/PdfParts/pdfTones'
import { signedAverage } from '../../components/SentimentWords/sentimentWords'
import { formatDate } from '../../utils/dateUtils'
import { formatCount } from '../../utils/numberFormat'
import { problemsLine } from './problemGrouping'

interface ProblemGroupPDF {
  readonly problem: string
  /** How many other wordings were merged into this problem. */
  readonly similarCount: number
  readonly rootCause: string | null
  readonly itemCount: number
  readonly avgSentiment: number
  readonly urgentCount: number
  readonly resolved?: boolean
}

interface SubcategoryGroupPDF {
  readonly subcategory: string
  readonly problems: ProblemGroupPDF[]
  /** Every problem of the subcategory; `problems` may list only the largest (`problems_truncated`). */
  readonly problemCount: number
  readonly totalItems: number
  readonly urgentCount: number
}

interface CategoryGroupPDF {
  readonly category: string
  readonly subcategories: SubcategoryGroupPDF[]
  readonly totalItems: number
  readonly urgentCount: number
}

export interface ProblemAnalysisPDFProps {
  readonly categories: CategoryGroupPDF[]
  readonly timeRange: string
  /** Translated badge text for resolved problems (the PDF renders outside
   * the i18n provider, so the page passes the resolved label in). Required
   * so a future call site can't silently ship untranslated. */
  readonly resolvedLabel: string
  readonly filters?: {
    source?: string | null
    category?: string | null
    subcategory?: string | null
    urgentOnly?: boolean
  }
}

/** A count as the report language writes it ("26,622"). */
function pdfCount(n: number): string {
  return formatCount(n, PDF_REPORT_LOCALE)
}

function getSentimentColor(score: number): string {
  if (score > 0) return PDF_TONES.ok.color
  if (score < -0.3) return PDF_TONES.danger.color
  return '#5e5966'
}

function buildActiveFilters(filters: ProblemAnalysisPDFProps['filters']): string[] {
  if (!filters) return []
  const entries: [string | null | undefined, string][] = [
    [filters.source, 'Source'],
    [filters.category, 'Category'],
    [filters.subcategory, 'Subcategory'],
  ]
  const result = entries
    .filter(([val]) => val != null && val !== '')
    .map(([val, label]) => `${label}: ${val}`)
  if (filters.urgentOnly === true) result.push('Urgent only')
  return result
}

function buildHeaderStats(categories: CategoryGroupPDF[]) {
  const totalProblems = categories.reduce((sum, c) =>
    sum + c.subcategories.reduce((s, sub) => s + sub.problemCount, 0), 0)
  const totalFeedback = categories.reduce((sum, c) => sum + c.totalItems, 0)
  const totalUrgent = categories.reduce((sum, c) => sum + c.urgentCount, 0)
  return [
    {
      label: 'Categories',
      value: categories.length,
      bg: '#f1e9ff',
      color: '#723acc',
    },
    {
      label: 'Problems',
      value: totalProblems,
      ...PDF_TONES.warn,
    },
    {
      label: 'Feedback Items',
      value: totalFeedback,
      ...PDF_TONES.ok,
    },
    {
      label: 'Urgent',
      value: totalUrgent,
      ...PDF_TONES.danger,
    },
  ]
}

function HeaderSection({
  categories, timeRange, filters,
}: ProblemAnalysisPDFProps) {
  const activeFilters = buildActiveFilters(filters)
  const subtitle = activeFilters.length > 0
    ? `Time range: ${timeRange} • ${activeFilters.join(' • ')}`
    : `Time range: ${timeRange}`

  return (
    <PdfReportHeader
      title="Problem Analysis Report"
      subtitle={subtitle}
      stats={buildHeaderStats(categories)}
      statMinWidth="120px"
    />
  )
}

function ProblemItem({ problem, resolvedLabel }: { readonly problem: ProblemGroupPDF; readonly resolvedLabel: string }) {
  const resolved = problem.resolved === true
  const tone = PDF_TONES[resolved ? 'ok' : 'warn']
  return (
    <div data-pdf-section style={{
      padding: '10px 16px',
      borderLeft: `3px solid ${tone.color}`,
      marginBottom: '8px',
      backgroundColor: tone.bg,
      borderRadius: '0 6px 6px 0',
      opacity: resolved ? 0.75 : 1,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '12px',
      }}>
        <div style={{ flex: 1 }}>
          <p style={{
            fontSize: '13px',
            fontWeight: '600',
            color: '#19161d',
            margin: '0 0 4px 0',
          }}>
            <PdfIcon icon={resolved ? CircleCheck : TriangleAlert} color={tone.color} />{problem.problem}
            {resolved && (
              <span style={{
                fontSize: '10px',
                fontWeight: '600',
                ...pdfToneStyle('ok'),
                borderRadius: '9999px',
                padding: '2px 8px',
                marginLeft: '8px',
              }}>
                {resolvedLabel.toUpperCase()}
              </span>
            )}
            {problem.similarCount > 0 && (
              <span style={{
                fontSize: '11px',
                color: '#5e5966',
                fontWeight: 'normal',
              }}>
                {' '}(+{pdfCount(problem.similarCount)} similar)
              </span>
            )}
          </p>
          {problem.rootCause != null && problem.rootCause !== '' ? <p style={{
            fontSize: '12px',
            color: '#5e5966',
            margin: '0 0 2px 0',
          }}>
            <PdfIcon icon={Lightbulb} color="#5e5966" />{problem.rootCause}
          </p> : null}
        </div>
        <div style={{
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: '12px',
            color: '#5e5966',
          }}>{pdfCount(problem.itemCount)} items</span>
          {problem.urgentCount > 0 && (
            <span style={{
              padding: '2px 8px',
              ...pdfToneStyle('danger'),
              borderRadius: '10px',
              fontSize: '11px',
              fontWeight: '500',
            }}>
              {pdfCount(problem.urgentCount)} urgent
            </span>
          )}
          <span style={{
            padding: '2px 8px',
            backgroundColor: '#f5f5f5',
            color: getSentimentColor(problem.avgSentiment),
            borderRadius: '10px',
            fontSize: '11px',
            fontWeight: '500',
          }}>
            {sentimentLabelFromScore(problem.avgSentiment).replace(/^./, (c) => c.toUpperCase())} ({signedAverage(problem.avgSentiment, PDF_REPORT_LOCALE)})
          </span>
        </div>
      </div>
    </div>
  )
}

function SubcategorySection({
  subcategory, categoryName, resolvedLabel,
}: {
  readonly subcategory: SubcategoryGroupPDF;
  readonly categoryName: string;
  readonly resolvedLabel: string
}) {
  return (
    <div data-pdf-section style={{
      marginBottom: '16px',
      marginLeft: '16px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '8px',
      }}>
        <h3 style={{
          fontSize: '15px',
          fontWeight: '600',
          color: '#4a464f',
          margin: 0,
        }}>
          {subcategory.subcategory}
        </h3>
        <span style={{
          fontSize: '12px',
          color: '#5e5966',
        }}>
          {problemsLine(subcategory)} • {pdfCount(subcategory.totalItems)} items
        </span>
        {subcategory.urgentCount > 0 && (
          <span style={{
            padding: '2px 8px',
            ...pdfToneStyle('danger'),
            borderRadius: '10px',
            fontSize: '11px',
          }}>
            {pdfCount(subcategory.urgentCount)} urgent
          </span>
        )}
      </div>
      {subcategory.problems.map((problem) => (
        <ProblemItem key={`${categoryName}-${subcategory.subcategory}-${problem.problem}`} problem={problem} resolvedLabel={resolvedLabel} />
      ))}
    </div>
  )
}

function CategorySection({ category, resolvedLabel }: { readonly category: CategoryGroupPDF; readonly resolvedLabel: string }) {
  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        backgroundColor: '#f5f5f5',
        borderRadius: '8px',
        borderLeft: '4px solid #8e48ff',
        marginBottom: '12px',
      }}>
        <h2 style={{
          fontSize: '18px',
          fontWeight: '700',
          color: '#19161d',
          margin: 0,
        }}>
          {category.category}
        </h2>
        <div style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          fontSize: '13px',
          color: '#5e5966',
        }}>
          <span>{pdfCount(category.subcategories.length)} subcategories</span>
          <span>{pdfCount(category.totalItems)} items</span>
          {category.urgentCount > 0 && (
            <span style={{
              padding: '2px 8px',
              ...pdfToneStyle('danger'),
              borderRadius: '10px',
              fontSize: '12px',
              fontWeight: '500',
            }}>
              {pdfCount(category.urgentCount)} urgent
            </span>
          )}
        </div>
      </div>
      {category.subcategories.map((sub) => (
        <SubcategorySection
          key={`${category.category}-${sub.subcategory}`}
          subcategory={sub}
          categoryName={category.category}
          resolvedLabel={resolvedLabel}
        />
      ))}
    </div>
  )
}

export default function ProblemAnalysisPDFContent(props: ProblemAnalysisPDFProps) {
  return (
    <PdfReport
      header={<HeaderSection {...props} />}
      footer={`Generated on ${formatDate(new Date(), PDF_REPORT_LOCALE)} • VoC Analytics — Problem Analysis Report`}
    >
      {props.categories.map((category) => (
        <CategorySection key={category.category} category={category} resolvedLabel={props.resolvedLabel} />
      ))}
    </PdfReport>
  )
}
