/**
 * @fileoverview The Documents Library (7.62.00, docs/documents-library.md): reference documents the assistant can
 * read (`#short-name` in a chat), at `/library` (inside a workspace `/workspace/{slug}/library`, the router's
 * basename): the list with its search, tag, project and sort, the upload sheet, and the preview drawer of one item,
 * which `?item=<id>&page=<n>` opens (libraryParams.ts).
 *
 * The scope is the request's (`X-Workspace-Id`): a workspace's library is its own, else the deployment's. A project
 * link is the deployment's alone (projects are not yet per workspace), so the project filter and field are offered
 * outside a workspace only. A viewer reads; the server decides every write.
 *
 * @module pages/Library
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { projectsApi } from '../../api/projectsApi'
import { projectsKey } from '../../api/projectQueryKeys'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useConfigStore } from '../../store/configStore'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import LibraryIntro from './LibraryIntro'
import LibraryList from './LibraryList'
import LibraryToolbar from './LibraryToolbar'
import { DEFAULT_FILTERS } from './libraryFilters'
import type { LibraryFilters, ProjectOption } from './libraryFilters'
import PreviewDrawer from './PreviewDrawer'
import UploadSheet from './UploadSheet'
import { usePreviewParams } from './libraryParams'
import { useLibraryList } from './useLibraryList'

/** The deployment's projects to filter by and link to, or null inside a workspace (no project link there). */
function useProjectOptions(enabled: boolean): readonly ProjectOption[] | null {
  const projects = useQuery({ queryKey: projectsKey(), queryFn: projectsApi.getProjects, enabled })
  return useMemo(() => {
    if (!enabled) return null
    return (projects.data?.projects ?? []).map((project) => ({ id: project.project_id, name: project.name }))
  }, [enabled, projects.data])
}

function LibraryContent() {
  const { t } = useTranslation('library')
  const workspace = useCurrentWorkspace()
  const canWrite = workspace?.role !== 'viewer'
  const projects = useProjectOptions(workspace === null)
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS)
  const [uploading, setUploading] = useState(false)
  const search = useDebouncedValue(filters.search.trim())
  const query = useMemo(() => ({
    ...(search === '' ? {} : { q: search }),
    ...(filters.tag === '' ? {} : { tag: filters.tag }),
    ...(filters.projectId === '' ? {} : { projectId: filters.projectId }),
    sort: filters.sort,
  }), [search, filters.tag, filters.projectId, filters.sort])
  const { pages, items, tags } = useLibraryList(query)
  const preview = usePreviewParams()
  const filtered = search !== '' || filters.tag !== '' || filters.projectId !== ''
  return (
    <>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start sm:gap-4">
        <PageTitle title={t('title')} subtitle={t('subtitle')} />
        {canWrite ? (
          <button type="button" className="btn btn-primary w-full sm:w-auto" onClick={() => setUploading(true)}>
            <Upload size={16} aria-hidden="true" />{t('upload.open')}
          </button>
        ) : null}
      </div>
      <LibraryIntro />
      {canWrite ? null : <p role="note" className="text-sm text-muted">{t('readOnly')}</p>}
      <LibraryToolbar filters={filters} onChange={setFilters} tags={tags} projects={projects} />
      <LibraryList canWrite={canWrite} onOpen={preview.open} onUpload={() => setUploading(true)} state={{
        items, filtered, isLoading: pages.isPending,
        loadFailed: pages.isError ? { retry: () => void pages.refetch(), retrying: pages.isFetching } : null,
        hasMore: pages.hasNextPage, loadingMore: pages.isFetchingNextPage, onLoadMore: () => void pages.fetchNextPage(),
      }} />
      <UploadSheet isOpen={uploading} onClose={() => setUploading(false)} />
      <PreviewDrawer itemId={preview.itemId} page={preview.page} onPage={preview.setPage} onClose={preview.close}
        canWrite={canWrite} projects={projects} />
    </>
  )
}

export default function Library() {
  const { t } = useTranslation('library')
  const { config } = useConfigStore()
  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl space-y-4 sm:space-y-6">
      {config.apiEndpoint ? <LibraryContent /> : (
        <>
          <PageTitle title={t('title')} subtitle={t('subtitle')} />
          <div className="card border-warn/30 bg-warn-subtle text-sm text-warn">{t('configureFirst')}</div>
        </>
      )}
    </div>
  )
}
