/**
 * @fileoverview Renders nothing; runs {@link useWorkspaceThemeSync} once inside the
 * signed-in shell (routes.tsx, next to Layout under ProtectedRoute).
 * @module theme/WorkspaceThemeSync
 */
import { useWorkspaceThemeSync } from './useWorkspaceThemeSync'

export default function WorkspaceThemeSync() {
  useWorkspaceThemeSync()
  return null
}
