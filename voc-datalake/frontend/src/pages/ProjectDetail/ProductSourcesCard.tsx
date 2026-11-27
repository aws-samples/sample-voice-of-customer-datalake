/**
 * @fileoverview The Product tab's Sources card (7.104.00, docs/project-workspace.md → Product tab), which replaces the
 * internal documents card: the files (PDF, DOCX, PPTX, MD, TXT and images, an image downscaled first), the public
 * links and the interview answers the Extract reads, each with its own status, and the Extract itself at its foot.
 *
 * A viewer (`canEdit` false) gets the list and nothing that writes: no drop zone, link, Delete, Retry or Extract
 * (the project gate would refuse each of them). A refused Retry, Fetch again or Delete is said under the list, in the
 * server's words (a link's daily reads used up, a source being read already). A list that could not be read says so,
 * with Try again, instead of reading as empty.
 *
 * @module pages/ProjectDetail/ProductSourcesCard
 */
import { useCallback } from 'react'
import { AlertCircle, FolderOpen, MessageSquareText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { pastedImages, withSyntheticName } from '../../utils/imageInput'
import ProductCard from './ProductCard'
import ProductExtractPanel from './ProductExtractPanel'
import ProductSourceLinkForm from './ProductSourceLinkForm'
import ProductSourceList from './ProductSourceList'
import SourceDropZone from './SourceDropZone'
import { useProductSources } from './useProductSources'
import type { ClipboardEvent } from 'react'
import type { ProductExtract } from './useProductExtract'
import type { ProductSources } from './useProductSources'

function EditorControls({ sources }: Readonly<{ sources: ProductSources }>) {
  return (
    <div className="space-y-3">
      <SourceDropZone onFiles={(files) => { void sources.upload(files) }} />
      <ProductSourceLinkForm onAdd={(url) => sources.addUrl.mutateAsync(url)} />
      {sources.errors.map((error) => (
        <p key={error} role="alert" className="flex items-start gap-1 text-xs text-danger">
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{error}
        </p>
      ))}
    </div>
  )
}

/** A refused Retry, Fetch again or Delete, in the server's words (useProductSources `actionError`). */
function RowActionError({ message }: Readonly<{ message: string | null }>) {
  if (message === null) return null
  return (
    <p role="alert" className="flex items-start gap-1 text-xs text-danger">
      <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{message}
    </p>
  )
}

/** No source yet: what to add, and (for an editor) a way to answer questions instead. */
function EmptySources({ canEdit, onAnswerQuestions }: Readonly<{ canEdit: boolean; onAnswerQuestions: () => void }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>{t(canEdit ? 'product.sources.empty' : 'product.sources.emptyViewer')}</p>
      {canEdit ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onAnswerQuestions}>
          <MessageSquareText size={14} aria-hidden="true" />{t('product.sources.answerQuestions')}
        </button>
      ) : null}
    </div>
  )
}

export default function ProductSourcesCard({ projectId, extract, canEdit, onAnswerQuestions }: Readonly<{
  projectId: string
  extract: ProductExtract
  canEdit: boolean
  /** Opens the gaps panel's typed answers (the empty card's "Answer questions"). */
  onAnswerQuestions: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const sources = useProductSources(projectId)
  const { upload } = sources
  const handlePaste = useCallback((event: ClipboardEvent) => {
    const images = pastedImages(event.clipboardData)
    // No image on the clipboard: leave the paste alone, so pasting into the link field still works.
    if (images.length === 0) return
    event.preventDefault()
    void upload(images.map(withSyntheticName))
  }, [upload])
  const empty = !sources.loading && !sources.isError && sources.docs.length === 0 && sources.uploading.length === 0
  return (
    <ProductCard
      icon={FolderOpen}
      title={t('product.sources.title')}
      description={t('product.sources.description')}
      aside={canEdit ? <span className="text-[12px] text-muted">{t('product.sources.hint')}</span> : undefined}
      onPaste={canEdit ? handlePaste : undefined}
    >
      {sources.isError
        ? <LoadFailed message={t('product.sources.loadFailed')} onRetry={sources.retryList} retrying={sources.listRetrying} />
        : null}
      {empty ? <EmptySources canEdit={canEdit} onAnswerQuestions={onAnswerQuestions} /> : null}
      {canEdit ? <EditorControls sources={sources} /> : null}
      <ProductSourceList
        docs={sources.docs}
        uploading={sources.uploading}
        loading={sources.loading}
        actions={canEdit ? { onRefresh: sources.retry, onDelete: sources.deleteSource, refreshing: sources.refreshing } : null}
      />
      {canEdit ? <RowActionError message={sources.actionError} /> : null}
      {canEdit ? <ProductExtractPanel docs={sources.docs} extract={extract} /> : null}
    </ProductCard>
  )
}
