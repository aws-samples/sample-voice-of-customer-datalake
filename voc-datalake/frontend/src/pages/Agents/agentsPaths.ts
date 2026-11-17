/**
 * @fileoverview The Agents pages' addresses, as paths (7.49.00, utils/pathPlace.ts):
 *
 * - the list's views: `/agents` (the agents), `/agents/runs` (7.51.00, the engineering runs), `/agents/workflows`,
 *   `/agents/spend`, `/agents/connections`, `/agents/skills`; on Skills, a role's history `/agents/skills/<role>` and
 *   one version `/agents/skills/<role>/v/<n>`;
 * - one agent's tabs: `/agents/<id>/<tab>` (`/agents/<id>` is Settings);
 * - the engineering setup guide, `/agents/setup[/<step>]` (SetupGuide/setupGuidePaths.ts), a page of its own.
 *
 * The view names are reserved: an agent's id is never one (`ag_<12 hex>`, lambda/shared/agents_store.py), and
 * routes.tsx lists each view before `agents/:id`. What a view shows stays in the query as a filter does: the Spend
 * tab's `?month=&by=&workflow=`, the Skills tab's scope `?connection=`, the Runs tab's `?month=&flow=&status=`.
 *
 * The query names no view: no `?tab=` link of before is read (7.49.00, a pre-release change).
 *
 * @module pages/Agents/agentsPaths
 */
import { pathOf, segmentsUnder } from '../../utils/pathPlace'
import type { Address, PlaceRead } from '../../utils/pathPlace'
import type { TabPage } from '../../utils/tabPaths'

const AGENTS_PATH = '/agents'

/** The list's views; `agents` is the list itself (`/agents`). */
export const AGENTS_VIEWS = ['agents', 'runs', 'workflows', 'spend', 'connections', 'skills'] as const

/** The pages under `/agents` that are neither a view of the list nor an agent (`setup`: the setup guide). */
const AGENTS_PAGES: ReadonlySet<string> = new Set(['setup'])

/** The views that are a path under `/agents` (every view but the list itself, which is `/agents`). */
export const AGENTS_PATH_VIEWS: ReadonlySet<string> = new Set(AGENTS_VIEWS.filter((view) => view !== 'agents'))
export type AgentsView = (typeof AGENTS_VIEWS)[number]

/** Where the Agents list is: its view and, on Skills, the role and the version open. */
export interface AgentsPlace {
  /** The view the path names (unknown to this caller or not: the page decides what it may show). */
  readonly view: AgentsView
  /** Skills: the role whose history is open (as written in the path; the page checks it), else null. */
  readonly role: string | null
  /** Skills: the version of the role open, else null (the history). */
  readonly version: number | null
}

const LIST: AgentsPlace = { view: 'agents', role: null, version: null }
const VERSION_SEGMENT = 'v'
const POSITIVE_INTEGER = /^[1-9]\d{0,5}$/

function isView(value: string | null | undefined): value is AgentsView {
  return AGENTS_VIEWS.some((view) => view === value)
}

/** The path of a view of the list (`/agents/spend`), or of a role and version on Skills. */
export function agentsPath(place: Pick<AgentsPlace, 'view'> & Partial<AgentsPlace>): string {
  if (place.view === 'agents') return AGENTS_PATH
  const role = place.view === 'skills' && place.role !== undefined && place.role !== null ? [place.role] : []
  const version = role.length > 0 && place.version !== undefined && place.version !== null
    ? [VERSION_SEGMENT, String(place.version)] : []
  return pathOf(['agents', place.view, ...role, ...version])
}

/** The Skills place a path's segments after `/agents/skills` name, and whether they name it as its path does. */
function skillsPlace(rest: readonly string[]): { readonly place: AgentsPlace; readonly own: boolean } {
  const [role, marker, number, ...extra] = rest
  if (role === undefined) return { place: { ...LIST, view: 'skills' }, own: true }
  const versioned = marker === VERSION_SEGMENT && number !== undefined && POSITIVE_INTEGER.test(number)
  const place: AgentsPlace = { view: 'skills', role, version: versioned ? Number(number) : null }
  return { place, own: extra.length === 0 && (marker === undefined || versioned) }
}

/** The place a view's path names (`first`, then the rest of its segments), and whether it names it as its path does. */
function viewPlace(first: AgentsView, rest: readonly string[]): { readonly place: AgentsPlace; readonly own: boolean } {
  return first === 'skills' ? skillsPlace(rest) : { place: { ...LIST, view: first }, own: rest.length === 0 }
}

/**
 * The list's place an address names, and the address to replace it with (null: its own); null when the address is
 * not the list's (an agent, a workflow, a run, the GitHub return pages).
 */
export function readAgentsAddress(address: Address): PlaceRead<AgentsPlace> | null {
  const segments = segmentsUnder(AGENTS_PATH, address.pathname)
  if (segments === null) return null
  const [first, ...rest] = segments
  if (first === undefined) return { place: LIST, replaceWith: null }
  if (!isView(first) || first === 'agents') return null
  const { place, own } = viewPlace(first, rest)
  return { place, replaceWith: own ? null : { pathname: agentsPath(place), search: address.search } }
}

/** One agent's page (`/agents/<id>`), or one of its tabs (`/agents/<id>/runs`). */
export function agentPath(agentId: string, tab?: string): string {
  return pathOf(['agents', agentId, ...(tab === undefined ? [] : [tab])])
}

/** One agent's tabs as paths (utils/tabPaths.ts): `/agents/<id>/<tab>`. */
export function agentTabPage<T extends string>(agentId: string, tabs: readonly [T, ...T[]]): TabPage<T> {
  return { base: agentPath(agentId), tabs }
}

/** The agent an address is one of the pages of (`/agents/<id>/…`), or null. */
export function agentIdOf(pathname: string): string | null {
  const [first] = segmentsUnder(AGENTS_PATH, pathname) ?? []
  return first === undefined || isView(first) || AGENTS_PAGES.has(first) ? null : first
}
