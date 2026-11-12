/**
 * @fileoverview The workspace the app is in (docs/multi-workspace.md, Request flow).
 *
 * The workspace gate (`WorkspaceGate.tsx`) sets it once the address's `/w/{slug}` names one of the caller's
 * workspaces; it stays null for a deployment or a person with none, and the app then works as it did before
 * workspaces. While it is set, every API call to a trusted origin names it in `X-Workspace-Id`
 * (`getAuthHeaders` in api/baseUrl.ts, and the feedback boards' own transport): the same origin rule as the
 * session's Authorization header, so a workspace id never reaches a host that is not this deployment's API.
 *
 * A plain store, not React state: the API clients read it outside React, at the moment they build headers.
 *
 * @module workspace/currentWorkspace
 */
import { create } from 'zustand'
import { isTrustedOrigin } from '../lib/trustedOrigins'

/** A member's role in a workspace (`MEMBER#` rows, lambda/shared/workspace.py). */
type WorkspaceRole ='admin' | 'editor' | 'viewer'

export interface CurrentWorkspace {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly role: WorkspaceRole
}

/** The request header the workspace middleware reads (`WORKSPACE_HEADER` in lambda/shared/workspace.py). */
const WORKSPACE_ID_HEADER = 'X-Workspace-Id'

const useWorkspaceStore = create<{ workspace: CurrentWorkspace | null }>(() => ({ workspace: null }))

/** The current workspace, or null outside one; re-renders when it changes. */
export function useCurrentWorkspace(): CurrentWorkspace | null {
  return useWorkspaceStore((state) => state.workspace)
}

/** Enter a workspace (the gate) or leave every workspace (`null`). */
export function setCurrentWorkspace(workspace: CurrentWorkspace | null): void {
  useWorkspaceStore.setState({ workspace })
}

/**
 * `{X-Workspace-Id: <id>}` for a call to `targetUrl` while a workspace is set and the URL's origin is trusted
 * ({@link isTrustedOrigin}); `{}` otherwise. An empty target is refused like `getAuthHeaders` refuses it: `''`
 * would resolve to the page's own origin.
 */
export function workspaceHeader(targetUrl: string): Record<string, string> {
  const { workspace } = useWorkspaceStore.getState()
  if (workspace === null || typeof targetUrl !== 'string' || targetUrl === '' || !isTrustedOrigin(targetUrl)) return {}
  return { [WORKSPACE_ID_HEADER]: workspace.id }
}
