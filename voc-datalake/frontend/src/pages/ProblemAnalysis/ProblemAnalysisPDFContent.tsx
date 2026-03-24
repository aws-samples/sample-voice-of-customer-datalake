/**
 * @fileoverview PDF content component for problem analysis export.
 * Renders a print-friendly view of the problem analysis tree.
 * @module pages/ProblemAnalysis/ProblemAnalysisPDFContent
 */

interface ProblemGroupPDF {
  readonly problem: string
  readonly similarProblems: string[]
  readonly rootCause: string | null
  readonly itemCount: number
  readonly avgSentiment: number
  readonly urgentCount: number
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
  readonly filters?: {
    source?: string | null
    category?: string | null
    subcategory?: string | null
    urgentOnly?: boolean
  }
}

function getSentimentColor(score: number): string {
  if (score > 0) return '#16a34a'
  if (score < -0.3) return '#dc2626'
  return '#6b7280'
}

function getSentimentLabel(score: number): string {
  if (score > 0) return 'Positive'
  if (score < -0.3) return 'Negative'
  return 'Neutral'
}

function HeaderSection({ categories, timeRange, filters }: ProblemAnalysisPDFProps) {
  const totalProblems = categories.reduce((sum, c) =>
    sum + c.subcategories.reduce((s, sub) => s + sub.problems.length, 0), 0)
  const totalFeedback = categories.reduce((sum, c) => sum + c.totalItems, 0)
  const totalUrgent = categories.reduce((sum, c) => sum + c.urgentCount, 0)

  const activeFilters: string[] = []
  if (filters?.source) activeFilters.push(`Source: ${filters.source}`)
  if (filters?.category) activeFilters.push(`Category: ${filters.category}`)
  if (filters?.subcategory) activeFilters.push(`Subcategory: ${filters.subcategory}`)
  if (filters?.urgentOnly) activeFilters.push('Urgent only')

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h1 style={{ fontSize: '28px', fontWeight: 'bold', margin: '0 0 4px 0', color: '#111827' }}>
        Problem Analysis Report
      </h1>
      <p style={{ fontSize: '14px', color: '#6b7280', margin: '0 0 16px 0' }}>
        Time range: {timeRange}
        {activeFilters.length > 0 && ` • ${activeFilters.join(' • ')}`}
      </p>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        {[
          { label: 'Categories', value: categories.length, bg: '#f0f9ff', color: '#1d4ed8' },
          { label: 'Problems', value: totalProblems, bg: '#fef3c7', color: '#92400e' },
          { label: 'Feedback Items', value: totalFeedback, bg: '#f0fdf4', color: '#166534' },
          { label: 'Urgent', value: totalUrgent, bg: '#fef2f2', color: '#991b1b' },
        ].map(stat => (
          <div key={stat.label} style={{
            padding: '12px 20px', backgroundColor: stat.bg, borderRadius: '8px',
            minWidth: '120px',
          }}>
            <p style={{ fontSize: '12px', color: stat.color, fontWeight: '500', margin: '0 0 4px 0' }}>{stat.label}</p>
            <p style={{ fontSize: '24px', fontWeight: 'bold', color: stat.color, margin: 0 }}>{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProblemItem({ problem }: { readonly problem: ProblemGroupPDF }) {
  return (
    <div data-pdf-section style={{ padding: '10px 16px', borderLeft: '3px solid #f59e0b', marginBottom: '8px', backgroundColor: '#fffbeb', borderRadius: '0 6px 6px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: '13px', fontWeight: '600', color: '#1f2937', margin: '0 0 4px 0' }}>
            ⚠️ {problem.problem}
            {problem.similarProblems.length > 0 && (
              <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: 'normal' }}>
                {' '}(+{problem.similarProblems.length} similar)
              </span>
            )}
          </p>
          {problem.rootCause && (
            <p style={{ fontSize: '12px', color: '#6b7280', margin: '0 0 2px 0' }}>
              💡 {problem.rootCause}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: '12px', color: '#6b7280' }}>{problem.itemCount} items</span>
          {problem.urgentCount > 0 && (
            <span style={{ padding: '2px 8px', backgroundColor: '#fecaca', color: '#991b1b', borderRadius: '10px', fontSize: '11px', fontWeight: '500' }}>
              {problem.urgentCount} urgent
            </span>
          )}
          <span style={{ padding: '2px 8px', backgroundColor: '#f3f4f6', color: getSentimentColor(problem.avgSentiment), borderRadius: '10px', fontSize: '11px', fontWeight: '500' }}>
            {getSentimentLabel(problem.avgSentiment)} ({problem.avgSentiment.toFixed(2)})
          </span>
        </div>
      </div>
    </div>
  )
}

function SubcategorySection({ subcategory, categoryName }: { readonly subcategory: SubcategoryGroupPDF; readonly categoryName: string }) {
  return (
    <div data-pdf-section style={{ marginBottom: '16px', marginLeft: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: '600', color: '#374151', margin: 0, textTransform: 'capitalize' }}>
          {subcategory.subcategory.replace(/_/g, ' ')}
        </h3>
        <span style={{ fontSize: '12px', color: '#9ca3af' }}>
          {subcategory.problems.length} problems • {subcategory.totalItems} items
        </span>
        {subcategory.urgentCount > 0 && (
          <span style={{ padding: '2px 8px', backgroundColor: '#fecaca', color: '#991b1b', borderRadius: '10px', fontSize: '11px' }}>
            {subcategory.urgentCount} urgent
          </span>
        )}
      </div>
      {subcategory.problems.map((problem, i) => (
        <ProblemItem key={`${categoryName}-${subcategory.subcategory}-${i}`} problem={problem} />
      ))}
    </div>
  )
}

function CategorySection({ category }: { readonly category: CategoryGroupPDF }) {
  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', backgroundColor: '#f8fafc', borderRadius: '8px',
        borderLeft: '4px solid #3b82f6', marginBottom: '12px',
      }}>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#1e293b', margin: 0, textTransform: 'capitalize' }}>
          {category.category.replace(/_/g, ' ')}
        </h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', fontSize: '13px', color: '#64748b' }}>
          <span>{category.subcategories.length} subcategories</span>
          <span>{category.totalItems} items</span>
          {category.urgentCount > 0 && (
            <span style={{ padding: '2px 8px', backgroundColor: '#fecaca', color: '#991b1b', borderRadius: '10px', fontSize: '12px', fontWeight: '500' }}>
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
        />
      ))}
    </div>
  )
}

export default function ProblemAnalysisPDFContent(props: ProblemAnalysisPDFProps) {
  return (
    <div style={{ padding: '40px', backgroundColor: 'white' }}>
      <HeaderSection {...props} />
      <hr style={{ border: 'none', borderTop: '2px solid #e5e7eb', marginBottom: '24px' }} />
      {props.categories.map((category) => (
        <CategorySection key={category.category} category={category} />
      ))}
      <div data-pdf-section>
        <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', marginTop: '32px', marginBottom: '16px' }} />
        <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center' }}>
          Generated on {new Date().toLocaleDateString()} • VoC Analytics — Problem Analysis Report
        </p>
      </div>
    </div>
  )
}
