/**
 * @fileoverview The workspace gate (docs/multi-workspace.md, Request flow): inside the signed-in tree, before
 * the layout and every page, it reads the caller's workspaces and decides what to show (`gateDecision.ts`).
 *
 * Entering a workspace sets the current workspace (`currentWorkspace.ts`) BEFORE any page renders, so the
 * first call of every page already carries `X-Workspace-Id`; then `GET /me/workspaces/current` confirms it and
 * gives the role the server applies there (a removed membership answers 404: the not-found page). A platform
 * admin entering, from the platform console, a workspace they are not a member of (`platformEntry.ts`) sees
 * nothing of it until that answer names the workspace; a 404 is the plain not-found page. On an
 * address without `/w/`, a caller with no workspace, or a list that cannot be read, gets the app as it was
 * before workspaces: phase 1 does not key the data by workspace yet, so nothing must stop on it. On a `/w/…`
 * address an unreadable list shows an error page with Retry and Sign out instead: that address never opens the
 * app outside its workspace. The public routes (`/login`, `/vote`, `/board`,
 * `/review`, `/unsubscribe`) are outside `ProtectedRoute` and never pass through here.
 *
 * @module workspace/WorkspaceGate
 */
import { useEffect, useLayoutEffect, useMemo } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import PageLoader from '../components/PageLoader/PageLoader'
import { apiErrorStatus, HTTP_NOT_FOUND } from '../api/apiErrorStatus'
import { currentWorkspaceKey, myWorkspacesKey, workspacesApi } from '../api/workspacesApi'
import { setCurrentWorkspace, useCurrentWorkspace } from './currentWorkspace'
import { gateDecision } from './gateDecision'
import { forgetPlatformEntry, platformEntryFor } from './platformEntry'
import { refusedWorkspaceIds, rememberRefused } from './refusedWorkspaces'
import { rememberWorkspace, useMyWorkspaces } from './useMyWorkspaces'
import { PAGE_WORKSPACE } from './workspacePath'
import WorkspaceChoice, { WorkspaceUnavailable } from './WorkspaceChoice'
import type { CurrentWorkspace } from './currentWorkspace'
import type { GateDecision } from './gateDecision'

interface GateState {
  /** Null while the list loads. */
  readonly decision: GateDecision | null
  /** The caller's workspaces ([] while loading or when the list failed). */
  readonly workspaces: readonly CurrentWorkspace[]
  /** The workspace being entered, if the decision is to enter one. */
  readonly entered: CurrentWorkspace | null
  /** Read the list again (the unavailable page's Retry), and whether that read is running. */
  readonly retry: () => void
  readonly retrying: boolean
}

/**
 * The gate's decision once the list has answered. The list counts as unreadable only when there is no data at
 * all: once read, a failed refetch keeps the last answer (TanStack keeps `data` and sets `isError`), so a
 * workspace already entered stays entered.
 */
function useGateDecision(): GateState {
  const { pathname, search, hash } = useLocation()
  const list = useMyWorkspaces()
  const retry = () => { void list.refetch() }

  useEffect(() => {
    if (list.isError) console.warn('Could not read your workspaces', list.error)
  }, [list.isError, list.error])

  if (list.isPending) return { decision: null, workspaces: [], entered: null, retry, retrying: list.isFetching }
  // A workspace the server refused in this tab is no longer offered, entered or redirected into.
  const refused = refusedWorkspaceIds()
  const workspaces = list.data?.filter((workspace) => !refused.includes(workspace.id)) ?? null
  const entry = PAGE_WORKSPACE.kind === 'slug' ? platformEntryFor(PAGE_WORKSPACE.slug) : null
  const decision = gateDecision(PAGE_WORKSPACE, workspaces, `${pathname}${search}${hash}`, entry)
  const entered = decision.kind === 'enter' || decision.kind === 'enter-unlisted' ? decision.workspace : null
  return { decision, workspaces: workspaces ?? [], entered, retry, retrying: list.isFetching }
}

/**
 * `workspace` as one object for as long as its fields stay the same: the store is set whenever it changes, and an
 * unlisted entry is built afresh on every render (from the console's record).
 */
function useSameWorkspace(workspace: CurrentWorkspace | null): CurrentWorkspace | null {
  const { id, slug, name, role } = workspace ?? {}
  return useMemo(
    () => (id === undefined || slug === undefined || name === undefined || role === undefined ? null : { id, slug, name, role }),
    [id, slug, name, role],
  )
}

/** What the server said about the workspace being entered. */
interface EnterState {
  /** The id of a listed workspace the server refused (404), else null. */
  readonly refusedId: string | null
  /** An unlisted entry the server refused, or answered as another workspace: the not-found page. */
  readonly unlistedRefused: boolean
  /** The server answered this workspace (an unlisted entry opens only then). */
  readonly confirmed: boolean
  /** The confirmation failed for another reason (a fault): an unlisted entry offers Try again. */
  readonly failed: boolean
  readonly retry: () => void
  readonly retrying: boolean
}

/**
 * Sets the store to `entered` (or clears it) before paint, then to the role the server applies there (a
 * platform admin entering is an admin; the list holds the membership row's role), and remembers the slug once
 * the server has confirmed it. For a listed workspace any failure of that read but a 404 is logged and the list's
 * role stays; an unlisted one (the platform console's entry) waits for the answer.
 */
function useEnterWorkspace(entered: CurrentWorkspace | null, unlisted: boolean): EnterState {
  const server = useQuery({
    queryKey: currentWorkspaceKey(entered?.id ?? ''),
    queryFn: workspacesApi.current,
    enabled: entered !== null,
  })
  const answer = readAnswer(entered, unlisted, server.data, server.error)
  useForgetRefused(answer.refusedId, answer.droppedSlug)

  // Cleared again when the gate unmounts (an in-app move to /login, say), so nothing outside it names the workspace.
  useLayoutEffect(() => {
    setCurrentWorkspace(entered)
    return () => setCurrentWorkspace(null)
  }, [entered])

  const { confirmed } = answer
  useEffect(() => {
    if (entered === null || confirmed === null) return
    rememberWorkspace(entered.slug)
    setCurrentWorkspace({ ...entered, name: confirmed.name, role: confirmed.role })
  }, [entered, confirmed])

  useEffect(() => {
    if (answer.failed) console.warn('Could not confirm the current workspace', server.error)
  }, [answer.failed, server.error])

  return {
    refusedId: answer.refusedId, unlistedRefused: answer.droppedSlug !== null, confirmed: confirmed !== null,
    failed: answer.failed, retry: () => { void server.refetch() }, retrying: server.isFetching,
  }
}

/** What `GET /me/workspaces/current` said about `entered` (pure). */
function readAnswer(entered: CurrentWorkspace | null, unlisted: boolean, data: CurrentWorkspace | undefined, error: Error | null) {
  const notFound = apiErrorStatus(error) === HTTP_NOT_FOUND
  const confirmed = confirmedAs(entered, unlisted, data)
  return {
    confirmed,
    ...refusals(entered, unlisted, notFound || (unlisted && data !== undefined && confirmed === null)),
    failed: error !== null && !notFound,
  }
}

/** The answer when it is the workspace being entered (an unlisted entry: the slug the address names too), else null. */
function confirmedAs(entered: CurrentWorkspace | null, unlisted: boolean, data: CurrentWorkspace | undefined): CurrentWorkspace | null {
  if (entered === null || data?.id !== entered.id) return null
  return !unlisted || data.slug === entered.slug ? data : null
}

/**
 * `refused`: a 404, or (an unlisted entry) an answer naming another workspace. A listed workspace's 404 (being
 * deleted, or a membership just removed) is `refusedId`; an unlisted entry the server refused is `droppedSlug`.
 */
function refusals(entered: CurrentWorkspace | null, unlisted: boolean, refused: boolean) {
  if (entered === null || !refused) return { refusedId: null, droppedSlug: null }
  return unlisted ? { refusedId: null, droppedSlug: entered.slug } : { refusedId: entered.id, droppedSlug: null }
}

/**
 * A listed workspace the server refused leaves the list for this tab, so the gate offers the others and never
 * redirects back into it (no loop through `/`); an unlisted entry it refused is dropped, so the next load of the
 * address is a plain not-found, like any slug that is not the caller's.
 */
function useForgetRefused(refusedId: string | null, droppedSlug: string | null): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (refusedId === null) return
    rememberRefused(refusedId)
    queryClient.setQueryData<CurrentWorkspace[]>(myWorkspacesKey(), (old) => old?.filter((workspace) => workspace.id !== refusedId))
  }, [refusedId, queryClient])
  useEffect(() => {
    if (droppedSlug !== null) forgetPlatformEntry(droppedSlug)
  }, [droppedSlug])
}

/** A one-workspace caller without a slug moves into it with a full page load, so the router's basename applies. */
function useRedirect(decision: GateDecision | null): void {
  const to = decision?.kind === 'redirect' ? decision.to : null
  useEffect(() => {
    if (to !== null) window.location.assign(to)
  }, [to])
}

/**
 * Not-found: the address names a workspace the caller cannot see, so each link opens one of their workspaces'
 * start page, never the one the server refused (its list row is stale). With a refusal in this tab it says the
 * workspace is not available, not that the caller has none.
 */
function NotFoundPage({ workspaces, refusedId }: Readonly<{ workspaces: readonly CurrentWorkspace[]; refusedId: string | null }>) {
  const offered = workspaces.filter((workspace) => workspace.id !== refusedId)
  const refusedHere = refusedId !== null || refusedWorkspaceIds().length > 0
  return <WorkspaceChoice workspaces={offered} path="/" notFound refused={refusedHere} />
}

export default function WorkspaceGate({ children }: Readonly<{ children: ReactNode }>) {
  const state = useGateDecision()
  const { decision } = state
  const entered = useSameWorkspace(state.entered)
  const unlisted = decision?.kind === 'enter-unlisted'
  const server = useEnterWorkspace(entered, unlisted)
  const current = useCurrentWorkspace()
  useRedirect(decision)

  // The store is set in a layout effect: until it holds this workspace, no page may render (or call the API). An
  // unlisted entry carries no name (platformEntry.ts) until the server's answer gives one: it waits for that too.
  const named = !unlisted || (current?.name ?? '') !== ''
  const ready = entered === null || (current?.id === entered.id && named)
  return gateScreen(state, server, unlisted, ready ? <>{children}</> : <PageLoader />)
}

/**
 * The gate's own page for a decision that does not open the app (loading, unavailable, picker, not-found), else
 * `open`: the app, once a platform admin's entry outside their list has been let in by the server.
 */
function gateScreen({ decision, workspaces, retry, retrying }: GateState, server: EnterState, unlisted: boolean, open: ReactElement): ReactElement {
  if (decision === null || decision.kind === 'redirect') return <PageLoader />
  if (decision.kind === 'unavailable') return <WorkspaceUnavailable onRetry={retry} retrying={retrying} />
  if (decision.kind === 'pick') return <WorkspaceChoice workspaces={decision.workspaces} path={decision.path} notFound={false} refused={false} />
  if (decision.kind === 'not-found' || server.refusedId !== null || server.unlistedRefused) {
    return <NotFoundPage workspaces={workspaces} refusedId={server.refusedId} />
  }
  if (unlisted && !server.confirmed) {
    return server.failed ? <WorkspaceUnavailable onRetry={server.retry} retrying={server.retrying} /> : <PageLoader />
  }
  return open
}
