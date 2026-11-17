/**
 * @fileoverview Administration → Data sources (`/admin/sources`, 7.54.00): one page for the sources, whoever's they are
 * (docs/multi-workspace.md "The deployment's Data sources").
 *
 * - **Scope switch, This workspace | Deployment** (inside a workspace, for platform admins: `?scope=deployment`,
 *   adminPaths.ts). This workspace's sources are the current workspace's (every card's calls carry its
 *   `X-Workspace-Id`); the deployment's are its own from any address (workspace/configScope.ts `'deployment'`: no
 *   header on any call, credentials, schedules, pauses and the GitHub Issues App sign-in alike). Outside a workspace
 *   there is nothing to switch: the page is the deployment's. It replaces the separate Data sources tab of 7.50.00.
 * - **The deployment's notice**, in two sentences (S3): what they bring in is deployment-wide feedback, the only
 *   feedback the engineering automations read (D8).
 * - **The cards, health first** (SettingsSections.tsx `DataSourcesSection`: paused or failing on top); the GitHub
 *   Issues card keeps 7.50.02's "Managed by your GitHub connection" view and "Configure manually (advanced)".
 *   `/admin/sources/<source>` opens a source's card (the readiness fix and the setup guide open the deployment's
 *   GitHub Issues card at `/admin/sources/github_issues?scope=deployment`).
 * - **Advanced** (folded, administrators, this workspace's view): Email inbox, Radar and the Design-system tokens
 *   (Integrations before 7.54.00), each a card a path names (`/admin/sources/inbox`, `radar`, `tokens`), which opens
 *   the fold.
 *
 * @module pages/Settings/DataSourcesPage
 */
import { useId, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Info } from 'lucide-react'
import CollapsibleSection from '../../components/CollapsibleSection/CollapsibleSection'
import Notice from '../../components/Notice/Notice'
import { RADIO_KEYS, rovingIndex } from '../../utils/rovingIndex'
import { ConfigScopeContext } from '../../workspace/configScope'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import EmailInboxCard from './EmailInboxCard'
import IntegrationsSection from './IntegrationsSection'
import RadarSection from './RadarSection'
import { DataSourcesSection } from './SettingsSections'
import type { SourceScope } from './adminPaths'
import type { AdminSectionId } from './adminTabs'
import { SectionAnchor } from './SectionAnchor'
import { useSourceInPath, useSourceScope } from './useAdminLocation'

interface DataSourcesPageProps {
  readonly apiEndpoint: string
  readonly isAdmin: boolean
  readonly isPlatformAdmin: boolean
  /** The card the path names (an Advanced one opens the fold), or null. */
  readonly section: AdminSectionId | null
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

const ADVANCED_SECTIONS: ReadonlySet<AdminSectionId> = new Set(['inbox', 'radar', 'tokens'])

/** Email inbox, Radar and the Design-system tokens, folded; a path naming one of them opens the fold. */
function AdvancedSources({ section }: Readonly<{ section: AdminSectionId | null }>) {
  const { t } = useTranslation('settings')
  const named = section !== null && ADVANCED_SECTIONS.has(section)
  const [open, setOpen] = useState(named)
  const [shownFor, setShownFor] = useState(section)
  if (shownFor !== section) {
    setShownFor(section)
    if (named) setOpen(true)
  }
  return (
    <CollapsibleSection title={t('sections.advanced')} open={open} onOpenChange={setOpen}>
      <p className="mb-4 text-sm text-muted">{t('sources.advancedHint')}</p>
      <div className="space-y-4 sm:space-y-6">
        <SectionAnchor section="inbox"><EmailInboxCard /></SectionAnchor>
        <SectionAnchor section="radar"><RadarSection /></SectionAnchor>
        <SectionAnchor section="tokens"><IntegrationsSection /></SectionAnchor>
      </div>
    </CollapsibleSection>
  )
}

function ScopedCards({ scope, children }: Readonly<{ scope: SourceScope; children: ReactNode }>) {
  // Keyed: each scope's page computes its own health order from its own status.
  return <ConfigScopeContext.Provider key={scope} value={scope}>{children}</ConfigScopeContext.Provider>
}

export default function DataSourcesPage({ apiEndpoint, isAdmin, isPlatformAdmin, section }: DataSourcesPageProps) {
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
      {isAdmin && scope === 'workspace' ? <AdvancedSources section={section} /> : null}
    </>
  )
}
