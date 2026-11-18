/**
 * @fileoverview Router location → contract `PageContext` (pure).
 *
 * The patterns mirror the protected children in `routes.tsx`. They are a table
 * here, not read from `routes.tsx`, because that module imports `Layout`, which
 * mounts the assistant — reading it from here would be an import cycle.
 * `pageContext.test.tsx` walks the real route table and fails when a route has
 * no pattern below.
 *
 * @module assistant/page/pageContext
 */
import { matchPath } from 'react-router-dom'
import { reviewFromSearch } from '../../hooks/useReviewModal'
import { AGENTS_PATH_VIEWS } from '../../pages/Agents/agentsPaths'
import { parseProjectRest } from '../../pages/ProjectDetail/projectPaths'
import { TAB_PATH_PAGES } from '../../pages/tabPathPages'
import { projectPathParts } from '../../pages/ProjectDetail/useProjectPlace'
import { ENGINEERING_RUN_ID, MAX_ID_LENGTH, boundedFilterValue } from '@stream/assistant/contract'
import type { PAGE_FILTER_KEYS, PageContext, PageKind } from '@stream/assistant/contract'

interface PagePattern {
  /** Route path as written in routes.tsx (relative to `/`; '' is the index). */
  route: string
  kind: PageKind
  /** Which `:param` carries the entity id, and where it goes (only when it matches `shape`, if given). */
  param?: { name: string; field: 'projectId' | 'feedbackId' | 'agentId' | 'engineeringRunId'; shape?: RegExp }
  /**
   * The context chip's `assistant:pages.<label>` key when it differs from
   * `kind` (the stream contract has fewer kinds than the SPA has pages).
   */
  label?: 'admin' | 'workflow' | 'connect' | 'account'
}

export const PAGE_PATTERNS: readonly PagePattern[] = [
  { route: '', kind: 'home' },
  { route: 'dashboard', kind: 'dashboard' },
  { route: 'feedback', kind: 'feedback' },
  { route: 'feedback/:id', kind: 'feedback', param: { name: 'id', field: 'feedbackId' } },
  { route: 'categories', kind: 'categories' },
  { route: 'problems', kind: 'problems' },
  { route: 'chat', kind: 'chat' },
  { route: 'projects', kind: 'projects' },
  // Its tabs, a document, an older version and full screen are the page's own paths (projectPaths.ts).
  { route: 'projects/:id/*', kind: 'project', param: { name: 'id', field: 'projectId' } },
  { route: 'prioritization', kind: 'prioritization' },
  { route: 'data-explorer/*', kind: 'data-explorer' },
  { route: 'scrapers', kind: 'scrapers' },
  // The list, the picker and a form's builder and preview are the page's own paths (FeedbackForms/builder/builderPaths.ts).
  { route: 'feedback-forms/*', kind: 'feedback-forms' },
  // Administration is the `settings` kind; `/settings`
  // only redirects to it now but keeps its pattern for the redirect's instant.
  { route: 'admin/*', kind: 'settings', label: 'admin' },
  { route: 'settings', kind: 'settings', label: 'admin' },
  { route: 'memory/*', kind: 'memory' },
  { route: 'agents', kind: 'agents' },
  // One library workflow: the agents pack (workflow tools), no agent in context. BEFORE the Workflows view's
  // `agents/workflows/*`, which would read it as the view.
  { route: 'agents/workflows/:workflowId', kind: 'agents', label: 'workflow' },
  // A default engineering flow's unsaved copy: the same pack, nothing stored yet.
  { route: 'agents/workflows/templates/:templateId', kind: 'agents', label: 'workflow' },
  // An engineering run's workspace (and an agent open in it, 7.51.00): the agents pack, the run on screen
  // (get_engineering_run's default), no agent.
  { route: 'agents/engineering/:runId/*', kind: 'agents',
    param: { name: 'runId', field: 'engineeringRunId', shape: ENGINEERING_RUN_ID } },
  // Where GitHub sends an administrator back from the deployment's GitHub App (7.45.00): the agents pack, nothing in
  // context (the query is the page's alone, taken and removed from the address at once).
  { route: 'agents/connections/github/created', kind: 'agents' },
  { route: 'agents/connections/github/installed', kind: 'agents' },
  // The list's views (agentsPaths.ts), BEFORE `agents/:id/*`, or a view's name reads as an agent id.
  { route: 'agents/runs/*', kind: 'agents' },
  { route: 'agents/workflows/*', kind: 'agents' },
  { route: 'agents/spend/*', kind: 'agents' },
  { route: 'agents/connections/*', kind: 'agents' },
  { route: 'agents/skills/*', kind: 'agents' },
  // Agent orchestration's Registry (7.52.00, with Quality gates as its filter): its own places under it.
  { route: 'agents/registry/*', kind: 'agents' },
  // The engineering setup guide and its steps (7.50.00, SetupGuide/setupGuidePaths.ts): the agents pack, no agent.
  { route: 'agents/setup/*', kind: 'agents' },
  // One agent and its tabs (`/agents/<id>/runs`).
  { route: 'agents/:id/*', kind: 'agent', param: { name: 'id', field: 'agentId' } },
  // Knowledge → Company: the company tool pack (context, my objectives, design system).
  { route: 'company/*', kind: 'company' },
  // `other` (core pack): the stream contract has no `connect` or `account` page kind.
  { route: 'connect', kind: 'other', label: 'connect' },
  // Radar (docs/radar.md): its own kind — core (get_radar), insights, and the scrapers pack so
  // "set up Radar for <brand>" (brand list, Radar scraper / connector, scan) works on this page.
  { route: 'radar', kind: 'radar' },
  { route: 'account/*', kind: 'other', label: 'account' },
  // A workspace's members (docs/multi-workspace.md): no assistant pack.
  { route: 'members', kind: 'other' },
  // A workspace's brand and plugins: no assistant pack either.
  { route: 'workspace-settings', kind: 'other' },
  // Participants (docs/participants.md): its own kind — core + the participants pack (lists, add people).
  { route: 'participants/*', kind: 'participants' },
  // The in-app feature-request board (docs/feature-requests.md): no assistant pack either.
  { route: 'feature-requests', kind: 'other' },
  { route: 'feature-requests/insights', kind: 'other' },
  { route: 'feature-requests/requests/*', kind: 'other' },
  // One feedback board (/feature-requests/:slug, a request open on it): no assistant pack in this release either.
  { route: 'feature-requests/:slug/*', kind: 'other' },
  // MCP OAuth consent (docs/mcp.md → "OAuth sign-in"): approve an assistant's sign-in; no assistant pack.
  { route: 'oauth/authorize', kind: 'other', label: 'connect' },
]

type PageFilterKey = (typeof PAGE_FILTER_KEYS)[number]

/**
 * The URL filters each filtered page owns (its hook's OWNED_PARAMS, minus legacy keys), sent as
 * `page.filters` so the assistant knows what is on screen (5.35: on /categories it could not see
 * the open category). The Dashboard has no URL filters: its time range is `forwardedProps.days`.
 */
const PAGE_FILTERS: Partial<Record<PageKind, readonly PageFilterKey[]>> = {
  categories: ['q', 'source', 'sentiment', 'usefulness', 'category', 'subcategory', 'rating', 'rating_dir', 'urgent', 'channel', 'dims', 'tag'],
  problems: ['source', 'usefulness', 'category', 'subcategory', 'urgent', 'resolved', 'similarity'],
}

/** The page's non-empty filters, each cut to the contract bound; undefined when none is set. */
function filtersFrom(kind: PageKind, search: string): PageContext['filters'] {
  const params = new URLSearchParams(search)
  const entries: [PageFilterKey, string][] = (PAGE_FILTERS[kind] ?? []).flatMap((key): [PageFilterKey, string][] => {
    const value = boundedFilterValue(key, params.get(key)?.trim() ?? '')
    return value === '' ? [] : [[key, value]]
  })
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

const MAX_TAB = 64
const MAX_PATH = 200
const TAB_PATTERN = /^[\w-]+$/

function paramValue(params: Record<string, string | undefined>, name: string): string | undefined {
  const value = params[name]
  return value !== undefined && value !== '' && value.length <= MAX_ID_LENGTH ? value : undefined
}

/** The route's entity id, when present and of its shape (an engineering run's is a ULID). */
function entityId(params: Record<string, string | undefined>, param: NonNullable<PagePattern['param']>): string | undefined {
  const value = paramValue(params, param.name)
  return value !== undefined && (param.shape?.test(value) ?? true) ? value : undefined
}

/** A project page's place (its path: projectPaths.ts), or null elsewhere. */
function projectPlaceOf({ pathname }: LocationLike) {
  const parts = projectPathParts(pathname)
  return parts === null ? null : parseProjectRest(parts.rest).place
}

/**
 * The tab a page's path names (7.49.00: a tab is a path): `/admin/<tab>/…`, `/memory/<tab>`, an Agents view
 * (`/agents/spend`), an agent's tab (`/agents/<id>/runs`), the boards' Insights; undefined when none does.
 */
function pathTab(pathname: string): string | undefined {
  const [first = '', second, third] = pathname.split('/').filter((segment) => segment !== '')
  if (TAB_PATH_PAGES.has(first)) return second
  if (first === 'feature-requests') return second === 'insights' ? second : undefined
  if (first !== 'agents' || second === undefined) return undefined
  if (AGENTS_PATH_VIEWS.has(second)) return third === undefined || second === 'skills' ? second : undefined
  return second === 'engineering' ? undefined : third
}

/** The page's tab: a project's is its path (`/projects/<id>/documents`), another page's its path too ({@link pathTab}). */
function tabFrom(location: LocationLike): string | undefined {
  const tab = projectPlaceOf(location)?.tab ?? pathTab(location.pathname)
  return tab !== undefined && tab.length <= MAX_TAB && TAB_PATTERN.test(tab) ? tab : undefined
}

function matchPattern(pattern: PagePattern, pathname: string) {
  return matchPath({ path: `/${pattern.route}`, end: true }, pathname)
}

/**
 * The `assistant:pages.*` key naming this page in the context chip: the
 * route's own label when it has one (/admin, /connect, …), else its kind.
 */
export function pageLabelKey(page: Pick<PageContext, 'kind' | 'path'>): string {
  const pattern = PAGE_PATTERNS.find((p) => p.kind === page.kind && matchPattern(p, page.path) !== null)
  return pattern?.label ?? page.kind
}

export interface LocationLike {
  pathname: string
  search: string
}

/**
 * Map a location to a page context; titles are added by the hook. An open review modal
 * (`?review=<id>`, one of OUR reviews) adds `feedbackId`, so the assistant's subject is the
 * review on screen; a Radar review (`&reviewBrand=`) does not — its id is not in our feedback.
 */
export function pageContextFromLocation(location: LocationLike): PageContext {
  const base = routeContext(location)
  const review = reviewFromSearch(location.search)
  return review.reviewId !== null && review.reviewBrand === null ? { ...base, feedbackId: review.reviewId } : base
}

/**
 * The document the Documents tab of a project page has open (`/projects/<id>/documents/<docId>`,
 * pages/ProjectDetail/projectPaths.ts), or undefined: elsewhere, or an id over MAX_ID_LENGTH.
 * Only a candidate: whether it is a prototype is known from the project record (usePageContext).
 */
export function selectedDocumentId(page: Pick<PageContext, 'kind'>, location: LocationLike): string | undefined {
  if (page.kind !== 'project') return undefined
  const id = projectPlaceOf(location)?.documentId ?? null
  return id !== null && id.length <= MAX_ID_LENGTH ? id : undefined
}

function routeContext(location: LocationLike): PageContext {
  const path = location.pathname.slice(0, MAX_PATH)
  const tab = tabFrom(location)
  const base = { path, ...(tab !== undefined ? { tab } : {}) }
  for (const pattern of PAGE_PATTERNS) {
    const match = matchPattern(pattern, location.pathname)
    if (match === null) continue
    const id = pattern.param ? entityId(match.params, pattern.param) : undefined
    const filters = filtersFrom(pattern.kind, location.search)
    return {
      kind: pattern.kind,
      ...base,
      ...(pattern.param && id !== undefined ? { [pattern.param.field]: id } : {}),
      ...(filters === undefined ? {} : { filters }),
    }
  }
  return { kind: 'other', ...base }
}
