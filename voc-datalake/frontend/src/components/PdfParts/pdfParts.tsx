/**
 * @fileoverview Shared print-friendly building blocks for the PDF report
 * exports (Dashboard, Categories, Problem Analysis, persona export). Inline styles only: the
 * report is rasterised off-screen, outside the app stylesheet.
 * @module components/PdfParts/pdfParts
 */

import type { CSSProperties, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { humanizeId } from '../../utils/displayLabels'
import { formatCount, formatDecimal } from '../../utils/numberFormat'
import { pdfZebraRow } from './pdfTones'

/**
 * The language of the reports' fixed wording ("Generated on", "Urgent Issues"): English. Their
 * dates and numbers are written in it too, so a report never mixes English words with another
 * locale's dates. A report whose words are translated passes the reader's language instead.
 */
export const PDF_REPORT_LOCALE = 'en'

/**
 * An inline section icon for the PDF reports (lucide SVG, rasterised with the
 * page) — the reports use the same icon set as the app, never emojis.
 */
export function PdfIcon({ icon: Icon, color }: { readonly icon: LucideIcon; readonly color?: string }) {
  return <Icon size={16} color={color} aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: '6px' }} />
}

export interface PdfStat {
  readonly label: string
  /** A number is grouped in the report language ("26,622"); a string is shown as given. */
  readonly value: string | number
  readonly bg: string
  readonly color: string
}

export function PdfSectionHeading({
  children, color = '#19161d',
}: {
  readonly children: ReactNode
  readonly color?: string
}) {
  return (
    <h2 style={{
      fontSize: '18px',
      fontWeight: '600',
      color,
      marginBottom: '12px',
    }}>{children}</h2>
  )
}

function PdfStatCard({
  stat, minWidth, valueSize,
}: {
  readonly stat: PdfStat
  readonly minWidth: string
  readonly valueSize: string
}) {
  return (
    <div style={{
      padding: '12px 20px',
      backgroundColor: stat.bg,
      borderRadius: '8px',
      minWidth,
    }}>
      <p style={{
        fontSize: '12px',
        color: stat.color,
        fontWeight: '500',
        margin: '0 0 4px 0',
      }}>{stat.label}</p>
      <p style={{
        fontSize: valueSize,
        fontWeight: 'bold',
        color: stat.color,
        margin: 0,
      }}>{typeof stat.value === 'number' ? formatCount(stat.value, PDF_REPORT_LOCALE) : stat.value}</p>
    </div>
  )
}

/** Report title, subtitle line and a row of coloured stat cards. */
export function PdfReportHeader({
  title, subtitle, stats, statMinWidth, statValueSize = '24px',
}: {
  readonly title: ReactNode
  readonly subtitle: ReactNode
  readonly stats: readonly PdfStat[]
  readonly statMinWidth: string
  readonly statValueSize?: string
}) {
  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h1 style={{
        fontSize: '28px',
        fontWeight: 'bold',
        margin: '0 0 4px 0',
        color: '#19161d',
      }}>{title}</h1>
      <p style={{
        fontSize: '14px',
        color: '#5e5966',
        margin: '0 0 16px 0',
      }}>{subtitle}</p>
      <div style={{
        display: 'flex',
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        {stats.map((stat) => (
          <PdfStatCard key={stat.label} stat={stat} minWidth={statMinWidth} valueSize={statValueSize} />
        ))}
      </div>
    </div>
  )
}

/** Page frame: header, a divider, the body sections, and a centred footer line. */
export function PdfReport({
  header, footer, children,
}: {
  readonly header: ReactNode
  readonly footer: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div style={{
      padding: '40px',
      backgroundColor: 'white',
    }}>
      {header}
      <hr style={{
        border: 'none',
        borderTop: '2px solid #e4e4e7',
        marginBottom: '24px',
      }} />
      {children}
      <div data-pdf-section>
        <hr style={{
          border: 'none',
          borderTop: '1px solid #e4e4e7',
          marginTop: '32px',
          marginBottom: '16px',
        }} />
        <p style={{
          fontSize: '11px',
          color: '#5e5966',
          textAlign: 'center',
        }}>{footer}</p>
      </div>
    </div>
  )
}

function ColorDot({ color, inline = false }: { readonly color: string; readonly inline?: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      backgroundColor: color,
      ...(inline ? {
        marginRight: '8px',
        verticalAlign: 'middle',
      } : {}),
    }} />
  )
}

export interface PdfShareCard {
  readonly name: string
  readonly value: number
  /** The entry's share, 0–100; printed with one decimal. */
  readonly percentage: number
  readonly color: string
}

/** One bordered card per entry: dot + name, the count, and its share. */
export function PdfShareCards({
  heading, cards, minWidth, locale = PDF_REPORT_LOCALE,
}: {
  readonly heading: ReactNode
  readonly cards: readonly PdfShareCard[]
  readonly minWidth: string
  /** The language the numbers are written in: the report's, unless its words are translated. */
  readonly locale?: string
}) {
  if (cards.length === 0) return null
  return (
    <div data-pdf-section style={{ marginBottom: '28px' }}>
      <PdfSectionHeading>{heading}</PdfSectionHeading>
      <div style={{
        display: 'flex',
        gap: '12px',
        flexWrap: 'wrap',
      }}>
        {cards.map((card) => (
          <div key={card.name} data-pdf-section style={{
            padding: '12px 20px',
            borderRadius: '8px',
            border: '1px solid #e4e4e7',
            flex: '1',
            minWidth,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '4px',
            }}>
              <ColorDot color={card.color} />
              <span style={{
                fontSize: '13px',
                fontWeight: '500',
                color: '#4a464f',
                textTransform: 'capitalize',
              }}>{card.name}</span>
            </div>
            <p style={{
              fontSize: '22px',
              fontWeight: 'bold',
              color: '#19161d',
              margin: '0 0 2px 0',
            }}>{formatCount(card.value, locale)}</p>
            <p style={{
              fontSize: '12px',
              color: '#5e5966',
              margin: 0,
            }}>{formatDecimal(card.percentage, locale, 1)}%</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export interface PdfShareRow {
  readonly name: string
  readonly value: number
  readonly color: string
}

interface ShareTableSize {
  readonly cellPadding: string
  readonly barHeight: number
  readonly countWidth: string
  readonly barWidth: string
}

const COMPACT: ShareTableSize = {
  cellPadding: '6px 8px',
  barHeight: 12,
  countWidth: '60px',
  barWidth: '140px',
}
const REGULAR: ShareTableSize = {
  cellPadding: '8px 12px',
  barHeight: 16,
  countWidth: '80px',
  barWidth: '200px',
}

function headerCell(size: ShareTableSize, align: 'left' | 'right', width?: string) {
  return {
    textAlign: align,
    padding: size.cellPadding,
    color: '#5e5966',
    fontWeight: '600',
    ...(width === undefined ? {} : { width }),
  }
}

function ShareBar({ percentage, color, height }: { readonly percentage: number; readonly color: string; readonly height: number }) {
  const radius = `${height / 2}px`
  return (
    <div style={{
      width: '100%',
      height: `${height}px`,
      backgroundColor: '#f5f5f5',
      borderRadius: radius,
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${percentage}%`,
        height: '100%',
        backgroundColor: color,
        borderRadius: radius,
        minWidth: percentage > 0 ? `${height / 4}px` : '0',
      }} />
    </div>
  )
}

/**
 * Name / count / share / bar table. `regular` is the roomier variant with a
 * colour dot before each name; `compact` fits two tables side by side.
 */
export function PdfShareTable({
  heading, labels, rows, total, variant, containerStyle, locale = PDF_REPORT_LOCALE,
}: {
  readonly heading: ReactNode
  readonly labels: { readonly name: string; readonly count: string; readonly share: string; readonly bar: string }
  readonly rows: readonly PdfShareRow[]
  readonly total: number
  readonly variant: 'compact' | 'regular'
  readonly containerStyle?: CSSProperties
  /** The language the numbers are written in: the report's, unless its words are translated. */
  readonly locale?: string
}) {
  if (rows.length === 0) return null
  const size = variant === 'compact' ? COMPACT : REGULAR
  const showDot = variant === 'regular'
  return (
    <div data-pdf-section style={{
      marginBottom: '28px',
      ...containerStyle,
    }}>
      <PdfSectionHeading>{heading}</PdfSectionHeading>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '13px',
      }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e4e4e7' }}>
            <th style={headerCell(size, 'left')}>{labels.name}</th>
            <th style={headerCell(size, 'right', size.countWidth)}>{labels.count}</th>
            <th style={headerCell(size, 'right', size.countWidth)}>{labels.share}</th>
            <th style={headerCell(size, 'left', size.barWidth)}>{labels.bar}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const percentage = total > 0 ? (row.value / total) * 100 : 0
            return (
              <tr key={row.name} style={pdfZebraRow(i)}>
                <td style={{
                  padding: size.cellPadding,
                  fontWeight: '500',
                  color: '#19161d',
                }}>
                  {showDot ? <ColorDot color={row.color} inline /> : null}
                  {humanizeId(row.name)}
                </td>
                <td style={{
                  textAlign: 'right',
                  padding: size.cellPadding,
                  color: '#4a464f',
                }}>{formatCount(row.value, locale)}</td>
                <td style={{
                  textAlign: 'right',
                  padding: size.cellPadding,
                  color: '#4a464f',
                }}>{formatDecimal(percentage, locale, 1)}%</td>
                <td style={{ padding: size.cellPadding }}>
                  <ShareBar percentage={percentage} color={row.color} height={size.barHeight} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
