/**
 * @fileoverview The Product tab's sources (7.104.00): the list (`GET …/product-docs`, the page's shared
 * `productDocsKey` entry, so the prototype card's visual picker sees a new screenshot too), its polling while a
 * source is still read, and the card's writes: files, a link, a retry or a re-fetch, a delete (a refused retry,
 * re-fetch or delete is said on the card, `actionError`). A failed read of the list is `isError`, never an empty
 * list.
 *
 * The polling: every 3 s for a minute after a source started reading, then every 15 s up to 16 minutes (a PDF,
 * DOCX, PPTX or link is read by the projects assist twin, whose timeout is 15 minutes), then not at all: the
 * server marks a source stalled past its deadline, and the next read of the tab shows it.
 *
 * @module pages/ProjectDetail/useProductSources
 */
import { useCallback, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { serverReason } from '../../lib/errors'
import { isImagePrepError } from './resizeImage'
import { SOURCE_ACCEPTED_LABEL, isDocumentMime, uploadRefusal, uploadSourceFile } from './productSourceUpload'
import { productDocsKey } from './useProjectData'
import type { TFunction } from 'i18next'
import type { ProductDoc } from '../../api/projectTypes'

const FAST_MS = 3000
const FAST_WINDOW_MS = 60_000
const SLOW_MS = 15_000
const POLL_WINDOW_MS = 16 * 60_000

/** A source still being read (uploaded, or claimed by its reader). */
export const isReading = (doc: Pick<ProductDoc, 'status'>): boolean => doc.status === 'pending' || doc.status === 'extracting'

/** A failed file the server reads again on Retry: a PDF, DOCX or PPTX, read on the projects assist twin
 * (shared/product_sources.py `SOURCE_CONTENT_TYPES`); Markdown, text and images are read once, by the S3 extractor,
 * when they are added, and any other answers 409 `not_refreshable`. */
export const canRetrySource = (doc: Pick<ProductDoc, 'status' | 'source_kind' | 'content_type'>): boolean =>
  doc.status === 'failed' && doc.source_kind === 'file' && isDocumentMime(doc.content_type)

/**
 * How long until the list is read again, 0 to stop: 3 s in the first minute after `since` (when a source started
 * reading, or the card's last write), 15 s until 16 minutes, then never. Pure, so the windows are pinned without
 * driving a component through 16 minutes of timers.
 */
export function sourcesPollInterval(docs: readonly Pick<ProductDoc, 'status'>[], since: number | null, now: number): number {
  if (!docs.some(isReading) || since === null) return 0
  const elapsed = now - since
  if (elapsed < FAST_WINDOW_MS) return FAST_MS
  return elapsed < POLL_WINDOW_MS ? SLOW_MS : 0
}

function uploadErrorKey(error: unknown): { key: string; reason?: string } {
  if (isImagePrepError(error)) {
    return { key: error.failure === 'too-large' ? 'imageErrors.tooLarge' : 'imageErrors.unreadable' }
  }
  return { key: 'product.sources.errors.uploadFailed', reason: serverReason(error) ?? (error instanceof Error ? error.message : '') }
}

export function useProductSources(projectId: string) {
  const { t } = useTranslation('projectDetail')
  const queryClient = useQueryClient()
  // When the current reading window began: the first sighting of a source being read, or the card's last write.
  const since = useRef<number | null>(null)
  const [uploading, setUploading] = useState<readonly string[]>([])
  const [errors, setErrors] = useState<readonly string[]>([])
  const list = useQuery({
    queryKey: productDocsKey(projectId),
    queryFn: () => projectsApi.listProductDocs(projectId),
    refetchInterval: (query) => {
      const docs = query.state.data?.docs ?? []
      if (!docs.some(isReading)) since.current = null
      else since.current ??= Date.now()
      return sourcesPollInterval(docs, since.current, Date.now())
    },
  })
  const reread = useCallback(() => {
    since.current = Date.now()
    return queryClient.invalidateQueries({ queryKey: productDocsKey(projectId) })
  }, [projectId, queryClient])

  const uploadOne = useCallback(async (file: File): Promise<string | null> => {
    const refusal = uploadRefusal(file)
    if (refusal?.reason === 'type') {
      return t('product.sources.errors.unsupportedType', { name: file.name, type: refusal.type, accepted: SOURCE_ACCEPTED_LABEL })
    }
    if (refusal?.reason === 'size') return t('product.sources.errors.tooLarge', { name: file.name, mb: refusal.capMb })
    setUploading((names) => [...names, file.name])
    try {
      await uploadSourceFile(projectId, file)
      return null
    } catch (error: unknown) {
      const { key, reason } = uploadErrorKey(error)
      return t(key, { name: file.name, message: reason })
    } finally {
      setUploading((names) => names.filter((name) => name !== file.name))
    }
  }, [projectId, t])

  const upload = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    setErrors([])
    const failures: string[] = []
    for (const file of files) {
      const failure = await uploadOne(file)
      if (failure !== null) failures.push(failure)
    }
    setErrors(failures)
    await reread()
  }, [reread, uploadOne])

  const settle = { onSettled: reread }
  const addUrl = useMutation({ mutationFn: (url: string) => projectsApi.addProductDocUrl(projectId, { url }), ...settle })
  const refresh = useMutation({ mutationFn: (docId: string) => projectsApi.refreshProductDoc(projectId, docId), ...settle })
  const remove = useMutation({ mutationFn: (docId: string) => projectsApi.deleteProductDoc(projectId, docId), ...settle })
  const { mutate: refreshMutate, reset: refreshReset } = refresh
  const { mutate: removeMutate, reset: removeReset } = remove

  // A row action's refusal (a 409 `not_refreshable` / `extracting` / `stale`, a link's 429 `rate_limited`, a delete
  // that failed), said on the card in the server's words; the next row action clears the last one's.
  const retry = useCallback((docId: string) => {
    removeReset()
    refreshMutate(docId)
  }, [refreshMutate, removeReset])
  const deleteSource = useCallback((docId: string) => {
    refreshReset()
    removeMutate(docId)
  }, [refreshReset, removeMutate])
  const actionError = actionErrorText(t, refresh.error, remove.error)

  return {
    docs: list.data?.docs ?? [],
    loading: list.isLoading,
    /** The list could not be read, and nothing was read before (not an empty state). */
    isError: list.isError && list.data === undefined,
    retryList: () => { void list.refetch() },
    listRetrying: list.isFetching,
    /** A Retry or Fetch again is under way: the row buttons wait for it rather than send another. */
    refreshing: refresh.isPending,
    uploading,
    errors,
    upload,
    addUrl,
    refresh,
    remove,
    retry,
    deleteSource,
    actionError,
    reread,
  }
}

/** What the card says of a refused Retry, Fetch again or Delete: the server's reason, else "Try again."; null when
 * neither failed. */
function actionErrorText(t: TFunction<'projectDetail'>, refreshError: unknown, removeError: unknown): string | null {
  const message = (error: unknown): string => serverReason(error) ?? t('product.sources.errors.tryAgain')
  if (refreshError !== null && refreshError !== undefined) return t('product.sources.errors.refreshFailed', { message: message(refreshError) })
  if (removeError !== null && removeError !== undefined) return t('product.sources.errors.deleteFailed', { message: message(removeError) })
  return null
}

export type ProductSources = ReturnType<typeof useProductSources>
