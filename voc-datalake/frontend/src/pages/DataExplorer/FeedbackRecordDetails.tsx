/**
 * @fileoverview A processed feedback record as a person reads it: the fields
 * that matter, labelled, with the stored JSON one click away ("Show raw JSON")
 * for the people who need it.
 * @module pages/DataExplorer/FeedbackRecordDetails
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '../../api/types'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { formatDate } from '../../utils/dateUtils'
import { cleanReviewText } from '../../utils/cleanReviewText'

type Row = readonly [labelKey: string, value: string | undefined]

function text(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const s = String(value).trim()
  return s === '' ? undefined : s
}

function useRows(item: FeedbackItem): readonly Row[] {
  const labels = useDisplayLabels()
  const { i18n } = useTranslation()
  return [
    ['details.title', text(cleanReviewText(item.title))],
    ['details.text', text(cleanReviewText(item.original_text))],
    ['details.source', labels.source(item.source_platform)],
    ['details.date', text(formatDate(item.source_created_at, i18n.language))],
    ['details.category', item.category ? labels.theme(item.category, item.subcategory) : undefined],
    ['details.rating', text(item.rating)],
    ['details.language', text(item.original_language)?.toUpperCase()],
    ['details.author', text(item.author)],
    ['details.problem', text(item.problem_summary)],
    ['details.persona', text(item.persona_name)],
  ]
}

export default function FeedbackRecordDetails({ item, id }: Readonly<{ item: FeedbackItem; id: string }>) {
  const { t } = useTranslation('dataExplorer')
  const [showRaw, setShowRaw] = useState(false)
  const rows = useRows(item).filter(([, value]) => value !== undefined)
  const rawId = `${id}-raw`
  return (
    <div id={id} className="mt-3 p-3 bg-bg-accent border border-border rounded-lg text-sm space-y-3">
      <dl className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5">
        {rows.map(([labelKey, value]) => (
          <div key={labelKey} className="contents">
            <dt className="text-xs text-muted sm:pt-0.5">{t(labelKey)}</dt>
            <dd className="text-text-strong break-words whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className="link text-xs focus-ring rounded-sm" aria-expanded={showRaw} aria-controls={rawId}
        onClick={() => setShowRaw(!showRaw)}>
        {showRaw ? t('details.hideRaw') : t('details.showRaw')}
      </button>
      {showRaw ? (
        <pre id={rawId} className="font-mono text-xs whitespace-pre-wrap overflow-x-auto text-text">{JSON.stringify(item, null, 2)}</pre>
      ) : null}
    </div>
  )
}
