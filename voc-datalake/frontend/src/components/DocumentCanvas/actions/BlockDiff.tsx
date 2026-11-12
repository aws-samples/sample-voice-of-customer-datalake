/**
 * @fileoverview A proposed Markdown text as a block-level diff over the stored one,
 * rendered as the document reads: added blocks on ok-subtle, removed ones on
 * danger-subtle and struck through, long unchanged runs collapsed. Each changed
 * block also says "Added" / "Removed" to a screen reader (colour is never the only cue).
 *
 * The diff itself is the approval preview's (assistant/approvals/lineDiff), run over
 * blocks instead of lines.
 *
 * @module components/DocumentCanvas/actions/BlockDiff
 */
import clsx from 'clsx'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { collapseUnchanged, diffBlocks } from '../../../assistant/approvals/lineDiff'
import { NoImage, SafeLink } from '../../../assistant/components/SafeLink'
import type { DiffHunkItem } from '../../../assistant/approvals/lineDiff'

/** Unchanged blocks kept around each change. */
const CONTEXT_BLOCKS = 1

/**
 * The proposed text is the model's, not yet approved: rendered as the assistant renders its answers (only safe
 * links; no images, so nothing it wrote is fetched before anyone approved it).
 */
const MARKDOWN_COMPONENTS = { a: SafeLink, img: NoImage }

const BLOCK_STYLES = {
  same: 'border-transparent',
  add: 'border-ok bg-ok-subtle',
  del: 'border-danger bg-danger-subtle text-muted line-through decoration-danger/50',
} as const

function Block({ item }: Readonly<{ item: DiffHunkItem }>) {
  const { t } = useTranslation('projectDetail')
  if (item.kind === 'skip') {
    return <p className="px-3 py-1 text-[12px] italic text-muted">{t('canvas.actions.assistant.unchanged', { count: item.count })}</p>
  }
  return (
    <div data-diff={item.kind} className={clsx('md-content rounded-md border-l-4 px-3 py-1', BLOCK_STYLES[item.kind])}>
      {item.kind === 'same' ? null : (
        <span className="sr-only">{item.kind === 'add' ? t('canvas.actions.assistant.added') : t('canvas.actions.assistant.removed')}: </span>
      )}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{item.text}</ReactMarkdown>
    </div>
  )
}

export default function BlockDiff({ before, after, id }: Readonly<{ before: string; after: string; id?: string }>) {
  const { t } = useTranslation('projectDetail')
  const result = useMemo(() => diffBlocks(before, after), [before, after])
  if (result.status === 'too-large') {
    return (
      <div id={id} className="space-y-2">
        <p className="text-[12px] text-warn">{t('canvas.actions.assistant.tooLarge')}</p>
        <div className="md-content rounded-md border border-border p-3"><ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{after}</ReactMarkdown></div>
      </div>
    )
  }
  if (result.added === 0 && result.removed === 0) {
    return <p id={id} className="text-[12px] text-muted">{t('canvas.actions.assistant.noChanges')}</p>
  }
  const items = collapseUnchanged(result.lines, CONTEXT_BLOCKS)
  return (
    <div id={id} role="group" aria-label={t('canvas.actions.assistant.diffLabel')} className="space-y-1">
      <p className="text-[12px] text-muted">{t('canvas.actions.assistant.stats', { added: result.added, removed: result.removed })}</p>
      {items.map((item, index) => <Block key={index} item={item} />)}
    </div>
  )
}
