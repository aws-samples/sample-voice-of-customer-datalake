/**
 * @fileoverview A zustand `persist` string storage that keeps some fields per
 * browser tab (sessionStorage) and the rest as shared preferences (localStorage).
 *
 * The industry default for panel chrome: whether a panel is open is the state
 * of one tab — opening it in one tab must not open it in the next one — while
 * preferences (mode, toggles) follow the user across tabs. Both halves are
 * written under the same key, one per storage. A per-tab field found in the
 * localStorage half (a record from before the split) is ignored, so an old
 * `open: true` never reopens the panel in a fresh tab.
 *
 * A storage that throws (privacy modes, quota) is skipped: the store then
 * simply forgets that half, as zustand does when no storage is available.
 *
 * @module assistant/store/tabScopedStorage
 */
import { z } from 'zod'
import type { StateStorage } from 'zustand/middleware'

/** zustand's `StateStorage`, answered synchronously (Web Storage is). */
interface SyncStateStorage extends StateStorage<void> {
  getItem: (name: string) => string | null
}

const envelopeSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  version: z.number().optional(),
})
type Envelope = z.infer<typeof envelopeSchema>

function storageOrNull(get: () => Storage): Storage | null {
  try {
    return get()
  } catch {
    return null
  }
}

function readEnvelope(storage: Storage | null, name: string): Envelope | null {
  try {
    const raw = storage?.getItem(name) ?? null
    if (raw === null) return null
    const parsed = envelopeSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function writeEnvelope(storage: Storage | null, name: string, envelope: Envelope): void {
  try {
    storage?.setItem(name, JSON.stringify(envelope))
  } catch {
    // Quota or a disabled storage: this half is not kept, the store still works.
  }
}

function split(state: Record<string, unknown>, perTab: ReadonlySet<string>) {
  const entries = Object.entries(state)
  return {
    shared: Object.fromEntries(entries.filter(([key]) => !perTab.has(key))),
    tab: Object.fromEntries(entries.filter(([key]) => perTab.has(key))),
  }
}

interface Storages {
  /** Preferences shared by every tab. */
  shared: () => Storage
  /** State of this tab only. */
  tab: () => Storage
}

const BROWSER_STORAGES: Storages = { shared: () => window.localStorage, tab: () => window.sessionStorage }

/** A synchronous `StateStorage` keeping `perTabKeys` in the tab storage and every other field in the shared one. */
export function tabScopedStorage(perTabKeys: readonly string[], storages: Storages = BROWSER_STORAGES): SyncStateStorage {
  const perTab = new Set(perTabKeys)
  const shared = () => storageOrNull(storages.shared)
  const tab = () => storageOrNull(storages.tab)
  return {
    getItem: (name) => {
      const local = readEnvelope(shared(), name)
      const session = readEnvelope(tab(), name)
      if (local === null && session === null) return null
      const state = { ...split(local?.state ?? {}, perTab).shared, ...split(session?.state ?? {}, perTab).tab }
      return JSON.stringify({ state, version: local?.version ?? session?.version ?? 0 })
    },
    setItem: (name, value) => {
      const parsed = envelopeSchema.safeParse(JSON.parse(value))
      if (!parsed.success) return
      const halves = split(parsed.data.state, perTab)
      const version = parsed.data.version ?? 0
      writeEnvelope(shared(), name, { state: halves.shared, version })
      writeEnvelope(tab(), name, { state: halves.tab, version })
    },
    removeItem: (name) => {
      shared()?.removeItem(name)
      tab()?.removeItem(name)
    },
  }
}
