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
  /** The version the store writes today (voc-config is at 3: `'all'` became all time, then the 14-day default). */
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
    write: () => useAuthStore.getState().setUser(USER),
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
    version: 3,
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

describe('voc-config: the default moved from 7 days to 14 days by imported date (version 3)', () => {
  /** Rehydrate `state` stored at `version` and return the range and basis it loads as. */
  async function loaded(state: Record<string, unknown>, version: number) {
    useConfigStore.setState({ timeRange: '24h', dateBasis: 'review' })
    storeBlob('voc-config', { state, version })
    await useConfigStore.persist.rehydrate()
    const { timeRange, dateBasis } = useConfigStore.getState()
    return { timeRange, dateBasis }
  }

  it.each([0, 1, 2])('moves a version-%i blob still on the old default (7d + imported) to 14d + imported', async (version) => {
    await expect(loaded({ timeRange: '7d', customDays: null, dateBasis: 'imported' }, version))
      .resolves.toStrictEqual({ timeRange: '14d', dateBasis: 'imported' })
  })

  it('treats a 7d blob from before the date-basis picker (no dateBasis) as the old default', async () => {
    await expect(loaded({ timeRange: '7d', customDays: null }, 1))
      .resolves.toMatchObject({ timeRange: '14d' })
  })

  it('keeps 7 days by review date: only the old default PAIR moves', async () => {
    await expect(loaded({ timeRange: '7d', customDays: null, dateBasis: 'review' }, 2))
      .resolves.toStrictEqual({ timeRange: '7d', dateBasis: 'review' })
  })

  it.each(['24h', '30d', '90d', 'custom'])('keeps a stored %s choice', async (timeRange) => {
    await expect(loaded({ timeRange, customDays: 21, dateBasis: 'imported' }, 2))
      .resolves.toStrictEqual({ timeRange, dateBasis: 'imported' })
  })

  it('migrates only once: a version-3 blob that picked 7d again keeps it', async () => {
    await expect(loaded({ timeRange: '7d', customDays: null, dateBasis: 'imported' }, 3))
      .resolves.toStrictEqual({ timeRange: '7d', dateBasis: 'imported' })
  })

  it("still keeps a pre-version-2 'all' (the 90 Days preset) on 90 days", async () => {
    await expect(loaded({ timeRange: 'all', customDays: null, dateBasis: 'imported' }, 1))
      .resolves.toStrictEqual({ timeRange: '90d', dateBasis: 'imported' })
  })
})
