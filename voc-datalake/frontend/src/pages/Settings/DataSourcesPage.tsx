/**
 * @fileoverview Administration → Sources → Source settings (`/admin/sources/plugins`, main's section; 7.54.00's Data
 * sources page): the sources, whoever's they are (docs/multi-workspace.md "The deployment's Data sources").
 *
 * - **Scope switch, This workspace | Deployment** (inside a workspace, for platform admins: `?scope=deployment`,
 *   adminPaths.ts). This workspace's sources are the current workspace's (every card's calls carry its
 *   `X-Workspace-Id`); the deployment's are its own from any address (workspace/configScope.ts `'deployment'`: no
 *   header on any call, credentials, schedules, pauses and the GitHub Issues App sign-in alike). Outside a workspace
 *   there is nothing to switch: the section is the deployment's.
 * - **The deployment's notice**, in two sentences (S3): what they bring in is deployment-wide feedback, the only
 *   feedback the engineering automations read (D8).
 * - **The cards, health first** (SettingsSections.tsx `DataSourcesSection`: paused or failing on top); the GitHub
 *   Issues card keeps 7.50.02's "Managed by your GitHub connection" view and "Configure manually (advanced)".
 *   `/admin/sources/plugins/<source>` opens a source's card (the readiness fix and the setup guide open the
 *   deployment's GitHub Issues card at `/admin/sources/plugins/github_issues?scope=deployment`).
 *
 * Email inbox, Radar and Integrations (the design-system tokens), 7.54.00's Advanced fold, are Sources' other sections
 * again (AdminSectionContent.tsx).
 *
 * @module pages/Settings/DataSourcesPage
 */
import { useId } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Info } from 'lucide-react'
import Notice from '../../components/Notice/Notice'
import { RADIO_KEYS, rovingIndex } from '../../utils/rovingIndex'
import { ConfigScopeContext } from '../../workspace/configScope'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { DataSourcesSection } from './SettingsSections'
import type { SourceScope } from './adminPaths'
import { useSourceInPath, useSourceScope } from './useAdminLocation'

interface DataSourcesPageProps {
  readonly apiEndpoint: string
  readonly isAdmin: boolean
  readonly isPlatformAdmin: boolean
}

const SCOPES: readonly SourceScope[] = ['workspace', 'deployment']
const SCOPE_LABEL_KEYS: Readonly<Record<SourceScope, string>> = {
  workspace: 'sources.scope.workspace', deployment: 'sources.scope.deployment',
}

/** "This workspace | Deployment": a radio group on the tabs track; arrow keys move and choose (APG). */
function ScopeSwitch({ scope, onChange }: Readonly<{ scope: SourceScope; onChange: (scope: SourceScope) => void }>) {
  const { t } = useTranslation('settings')
  const labelId = useId()
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = rovingIndex(event.key, SCOPES.indexOf(scope), SCOPES.length, RADIO_KEYS)
    const target = next === null ? undefined : SCOPES[next]
    if (target === undefined) return
    event.preventDefault()
    onChange(target)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-scope="${target}"]`)?.focus()
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span id={labelId} className="text-sm font-medium text-text">{t('sources.scope.label')}</span>
      <div role="radiogroup" aria-labelledby={labelId} className="tabs-track" onKeyDown={onKeyDown}>
        {SCOPES.map((option) => (
          <button key={option} type="button" role="radio" data-scope={option} aria-checked={option === scope}
            tabIndex={option === scope ? 0 : -1} onClick={() => onChange(option)}
            className={clsx('tab', option === scope && 'tab-active')}>
            {t(SCOPE_LABEL_KEYS[option])}
          </button>
        ))}
      </div>
    </div>
  )
}

function ScopedCards({ scope, children }: Readonly<{ scope: SourceScope; children: ReactNode }>) {
  // Keyed: each scope's page computes its own health order from its own status.
  return <ConfigScopeContext.Provider key={scope} value={scope}>{children}</ConfigScopeContext.Provider>
}

export default function DataSourcesPage({ apiEndpoint, isAdmin, isPlatformAdmin }: DataSourcesPageProps) {
  const { t } = useTranslation('settings')
  const workspace = useCurrentWorkspace()
  const [requested, setScope] = useSourceScope()
  const openSource = useSourceInPath()
  const mayUseDeployment = isAdmin && isPlatformAdmin
  const scope: SourceScope = requested === 'deployment' && mayUseDeployment ? 'deployment' : 'workspace'
  // Outside a workspace the page is the deployment's whatever the scope says.
  const deploymentShown = scope === 'deployment' || workspace === null
  return (
    <>
      {mayUseDeployment && workspace !== null ? <ScopeSwitch scope={scope} onChange={setScope} /> : null}
      {deploymentShown ? (
        <Notice variant="banner" tone="warn" role="note" icon={Info} text={t('deploymentSources.notice')} />
      ) : null}
      <ScopedCards scope={scope}>
        <DataSourcesSection apiEndpoint={apiEndpoint} isAdmin={isAdmin} openSource={openSource} />
      </ScopedCards>
    </>
  )
}
