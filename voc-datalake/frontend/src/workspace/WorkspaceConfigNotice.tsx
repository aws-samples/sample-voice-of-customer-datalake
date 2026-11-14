/**
 * @fileoverview Whose configuration Administration's categories, dimensions and source-policies editors show
 * (docs/multi-workspace.md → The configuration cut-over, 7.08.00).
 *
 * Administration's three editors edit the DEPLOYMENT's rows from any address (workspace/configScope.ts
 * `'deployment'`: no `X-Workspace-Id`), for the deployment's administrators, as before workspaces: those rows still
 * classify and redact all feedback outside workspaces. Inside a workspace this notice says so plainly, and links to
 * the workspace's own settings page, where its admins edit the workspace's rows. Outside a workspace it renders
 * nothing.
 *
 * @module workspace/WorkspaceConfigNotice
 */
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import Notice from '../components/Notice/Notice'
import { useCurrentWorkspace } from './currentWorkspace'

export default function WorkspaceConfigNotice() {
  const { t } = useTranslation()
  const workspace = useCurrentWorkspace()
  if (workspace === null) return null
  return (
    <Notice
      variant="banner"
      tone="warn"
      role="note"
      icon={Info}
      className="mb-4"
      text={t('workspaces.config.adminNotice', { name: workspace.name })}
      action={{ label: t('workspaces.config.openSettings'), to: '/workspace-settings' }}
    />
  )
}
