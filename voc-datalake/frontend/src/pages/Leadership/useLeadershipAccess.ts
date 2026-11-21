/**
 * @fileoverview Who sees the leadership view and who sets its baselines, as the server decides it
 * (lambda/shared/adoption_metrics_routes.py, adoption_routes.py): in a workspace its admins; outside one the
 * deployment's admins, and platform admins read it too (live-checked by the server). The groups in the token are a
 * hint only: the server refuses anyone else.
 * @module pages/Leadership/useLeadershipAccess
 */
import { useIsAdmin, useIsPlatformAdmin } from '../../store/authStore'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'

export interface LeadershipAccess {
  readonly canRead: boolean
  /** May change the time-saved baselines (an admin of the scope, never a platform admin as such). */
  readonly canEdit: boolean
  /** Outside a workspace, a platform admin: the page links the platform's cost estimate. */
  readonly showsPlatformCost: boolean
  readonly inWorkspace: boolean
}

export function useLeadershipAccess(): LeadershipAccess {
  const workspace = useCurrentWorkspace()
  const isAdmin = useIsAdmin()
  const isPlatformAdmin = useIsPlatformAdmin()
  if (workspace !== null) {
    const admin = workspace.role === 'admin'
    return { canRead: admin, canEdit: admin, showsPlatformCost: false, inWorkspace: true }
  }
  return { canRead: isAdmin || isPlatformAdmin, canEdit: isAdmin, showsPlatformCost: isPlatformAdmin, inWorkspace: false }
}
