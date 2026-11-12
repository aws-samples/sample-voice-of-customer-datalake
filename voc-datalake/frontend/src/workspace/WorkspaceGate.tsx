/**
 * @fileoverview The workspace gate (docs/multi-workspace.md, Request flow): inside the signed-in tree, before
 * the layout and every page, it reads the caller's workspaces and decides what to show (`gateDecision.ts`).
 *
 * Entering a workspace sets the current workspace (`currentWorkspace.ts`) BEFORE any page renders, so the
 * first call of every page already carries `X-Workspace-Id`; then `GET /me/workspaces/current` confirms it and
 * gives the role the server applies there (a removed membership answers 404: the not-found page). On an
 * address without `/w/`, a caller with no workspace, or a list that cannot be read, gets the app as it was
 * before workspaces: phase 1 does not key the data by workspace yet, so nothing must stop on it. On a `/w/…`
 * address an unreadable list shows an error page with Retry and Sign out instead: that address never opens the
 * app outside its workspace. The public routes (`/login`, `/vote`, `/board`,
 * `/review`, `/unsubscribe`) are outside `ProtectedRoute` and never pass through here.
 *
 * @module workspace/WorkspaceGate
 */
import { useEffect, useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import PageLoader from '../components/PageLoader/PageLoader'
import { apiErrorStatus, HTTP_NOT_FOUND } from '../api/apiErrorStatus'
import { currentWorkspaceKey, myWorkspacesKey, workspacesApi } from '../api/workspacesApi'
import { setCurrentWorkspace, useCurrentWorkspace } from './currentWorkspace'
import { gateDecision } from './gateDecision'
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
  const decision = gateDecision(PAGE_WORKSPACE, workspaces, `${pathname}${search}${hash}`)
  return {
    decision, workspaces: workspaces ?? [], entered: decision.kind === 'enter' ? decision.workspace : null,
    retry, retrying: list.isFetching,
  }
}

/**
 * Sets the store to `entered` (or clears it) before paint, then to the role the server applies there (a
 * platform admin entering is an admin; the list holds the membership row's role), and remembers the slug once
 * the server has confirmed it. Answers the id of the workspace when the server said the caller cannot enter it
 * (404), else null; any other failure of that read is logged and the list's role stays.
 */
function useEnterWorkspace(entered: CurrentWorkspace | null): string | null {
  const server = useQuery({
    queryKey: currentWorkspaceKey(entered?.id ?? ''),
    queryFn: workspacesApi.current,
    enabled: entered !== null,
  })
  const refused = apiErrorStatus(server.error) === HTTP_NOT_FOUND
  const queryClient = useQueryClient()

  // A 404 although the list names it (being deleted, or a membership just removed): leave it out of the list
  // for this tab, so the gate offers the others and never redirects back into it (no loop through `/`).
  const refusedId = refused ? entered?.id ?? null : null
  useEffect(() => {
    if (refusedId === null) return
    rememberRefused(refusedId)
    queryClient.setQueryData<CurrentWorkspace[]>(myWorkspacesKey(), (old) => old?.filter((workspace) => workspace.id !== refusedId))
  }, [refusedId, queryClient])

  // Cleared again when the gate unmounts (an in-app move to /login, say), so nothing outside it names the workspace.
  useLayoutEffect(() => {
    setCurrentWorkspace(entered)
    return () => setCurrentWorkspace(null)
  }, [entered])

  useEffect(() => {
    if (entered === null || server.data?.id !== entered.id) return
    rememberWorkspace(entered.slug)
    setCurrentWorkspace({ ...entered, role: server.data.role })
  }, [entered, server.data])

  useEffect(() => {
    if (server.error !== null && !refused) console.warn('Could not confirm the current workspace', server.error)
  }, [server.error, refused])

  return refusedId
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
  const { decision, workspaces, entered, retry, retrying } = useGateDecision()
  const refusedId = useEnterWorkspace(entered)
  const current = useCurrentWorkspace()
  useRedirect(decision)

  if (decision === null || decision.kind === 'redirect') return <PageLoader />
  if (decision.kind === 'unavailable') return <WorkspaceUnavailable onRetry={retry} retrying={retrying} />
  if (decision.kind === 'pick') return <WorkspaceChoice workspaces={decision.workspaces} path={decision.path} notFound={false} refused={false} />
  if (decision.kind === 'not-found' || refusedId !== null) return <NotFoundPage workspaces={workspaces} refusedId={refusedId} />
  // The store is set in a layout effect: until it holds this workspace, no page may render (or call the API).
  if (entered !== null && current?.id !== entered.id) return <PageLoader />
  return <>{children}</>
}
