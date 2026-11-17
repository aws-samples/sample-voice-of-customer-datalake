/**
 * @fileoverview The surface's read body: the text by its content type (Markdown through the light reader with
 * Rendered / Source and, from three headings, its Contents; plain text as written; code in the code view), its
 * front-matter as Properties above it, and, where the adapter offers comments, the comment rail on the rendered text.
 * "Nothing written yet." for an empty text.
 *
 * @module components/Document/surface/ReadBody
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import DocumentComments from '../../DocumentComments/DocumentComments'
import Outline from '../Outline'
import ReadView from '../read/ReadView'
import { markdownPolicy } from '../read/markdownPolicy'
import { READING_TEXT_CLASS } from '../readingColumn'
import CodeView from '../text/CodeView'
import PropertiesPanel from '../text/PropertiesPanel'
import { splitFrontMatter } from '../text/frontMatter'
import type { CommentActions, ViewedVersion } from '../../DocumentComments/commentTypes'
import type { CommentThread } from '../../../api/documentReviewSchema'
import type { ContentType, OutlineItem, SurfaceVariant } from '../types'

/** The comment rail on the rendered text (the review page): the threads and their writes. */
export interface SurfaceComments {
  readonly threads: readonly CommentThread[]
  readonly viewed: ViewedVersion
  readonly actions: CommentActions
  readonly canComment: boolean
}

/** Contents from this many headings: fewer is a short text that needs none. */
const CONTENTS_FROM = 3

interface ReadBodyProps {
  readonly content: string
  readonly title: string
  readonly contentType: ContentType
  readonly split: boolean
  readonly variant: SurfaceVariant
  readonly comments: SurfaceComments | null
}

/** Bring a heading of the rendered text into view and give it the focus (it is not focusable on its own). */
function goTo(id: string) {
  const target = globalThis.document.getElementById(id)
  if (target === null) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
}

function MarkdownBody({ body, title, variant, comments }: Readonly<{
  body: string; title: string; variant: SurfaceVariant; comments: SurfaceComments | null
}>) {
  const [outline, setOutline] = useState<readonly OutlineItem[]>([])
  const onOutline = useCallback((items: readonly OutlineItem[]) => setOutline(items), [])
  const textClass = variant === 'panel' ? `${READING_TEXT_CLASS} md-content-compact` : READING_TEXT_CLASS
  // The heading ids (deep links, Contents) belong to the page: a panel, sheet or inline text may sit over or beside
  // the same document's page, and an id is never on two elements.
  const ownsIds = variant === 'page'
  const contents = ownsIds && outline.length >= CONTENTS_FROM
  return (
    <div className={contents ? 'lg:grid lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-6' : undefined}>
      {contents ? <Outline items={outline} onNavigate={goTo} className="mb-4 lg:mb-0" /> : null}
      <div className="min-w-0">
        {comments === null
          ? <ReadView source={body} policy={markdownPolicy.stored} title={title} className={textClass} onOutline={onOutline}
            headingIds={ownsIds} />
          : (
            <DocumentComments markdown={body} threads={comments.threads} viewed={comments.viewed} actions={comments.actions}
              canComment={comments.canComment} onOutline={onOutline} />
          )}
      </div>
    </div>
  )
}

export default function ReadBody({ content, title, contentType, split, variant, comments }: ReadBodyProps) {
  const { t } = useTranslation('documents')
  const { frontMatter, body } = split ? splitFrontMatter(content) : { frontMatter: null, body: content }
  if (content.trim() === '') return <p className="text-sm text-muted">{t('surface.empty')}</p>
  return (
    <>
      {frontMatter === null ? null : <PropertiesPanel frontMatter={frontMatter} />}
      {contentType === 'markdown' ? <MarkdownBody body={body} title={title} variant={variant} comments={comments} /> : null}
      {contentType === 'plain' ? <p className="whitespace-pre-wrap break-words text-sm text-text">{body}</p> : null}
      {contentType === 'code' ? <CodeView text={body} label={t('view.sourceOf', { title })} /> : null}
    </>
  )
}
