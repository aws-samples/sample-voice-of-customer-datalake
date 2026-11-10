/**
 * @fileoverview The memory list's writes: +1, edit, forget, restore, merge — and the
 * add from the "Add memory" dialog. Each one lays the item the server answered
 * over the list at once (`memoryOverlay`) and invalidates every memory list, so
 * the change shows immediately and the server copy catches up underneath.
 *
 * @module pages/Memory/useMemoryMutations
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { memoryApi, memoryKeys } from '../../api/memoryApi'
import type { MemoryItem, MemoryStatus } from '../../api/memoryApi'

type RecordWrite = (items: readonly MemoryItem[], options?: { created?: boolean }) => void

const ARCHIVED: MemoryStatus = 'archived'
const present = (item: MemoryItem | null): MemoryItem[] => (item === null ? [] : [item])

export function useMemoryMutations(record: RecordWrite, onMerged: () => void, onNotCounted: (memoryId: string) => void = () => {}) {
  const queryClient = useQueryClient()
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: memoryKeys.all() })
  const settle = (item: MemoryItem | null) => { record(present(item)); invalidate() }
  return {
    confirm: useMutation({
      mutationFn: memoryApi.confirm,
      onSuccess: ({ item, counted }, memoryId) => {
        if (!counted) { onNotCounted(memoryId) }
        settle(item)
      },
    }),
    update: useMutation({ mutationFn: memoryApi.update, onSuccess: settle }),
    forget: useMutation({ mutationFn: memoryApi.forget, onSuccess: settle }),
    restore: useMutation({ mutationFn: memoryApi.restore, onSuccess: settle }),
    merge: useMutation({
      mutationFn: ({ sources, statement }: { sources: readonly MemoryItem[]; statement: string }) =>
        memoryApi.merge(sources.map((m) => m.memory_id), statement),
      onSuccess: (merged, { sources }) => {
        // The server archives the originals; show that now rather than after the index catches up.
        record(sources.map((m) => ({ ...m, status: ARCHIVED })))
        record(present(merged), { created: true })
        onMerged()
        invalidate()
      },
    }),
    /** After "Add memory" saved: show the new memory first, then refetch. */
    added: (item: MemoryItem | null) => { record(present(item), { created: true }); invalidate() },
  }
}
