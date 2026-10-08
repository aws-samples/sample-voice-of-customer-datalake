/**
 * @fileoverview Company or personal memories: search, status/kind filters,
 * cursor paging, +1, forget (ConfirmModal), restore and multi-select merge.
 *
 * Who may do what (the server enforces every rule; the UI only offers what
 * will succeed):
 * - personal — the owner (the list only ever holds the caller's own): all actions;
 * - company — anyone +1s; curators forget, restore and merge.
 *
 * @module pages/Memory/MemoryList
 */
import { useDeferredValue, useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2, Merge, Search } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { isMemoryKind as isKind, isMemoryStatus as isStatus, MEMORY_KINDS, MEMORY_STATUSES, memoryApi, memoryKeys } from '../../api/memoryApi'
import type { MemoryItem, MemoryKind, MemoryScope, MemoryStatus } from '../../api/memoryApi'
import MemoryCard from './MemoryCard'
import type { MemoryActions } from './MemoryCard'
import AddMemoryForm from './AddMemoryForm'
import MergeModal from './MergeModal'

interface Filters {
  q: string
  status: MemoryStatus | ''
  kind: MemoryKind | ''
}

function useMemoryPages(scope: MemoryScope, filters: Filters) {
  const params = {
    scope,
    q: filters.q,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
  }
  return useInfiniteQuery({
    queryKey: memoryKeys.list(params),
    queryFn: ({ pageParam }) => memoryApi.list({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor,
  })
}

function useMemoryMutations(onMerged: () => void) {
  const queryClient = useQueryClient()
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: memoryKeys.all() })
  return {
    confirm: useMutation({ mutationFn: memoryApi.confirm, onSuccess: invalidate }),
    forget: useMutation({ mutationFn: memoryApi.forget, onSuccess: invalidate }),
    restore: useMutation({ mutationFn: memoryApi.restore, onSuccess: invalidate }),
    merge: useMutation({
      mutationFn: ({ ids, statement }: { ids: string[]; statement: string }) => memoryApi.merge(ids, statement),
      onSuccess: () => { onMerged(); invalidate() },
    }),
    invalidate,
  }
}

export default function MemoryList({ scope, canCurate }: Readonly<{ scope: MemoryScope; canCurate: boolean }>) {
  const { t } = useTranslation('memory')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<MemoryStatus | ''>('')
  const [kind, setKind] = useState<MemoryKind | ''>('')
  const q = useDeferredValue(query)
  const pages = useMemoryPages(scope, { q, status, kind })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [forgetting, setForgetting] = useState<MemoryItem | null>(null)
  const [merging, setMerging] = useState(false)
  const mutations = useMemoryMutations(() => { setMerging(false); setSelected(new Set()) })

  const items = pages.data?.pages.flatMap((p) => p.items) ?? []
  const canManage = scope === 'personal' || canCurate
  const selectedItems = items.filter((m) => selected.has(m.memory_id))
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (!next.delete(id)) next.add(id)
    return next
  })
  const actionsFor = (memory: MemoryItem): MemoryActions => ({
    onConfirm: () => mutations.confirm.mutate(memory.memory_id),
    ...(canManage ? {
      onForget: () => setForgetting(memory),
      onRestore: () => mutations.restore.mutate(memory.memory_id),
      onToggleSelect: () => toggle(memory.memory_id),
    } : {}),
  })

  return (
    <div className="space-y-4">
      <AddMemoryForm scope={scope} canCurate={canCurate} onAdded={mutations.invalidate} />

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input type="search" aria-label={t('filters.search')} placeholder={t('filters.search')} value={query} onChange={(e) => setQuery(e.target.value)} className="input pl-8" />
        </div>
        <select aria-label={t('filters.status')} value={status} onChange={(e) => setStatus(isStatus(e.target.value) ? e.target.value : '')} className="select sm:w-40">
          <option value="">{t('filters.anyStatus')}</option>
          {MEMORY_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
        <select aria-label={t('filters.kind')} value={kind} onChange={(e) => setKind(isKind(e.target.value) ? e.target.value : '')} className="select sm:w-44">
          <option value="">{t('filters.anyKind')}</option>
          {MEMORY_KINDS.map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}
        </select>
      </div>

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
        isLoading={pages.isLoading}
        isError={pages.isError}
        selected={selected}
        actionsFor={actionsFor}
      />
      {pages.hasNextPage ? (
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
          onMerge={(statement) => mutations.merge.mutate({ ids: selectedItems.map((m) => m.memory_id), statement })}
          onClose={() => setMerging(false)}
        />
      ) : null}
    </div>
  )
}

function ListBody({ items, isLoading, isError, selected, actionsFor }: Readonly<{
  items: readonly MemoryItem[]
  isLoading: boolean
  isError: boolean
  selected: ReadonlySet<string>
  actionsFor: (memory: MemoryItem) => MemoryActions
}>) {
  const { t } = useTranslation('memory')
  if (isError) {
    return <p role="alert" className="text-sm text-danger flex items-center gap-2"><AlertCircle size={16} /> {t('loadFailed')}</p>
  }
  if (isLoading) {
    return <p className="text-sm text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> {t('loading')}</p>
  }
  if (items.length === 0) return <p className="card text-sm text-muted text-center">{t('empty')}</p>
  return (
    <ul className="space-y-3">
      {items.map((memory) => (
        <MemoryCard key={memory.memory_id} memory={memory} selected={selected.has(memory.memory_id)} actions={actionsFor(memory)} />
      ))}
    </ul>
  )
}
