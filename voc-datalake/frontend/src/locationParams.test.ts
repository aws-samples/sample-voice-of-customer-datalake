/**
 * @fileoverview Fails when a page reads WHERE a person is from the query string (7.49.00, docs/document-canvas.md →
 * "Addresses"). A page, its tab and section, the item open on it, a sub-view and a mode are the PATH; the query
 * holds only what combines freely (filters, search, a sort, a window) and what another party puts there.
 *
 * Every production module that reads the query (`useSearchParams`, or a `.get` / `.getAll` / `.has` on a
 * URLSearchParams) is listed in {@link ALLOWED} with the keys it reads, their kind and why. No module reads a location
 * key ({@link LOCATION_KEYS}): an old `?tab=` link is not redirected either (a pre-release change). A new reader, a
 * new key, or a location key read anywhere fails here; so does an in-app link written with a location query
 * (`/admin?tab=…`).
 *
 * `api/` modules are scanned for reads too (api/feedbackFacets.ts reads the app's facet filters), not for links:
 * their `?…=` strings are API requests, not app addresses.
 *
 * @module locationParams.test
 */
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { productionSourcePaths } from './test/appSources'

const SRC = resolve(__dirname)
const SPEC_FILE = /\.(test|spec)\.(ts|tsx)$|-fixtures\.tsx?$|\/test\/|\/__tests__\//

/** Query keys that say where a person is: since 7.49.00 they are path segments, never read from the query. */
const LOCATION_KEYS: ReadonlySet<string> = new Set(['tab', 'section', 'doc', 'view', 'request', 'role', 'version', 'expired'])

type Kind =
  /** Filters, search, sort, a window or a scope picker: they combine freely, so they stay a query. */
  | 'filter'
  /** The review modal: it opens over ANY page (every path above), so it cannot be one page's path segment. */
  | 'overlay'
  /** A link's input for a form on the page, read once (and dropped): not a place. */
  | 'prefill'
  /** Another party's return: GitHub, an OAuth client, an emailed link. Its query is theirs by design. */
  | 'callback'
  /** Not the app's address at all (a signed URL's own parameters). */
  | 'other-url'

interface Allowed {
  readonly kind: Kind
  /** Every key the module reads by name (a literal or a constant of the module); [] when it reads by a list. */
  readonly keys: readonly string[]
  /** A helper's parameter the module reads its keys through (its callers pass the literal keys listed). */
  readonly via?: string
  readonly reason: string
}

const ALLOWED: Readonly<Record<string, Allowed>> = {
  // Filters and search.
  'api/feedbackFacets.ts': { kind: 'filter', keys: ['source', 'category', 'sentiment', 'usefulness'], reason: 'the facet filters (Dashboard, Categories, Problems) parsed from the address' },
  'hooks/useFacetParams.ts': { kind: 'filter', keys: [], reason: 'the facet filters, read through api/feedbackFacets.ts' },
  'pages/Categories/useCategoryFilters.ts': { kind: 'filter', keys: ['q', 'rating', 'rating_dir', 'dims', 'types', 'urgent'], via: 'name', reason: 'the Categories list filters and search (OWNED_PARAMS)' },
  'pages/ProblemAnalysis/useProblemFilters.ts': { kind: 'filter', keys: ['similarity', 'urgent', 'resolved', 'types'], via: 'name', reason: 'the Problem Analysis filters (OWNED_PARAMS)' },
  'pages/Radar/Radar.tsx': { kind: 'filter', keys: ['brand', 'days'], reason: 'the brand picker and the window: filters of the one Radar page' },
  'pages/FeatureRequests/useBoardControls.ts': { kind: 'filter', keys: ['q', 'status', 'sort'], reason: 'a board list\'s search, status filter and sort' },
  'pages/FeatureRequests/useInsights.ts': { kind: 'filter', keys: ['board', 'days'], reason: 'the Insights tab\'s board picker and window' },
  'pages/Agents/spendView.ts': { kind: 'filter', keys: ['month', 'by', 'workflow'], reason: 'the Spend view\'s month, grouping and workflow filter, and the Runs list\'s month' },
  'pages/Agents/EngineeringSpend.tsx': { kind: 'filter', keys: [], reason: 'writes the Spend filters spendView.ts reads' },
  'pages/Agents/skillsView.ts': { kind: 'filter', keys: ['connection'], reason: 'the Skills scope picker (the shared skills or one connection); the role and version are the path' },
  'pages/Agents/Registry/RegistryPage.tsx': { kind: 'filter', keys: ['connection'], reason: 'the Registry\'s scope picker (the shared skills or one connection, 7.52.00); the cards, the gates and a card are the path' },
  'pages/Agents/RunWorkspace/runsFilters.ts': { kind: 'filter', keys: ['flow', 'status'], reason: 'the Runs list\'s flow and status filters (7.51.00; its month through spendView.ts): they combine freely; a run and its agent are the path' },
  'pages/Agents/RunWorkspace/RunsView.tsx': { kind: 'filter', keys: [], reason: 'writes the Runs filters runsFilters.ts reads' },
  'pages/Settings/adminPaths.ts': { kind: 'filter', keys: ['scope'], reason: 'the Data sources scope switch (this workspace or the deployment); the tab, card and source are the path' },
  // The review modal.
  'hooks/useReviewModal.ts': { kind: 'overlay', keys: ['review', 'reviewBrand'], reason: 'one review over whatever page is open; Back closes it' },
  // Prefilled forms.
  'pages/Connect/Connect.tsx': { kind: 'prefill', keys: ['project'], reason: 'the token form\'s initial project pin (the project header\'s "Connect MCP")' },
  'pages/ProjectDetail/decisions/decisionDraft.ts': { kind: 'prefill', keys: ['newDecision', 'title', 'verdict', 'rationale', 'feedback'], via: 'name', reason: 'a decision draft from a deep link, read once and dropped' },
  'pages/ProjectDetail/decisions/DecisionsTab.tsx': { kind: 'prefill', keys: [], reason: 'drops the decision prefill once read (decisionDraft.ts)' },
  // External callbacks.
  'api/oauthRedirect.ts': { kind: 'callback', keys: ['redirect_uri'], reason: 'the MCP OAuth authorize request the consent page approves' },
  'pages/OAuthConsent/OAuthConsent.tsx': { kind: 'callback', keys: [], reason: 'the OAuth authorize request, passed whole to the API (docs/mcp.md)' },
  'pages/Agents/githubCallback.ts': { kind: 'callback', keys: [], reason: 'takes GitHub\'s return query once and removes it from the address' },
  'pages/Agents/GitHubAppCreated.tsx': { kind: 'callback', keys: ['code', 'state'], reason: 'GitHub\'s manifest return (`redirect_url`): `?code=&state=`' },
  'pages/Agents/GitHubAppInstalled.tsx': { kind: 'callback', keys: ['installation_id', 'setup_action', 'state'], reason: 'GitHub\'s installation return (`setup_url`)' },
  'pages/Board/BoardLogin.tsx': { kind: 'callback', keys: ['email', 'code'], reason: 'the emailed board sign-in link, read once and removed' },
  'pages/Board/signInLink.ts': { kind: 'callback', keys: [], reason: 'strips the emailed sign-in link\'s `email` and `code`' },
  'pages/Unsubscribe/Unsubscribe.tsx': { kind: 'callback', keys: ['t'], reason: 'the emailed one-click unsubscribe token' },
  // Not the app's address.
  'components/prototypeLinkLifetime.ts': { kind: 'other-url', keys: ['Expires'], reason: 'a CloudFront signed URL\'s own expiry' },
  // What the assistant is told is on screen.
  'assistant/page/pageContext.ts': { kind: 'filter', keys: [], reason: 'the assistant\'s page context: the filters on screen (PAGE_FILTERS), read by their list' },
}

/** A read by name on a receiver (`params.get('tab')`, `searchParams.has(NAME)`); the receiver is checked by {@link RECEIVER}. */
const NAMED_READ = /\b(\w+)\.(?:get|getAll|has)\(([^()]*)\)/g
/** The receivers that hold a query: `params`, `searchParams`, `query`, `search`, … (a Map's `.get` is no read). */
const RECEIVER = /(?:params|query|search)$/i
/** A read on a query built in place: `new URLSearchParams(search).get(…)`. */
const BUILT_READ = /\bURLSearchParams\([^()]*\)\.(?:get|getAll|has)\(([^()]*)\)/g
/** The query a GitHub return page took (githubCallback.ts `useTakenQuery`): `taken.get(…)`. */
const TAKEN_READ = /\btaken\.(?:get|getAll|has)\(([^()]*)\)/g
const LOCATION_LINK = /['"`][^'"`\n]*[?&](?:tab|section|doc|view|request|role|version|expired)=/

/** The module without its comments (whole comment lines and trailing `// …`), so a doc's example is no read. */
function codeOf(text: string): string {
  return text.split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .map((line) => line.replace(/\s\/\/\s.*$/, ''))
    .join('\n')
}

const LITERAL = /^(['"])([^'"]+)\1$/

/** A field of a module constant (`PARAM.status` → `PARAM = { status: 'status' }`), or null. */
function fieldKey(object: string, field: string, code: string): string | null {
  const body = new RegExp(String.raw`\b${object}\b[^=\n]*=\s*(?:Object\.freeze\()?\{([^}]*)\}`).exec(code)?.[1] ?? ''
  return new RegExp(String.raw`\b${field}\s*:\s*(['"])([^'"]+)\1`).exec(body)?.[2] ?? null
}

/** The value of a read's argument: a literal, a module constant (`NAME = 'x'`), or a field of one (`PARAM.status`). */
function keyOf(raw: string, code: string): string | null {
  const argument = raw.trim()
  const literal = LITERAL.exec(argument)
  if (literal !== null) return literal[2] ?? null
  const [object, field, ...more] = argument.split('.')
  if (field !== undefined && more.length === 0 && object !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(object)) return fieldKey(object, field, code)
  if (!/^\w+$/.test(argument)) return null
  return new RegExp(String.raw`\b${argument}\s*[:=]\s*(['"])([^'"]+)\1`).exec(code)?.[2] ?? null
}

/** Every argument the module reads the query by. */
function readArguments(code: string): string[] {
  const named = [...code.matchAll(NAMED_READ)].filter((match) => RECEIVER.test(match[1] ?? '')).map((match) => match[2] ?? '')
  const built = [...code.matchAll(BUILT_READ)].map((match) => match[1] ?? '')
  const taken = code.includes('useTakenQuery(') ? [...code.matchAll(TAKEN_READ)].map((match) => match[1] ?? '') : []
  return [...named, ...built, ...taken]
}

interface Reader {
  readonly file: string
  readonly keys: readonly string[]
  /** The arguments no key could be read from (an imported or typed constant, a loop variable). */
  readonly unresolved: readonly string[]
}

const SOURCES = productionSourcePaths(SRC, SPEC_FILE).map((path) => ({ file: relative(SRC, path), code: codeOf(readFileSync(path, 'utf8')) }))

const READERS: readonly Reader[] = SOURCES.flatMap(({ file, code }) => {
  const reads = readArguments(code)
  if (reads.length === 0 && !code.includes('useSearchParams(')) return []
  const keys = reads.map((argument) => keyOf(argument, code)).filter((key): key is string => key !== null)
  const unresolved = reads.filter((argument) => keyOf(argument, code) === null).map((argument) => argument.trim())
  return [{ file, keys: [...new Set(keys)].sort((a, b) => a.localeCompare(b)), unresolved }]
})

describe('where a person is lives in the path, not the query', () => {
  it('finds the readers (the scan is not vacuous)', () => {
    expect(READERS.length).toBeGreaterThan(20)
    expect(READERS.map((reader) => reader.file)).toContain('hooks/useReviewModal.ts')
  })

  it('lists every module that reads the query', () => {
    expect(READERS.map((reader) => reader.file).filter((file) => ALLOWED[file] === undefined)).toStrictEqual([])
  })

  it('lists no module that no longer reads it', () => {
    const readers = new Set(READERS.map((reader) => reader.file))
    expect(Object.keys(ALLOWED).filter((file) => !readers.has(file))).toStrictEqual([])
  })

  it('reads in each module only the keys listed for it', () => {
    const unlisted = READERS.flatMap(({ file, keys }) => keys
      .filter((key) => !(ALLOWED[file]?.keys ?? []).includes(key))
      .map((key) => `${file}: ${key}`))
    expect(unlisted).toStrictEqual([])
  })

  it('reads every key by a name the scan can read (a list reader, keys: [], and a helper\'s `via` aside)', () => {
    // A key read through an imported constant or a loop variable would pass the key checks unseen.
    const unread = READERS.flatMap(({ file, unresolved }) => ((ALLOWED[file]?.keys.length ?? 0) > 0 ? unresolved : [])
      .filter((argument) => argument !== ALLOWED[file]?.via)
      .map((argument) => `${file}: ${argument}`))
    expect(unread).toStrictEqual([])
  })

  it('reads no location key anywhere', () => {
    const misplaced = Object.entries(ALLOWED).flatMap(([file, { kind, keys }]) => keys
      .filter((key) => LOCATION_KEYS.has(key))
      .map((key) => `${file}: ${key} (${kind})`))
    expect(misplaced).toStrictEqual([])
  })

  it('gives every allowed module its reason', () => {
    expect(Object.entries(ALLOWED).filter(([, { reason }]) => reason.trim().length < 12).map(([file]) => file)).toStrictEqual([])
  })

  it('writes no in-app link with a location in its query', () => {
    const links = SOURCES.filter(({ file }) => !file.startsWith('api/')).flatMap(({ file, code }) => code.split('\n')
      .filter((line) => LOCATION_LINK.test(line))
      .map((line) => `${file}: ${line.trim()}`))
    expect(links).toStrictEqual([])
  })
})
