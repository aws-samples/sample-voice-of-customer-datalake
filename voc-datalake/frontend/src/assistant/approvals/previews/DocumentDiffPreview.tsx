/**
 * @fileoverview `update_document` preview: a line diff of the stored document
 * against the proposed content, collapsed to the changed regions. Inputs past
 * the diff caps fall back to a side-by-side excerpt.
 *
 * @module assistant/approvals/previews/DocumentDiffPreview
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { collapseUnchanged, diffLines } from '../lineDiff'
import { LongText } from './ValueView'
import { useProjectDetail } from './useProjectDetail'
import type { DiffHunkItem } from '../lineDiff'
import type { UpdateDocumentArgs } from '../schemas'

/** Characters of each side shown when the diff is too large to compute. */
const EXCERPT_CHARS = 1500

const LINE_STYLES = {
  same: 'text-muted',
  add: 'bg-ok-subtle text-ok',
  del: 'bg-danger-subtle text-danger line-through decoration-danger/40',
} as const
const LINE_MARKS = { same: ' ', add: '+', del: '−' } as const

function DiffRow({ item }: Readonly<{ item: DiffHunkItem }>) {
  const { t } = useTranslation('assistantTools')
  if (item.kind === 'skip') {
    return <div className="px-2 py-0.5 text-muted-strong italic">{t('preview.diff.unchanged', { n: item.count })}</div>
  }
  return (
    <div className={clsx('px-2 whitespace-pre-wrap break-words', LINE_STYLES[item.kind])}>
      <span aria-hidden="true" className="select-none mr-1">{LINE_MARKS[item.kind]}</span>
      <span className="sr-only">{t(`preview.diff.${item.kind}`)} </span>
      {item.text === '' ? '\u00a0' : item.text}
    </div>
  )
}

function SideBySide({ before, after }: Readonly<{ before: string; after: string }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <div>
      <p className="text-[12px] text-warn mb-1">{t('preview.diff.tooLarge')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
        <div>
          <p className="font-medium text-muted">{t('preview.before')}</p>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-bg-accent p-2 font-mono max-h-48 overflow-auto">{before.slice(0, EXCERPT_CHARS)}</pre>
        </div>
        <div>
          <p className="font-medium text-muted">{t('preview.after')}</p>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-bg-accent p-2 font-mono max-h-48 overflow-auto">{after.slice(0, EXCERPT_CHARS)}</pre>
        </div>
      </div>
    </div>
  )
}

/**
 * A line diff of `before` → `after`, collapsed to the changed regions. Shared with
 * the document Versions compare view, which names its own "identical" message.
 */
export function ContentDiff({ before, after, identicalText }: Readonly<{ before: string; after: string; identicalText?: string }>) {
  const { t } = useTranslation('assistantTools')
  const result = useMemo(() => diffLines(before, after), [before, after])
  if (result.status === 'too-large') return <SideBySide before={before} after={after} />
  if (result.added === 0 && result.removed === 0) {
    return <p className="text-[12px] text-muted">{identicalText ?? t('preview.diff.noChanges')}</p>
  }
  const items = collapseUnchanged(result.lines)
  return (
    <div>
      <p className="font-mono text-[12px] text-muted mb-1">{t('preview.diff.stats', { added: result.added, removed: result.removed })}</p>
      <div
        className="font-mono text-[12px] border border-border bg-bg-accent rounded-md max-h-64 overflow-auto"
        role="group"
        aria-label={t('preview.diff.label')}
      >
        {items.map((item, i) => <DiffRow key={i} item={item} />)}
      </div>
    </div>
  )
}

export function DocumentDiffPreview({ args }: Readonly<{ args: UpdateDocumentArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data, isLoading, isError } = useProjectDetail(args.project_id)
  const doc = data?.documents.find((d) => d.document_id === args.document_id)

  const body = (() => {
    if (isLoading) return <p className="text-[12px] text-muted">{t('preview.loading')}</p>
    if (isError || doc === undefined) {
      return (
        <div>
          <p className="text-[12px] text-warn mb-1">{t('preview.diff.currentUnavailable')}</p>
          <LongText text={args.content} />
        </div>
      )
    }
    return <ContentDiff before={doc.content} after={args.content} />
  })()

  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="text-[12px] font-medium text-muted">{t('preview.document')}: </span>
        {doc?.title ?? args.document_id}
        {args.title !== undefined && args.title !== doc?.title && (
          <span> → <strong>{args.title}</strong></span>
        )}
      </p>
      {args.change_summary !== '' && (
        <p>
          <span className="text-[12px] font-medium text-muted">{t('preview.changeSummary')}: </span>
          {args.change_summary}
        </p>
      )}
      {body}
    </div>
  )
}
