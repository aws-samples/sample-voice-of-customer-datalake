/**
 * @fileoverview The names of the caller's workspaces by id, for Connect's token and sign-in lists, which name the
 * workspace each credential acts in (`workspace_id`).
 *
 * @module pages/Connect/useWorkspaceNames
 */
import { useQuery } from '@tanstack/react-query'
import type { ConnectToken } from '../../api/connectSchema'
import { myWorkspacesKey, workspacesApi } from '../../api/workspacesApi'

/**
 * `GET /me/workspaces` (the cache the workspace menu shares), asked only when one of `credentials` names a
 * workspace; a workspace the caller has left is not in the map, and the list shows its id.
 */
export function useWorkspaceNames(
  credentials: readonly Pick<ConnectToken, 'workspace_id'>[] | undefined,
): ReadonlyMap<string, string> {
  const { data } = useQuery({
    queryKey: myWorkspacesKey(), queryFn: workspacesApi.list,
    enabled: (credentials ?? []).some((credential) => credential.workspace_id !== undefined),
  })
  return new Map((data ?? []).map((workspace) => [workspace.id, workspace.name || workspace.slug]))
}
