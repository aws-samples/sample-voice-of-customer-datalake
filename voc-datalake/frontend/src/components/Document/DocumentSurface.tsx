/**
 * @fileoverview DocumentSurface: the one document viewer and editor of the app (docs/kiro-design-system.md →
 * Documents). A feature passes its document through an adapter (types.ts DocumentAdapter); the surface never names a
 * route.
 *
 * - Variants: `page` (Projects documents; a full-page view), `panel` (a 360 px inspector: compact type, the text
 *   scrolling inside, Open full page), `sheet` (a dialog or side sheet: header, body, sticky footer) and `inline` (no
 *   chrome).
 * - Modes: `read` (the light reader: Rendered / Source, Contents, comments), `edit` (the draft, its save row and the
 *   canvas, loaded on Edit; or a plain text's field) and `compare` (two versions, DocumentDiff).
 * - States: loading (the header from what the caller knows, then skeleton lines), empty ("Nothing written yet."),
 *   read only (the reason as visible text: ReadOnlyNote), saving / saved / unsaved, the stale-save conflict with
 *   Compare and merge, a refused save, a text past its limit.
 *
 * A page with an editor and a bar of its own (the Projects document page) hands its frame (`page`) and its own body
 * (`children`): the surface lays the page out, and the page keeps its canvas, its review view and its slots.
 *
 * @module components/Document/DocumentSurface
 */
import clsx from 'clsx'
import { ExternalLink } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import DocumentDiff from './diff/DocumentDiff'
import { markdownPolicy } from './read/markdownPolicy'
import EditBody from './surface/EditBody'
import PageFrame from './surface/PageFrame'
import ReadBody from './surface/ReadBody'
import { ReadOnlyNote } from './surface/ReadOnlyNote'
import type { ReactNode } from 'react'
import type { SurfaceComments } from './surface/ReadBody'
import type { PageFrameProps } from './surface/PageFrame'
import type { DocumentAdapter, StoredDocument, SurfaceMode, SurfaceVariant } from './types'

/** The other side of a compare: the version the stored one is compared with, and what each side is called. */
export interface SurfaceCompare {
  readonly before: string
  readonly beforeLabel: string
  readonly afterLabel: string
  /** Said when the two are the same. */
  readonly identicalText: string
}

export interface DocumentSurfaceProps<S extends StoredDocument> {
  readonly adapter: DocumentAdapter<S>
  readonly variant: SurfaceVariant
  /** The document's name, known before it loads: the surface's heading. */
  readonly title: string
  /** The heading's level (a panel or inline surface sits under its host's heading). */
  readonly headingLevel: 1 | 2 | 3
  /** The line under the heading (the document's details, provenance, a share's expiry); null: none. */
  readonly meta: ReactNode
  /** The stored version shown; undefined while it loads. */
  readonly stored: S | undefined
  readonly mode: SurfaceMode
  /** Compare mode's other side (null in the other modes). */
  readonly compare: SurfaceCompare | null
  /** The comment rail on the rendered text (null: no comments here). */
  readonly comments: SurfaceComments | null
  /** A saved version, back from the edit body (the feature selects it). */
  readonly onSaved: (stored: S) => void
  /** The full-page address of this document (a panel or sheet's "Open full page"; null: none). */
  readonly fullPath: string | null
  /** A sheet's sticky footer (its decision, Close); null: none. */
  readonly footer: ReactNode
  /** A page with a frame of its own (Projects: its bar, focus view, older version); null: the surface's own card. */
  readonly page: Omit<PageFrameProps, 'children' | 'documentId'> | null
  /** The page's own body (Projects: its canvas, coaching and evidence); null: the surface's body for the mode. */
  readonly children: ReactNode
}

const HEADINGS = { 1: 'h1', 2: 'h2', 3: 'h3' } as const

const VARIANT_CLASS: Readonly<Record<SurfaceVariant, string>> = {
  page: 'rounded-xl border border-border bg-card p-4 sm:p-6',
  panel: 'flex max-h-[min(70vh,40rem)] flex-col',
  sheet: 'flex min-h-0 flex-col',
  inline: '',
}

const TITLE_CLASS: Readonly<Record<SurfaceVariant, string>> = {
  page: 'text-xl font-bold tracking-tight text-text-strong break-words',
  panel: 'text-[14px] font-semibold text-text-strong break-words',
  sheet: 'dialog-title break-words',
  inline: 'sr-only',
}

/** Three lines on their way: never a blank box. */
function Loading() {
  const { t } = useTranslation('documents')
  return (
    <div role="status" aria-label={t('surface.loading')} className="space-y-2">
      <div className="skeleton h-4 w-3/4" /><div className="skeleton h-4" /><div className="skeleton h-4 w-5/6" />
    </div>
  )
}

function Body<S extends StoredDocument>({ props, stored }: Readonly<{ props: DocumentSurfaceProps<S>; stored: S }>) {
  const { adapter, mode, compare, comments, variant, title, onSaved } = props
  const split = adapter.frontMatter === 'split'
  // A code document is never edited here (D6-5), and a panel edits plain text only.
  const editable = adapter.permissions.edit === true && adapter.contentType !== 'code'
    && (variant !== 'panel' || adapter.contentType === 'plain')
  if (mode === 'edit' && editable) return <EditBody adapter={adapter} stored={stored} title={title} onSaved={onSaved} />
  if (mode === 'compare' && compare !== null) {
    return (
      <DocumentDiff before={compare.before} after={stored.content} policy={markdownPolicy.stored} identicalText={compare.identicalText}
        beforeLabel={compare.beforeLabel} afterLabel={compare.afterLabel} />
    )
  }
  return <ReadBody content={stored.content} title={title} contentType={adapter.contentType} split={split} variant={variant} comments={comments} />
}

export default function DocumentSurface<S extends StoredDocument>(props: DocumentSurfaceProps<S>) {
  const { t } = useTranslation('documents')
  const headingId = useId()
  const { adapter, variant, title, headingLevel, meta, stored, mode, fullPath, footer, page, children } = props
  if (page !== null) {
    return <PageFrame {...page} documentId={adapter.id}>{children}</PageFrame>
  }
  const Heading = HEADINGS[headingLevel]
  const reason = adapter.permissions.edit === true ? null : adapter.permissions.edit
  return (
    <section aria-labelledby={headingId} data-document={adapter.id} data-variant={variant} className={VARIANT_CLASS[variant]}>
      <header className={clsx('space-y-2', variant !== 'inline' && 'mb-4')}>
        <div className="flex flex-wrap items-center gap-2">
          <Heading id={headingId} className={clsx('mr-auto min-w-0', TITLE_CLASS[variant])}>{title}</Heading>
          {fullPath === null ? null : (
            <Link to={fullPath} className="btn btn-ghost btn-sm">
              {t('panel.openFull')}<ExternalLink size={12} aria-hidden="true" />
            </Link>
          )}
        </div>
        {meta}
        {reason === null || mode === 'compare' ? null : <ReadOnlyNote reason={reason} olderVersion={null} />}
      </header>
      <div className={clsx('min-h-0', (variant === 'panel' || variant === 'sheet') && 'overflow-y-auto', variant === 'sheet' && 'max-h-[70vh]')}>
        {stored === undefined ? <Loading /> : (children ?? <Body props={props} stored={stored} />)}
      </div>
      {footer === null ? null : <div className="sticky bottom-0 mt-4 border-t border-border bg-card pt-3">{footer}</div>}
    </section>
  )
}
