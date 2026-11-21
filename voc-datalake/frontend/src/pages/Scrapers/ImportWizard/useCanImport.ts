/**
 * @fileoverview Who may import, as every `/scrapers/manual/*` route and an imported form's rows decide it (7.67.00):
 * inside a workspace its admins (the role the server applies there, `GET /me/workspaces/current`; the deployment's
 * `admins` group grants nothing inside a workspace), outside one the deployment's `admins`, as before. The server
 * decides every import either way; this only decides what the app offers.
 *
 * @module pages/Scrapers/ImportWizard/useCanImport
 */
import { useIsAdmin } from '../../../store/authStore'
import { useCurrentWorkspace } from '../../../workspace/currentWorkspace'
import { useServerRole } from '../../../workspace/useMyWorkspaces'

export function useCanImport(): boolean {
  const isAdmin = useIsAdmin()
  const workspace = useCurrentWorkspace()
  const role = useServerRole(workspace)
  return workspace === null ? isAdmin : role === 'admin'
}
