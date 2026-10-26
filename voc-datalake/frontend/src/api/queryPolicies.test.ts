/**
 * @fileoverview The caching policy: every query-key root in the app is classified
 * (a new query cannot ship without a policy), the families resolve to the right
 * defaults on the app's QueryClient, and a 4xx is never fetched twice.
 */
import { describe, expect, it, vi } from 'vitest'
import { ApiError, AuthError } from '../lib/errors'
import {
  FAMILY_POLICIES, ROOT_FAMILIES, SUB_KEY_FAMILIES, cacheFamilyOf, createAppQueryClient, shouldRetryQuery,
} from './queryPolicies'

const sources = import.meta.glob(
  ['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx', '!../test/**', '!../**/*fixtures*'],
  { query: '?raw', import: 'default', eager: true },
)

/** A declaration that names a query key: `fooKey`, `FOO_KEY`, `fooKeys = {…}`, `ROOT = '…'`. */
const KEY_DECLARATION = /(?:const|function)\s+(\w*(?:Key|KEY|Keys|_ROOT))\b([\s\S]*?)(?=\n\s*\n|\n(?:export|const|\/\*\*|\/\/)\b|$)/g
/** `…Key` helpers that build i18n / error / label strings, not query keys. */
const NOT_A_QUERY_KEY = /I18N|Error|Label|Title/

/** The first capture group of every match. */
function firstGroups(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
}

function declaredRoots(name: string, body: string): string[] {
  if (NOT_A_QUERY_KEY.test(name)) return []
  return name.endsWith('_ROOT') ? firstGroups(body, /^\s*=\s*'([^']+)'/g) : firstGroups(body, /\[\s*'([^']+)'/g)
}

/** Every query-key root a module uses: inline `queryKey: ['root', …]` and every key factory / constant. */
function queryKeyRoots(source: string): string[] {
  const inline = firstGroups(source, /queryKey:\s*\[\s*'([^']+)'/g)
  const declared = [...source.matchAll(KEY_DECLARATION)].flatMap((m) => declaredRoots(m[1] ?? '', m[2] ?? ''))
  return [...inline, ...declared]
}

/** Root → the first module using it (the file is only for the failure message). */
function rootsInSource(): Map<string, string> {
  const pairs = Object.entries(sources).flatMap(([file, source]) =>
    (typeof source === 'string' ? queryKeyRoots(source).map((root) => [root, file] as const) : []))
  return new Map([...pairs].reverse())
}

describe('query-key classification', () => {
  const found = rootsInSource()

  it('finds the roots it is meant to find (the scanner itself works)', () => {
    expect(found.has('summary')).toBe(true) // factory: hooks/useSummaryQuery
    expect(found.has('radar')).toBe(true) // keys object: api/radarApi
    expect(found.has('all-project-details')).toBe(true) // `_ROOT` constant
    expect(found.has('prototype-pins')).toBe(true) // last declaration in its file
  })

  it('classifies every query-key root used in src/ (add new roots to ROOT_FAMILIES)', () => {
    const unclassified = [...found].filter(([root]) => !Object.hasOwn(ROOT_FAMILIES, root)).map(([r, f]) => `${r} (${f})`)
    expect(unclassified).toStrictEqual([])
  })

  it('lists no root the app no longer uses', () => {
    expect(Object.keys(ROOT_FAMILIES).filter((root) => !found.has(root))).toStrictEqual([])
  })

  it('refines only roots that are classified', () => {
    expect(SUB_KEY_FAMILIES.filter(([key]) => !Object.hasOwn(ROOT_FAMILIES, String(key[0])))).toStrictEqual([])
  })
})

describe('family defaults on the app QueryClient', () => {
  const client = createAppQueryClient()
  const resolved = (key: readonly unknown[]) => client.defaultQueryOptions({ queryKey: key })

  it('reuses feedback data for 5 minutes, keeps it 30, and does not refetch on focus', () => {
    const summary = resolved(['summary', { days: 7 }])
    expect(summary.staleTime).toBe(5 * 60_000)
    expect(summary.gcTime).toBe(30 * 60_000)
    expect(summary.refetchOnWindowFocus).toBe(false)
  })

  it('reuses configuration for 10 minutes without focus refetches', () => {
    expect(resolved(['brand-settings']).staleTime).toBe(10 * 60_000)
    expect(resolved(['categories-config']).refetchOnWindowFocus).toBe(false)
    expect(resolved(['radar', 'brands']).staleTime).toBe(FAMILY_POLICIES.config.staleTime)
  })

  it('keeps per-user live data short and focus-refreshed, even under a config root', () => {
    const brief = resolved(['settings', 'my-briefing', 'brief', 'sub-1'])
    expect(brief.staleTime).toBe(30_000)
    expect(brief.refetchOnWindowFocus).toBe(true)
    expect(resolved(['assistant', 'sessions']).staleTime).toBe(30_000)
  })

  it('does not focus-refetch the agent list the sidebar already polls, but keeps runs live', () => {
    expect(resolved(['agents', 'list']).refetchOnWindowFocus).toBe(false)
    expect(resolved(['agents', 'run', 'a1', 'r1']).refetchOnWindowFocus).toBe(true)
    expect(cacheFamilyOf(['agents', 'plans', 'list'])).toBe('live')
  })

  it('gives everything else the 60 s global default', () => {
    expect(resolved(['projects']).staleTime).toBe(60_000)
    expect(resolved(['never-classified']).staleTime).toBe(60_000)
    expect(cacheFamilyOf(['radar', 'overview'])).toBe('feedbackData')
    expect(cacheFamilyOf([42])).toBe('standard')
  })
})

describe('retries', () => {
  it('never retries a client error', () => {
    for (const status of [400, 401, 403, 404, 409]) expect(shouldRetryQuery(0, new ApiError(status))).toBe(false)
    expect(shouldRetryQuery(0, new AuthError())).toBe(false)
  })

  it('retries a server error, a throttle and a network failure once', () => {
    expect(shouldRetryQuery(0, new ApiError(503))).toBe(true)
    expect(shouldRetryQuery(0, new ApiError(429))).toBe(true)
    expect(shouldRetryQuery(0, new TypeError('Failed to fetch'))).toBe(true)
    expect(shouldRetryQuery(1, new ApiError(503))).toBe(false)
  })

  it('fetches a 404 exactly once through the app client', async () => {
    const client = createAppQueryClient()
    const queryFn = vi.fn(() => Promise.reject(new ApiError(404)))
    await expect(client.fetchQuery({ queryKey: ['project', 'gone'], queryFn, retryDelay: 0 })).rejects.toThrow('404')
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('fetches a 500 twice through the app client', async () => {
    const client = createAppQueryClient()
    const queryFn = vi.fn(() => Promise.reject(new ApiError(500)))
    await expect(client.fetchQuery({ queryKey: ['project', 'flaky'], queryFn, retryDelay: 0 })).rejects.toThrow('500')
    expect(queryFn).toHaveBeenCalledTimes(2)
  })
})
