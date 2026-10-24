/**
 * @fileoverview The memory list as the user just changed it.
 *
 * Company memories are listed from a secondary index that is only eventually
 * consistent, so a refetch right after "Remember", +1, restore or merge can still
 * answer the old list — the new memory "did not appear". Every write answers the
 * item as stored; this overlay keeps those answers and lays them over whatever the
 * server lists (the item replaces its listed copy; a new one is shown first) until
 * the list is left. The list is still invalidated after every write, so the server
 * copy catches up underneath.
 *
 * @module pages/Memory/memoryOverlay
 */
import { useCallback, useMemo, useState } from 'react'
import type { MemoryItem, MemoryKind, MemoryStatus } from '../../api/memoryApi'

/** "All statuses": every status the caller may list, archived (forgotten) included. */
export const ALL_STATUSES = 'all'
/** '' = the server default (active), one status, or every status. */
export type MemoryStatusFilter = MemoryStatus | '' | typeof ALL_STATUSES

export interface MemoryFilters {
  readonly q: string
  readonly status: MemoryStatusFilter
  readonly kind: MemoryKind | ''
}

/**
 * Whether `memory` belongs in a list with `filters`, the way the server decides:
 * a status filter (no filter = active, `all` = any), a kind and a case-insensitive text match.
 */
export function matchesFilters(memory: MemoryItem, filters: MemoryFilters): boolean {
  const status = filters.status === '' ? 'active' : filters.status
  const q = filters.q.trim().toLowerCase()
  return (status === ALL_STATUSES || memory.status === status)
    && (filters.kind === '' || memory.kind === filters.kind)
    && (q === '' || memory.statement.toLowerCase().includes(q))
}

interface Overlay {
  /** The latest copy of each item the user changed, by id. */
  readonly latest: ReadonlyMap<string, MemoryItem>
  /** Ids the user created here (shown even before the server lists them), newest first. */
  readonly created: readonly string[]
}

/** The server's page laid under the user's own changes, filtered as the server would. */
export function applyOverlay(listed: readonly MemoryItem[], overlay: Overlay, filters: MemoryFilters): MemoryItem[] {
  const listedIds = new Set(listed.map((m) => m.memory_id))
  const fresh = overlay.created
    .filter((id) => !listedIds.has(id))
    .flatMap((id) => { const item = overlay.latest.get(id); return item === undefined ? [] : [item] })
  const current = listed.map((m) => overlay.latest.get(m.memory_id) ?? m)
  return [...fresh, ...current].filter((m) => matchesFilters(m, filters))
}

/** `applyOverlay` bound to component state: `record` an answered write, `created` for a new memory. */
export function useMemoryOverlay(listed: readonly MemoryItem[], filters: MemoryFilters) {
  const [overlay, setOverlay] = useState<Overlay>({ latest: new Map(), created: [] })
  const record = useCallback((items: readonly MemoryItem[], options: { created?: boolean } = {}) => {
    if (items.length === 0) return
    setOverlay((current) => ({
      latest: new Map([...current.latest, ...items.map((m): [string, MemoryItem] => [m.memory_id, m])]),
      created: options.created === true ? [...items.map((m) => m.memory_id), ...current.created] : current.created,
    }))
  }, [])
  const items = useMemo(() => applyOverlay(listed, overlay, filters), [listed, overlay, filters])
  return { items, record }
}
