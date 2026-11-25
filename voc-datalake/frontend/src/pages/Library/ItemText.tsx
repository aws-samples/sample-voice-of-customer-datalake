/**
 * @fileoverview A ready item's extracted text, one page at a time (a PDF's page or a slide; a long text without pages
 * in parts of 20,000 characters), with Previous / Next. Markdown renders as the assistant's answers do (an uploaded
 * file is nobody's approved text: only safe links, `SafeLink`, and its images never fetched, `NoImage`); every other
 * format reads as written.
 *
 * @module pages/Library/ItemText
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { NoImage, SafeLink } from '../../assistant/components/SafeLink'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { libraryApi, libraryKeys } from '../../api/libraryApi'
import type { LibraryItem } from '../../api/librarySchema'

/** Uploaded markdown: only safe links, never images (assistant/components/SafeLink.tsx). */
const MARKDOWN_COMPONENTS = { a: SafeLink, img: NoImage }
/** A comfortable line length for reading a document's text. */
const READING_COLUMN_CLASS = 'min-w-0 max-w-[70ch]'

function PageNav({ page, parts, paged, onPage }: Readonly<{
  page: number; parts: number; paged: boolean; onPage: (page: number) => void
}>) {
  const { t } = useTranslation('library')
  const where = paged ? t('text.pageOf', { current: page, total: parts }) : t('text.partOf', { current: page, total: parts })
  return (
    <nav aria-label={t('text.pagesLabel')} className="flex items-center justify-between gap-2">
      <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft size={14} aria-hidden="true" />{t('text.previous')}
      </button>
      <span className="text-[12px] text-muted tabular-nums" aria-live="polite">{where}</span>
      <button type="button" className="btn btn-secondary btn-sm" disabled={page >= parts} onClick={() => onPage(page + 1)}>
        {t('text.next')}<ChevronRight size={14} aria-hidden="true" />
      </button>
    </nav>
  )
}

function Body({ text, item }: Readonly<{ text: string; item: LibraryItem }>) {
  const { t } = useTranslation('library')
  if (text.trim() === '') return <p className="text-sm text-muted">{t('text.empty')}</p>
  if (item.format === 'md') {
    return (
      <div className="md-content break-words text-sm leading-7">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
      </div>
    )
  }
  return <p className="whitespace-pre-wrap break-words text-sm text-text">{text}</p>
}

export default function ItemText({ item, parts, page, onPage }: Readonly<{
  item: LibraryItem
  /** How many pages (or parts) its text has (the item read's `text_parts`). */
  parts: number
  /** The page asked for (the address's), kept within the text. */
  page: number
  onPage: (page: number) => void
}>) {
  const { t } = useTranslation('library')
  const shown = Math.min(Math.max(page, 1), Math.max(parts, 1))
  const text = useQuery({
    queryKey: libraryKeys.text(item.item_id, shown),
    queryFn: () => libraryApi.text(item.item_id, shown),
  })
  return (
    <section aria-labelledby={`${item.item_id}-text`} className="space-y-3">
      <h3 id={`${item.item_id}-text`} className="text-sm font-semibold text-text-strong">{t('text.title')}</h3>
      {parts > 1 ? <PageNav page={shown} parts={parts} paged={text.data?.paged ?? item.pages !== undefined} onPage={onPage} /> : null}
      {text.isError ? <LoadFailed onRetry={() => void text.refetch()} retrying={text.isFetching} message={t('text.loadFailed')} /> : null}
      {text.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('text.loading')}
        </p>
      ) : null}
      {text.data === undefined ? null : <div className={READING_COLUMN_CLASS}><Body text={text.data.text} item={item} /></div>}
      {item.truncated === true ? <p className="text-[12px] text-warn">{t('text.truncated')}</p> : null}
    </section>
  )
}
