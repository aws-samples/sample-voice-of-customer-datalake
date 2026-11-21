/**
 * @fileoverview A project page's address, as paths (inside a workspace, under its `/workspace/<slug>` base):
 *
 * - a tab: `/projects/<id>/overview` (`/projects/<id>` is the Overview too), `/personas`, `/focus-groups`, `/product`,
 *   `/documents`, `/decisions`, `/participants`;
 * - a document: `/projects/<id>/documents/<docId>`;
 * - an older version of it, read-only (the toolbar's version picker): `…/documents/<docId>/v/<n>` (the version on
 *   the page is never `/v/`);
 * - full screen: `…/documents/<docId>/focus`, `…/documents/<docId>/v/<n>/focus`.
 *
 * The query holds none of these (7.49.00: no query link of before is read, a pre-release change); it keeps its own
 * parameters (filters, a prefilled decision, an open review) across every move.
 *
 * @module pages/ProjectDetail/projectPaths
 */
import { parseTab } from './types'
import type { Tab } from './types'

/** Where a project page is: its tab and, on Documents, the open document, the older version shown, full screen. */
export interface ProjectPlace {
  readonly tab: Tab
  /** The open document (the Documents tab only); null: none. */
  readonly documentId: string | null
  /** The older version on screen (`/v/<n>`); null: the document's own. */
  readonly version: number | null
  readonly focus: boolean
}

const OVERVIEW: ProjectPlace = { tab: 'overview', documentId: null, version: null, focus: false }

const VERSION_SEGMENT = 'v'
const FOCUS_SEGMENT = 'focus'
const POSITIVE_INTEGER = /^[1-9]\d{0,8}$/

/** The place of a tab (nothing open on it). */
export function tabPlace(tab: Tab): ProjectPlace {
  return { ...OVERVIEW, tab }
}

/** The place of a document (its own version, not full screen). */
export function documentPlace(documentId: string): ProjectPlace {
  return { ...OVERVIEW, tab: 'documents', documentId }
}

/** The app path of `place` in the project `projectId`. */
export function projectPlacePath(projectId: string, place: ProjectPlace): string {
  const base = `/projects/${encodeURIComponent(projectId)}/${place.tab}`
  if (place.tab !== 'documents' || place.documentId === null) return base
  const version = place.version === null ? '' : `/${VERSION_SEGMENT}/${String(place.version)}`
  const focus = place.focus ? `/${FOCUS_SEGMENT}` : ''
  return `${base}/${encodeURIComponent(place.documentId)}${version}${focus}`
}

/** A document's path (`/projects/<id>/documents/<docId>`): the in-app links that open one. */
export function projectDocumentPath(projectId: string, documentId: string): string {
  return projectPlacePath(projectId, documentPlace(documentId))
}

/** The document part of a path (`<docId>[/v/<n>][/focus]`), or null when it is not one. */
function documentPart(segments: readonly string[]): Pick<ProjectPlace, 'documentId' | 'version' | 'focus'> | null {
  const [documentId, ...rest] = segments
  if (documentId === undefined || documentId === '') return null
  const focus = rest.at(-1) === FOCUS_SEGMENT
  const middle = focus ? rest.slice(0, -1) : rest
  if (middle.length === 0) return { documentId, version: null, focus }
  const [marker, number] = middle
  if (middle.length !== 2 || marker !== VERSION_SEGMENT || number === undefined || !POSITIVE_INTEGER.test(number)) return null
  return { documentId, version: Number(number), focus }
}

/**
 * What the path under `/projects/<id>/` names (`rest`: the route's splat, '' for the project itself), and whether it
 * is that place's own path. Anything it cannot read is the nearest place it can (an unknown tab, as an old `mcp` or
 * `chat` bookmark: the Overview; a document's unknown tail: the document), not its own path: the page replaces it.
 */
export function parseProjectRest(rest: string): { readonly place: ProjectPlace; readonly canonical: boolean } {
  const segments = rest.split('/').filter((segment) => segment !== '')
  const [first, ...more] = segments
  if (first === undefined) return { place: OVERVIEW, canonical: true }
  const tab = parseTab(first)
  if (tab !== first) return { place: OVERVIEW, canonical: false }
  if (tab !== 'documents') return { place: tabPlace(tab), canonical: more.length === 0 }
  if (more.length === 0) return { place: tabPlace(tab), canonical: true }
  const document = documentPart(more)
  if (document !== null) return { place: { tab, ...document }, canonical: true }
  const [documentId] = more
  return { place: documentId === undefined ? tabPlace(tab) : documentPlace(documentId), canonical: false }
}

/** The place without full screen and without an older version: the same document's page as it is edited. */
export function samePageAs(a: ProjectPlace, b: ProjectPlace): boolean {
  return a.tab === b.tab && a.documentId === b.documentId
}
