/**
 * @fileoverview Router location → contract `PageContext` (pure).
 *
 * The patterns mirror the protected children in `routes.tsx`. They are a table
 * here, not read from `routes.tsx`, because that module imports `Layout`, which
 * mounts the assistant — reading it from here would be an import cycle.
 * `pageContext.test.ts` walks the real route table and fails when a route has
 * no pattern below.
 *
 * @module assistant/page/pageContext
 */
import { matchPath } from 'react-router-dom'
import { MAX_ID_LENGTH } from '../contract'
import type { PageContext, PageKind } from '../contract'

interface PagePattern {
  /** Route path as written in routes.tsx (relative to `/`; '' is the index). */
  route: string
  kind: PageKind
  /** Which `:param` carries the entity id, and where it goes. */
  param?: { name: string; field: 'projectId' | 'feedbackId' | 'agentId' }
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
  { route: 'projects/:id', kind: 'project', param: { name: 'id', field: 'projectId' } },
  { route: 'prioritization', kind: 'prioritization' },
  { route: 'data-explorer', kind: 'data-explorer' },
  { route: 'scrapers', kind: 'scrapers' },
  { route: 'feedback-forms', kind: 'feedback-forms' },
  // Administration (todofeatures §6.1) is the `settings` kind; `/settings`
  // only redirects to it now but keeps its pattern for the redirect's instant.
  { route: 'admin', kind: 'settings' },
  { route: 'settings', kind: 'settings' },
  { route: 'memory', kind: 'memory' },
  { route: 'agents', kind: 'agents' },
  { route: 'agents/:id', kind: 'agent', param: { name: 'id', field: 'agentId' } },
  // Knowledge → Company: the company tool pack (context, my objectives, design system).
  { route: 'company', kind: 'company' },
  // `other` (core pack): the stream contract has no `connect` or `account` page kind.
  { route: 'connect', kind: 'other' },
  { route: 'account', kind: 'other' },
]

const MAX_TAB = 64
const MAX_PATH = 200
const TAB_PATTERN = /^[\w-]+$/

function paramValue(params: Record<string, string | undefined>, name: string): string | undefined {
  const value = params[name]
  return value !== undefined && value !== '' && value.length <= MAX_ID_LENGTH ? value : undefined
}

function tabFrom(search: string): string | undefined {
  const tab = new URLSearchParams(search).get('tab')
  return tab !== null && tab.length <= MAX_TAB && TAB_PATTERN.test(tab) ? tab : undefined
}

export interface LocationLike {
  pathname: string
  search: string
}

/** Map a location to a page context; titles are added by the hook. */
export function pageContextFromLocation(location: LocationLike): PageContext {
  const path = location.pathname.slice(0, MAX_PATH)
  const tab = tabFrom(location.search)
  const base = { path, ...(tab !== undefined ? { tab } : {}) }
  for (const pattern of PAGE_PATTERNS) {
    const match = matchPath({ path: `/${pattern.route}`, end: true }, location.pathname)
    if (match === null) continue
    const id = pattern.param ? paramValue(match.params, pattern.param.name) : undefined
    return {
      kind: pattern.kind,
      ...base,
      ...(pattern.param && id !== undefined ? { [pattern.param.field]: id } : {}),
    }
  }
  return { kind: 'other', ...base }
}
