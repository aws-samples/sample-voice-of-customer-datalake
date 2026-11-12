/**
 * @fileoverview Who may edit the brand on Administration → General, as `PUT /settings/brand` decides it
 * (`require_settings_admin`, lambda/shared/request_workspace.py): inside a workspace, its admins (the role the server
 * applies there, `GET /me/workspaces/current`; the deployment's `admins` group grants nothing inside a workspace);
 * outside one, the deployment's `admins`, as before.
 *
 * @module pages/Settings/useBrandEditRight
 */
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { useServerWorkspace } from '../../workspace/useMyWorkspaces'

/**
 * Whether the caller may edit the brand. Inside a workspace: `admin` in the server's answer for it; until that
 * answers, nobody (the form stays read-only for a moment rather than offer a save the server would refuse); if
 * that read fails, the membership's role, as the gate and the members page keep it. The server decides every
 * save either way.
 */
export function useBrandEditRight(isDeploymentAdmin: boolean): boolean {
  const workspace = useCurrentWorkspace()
  const server = useServerWorkspace(workspace?.id ?? null)
  if (workspace === null) return isDeploymentAdmin
  if (server.isPending) return false
  const role = server.data?.id === workspace.id ? server.data.role : workspace.role
  return role === 'admin'
}
