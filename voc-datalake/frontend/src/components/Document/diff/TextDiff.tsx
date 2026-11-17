/**
 * @fileoverview A text's line diff (`+`/`−` marks, "Added:"/"Removed:" to a screen reader, long unchanged runs
 * collapsed): DocumentDiff's Source view, and the assistant's approval card for an edited document. Past the diff
 * caps (lineDiff.ts `MAX_DIFF_CELLS`) it falls back to the start of each side, side by side from `sm`.
 *
 * @module components/Document/diff/TextDiff
 */
import clsx from 'clsx'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { collapseUnchanged, diffLines } from './lineDiff'
import type { DiffHunkItem } from './lineDiff'

/** Characters of each side shown when the diff is too large to compute. */
const EXCERPT_CHARS = 1500

const LINE_STYLES = {
  same: 'text-muted',
  add: 'bg-ok-subtle text-ok',
  del: 'bg-danger-subtle text-danger line-through decoration-danger/40',
} as const
const LINE_MARKS = { same: ' ', add: '+', del: '−' } as const

interface TextDiffProps {
  readonly before: string
  readonly after: string
  /** Said when the two texts are the same (what they are is the caller's: a version, a proposal). */
  readonly identicalText: string
  /** The two sides' names in the side-by-side fallback. */
  readonly beforeLabel: string
  readonly afterLabel: string
}

function DiffRow({ item }: Readonly<{ item: DiffHunkItem }>) {
  const { t } = useTranslation('documents')
  if (item.kind === 'skip') {
    return <div className="px-2 py-0.5 text-muted-strong italic">{t('diff.lines.unchanged', { n: item.count })}</div>
  }
  return (
    <div className={clsx('px-2 whitespace-pre-wrap break-words', LINE_STYLES[item.kind])}>
      <span aria-hidden="true" className="select-none mr-1">{LINE_MARKS[item.kind]}</span>
      <span className="sr-only">{t(`diff.lines.${item.kind}`)} </span>
      {item.text === '' ? '\u00a0' : item.text}
    </div>
  )
}

function SideBySide({ before, after, beforeLabel, afterLabel }: Readonly<Omit<TextDiffProps, 'identicalText'>>) {
  const { t } = useTranslation('documents')
  return (
    <div>
      <p className="text-[12px] text-warn mb-1">{t('diff.lines.tooLarge')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
        <div>
          <p className="font-medium text-muted">{beforeLabel}</p>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-bg-accent p-2 font-mono max-h-48 overflow-auto">{before.slice(0, EXCERPT_CHARS)}</pre>
        </div>
        <div>
          <p className="font-medium text-muted">{afterLabel}</p>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-bg-accent p-2 font-mono max-h-48 overflow-auto">{after.slice(0, EXCERPT_CHARS)}</pre>
        </div>
      </div>
    </div>
  )
}

export default function TextDiff({ before, after, identicalText, beforeLabel, afterLabel }: TextDiffProps) {
  const { t } = useTranslation('documents')
  const result = useMemo(() => diffLines(before, after), [before, after])
  if (result.status === 'too-large') return <SideBySide before={before} after={after} beforeLabel={beforeLabel} afterLabel={afterLabel} />
  if (result.added === 0 && result.removed === 0) return <p className="text-[12px] text-muted">{identicalText}</p>
  const items = collapseUnchanged(result.lines)
  return (
    <div>
      <p className="font-mono text-[12px] text-muted mb-1">{t('diff.lines.stats', { added: result.added, removed: result.removed })}</p>
      <div className="font-mono text-[12px] border border-border bg-bg-accent rounded-md max-h-64 overflow-auto" role="group"
        aria-label={t('diff.lines.label')}>
        {items.map((item, i) => <DiffRow key={i} item={item} />)}
      </div>
    </div>
  )
}
