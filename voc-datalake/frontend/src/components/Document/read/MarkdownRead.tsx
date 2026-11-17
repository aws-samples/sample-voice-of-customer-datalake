/**
 * @fileoverview The light reader: Markdown rendered with react-markdown (the `vendor-markdown` chunk the assistant,
 * Reports and History already load) through one safe policy (markdownPolicy.tsx), reading as the canvas does
 * (remarkParity: callouts, to-dos, heading ids, raw source as code) without loading the editor. Read, panel and
 * inline surfaces use it; it never imports `@tiptap/*` (build/readEngineImports.test.ts).
 *
 * One parse per text: the render is memoized on the text and the policy, and the Contents (`onOutline`) come out of
 * that same parse.
 *
 * @module components/Document/read/MarkdownRead
 */
import { memo, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkParity } from './remarkParity'
import type { Ref } from 'react'
import type { MarkdownPolicy } from './markdownPolicy'
import type { CalloutKind } from '../edit/markdown/callout'
import type { OutlineItem } from '../types'

interface MarkdownReadProps {
  readonly source: string
  readonly policy: MarkdownPolicy
  readonly className?: string
  /** The h1–h3 with their ids, after each parse (the surface's Contents). */
  readonly onOutline?: (items: readonly OutlineItem[]) => void
  /**
   * Give the headings the canvas's ids (deep links, Contents). Off where the same text may already be on the page
   * (a diff's blocks, a version opened over the page): an id is never on two elements.
   */
  readonly headingIds?: boolean
  /** The rendered text's container: comment anchors index it (components/DocumentComments/anchors.ts). */
  readonly rootRef?: Ref<HTMLDivElement>
}

function MarkdownRead({ source, policy, className, onOutline, headingIds = true, rootRef }: MarkdownReadProps) {
  const { t } = useTranslation('documents')
  const outline = useRef<readonly OutlineItem[]>([])
  const plugins = useMemo(() => {
    const calloutLabels: Record<CalloutKind, string> = {
      note: t('editor.callout.note'), tip: t('editor.callout.tip'), important: t('editor.callout.important'),
      warning: t('editor.callout.warning'), caution: t('editor.callout.caution'),
    }
    const onHeadings = (items: readonly OutlineItem[]) => { outline.current = items }
    return [remarkGfm, [remarkParity, { calloutLabels, ids: headingIds, onHeadings }]] as const
  }, [headingIds, t])
  // The parse ran in this render (react-markdown parses as it renders): its Contents go out once it committed.
  useEffect(() => { onOutline?.(outline.current) }, [onOutline, plugins, source])
  return (
    <div ref={rootRef} className={className}>
      <ReactMarkdown remarkPlugins={[...plugins]} components={policy.components}
        urlTransform={policy.urlTransform}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

export default memo(MarkdownRead)
