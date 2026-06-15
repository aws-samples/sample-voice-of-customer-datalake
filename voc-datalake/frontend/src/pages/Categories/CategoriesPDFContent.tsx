/**
 * @fileoverview PDF content component for categories analysis export.
 * Renders a print-friendly view of category breakdown, sentiment, and keywords.
 * @module pages/Categories/CategoriesPDFContent
 */

import { useTranslation } from 'react-i18next'

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
}

function getSentimentLabel(avgSentiment: number, t: (key: string) => string): string {
  if (avgSentiment > 20) return t('positive')
  if (avgSentiment < -20) return t('negative')
  return t('neutral')
}

function getSentimentHeaderColor(avgSentiment: number): string {
  if (avgSentiment > 20) return '#166534'
  if (avgSentiment < -20) return '#991b1b'
  return '#374151'
}

function HeaderSection({
  categoryData, totalIssues, avgSentiment, timeRange, selectedSource,
}: CategoriesPDFProps) {
  const { t } = useTranslation('categories')
  const sentimentLabel = getSentimentLabel(avgSentiment, t)
  const sentimentColor = getSentimentHeaderColor(avgSentiment)

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h1 style={{
        fontSize: '28px',
        fontWeight: 'bold',
        margin: '0 0 4px 0',
        color: '#111827',
      }}>
        {t('pdf.title')}
      </h1>
      <p style={{
        fontSize: '14px',
        color: '#6b7280',
        margin: '0 0 16px 0',
      }}>
        {selectedSource != null && selectedSource !== ''
          ? t('pdf.timeRangeWithSource', {
            range: timeRange,
            source: selectedSource,
          })
          : t('pdf.timeRange', { range: timeRange })}
      </p>
      <div style={{
        display: 'flex',
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        {[
          {
            label: t('pdf.categoriesLabel'),
            value: String(categoryData.length),
            bg: '#f0f9ff',
            color: '#1d4ed8',
          },
          {
            label: t('pdf.totalFeedback'),
            value: String(totalIssues),
            bg: '#f0fdf4',
            color: '#166534',
          },
          {
            label: t('pdf.sentimentLabel'),
            value: `${sentimentLabel} (${avgSentiment.toFixed(0)}%)`,
            bg: '#faf5ff',
            color: sentimentColor,
          },
        ].map((stat) => (
          <div key={stat.label} style={{
            padding: '12px 20px',
            backgroundColor: stat.bg,
            borderRadius: '8px',
            minWidth: '140px',
          }}>
            <p style={{
              fontSize: '12px',
              color: stat.color,
              fontWeight: '500',
              margin: '0 0 4px 0',
            }}>{stat.label}</p>
            <p style={{
              fontSize: '20px',
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

function CategoryBreakdownSection({
  categoryData, totalIssues,
}: {
  readonly categoryData: CategoryDataPDF[];
  readonly totalIssues: number
}) {
  const { t } = useTranslation('categories')

  if (categoryData.length === 0) return null

  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#1e293b',
        marginBottom: '12px',
      }}>{t('pdf.categoryBreakdown')}</h2>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '13px',
      }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
            <th style={{
              textAlign: 'left',
              padding: '8px 12px',
              color: '#6b7280',
              fontWeight: '600',
            }}>{t('pdf.category')}</th>
            <th style={{
              textAlign: 'right',
              padding: '8px 12px',
              color: '#6b7280',
              fontWeight: '600',
              width: '80px',
            }}>{t('pdf.count')}</th>
            <th style={{
              textAlign: 'right',
              padding: '8px 12px',
              color: '#6b7280',
              fontWeight: '600',
              width: '80px',
            }}>{t('pdf.share')}</th>
            <th style={{
              textAlign: 'left',
              padding: '8px 12px',
              color: '#6b7280',
              fontWeight: '600',
              width: '200px',
            }}>{t('pdf.distribution')}</th>
          </tr>
        </thead>
        <tbody>
          {categoryData.map((cat, i) => {
            const percentage = totalIssues > 0 ? (cat.value / totalIssues) * 100 : 0
            return (
              <tr key={cat.name} style={{
                borderBottom: '1px solid #f3f4f6',
                backgroundColor: i % 2 === 0 ? '#ffffff' : '#f9fafb',
              }}>
                <td style={{
                  padding: '8px 12px',
                  textTransform: 'capitalize',
                  fontWeight: '500',
                  color: '#1f2937',
                }}>
                  <span style={{
                    display: 'inline-block',
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: cat.color,
                    marginRight: '8px',
                    verticalAlign: 'middle',
                  }} />
                  {cat.name.replaceAll('_', ' ')}
                </td>
                <td style={{
                  textAlign: 'right',
                  padding: '8px 12px',
                  color: '#374151',
                }}>{cat.value}</td>
                <td style={{
                  textAlign: 'right',
                  padding: '8px 12px',
                  color: '#374151',
                }}>{percentage.toFixed(1)}%</td>
                <td style={{ padding: '8px 12px' }}>
                  <div style={{
                    width: '100%',
                    height: '16px',
                    backgroundColor: '#f3f4f6',
                    borderRadius: '8px',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${percentage}%`,
                      height: '100%',
                      backgroundColor: cat.color,
                      borderRadius: '8px',
                      minWidth: percentage > 0 ? '4px' : '0',
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

function SentimentSection({ sentimentData }: { readonly sentimentData: SentimentDataPDF[] }) {
  const { t } = useTranslation('categories')

  if (sentimentData.length === 0) return null

  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#1e293b',
        marginBottom: '12px',
      }}>{t('pdf.sentimentDistribution')}</h2>
      <div style={{
        display: 'flex',
        gap: '12px',
        flexWrap: 'wrap',
      }}>
        {sentimentData.map((s) => (
          <div key={s.name} data-pdf-section style={{
            padding: '12px 20px',
            borderRadius: '8px',
            border: '1px solid #e5e7eb',
            minWidth: '120px',
            flex: '1',
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
                backgroundColor: s.color,
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
            }}>{s.percentage.toFixed(1)}%</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function KeywordsSection({ wordCloudData }: { readonly wordCloudData: WordCloudItemPDF[] }) {
  const { t } = useTranslation('categories')

  if (wordCloudData.length === 0) return null

  const maxCount = wordCloudData[0]?.count ?? 1

  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#1e293b',
        marginBottom: '12px',
      }}>{t('pdf.topKeywords')}</h2>
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
              {item.word} ({item.count})
            </span>
          )
        })}
      </div>
    </div>
  )
}

export default function CategoriesPDFContent(props: CategoriesPDFProps) {
  const { t } = useTranslation('categories')

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
      <CategoryBreakdownSection categoryData={props.categoryData} totalIssues={props.totalIssues} />
      <SentimentSection sentimentData={props.sentimentData} />
      <KeywordsSection wordCloudData={props.wordCloudData} />
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
          {t('pdf.generatedOn', { date: new Date().toLocaleDateString() })}
        </p>
      </div>
    </div>
  )
}
