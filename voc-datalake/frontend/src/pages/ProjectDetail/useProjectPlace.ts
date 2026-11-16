/**
 * @fileoverview The project page's place in the address (projectPaths.ts): read from the path on every render, and
 * moved to by a navigation. A move the person makes (another tab, another document, an older version, full screen) is
 * a history entry of its own, so Back and Forward walk them; the page's own moves on one document (a save or a
 * restore made a new version, the canvas loaded the latest) replace the entry, so Back never lands on a version the
 * page has moved past. Every move keeps the rest of the query (filters, an open review).
 *
 * A path that does not name its place as it should (an unknown tab, a document's unknown tail) is replaced by the
 * place's own path, in place (`useCanonicalProjectPath`); meanwhile the place is read as the replacement will name it,
 * so nothing renders for the other form first.
 *
 * Read from the location, not the route's params, so the document page reads it under any route (its specs mount it
 * at a bare `/projects/<id>/…` address).
 *
 * @module pages/ProjectDetail/useProjectPlace
 */
import { useCallback, useEffect } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import { parseProjectRest, projectPlacePath, samePageAs } from './projectPaths'
import type { ProjectPlace } from './projectPaths'

/** The project route, as routes.tsx declares it (the splat is the page's own). */
const PROJECT_ROUTE = '/projects/:id/*'

/** The project and the rest of a pathname (`/projects/p1/documents/d1` → p1, `documents/d1`); null elsewhere. */
export function projectPathParts(pathname: string): { readonly projectId: string; readonly rest: string } | null {
  const match = matchPath(PROJECT_ROUTE, pathname)
  const projectId = match?.params.id
  return projectId === undefined ? null : { projectId, rest: match?.params['*'] ?? '' }
}

interface Address {
  readonly pathname: string
  readonly search: string
}

/** The place an address names, and the path that names it as it should when it does not, or null. */
function readAddress({ pathname, search }: Address): { place: ProjectPlace; replaceWith: Address | null } | null {
  const parts = projectPathParts(pathname)
  if (parts === null) return null
  const { place, canonical } = parseProjectRest(parts.rest)
  return { place, replaceWith: canonical ? null : { pathname: projectPlacePath(parts.projectId, place), search } }
}

/**
 * Going from `current` to `next` changes only what the page shows of one document (full screen, an older version):
 * the page and its draft stay, so the unsaved-changes guard lets such a move through.
 */
export function onlyDocumentViewChanged(current: Address, next: Address): boolean {
  const [from, to] = [readAddress(current), readAddress(next)]
  if (from === null || to === null || current.search !== next.search || current.pathname === next.pathname) return false
  return projectPathParts(current.pathname)?.projectId === projectPathParts(next.pathname)?.projectId
    && from.place.documentId !== null && samePageAs(from.place, to.place)
}

export interface ProjectPlaceControls {
  readonly place: ProjectPlace
  /** Go to `place`; `replace`: the page's own move on one document (see the module's doc). */
  readonly go: (place: ProjectPlace, options?: { readonly replace?: boolean }) => void
}

export function useProjectPlace(): ProjectPlaceControls {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const projectId = projectPathParts(pathname)?.projectId ?? ''
  const read = readAddress({ pathname, search })
  const place = read?.place ?? parseProjectRest('').place
  const keptSearch = read?.replaceWith?.search ?? search
  const go = useCallback((next: ProjectPlace, options: { readonly replace?: boolean } = {}) => {
    void navigate({ pathname: projectPlacePath(projectId, next), search: keptSearch }, { replace: options.replace === true })
  }, [navigate, projectId, keptSearch])
  return { place, go }
}

/** Replaces a path that does not name its place as it should by the place's path (see the module's doc). */
export function useCanonicalProjectPath(): void {
  const { pathname, search, hash } = useLocation()
  const navigate = useNavigate()
  const target = readAddress({ pathname, search })?.replaceWith ?? null
  const to = target === null ? null : `${target.pathname}${target.search}${hash}`
  // An effect, not a layout effect: the router takes a navigation only once its own effect has run.
  useEffect(() => {
    if (to !== null) void navigate(to, { replace: true })
  }, [navigate, to])
}
