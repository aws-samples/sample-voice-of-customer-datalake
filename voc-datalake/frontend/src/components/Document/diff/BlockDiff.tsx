/**
 * @fileoverview A Markdown text as a block-level diff over another, rendered as the document reads (the light
 * reader, through the caller's policy): added blocks on ok-subtle, removed ones on danger-subtle and struck through,
 * long unchanged runs collapsed. Each changed block also says "Added" / "Removed" to a screen reader (colour is
 * never the only cue). The assistant's pending edit and DocumentDiff's Rendered view.
 *
 * The diff itself is lineDiff.ts's (components/Document/diff/lineDiff), run over blocks instead of lines.
 *
 * @module components/Document/diff/BlockDiff
 */
import clsx from 'clsx'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { collapseUnchanged, diffBlocks } from './lineDiff'
import MarkdownRead from '../read/MarkdownRead'
import { markdownPolicy } from '../read/markdownPolicy'
import type { DiffHunkItem } from './lineDiff'
import type { MarkdownPolicy } from '../read/markdownPolicy'

/** Unchanged blocks kept around each change. */
const CONTEXT_BLOCKS = 1

const BLOCK_STYLES = {
  same: 'border-transparent',
  add: 'border-ok bg-ok-subtle',
  del: 'border-danger bg-danger-subtle text-muted line-through decoration-danger/50',
} as const

interface BlockDiffProps {
  readonly before: string
  readonly after: string
  readonly id?: string
  /**
   * How the blocks render. By default the model's policy: a proposal is the model's, not yet approved (only safe
   * links; no images, so nothing it wrote is fetched before anyone approved it).
   */
  readonly policy?: MarkdownPolicy
  /** Said when nothing changed (default: the assistant's "The suggestion matches the saved text."). */
  readonly identicalText?: string
}

function Block({ item, policy }: Readonly<{ item: DiffHunkItem; policy: MarkdownPolicy }>) {
  const { t } = useTranslation('documents')
  if (item.kind === 'skip') {
    return <p className="px-3 py-1 text-[12px] italic text-muted">{t('actions.assistant.unchanged', { count: item.count })}</p>
  }
  return (
    <div data-diff={item.kind} className={clsx('rounded-md border-l-4 px-3 py-1', BLOCK_STYLES[item.kind])}>
      {item.kind === 'same' ? null : (
        <span className="sr-only">{item.kind === 'add' ? t('actions.assistant.added') : t('actions.assistant.removed')}: </span>
      )}
      <MarkdownRead source={item.text} policy={policy} className="md-content" headingIds={false} />
    </div>
  )
}

export default function BlockDiff({ before, after, id, policy = markdownPolicy.model, identicalText }: BlockDiffProps) {
  const { t } = useTranslation('documents')
  const result = useMemo(() => diffBlocks(before, after), [before, after])
  if (result.status === 'too-large') {
    return (
      <div id={id} className="space-y-2">
        <p className="text-[12px] text-warn">{t('actions.assistant.tooLarge')}</p>
        <MarkdownRead source={after} policy={policy} className="md-content rounded-md border border-border p-3" headingIds={false} />
      </div>
    )
  }
  if (result.added === 0 && result.removed === 0) {
    return <p id={id} className="text-[12px] text-muted">{identicalText ?? t('actions.assistant.noChanges')}</p>
  }
  const items = collapseUnchanged(result.lines, CONTEXT_BLOCKS)
  return (
    <div id={id} role="group" aria-label={t('actions.assistant.diffLabel')} className="space-y-1">
      <p className="text-[12px] text-muted">{t('actions.assistant.stats', { added: result.added, removed: result.removed })}</p>
      {items.map((item, index) => <Block key={index} item={item} policy={policy} />)}
    </div>
  )
}
