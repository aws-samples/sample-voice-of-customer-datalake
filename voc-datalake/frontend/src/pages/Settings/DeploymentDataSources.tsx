/**
 * @fileoverview Administration → Data sources (`/admin/data-sources`, 7.50.00): the DEPLOYMENT's own sources, for
 * platform admins only (adminTabs.ts; docs/multi-workspace.md "The deployment's Data sources").
 *
 * It is the Data sources page (SettingsSections.tsx `DataSourcesSection`: a card per plugin) in the deployment's
 * scope (workspace/configScope.ts `'deployment'`), as Administration's categories editor is: every read and write of
 * its cards (credentials, the schedule and its breaker, the GitHub Issues card's App sign-in) sends no
 * `X-Workspace-Id`, from any address, inside a workspace too. What these sources ingest is deployment-wide feedback,
 * outside every workspace, and that is the only feedback the engineering automations read (Bug fixer, Feature builder,
 * Issue triage: D8, until agents move per workspace); the copy above the cards says so, and, inside a workspace, that
 * nothing here changes it (its own sources are its Administration → Sources). The GitHub Issues source configures
 * itself from Agents → Connections (7.50.02: each repository connected through the deployment's GitHub App is read),
 * so its card here is the advanced view; `/admin/data-sources/<source>` opens a source's card (useAdminLocation.ts
 * `useSourceInPath`: the readiness fix and the setup guide open the GitHub Issues card so).
 *
 * @module pages/Settings/DeploymentDataSources
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Info } from 'lucide-react'
import { ConfigScopeContext } from '../../workspace/configScope'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { DataSourcesSection } from './SettingsSections'
import { SECTION_TITLE } from './sectionTitle'
import { useSourceInPath } from './useAdminLocation'

interface DeploymentDataSourcesProps {
  readonly apiEndpoint: string
  readonly isAdmin: boolean
}

/** What these sources feed (the deployment), who reads it (the engineering automations), and how GitHub Issues is set. */
function DeploymentNotice() {
  const { t } = useTranslation('settings')
  const titleId = useId()
  const workspace = useCurrentWorkspace()
  return (
    <section aria-labelledby={titleId} className="card space-y-2" data-testid="deployment-sources-notice">
      <div className="flex items-center gap-2">
        <Database className="text-accent flex-shrink-0" size={16} aria-hidden="true" />
        <h2 id={titleId} className={SECTION_TITLE}>{t('deploymentSources.title')}</h2>
      </div>
      <p className="text-sm text-text">{t('deploymentSources.feeds')}</p>
      <p className="text-sm text-text">{t('deploymentSources.engineering')}</p>
      <p className="text-sm text-muted">{t('deploymentSources.appSignIn')}</p>
      {workspace !== null && (
        <p role="note" className="flex items-start gap-2 text-sm text-text bg-info-subtle border border-info/30 p-3 rounded-lg">
          <Info size={16} className="flex-shrink-0 mt-0.5 text-info" aria-hidden="true" />
          {t('deploymentSources.inWorkspace', { name: workspace.name })}
        </p>
      )}
    </section>
  )
}

export default function DeploymentDataSources({ apiEndpoint, isAdmin }: DeploymentDataSourcesProps) {
  const openSource = useSourceInPath()
  return (
    <div className="space-y-4">
      <DeploymentNotice />
      <ConfigScopeContext.Provider value="deployment">
        <DataSourcesSection apiEndpoint={apiEndpoint} isAdmin={isAdmin} openSource={openSource} />
      </ConfigScopeContext.Provider>
    </div>
  )
}
