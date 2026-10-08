/**
 * Every persisted store is versioned and keeps the blobs users already have (issue #267 item 9).
 *
 * Before versioning, Zustand wrote these blobs as version 0. Each store now
 * declares version 1 with a `migrate` that keeps that shape, so an existing
 * blob still loads; a blob that does not match it loads as the defaults.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { useAuthStore } from './authStore'
import { useConfigStore } from './configStore'
import { useManualImportStore } from './manualImportStore'

interface StoreCase {
  key: string
  /** A blob in the shape this store persisted before it was versioned. */
  legacyState: Record<string, unknown>
  rehydrate: () => Promise<void> | void
  /** The slice of live state that `legacyState` should have restored. */
  read: () => unknown
  expected: unknown
  /** Put a known value in the store so a rejected blob is seen to leave it alone. */
  preset: () => void
  presetValue: unknown
  /** Change one persisted field, which writes the blob. */
  write: () => void
  /** The version the store writes today (voc-config is at 2: `'all'` became all time). */
  version: number
}

const USER = { username: 'ann', email: 'ann@example.com', groups: ['users'] }
const REVIEW = { text: 'Great', rating: 5, author: null, date: null, title: null }

const CASES: StoreCase[] = [
  {
    key: 'voc-auth',
    legacyState: { user: USER, accessToken: 'a', idToken: 'i', isAuthenticated: true },
    rehydrate: () => useAuthStore.persist.rehydrate(),
    read: () => useAuthStore.getState().user,
    expected: USER,
    preset: () => useAuthStore.setState({ user: null }),
    presetValue: null,
    write: () => useAuthStore.getState().setError('x'),
    version: 1,
  },
  {
    key: 'voc-config',
    legacyState: { timeRange: '30d', customDays: null, dateBasis: 'review' },
    rehydrate: () => useConfigStore.persist.rehydrate(),
    read: () => useConfigStore.getState().timeRange,
    expected: '30d',
    preset: () => useConfigStore.setState({ timeRange: '7d' }),
    presetValue: '7d',
    write: () => useConfigStore.getState().setTimeRange('48h'),
    version: 2,
  },
  {
    key: 'voc-manual-import',
    legacyState: { sourceUrl: 'https://example.com/r', parsedReviews: [REVIEW], jobId: null },
    rehydrate: () => useManualImportStore.persist.rehydrate(),
    read: () => useManualImportStore.getState().parsedReviews,
    expected: [REVIEW],
    preset: () => useManualImportStore.setState({ parsedReviews: [] }),
    presetValue: [],
    write: () => useManualImportStore.getState().setSourceUrl('https://example.com/s'),
    version: 1,
  },
]

/** Serve `blob` as the stored value of `key`, the way persist reads it back. */
function storeBlob(key: string, blob: unknown): void {
  vi.mocked(localStorage.getItem).mockImplementation((k) => (k === key ? JSON.stringify(blob) : null))
}

const WrittenSchema = z.object({ version: z.number() })

afterEach(() => {
  vi.mocked(localStorage.getItem).mockReset()
  vi.mocked(localStorage.getItem).mockReturnValue(null)
})

describe.each(CASES)('$key', (store) => {
  it('loads a blob written before the store was versioned', async () => {
    store.preset()
    storeBlob(store.key, { state: store.legacyState, version: 0 })

    await store.rehydrate()

    expect(store.read()).toStrictEqual(store.expected)
  })

  it('ignores a blob that does not match the persisted shape', async () => {
    store.preset()
    // One wrong-typed field per store; the other stores' keys are unknown here and stripped.
    storeBlob(store.key, { state: { ...store.legacyState, user: 7, timeRange: 7, parsedReviews: 'x' }, version: 0 })

    await store.rehydrate()

    expect(store.read()).toStrictEqual(store.presetValue)
  })

  it('writes its blob at its current version', () => {
    store.write()

    const written = vi.mocked(localStorage.setItem).mock.calls.filter(([k]) => k === store.key).at(-1)
    expect(WrittenSchema.parse(JSON.parse(written?.[1] ?? '{}')).version).toBe(store.version)
  })
})

describe("voc-config: 'all' changed from the 90-day preset to all time (version 2)", () => {
  it.each([0, 1])("keeps a version-%i blob's 'all' (then the 90 Days preset) on 90 days", async (version) => {
    useConfigStore.setState({ timeRange: '7d' })
    storeBlob('voc-config', { state: { timeRange: 'all', customDays: null, dateBasis: 'imported' }, version })

    await useConfigStore.persist.rehydrate()

    expect(useConfigStore.getState().timeRange).toBe('90d')
  })

  it("loads a version-2 'all' as all time", async () => {
    useConfigStore.setState({ timeRange: '7d' })
    storeBlob('voc-config', { state: { timeRange: 'all', customDays: null, dateBasis: 'imported' }, version: 2 })

    await useConfigStore.persist.rehydrate()

    expect(useConfigStore.getState().timeRange).toBe('all')
  })

  it('leaves every other pre-version-2 range as it was', async () => {
    useConfigStore.setState({ timeRange: '7d' })
    storeBlob('voc-config', { state: { timeRange: '30d', customDays: null, dateBasis: 'imported' }, version: 1 })

    await useConfigStore.persist.rehydrate()

    expect(useConfigStore.getState().timeRange).toBe('30d')
  })
})
