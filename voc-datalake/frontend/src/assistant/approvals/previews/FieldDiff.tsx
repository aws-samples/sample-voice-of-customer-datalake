/**
 * @fileoverview The field table and the before → after diff the approval
 * cards of the record-writing tools share (connectors, users): one row per
 * saved field, in a fixed order, each with a `compare` string so an update can
 * diff row by row and collapse what is unchanged. Deterministic — every row is
 * computed from the validated args (and the stored record read fresh at
 * render), never from model prose.
 *
 * @module assistant/approvals/previews/FieldDiff
 */
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import type { ReactNode } from 'react'

export interface FieldRow {
  key: string
  label: string
  value: ReactNode
  /** Stable text of the saved value (diffing compares this, never the rendered node). */
  compare: string
  /** Technical (CSS selectors, ids, paging): shown behind the card's "Details" disclosure. */
  technical?: boolean
}

/** Label column + value column, shared by the field table and the diff. */
const FIELD_GRID = 'grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5 text-sm'

/** A one-line note under a table, with the info icon the cards use. */
export function CardNote({ text }: Readonly<{ text: string }>) {
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-text">
      <Info className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
      {text}
    </p>
  )
}

export function NothingSavedNote() {
  const { t } = useTranslation('assistantTools')
  return <CardNote text={t('preview.scraper.nothingSaved')} />
}

function FieldRows({ rows, label }: Readonly<{ rows: readonly FieldRow[]; label: string }>) {
  return (
    <dl aria-label={label} className={FIELD_GRID}>
      {rows.map((row) => (
        <div key={row.key} className="contents" data-testid={`field-${row.key}`}>
          <dt className="text-[12px] font-medium text-muted">{row.label}</dt>
          <dd className="min-w-0 break-words text-text">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A collapsed "Details" section: the technical part of a card, there for whoever wants it. */
export function DetailsDisclosure({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-[12px] font-medium text-muted">{t('card.details')}</summary>
      <div className="mt-1.5">{children}</div>
    </details>
  )
}

/** The saved fields; the technical ones (selectors, ids, paging) collapsed under "Details". */
export function FieldTable({ rows, label }: Readonly<{ rows: readonly FieldRow[]; label: string }>) {
  const plain = rows.filter((row) => row.technical !== true)
  const technical = rows.filter((row) => row.technical === true)
  return (
    <div className="space-y-2">
      <FieldRows rows={plain} label={label} />
      {technical.length > 0 && <DetailsDisclosure><FieldRows rows={technical} label={label} /></DetailsDisclosure>}
    </div>
  )
}

function DiffRow({ before, after }: Readonly<{ before: FieldRow; after: FieldRow }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <div className="contents" data-testid={`diff-${after.key}`}>
      <dt className="text-[12px] font-medium text-muted">{after.label}</dt>
      <dd className="min-w-0 break-words space-y-0.5">
        <div className="text-muted line-through decoration-muted/60"><span className="sr-only">{t('preview.before')}: </span>{before.value}</div>
        <div className="text-text-strong"><span className="sr-only">{t('preview.after')}: </span>{after.value}</div>
      </dd>
    </div>
  )
}

/** The changed rows before → after (compared on `compare`), the unchanged ones collapsed under a summary. */
export function FieldDiff({ beforeRows, afterRows }: Readonly<{ beforeRows: readonly FieldRow[]; afterRows: readonly FieldRow[] }>) {
  const { t } = useTranslation('assistantTools')
  const pairs = afterRows.map((after, i) => ({ after, before: beforeRows[i] ?? after }))
  const changed = pairs.filter(({ before, after }) => before.compare !== after.compare)
  const unchanged = pairs.filter(({ before, after }) => before.compare === after.compare).map(({ after }) => after)
  return (
    <div className="space-y-2">
      <dl aria-label={t('preview.scraper.changedFields')} className={FIELD_GRID}>
        {changed.map(({ before, after }) => <DiffRow key={after.key} before={before} after={after} />)}
      </dl>
      {changed.length === 0 && <p className="text-[12px] text-muted">{t('preview.scraper.noChange')}</p>}
      {unchanged.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-[12px] text-muted">{t('preview.scraper.unchangedFields', { count: unchanged.length })}</summary>
          <div className="mt-1.5"><FieldTable rows={unchanged} label={t('preview.unchanged')} /></div>
        </details>
      )}
    </div>
  )
}
