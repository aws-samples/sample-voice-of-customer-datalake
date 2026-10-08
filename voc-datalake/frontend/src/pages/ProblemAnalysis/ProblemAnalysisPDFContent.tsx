/**
 * @fileoverview PDF content component for problem analysis export.
 * Renders a print-friendly view of the problem analysis tree.
 * @module pages/ProblemAnalysis/ProblemAnalysisPDFContent
 */

import { sentimentLabelFromScore } from '../../lib/sentiment'
import { CircleCheck, TriangleAlert, Lightbulb } from 'lucide-react'
import { PdfIcon, PdfReport, PdfReportHeader } from '../../components/PdfParts/pdfParts'

interface ProblemGroupPDF {
  readonly problem: string
  readonly similarProblems: string[]
  readonly rootCause: string | null
  readonly itemCount: number
  readonly avgSentiment: number
  readonly urgentCount: number
  readonly resolved?: boolean
}

interface SubcategoryGroupPDF {
  readonly subcategory: string
  readonly problems: ProblemGroupPDF[]
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

function getSentimentColor(score: number): string {
  if (score > 0) return '#007038'
  if (score < -0.3) return '#bd1c3a'
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
    sum + c.subcategories.reduce((s, sub) => s + sub.problems.length, 0), 0)
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
      bg: '#f0eee6',
      color: '#6b5900',
    },
    {
      label: 'Feedback Items',
      value: totalFeedback,
      bg: '#e0eee7',
      color: '#007038',
    },
    {
      label: 'Urgent',
      value: totalUrgent,
      bg: '#f8e8eb',
      color: '#bd1c3a',
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
  return (
    <div data-pdf-section style={{
      padding: '10px 16px',
      borderLeft: resolved ? '3px solid #007038' : '3px solid #6b5900',
      marginBottom: '8px',
      backgroundColor: resolved ? '#e0eee7' : '#f0eee6',
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
            {resolved ? <PdfIcon icon={CircleCheck} color="#007038" /> : <PdfIcon icon={TriangleAlert} color="#6b5900" />}{problem.problem}
            {resolved && (
              <span style={{
                fontSize: '10px',
                fontWeight: '600',
                color: '#007038',
                backgroundColor: '#e0eee7',
                borderRadius: '9999px',
                padding: '2px 8px',
                marginLeft: '8px',
              }}>
                {resolvedLabel.toUpperCase()}
              </span>
            )}
            {problem.similarProblems.length > 0 && (
              <span style={{
                fontSize: '11px',
                color: '#5e5966',
                fontWeight: 'normal',
              }}>
                {' '}(+{problem.similarProblems.length} similar)
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
          }}>{problem.itemCount} items</span>
          {problem.urgentCount > 0 && (
            <span style={{
              padding: '2px 8px',
              backgroundColor: '#f8e8eb',
              color: '#bd1c3a',
              borderRadius: '10px',
              fontSize: '11px',
              fontWeight: '500',
            }}>
              {problem.urgentCount} urgent
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
            {sentimentLabelFromScore(problem.avgSentiment).replace(/^./, (c) => c.toUpperCase())} ({problem.avgSentiment.toFixed(2)})
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
          textTransform: 'capitalize',
        }}>
          {subcategory.subcategory.replaceAll('_', ' ')}
        </h3>
        <span style={{
          fontSize: '12px',
          color: '#5e5966',
        }}>
          {subcategory.problems.length} problems • {subcategory.totalItems} items
        </span>
        {subcategory.urgentCount > 0 && (
          <span style={{
            padding: '2px 8px',
            backgroundColor: '#f8e8eb',
            color: '#bd1c3a',
            borderRadius: '10px',
            fontSize: '11px',
          }}>
            {subcategory.urgentCount} urgent
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
          textTransform: 'capitalize',
        }}>
          {category.category.replaceAll('_', ' ')}
        </h2>
        <div style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          fontSize: '13px',
          color: '#5e5966',
        }}>
          <span>{category.subcategories.length} subcategories</span>
          <span>{category.totalItems} items</span>
          {category.urgentCount > 0 && (
            <span style={{
              padding: '2px 8px',
              backgroundColor: '#f8e8eb',
              color: '#bd1c3a',
              borderRadius: '10px',
              fontSize: '12px',
              fontWeight: '500',
            }}>
              {category.urgentCount} urgent
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
      footer={`Generated on ${new Date().toLocaleDateString()} • VoC Analytics — Problem Analysis Report`}
    >
      {props.categories.map((category) => (
        <CategorySection key={category.category} category={category} resolvedLabel={props.resolvedLabel} />
      ))}
    </PdfReport>
  )
}
