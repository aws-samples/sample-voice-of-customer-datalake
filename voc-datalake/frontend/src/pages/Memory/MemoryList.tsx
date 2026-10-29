/**
 * @fileoverview Company or personal memories: search, status/kind filters,
 * cursor paging, +1, inline edit, forget (ConfirmModal), restore, multi-select
 * merge and the "Add memory" dialog.
 *
 * Who may do what (the server enforces every rule; the UI only offers what
 * will succeed):
 * - personal — the owner (the list only ever holds the caller's own): add, edit,
 *   "Still true" (the confirm route: it refreshes the memory against decay, never a
 *   +1, which on your own memory would be yourself), forget, restore, merge;
 * - company — anyone adds (a non-curator's goes to review) and +1s; curators
 *   edit, forget, restore and merge.
 *
 * Search is debounced (one request per typed query). A search page can come
 * back empty while the server still has more to read (it filters page by page),
 * so an empty search keeps reading a few pages before it says "No memories match".
 *
 * @module pages/Memory/MemoryList
 */
import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2, Merge, Plus, Search } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { isMemoryKind as isKind, isMemoryStatus as isStatus, MEMORY_KINDS, MEMORY_STATUSES, memoryApi, memoryKeys } from '../../api/memoryApi'
import type { MemoryItem, MemoryKind, MemoryListParams, MemoryPage, MemoryScope, MemoryStatus } from '../../api/memoryApi'
import MemoryCard from './MemoryCard'
import type { MemoryActions } from './MemoryCard'
import type { MemoryEditing } from './MemoryEditor'
import AddMemoryDialog from './AddMemoryDialog'
import MergeModal from './MergeModal'
import { useMemoryOverlay } from './memoryOverlay'
import { ALL_STATUSES } from './memoryOverlay'
import type { MemoryFilters, MemoryStatusFilter } from './memoryOverlay'
import { useMemoryMutations } from './useMemoryMutations'

/** How many empty search pages are read before the list says nothing matches. */
const MAX_EMPTY_SEARCH_PAGES = 5

/**
 * The statuses "All statuses" walks, in order. The server lists one status per call
 * (none = active), so the old "Any status" was active only and never showed an
 * archived (forgotten) memory; the default is now labelled "Active" and "All
 * statuses" reads every status. Company archived memories are for curators only.
 */
function anyStatusOrder(scope: MemoryScope, canCurate: boolean): MemoryStatus[] {
  return MEMORY_STATUSES.filter((s) => s !== 'archived' || scope === 'personal' || canCurate)
}

/** A select value as a status filter ('' = the server default, active). */
const toStatusFilter = (value: string): MemoryStatusFilter => (value === ALL_STATUSES || isStatus(value) ? value : '')

interface PageCursor { readonly index: number; readonly cursor: string }

const uniqueById = (items: readonly MemoryItem[]): MemoryItem[] => [...new Map(items.map((m) => [m.memory_id, m])).values()]
const FIRST_PAGE: PageCursor | undefined = { index: 0, cursor: '' }

/** The next page after `last`: on in the same status, else the first page of the next one. */
function nextCursor(statuses: readonly MemoryStatus[], index: number, next: string | null | undefined): PageCursor | undefined {
  if (next) return { index, cursor: next }
  return index + 1 < statuses.length ? { index: index + 1, cursor: '' } : undefined
}

type Base = Omit<MemoryListParams, 'status' | 'cursor'>

/**
 * One page from `at`. When its status is exhausted (no cursor left), the next
 * status is read on and appended in the same page, so "All statuses" shows every
 * status at once rather than one status per "Load more"; a page that still has a
 * cursor in its own status ends there (a search filters page by page —
 * `useReadOnWhileEmpty` reads on from there).
 */
async function readPage(base: Base, statuses: readonly MemoryStatus[], at: PageCursor, serverDefault: boolean): Promise<MemoryPage & { following?: PageCursor }> {
  const status = statuses[at.index] ?? 'active'
  // The default view is the server's own default (active): no `status` param.
  const statusParam = serverDefault ? {} : { status }
  const page = await memoryApi.list({ ...base, ...statusParam, ...(at.cursor ? { cursor: at.cursor } : {}) })
  const following = nextCursor(statuses, at.index, page.next_cursor)
  if (following === undefined || following.index === at.index) return { ...page, following }
  const rest = await readPage(base, statuses, following, serverDefault)
  return { ...rest, items: [...page.items, ...rest.items] }
}

/** The statuses one list reads: the server default (active), one status, or all of them in turn. */
function statusesFor(status: MemoryStatusFilter, scope: MemoryScope, canCurate: boolean): MemoryStatus[] {
  if (status === ALL_STATUSES) return anyStatusOrder(scope, canCurate)
  return [status === '' ? 'active' : status]
}

function useMemoryPages(scope: MemoryScope, filters: MemoryFilters, canCurate: boolean) {
  const base: Base = { scope, q: filters.q, ...(filters.kind ? { kind: filters.kind } : {}) }
  const statuses = statusesFor(filters.status, scope, canCurate)
  const keyStatus = filters.status === '' ? {} : { status: filters.status }
  return useInfiniteQuery({
    queryKey: [...memoryKeys.list(base), keyStatus],
    queryFn: ({ pageParam }) => readPage(base, statuses, pageParam ?? { index: 0, cursor: '' }, filters.status === ''),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.following,
  })
}

/** An empty search reads on (a few pages) instead of offering "Load more" over nothing. */
function useReadOnWhileEmpty(pages: ReturnType<typeof useMemoryPages>, searching: boolean, shown: number) {
  const loaded = pages.data?.pages.length ?? 0
  const { hasNextPage, isFetching, fetchNextPage } = pages
  const keepReading = searching && shown === 0 && hasNextPage && !isFetching && loaded > 0 && loaded < MAX_EMPTY_SEARCH_PAGES
  // `loaded` is a dependency on purpose: a page can finish within one render, leaving
  // `keepReading` true throughout — the effect must still run again for the next page.
  useEffect(() => { if (keepReading) void fetchNextPage() }, [keepReading, loaded, fetchNextPage])
  return searching && shown === 0 && (isFetching || keepReading)
}

function FilterBar({ query, status, kind, onQuery, onStatus, onKind, onAdd }: Readonly<{
  query: string; status: MemoryStatusFilter; kind: MemoryKind | ''
  onQuery: (q: string) => void; onStatus: (s: MemoryStatusFilter) => void; onKind: (k: MemoryKind | '') => void; onAdd: () => void
}>) {
  const { t } = useTranslation('memory')
  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <div className="relative flex-1">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input type="search" aria-label={t('filters.search')} placeholder={t('filters.search')} value={query} onChange={(e) => onQuery(e.target.value)} className="input pl-8" />
      </div>
      <select aria-label={t('filters.status')} value={status} onChange={(e) => onStatus(toStatusFilter(e.target.value))} className="select sm:w-40">
        <option value="">{t('status.active')}</option>
        {MEMORY_STATUSES.filter((s) => s !== 'active').map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        <option value={ALL_STATUSES}>{t('filters.allStatuses')}</option>
      </select>
      <select aria-label={t('filters.kind')} value={kind} onChange={(e) => onKind(isKind(e.target.value) ? e.target.value : '')} className="select sm:w-44">
        <option value="">{t('filters.anyKind')}</option>
        {MEMORY_KINDS.map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}
      </select>
      <button type="button" onClick={onAdd} className="btn btn-primary flex items-center justify-center gap-1.5">
        <Plus size={14} aria-hidden /> {t('add.open')}
      </button>
    </div>
  )
}

/** What happened to the memory just added: live, sent for review, and whether details were hidden. */
function AddedNotice({ item }: Readonly<{ item: MemoryItem | null | undefined }>) {
  const { t } = useTranslation('memory')
  if (item === undefined) return null
  return <p role="status" className="text-xs text-ok">{item?.status === 'proposed' ? t('add.sentForReview') : t('add.saved')}</p>
}

export default function MemoryList({ scope, canCurate }: Readonly<{ scope: MemoryScope; canCurate: boolean }>) {
  const { t } = useTranslation('memory')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<MemoryStatusFilter>('')
  const [kind, setKind] = useState<MemoryKind | ''>('')
  const q = useDebouncedValue(query.trim())
  const filters = useMemo(() => ({ q, status, kind }), [q, status, kind])
  const pages = useMemoryPages(scope, filters, canCurate)
  // De-duplicated by id: "All statuses" reads several statuses, and an item that changed status between pages must not show twice.
  const listed = useMemo(() => uniqueById(pages.data?.pages.flatMap((p) => p.items) ?? []), [pages.data])
  const { items, record } = useMemoryOverlay(listed, filters)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [forgetting, setForgetting] = useState<MemoryItem | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  const [adding, setAdding] = useState(false)
  const [lastAdded, setLastAdded] = useState<MemoryItem | null | undefined>(undefined)
  // +1s the server did not count (the caller already backs them): the card says so.
  const [backed, setBacked] = useState<ReadonlySet<string>>(new Set())
  const mutations = useMemoryMutations(record, () => { setMerging(false); setSelected(new Set()) },
    (id) => setBacked((current) => new Set(current).add(id)))
  const readingOn = useReadOnWhileEmpty(pages, q !== '', items.length)

  const canManage = scope === 'personal' || canCurate
  const selectedItems = items.filter((m) => selected.has(m.memory_id))
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (!next.delete(id)) next.add(id)
    return next
  })
  const startEdit = (id: string) => { mutations.update.reset(); setEditingId(id) }
  const editingFor = (memory: MemoryItem): MemoryEditing | undefined => (memory.memory_id !== editingId ? undefined : {
    pending: mutations.update.isPending,
    failed: mutations.update.isError,
    onSave: (statement) => mutations.update.mutate({ id: memory.memory_id, statement }, { onSuccess: () => setEditingId(null) }),
    onCancel: () => setEditingId(null),
  })
  const actionsFor = (memory: MemoryItem): MemoryActions => ({
    onConfirm: () => mutations.confirm.mutate(memory.memory_id),
    alreadyBacked: backed.has(memory.memory_id),
    personal: scope === 'personal',
    ...(canManage ? {
      onEdit: () => startEdit(memory.memory_id),
      onForget: () => setForgetting(memory),
      onRestore: () => mutations.restore.mutate(memory.memory_id),
      onToggleSelect: () => toggle(memory.memory_id),
    } : {}),
  })

  return (
    <div className="space-y-4">
      <FilterBar query={query} status={status} kind={kind} onQuery={setQuery} onStatus={setStatus} onKind={setKind}
        onAdd={() => setAdding(true)} />
      <AddedNotice item={lastAdded} />

      {canManage && selected.size > 0 ? (
        <div className="flex items-center justify-between gap-2 card p-3 bg-bg-accent">
          <span className="text-sm text-text">{t('selected', { count: selected.size })}</span>
          <button type="button" disabled={selectedItems.length < 2} onClick={() => setMerging(true)} className="btn btn-primary btn-sm flex items-center gap-1.5">
            <Merge size={14} /> {t('merge.open')}
          </button>
        </div>
      ) : null}

      <ListBody
        items={items}
        isLoading={pages.isLoading || readingOn}
        isError={pages.isError}
        query={q}
        selected={selected}
        actionsFor={actionsFor}
        editingFor={editingFor}
        onAdd={() => setAdding(true)}
      />
      {pages.hasNextPage && items.length > 0 ? (
        <button type="button" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage} className="btn btn-secondary w-full">
          {pages.isFetchingNextPage ? <Loader2 size={14} className="animate-spin" /> : null} {t('loadMore')}
        </button>
      ) : null}

      <ConfirmModal
        isOpen={forgetting !== null}
        title={t('forgetTitle')}
        message={t('forgetMessage', { statement: forgetting?.statement ?? '' })}
        confirmLabel={t('forget')}
        variant="danger"
        isLoading={mutations.forget.isPending}
        onConfirm={() => { if (forgetting) mutations.forget.mutate(forgetting.memory_id, { onSuccess: () => setForgetting(null) }) }}
        onCancel={() => setForgetting(null)}
      />
      {merging ? (
        <MergeModal
          items={selectedItems}
          pending={mutations.merge.isPending}
          failed={mutations.merge.isError}
          onMerge={(statement) => mutations.merge.mutate({ sources: selectedItems, statement })}
          onClose={() => setMerging(false)}
        />
      ) : null}
      {adding ? (
        <AddMemoryDialog scope={scope} canCurate={canCurate} onClose={() => setAdding(false)}
          onAdded={(item) => { mutations.added(item); setLastAdded(item) }} />
      ) : null}
    </div>
  )
}

function ListBody({ items, isLoading, isError, query, selected, actionsFor, editingFor, onAdd }: Readonly<{
  items: readonly MemoryItem[]
  isLoading: boolean
  isError: boolean
  query: string
  selected: ReadonlySet<string>
  actionsFor: (memory: MemoryItem) => MemoryActions
  editingFor: (memory: MemoryItem) => MemoryEditing | undefined
  onAdd: () => void
}>) {
  const { t } = useTranslation('memory')
  if (isError) {
    return <p role="alert" className="text-sm text-danger flex items-center gap-2"><AlertCircle size={16} /> {t('loadFailed')}</p>
  }
  if (isLoading && items.length === 0) {
    return <p className="text-sm text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> {t('loading')}</p>
  }
  if (items.length === 0 && query !== '') return <p className="card text-sm text-muted text-center">{t('noMatch', { q: query })}</p>
  if (items.length === 0) {
    return (
      <div className="card text-sm text-muted text-center space-y-2">
        <p>{t('empty')}</p>
        <button type="button" onClick={onAdd} className="btn btn-secondary btn-sm">{t('add.open')}</button>
      </div>
    )
  }
  return (
    <ul className="space-y-3">
      {items.map((memory) => (
        <MemoryCard key={memory.memory_id} memory={memory} selected={selected.has(memory.memory_id)} actions={actionsFor(memory)}
          editing={editingFor(memory)} />
      ))}
    </ul>
  )
}
