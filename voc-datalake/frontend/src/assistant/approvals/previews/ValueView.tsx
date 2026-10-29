/**
 * @fileoverview Readable rendering of an arbitrary (already-validated) tool
 * argument value, plus the default key/value preview used when a tool has no
 * rich preview. Long text collapses behind a disclosure.
 *
 * @module assistant/approvals/previews/ValueView
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isRecord } from '../../../lib/typeGuards'
import { humanizeKey, LONG_TEXT_CHARS } from './format'
import { DetailsDisclosure } from './FieldDiff'

export function LongText({ text }: Readonly<{ text: string }>) {
  const { t } = useTranslation('assistantTools')
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  if (text.length <= LONG_TEXT_CHARS) {
    return <span className="whitespace-pre-wrap break-words">{text}</span>
  }
  return (
    <span>
      <span id={id} className="whitespace-pre-wrap break-words">
        {expanded ? text : `${text.slice(0, LONG_TEXT_CHARS)}…`}
      </span>{' '}
      <button
        type="button"
        className="text-[12px] font-medium link"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? t('preview.showLess') : t('preview.showMore', { n: text.length })}
      </button>
    </span>
  )
}

export function ValueView({ value }: Readonly<{ value: unknown }>) {
  const { t } = useTranslation('assistantTools')
  if (value === undefined || value === null || value === '') {
    return <span className="italic text-muted">{t('preview.empty')}</span>
  }
  if (typeof value === 'boolean') return <span>{value ? t('preview.yes') : t('preview.no')}</span>
  if (typeof value === 'string') return <LongText text={value} />
  if (typeof value === 'number') return <span>{value}</span>
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    if (items.length === 0) return <span className="italic text-muted">{t('preview.empty')}</span>
    return (
      <ul className="list-disc pl-4 space-y-0.5">
        {items.map((item, i) => <li key={i}><ValueView value={item} /></li>)}
      </ul>
    )
  }
  if (isRecord(value)) return <KeyValueList value={value} nested />
  return <span>{String(value)}</span>
}

export function KeyValueList({ value, nested = false }: Readonly<{ value: Record<string, unknown>; nested?: boolean }>) {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  return (
    <dl className={nested ? 'space-y-1 border-l border-border pl-2' : 'space-y-1.5'}>
      {entries.map(([key, v]) => (
        <div key={key} className="text-sm">
          <dt className="text-[12px] font-medium text-muted">{humanizeKey(key)}</dt>
          <dd className="text-text"><ValueView value={v} /></dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The default preview, for a tool without a written one: its raw arguments
 * (except the project id, shown as a chip). They read as field names and
 * values, so they sit behind "Details"; the title and message say what happens.
 */
export function ArgsPreview({ args }: Readonly<{ args: unknown }>) {
  if (!isRecord(args)) return null
  const visible = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'project_id'))
  return Object.keys(visible).length === 0 ? null : <DetailsDisclosure><KeyValueList value={visible} /></DetailsDisclosure>
}
