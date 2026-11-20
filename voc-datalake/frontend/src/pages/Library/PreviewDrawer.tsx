/**
 * @fileoverview The preview drawer of one library item (opened by a row, and by `?item=<id>&page=<n>`, the
 * assistant's citation chips): its status, its details or their editor, a 5-minute link to download the original,
 * Retry for a failed item, Delete behind a confirmation, and its extracted text, page by page.
 *
 * Who may do what, as the server decides it (lambda/shared/library_routes.py): every member reads; an editor or an
 * admin edits, retries and uploads; an admin or the person who uploaded it deletes. The drawer offers the writes to
 * a writer and says the server's refusal (a delete by another editor: 403) when it comes.
 *
 * @module pages/Library/PreviewDrawer
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, FileText, Loader2, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { NewTabLink } from '../../components/NewTabLink/NewTabLink'
import SideSheet from '../../components/SideSheet/SideSheet'
import { libraryApi, libraryKeys } from '../../api/libraryApi'
import type { LibraryDetail, LibraryItem } from '../../api/librarySchema'
import { failureText, libraryFailure } from './libraryErrors'
import ItemDetails from './ItemDetails'
import ItemEditor from './ItemEditor'
import ItemText from './ItemText'
import StatusBadge from './StatusBadge'
import type { ProjectOption } from './libraryFilters'
import { IN_FLIGHT_REFETCH_MS, isInFlight } from './useLibraryList'

function StatusLine({ item }: Readonly<{ item: LibraryItem }>) {
  const { t } = useTranslation('library')
  const note = (() => {
    switch (item.status) {
      case 'pending': return t('preview.pending')
      case 'extracting': return t('preview.extracting')
      case 'failed': return item.error ?? t('preview.failed')
      case 'ready': return null
    }
  })()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge status={item.status} />
      {note === null ? null : <p className={item.status === 'failed' ? 'text-sm text-danger' : 'text-sm text-muted'}>{note}</p>}
    </div>
  )
}

function useItemWrites(itemId: string, onDeleted: () => void) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () => libraryApi.retry(itemId),
    onSuccess: async (item) => {
      queryClient.setQueryData(libraryKeys.item(itemId), (detail: LibraryDetail | undefined) => (detail === undefined ? detail : { ...detail, item }))
      await queryClient.invalidateQueries({ queryKey: libraryKeys.all })
    },
  })
  const remove = useMutation({
    mutationFn: () => libraryApi.remove(itemId),
    onSuccess: async () => {
      onDeleted()
      queryClient.removeQueries({ queryKey: libraryKeys.item(itemId) })
      await queryClient.invalidateQueries({ queryKey: libraryKeys.all })
    },
  })
  return { retry, remove }
}

function Actions({ detail, canWrite, onEdit, onRetry, retrying, onDelete }: Readonly<{
  detail: LibraryDetail; canWrite: boolean; onEdit: () => void; onRetry: () => void; retrying: boolean; onDelete: () => void
}>) {
  const { t } = useTranslation('library')
  const { item, originalUrl } = detail
  return (
    <div className="flex flex-wrap gap-2">
      {originalUrl === null ? null : (
        <NewTabLink href={originalUrl} className="btn btn-secondary btn-sm" iconSize={14} newTab={t('preview.newTab')}>
          <Download size={14} aria-hidden="true" />{t('preview.download')}
        </NewTabLink>
      )}
      {canWrite && item.status === 'failed' ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry} disabled={retrying}>
          {retrying ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
          {t('preview.retry')}
        </button>
      ) : null}
      {canWrite ? (
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit}><Pencil size={14} aria-hidden="true" />{t('preview.edit')}</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={onDelete}><Trash2 size={14} aria-hidden="true" />{t('preview.delete')}</button>
        </>
      ) : null}
    </div>
  )
}

function DrawerBody({ detail, page, onPage, canWrite, projects, onDeleted, onReload }: Readonly<{
  detail: LibraryDetail
  page: number
  onPage: (page: number) => void
  canWrite: boolean
  projects: readonly ProjectOption[] | null
  onDeleted: () => void
  onReload: () => Promise<unknown>
}>) {
  const { t } = useTranslation('library')
  const { item } = detail
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const writes = useItemWrites(item.item_id, onDeleted)
  const projectName = item.project_id === undefined ? null : projects?.find((project) => project.id === item.project_id)?.name ?? item.project_id
  return (
    <>
      <StatusLine item={item} />
      {writes.retry.isError ? <p role="alert" className="text-sm text-danger">{failureText(t, libraryFailure(writes.retry.error))}</p> : null}
      <Actions detail={detail} canWrite={canWrite} onEdit={() => setEditing(true)} onRetry={() => writes.retry.mutate()}
        retrying={writes.retry.isPending} onDelete={() => { writes.remove.reset(); setConfirming(true) }} />
      {editing
        ? <ItemEditor key={item.version} item={item} projects={projects} onDone={() => setEditing(false)} onReload={onReload} />
        : <ItemDetails item={item} projectName={projectName} />}
      <p className="text-[12px] text-muted">{t('preview.mentionHint', { slug: `#${item.slug}` })}</p>
      {item.status === 'ready' ? <ItemText item={item} parts={detail.textParts} page={page} onPage={onPage} /> : null}
      <ConfirmModal isOpen={confirming} title={t('delete.title')} message={t('delete.message', { title: item.title })}
        confirmLabel={t('delete.confirm')} variant="danger" isLoading={writes.remove.isPending}
        onConfirm={() => writes.remove.mutate()} onCancel={() => setConfirming(false)}>
        {writes.remove.isError
          ? <p role="alert" className="mt-3 text-sm text-danger">{failureText(t, libraryFailure(writes.remove.error, 'delete'))}</p>
          : null}
      </ConfirmModal>
    </>
  )
}

export default function PreviewDrawer({ itemId, page, onPage, onClose, canWrite, projects }: Readonly<{
  itemId: string | null
  page: number
  onPage: (page: number) => void
  onClose: () => void
  canWrite: boolean
  projects: readonly ProjectOption[] | null
}>) {
  const { t } = useTranslation('library')
  const detail = useQuery({
    queryKey: libraryKeys.item(itemId ?? ''),
    queryFn: () => libraryApi.get(itemId ?? ''),
    enabled: itemId !== null,
    refetchInterval: (query) => (query.state.data !== undefined && isInFlight(query.state.data.item) ? IN_FLIGHT_REFETCH_MS : false),
  })
  const item = detail.data?.item
  const notFound = detail.isError && libraryFailure(detail.error) === 'notFound'
  return (
    <SideSheet isOpen={itemId !== null} onClose={onClose} size="wide" icon={FileText}
      title={item?.title ?? t('preview.title')} description={item === undefined ? undefined : `#${item.slug}`}>
      {detail.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('preview.loading')}
        </p>
      ) : null}
      {notFound ? <p role="alert" className="text-sm text-muted">{t('preview.notFound')}</p> : null}
      {detail.isError && !notFound
        ? <LoadFailed onRetry={() => void detail.refetch()} retrying={detail.isFetching} message={t('preview.loadFailed')} />
        : null}
      {detail.data === undefined ? null : (
        <DrawerBody detail={detail.data} page={page} onPage={onPage} canWrite={canWrite} projects={projects}
          onDeleted={onClose} onReload={() => detail.refetch()} />
      )}
    </SideSheet>
  )
}
