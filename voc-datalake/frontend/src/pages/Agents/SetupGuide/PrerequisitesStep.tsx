/**
 * @fileoverview Step 0 of the setup guide, the prerequisites, each with where it stands and the page that sets it:
 *
 * - GitHub connected with the deployment's GitHub App, in two clicks (7.45.00: Agents → Connections → Connect GitHub);
 * - the repository's CI points attested on its connection (the broker serves no push or pull request until then);
 * - its issues ingested by the GitHub Issues source, deployment-wide (Administration → Data sources, the deployment's:
 *   the engineering automations read deployment-wide feedback only), signed in with that App, and the `voc-agent`
 *   label on the issues the agents may take.
 *
 * Under them, the prerequisite checks of the automations' readiness, with each fix and its doc link: the source and
 * the label are known only from those.
 *
 * @module pages/Agents/SetupGuide/PrerequisitesStep
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { isCiAttested } from '../../../api/engineeringConnectionsApi'
import { useIsPlatformAdmin } from '../../../store/authStore'
import { adminPath } from '../../Settings/adminPaths'
import { agentsPath } from '../agentsPaths'
import { ReadinessList } from '../ReadinessChecks'
import { prerequisiteChecks, throughApp } from './setupGuideRules'
import type { ReactNode } from 'react'
import type { ReadinessCheck } from '../../../api/engineeringReadinessApi'
import type { GuideFacts } from './setupGuideRules'

/** The deployment's Data sources (platform administrators; docs/multi-workspace.md "The deployment's Data sources"). */
const DEPLOYMENT_SOURCES_PATH = adminPath({ tab: 'data-sources', section: null })

type ItemState = 'met' | 'notMet' | 'unknown'

function Item({ state, text, children }: Readonly<{ state: ItemState; text: string; children: ReactNode }>) {
  const { t } = useTranslation('agents')
  const badge = { met: 'badge badge-ok', notMet: 'badge badge-muted', unknown: 'badge badge-muted' }[state]
  return (
    <li className="space-y-1 py-2">
      <p className="flex flex-wrap items-start gap-2 text-sm text-text">
        <span className={badge}>{t(`setupGuide.prerequisites.${state}`)}</span>
        <span className="min-w-0 flex-1">{text}</span>
      </p>
      <div className="flex flex-wrap gap-3 text-[12px]">{children}</div>
    </li>
  )
}

/** Where the GitHub Issues source is set for the deployment: its own page for a platform admin, else Data sources. */
function SourcesLink() {
  const { t } = useTranslation('agents')
  const platform = useIsPlatformAdmin()
  if (platform) return <Link className="link" to={DEPLOYMENT_SOURCES_PATH}>{t('setupGuide.prerequisites.openDeploymentSources')}</Link>
  return (
    <>
      <Link className="link" to={adminPath({ tab: 'sources', section: 'plugins' })}>{t('setupGuide.prerequisites.openSources')}</Link>
      <span className="text-muted">{t('setupGuide.prerequisites.sourcesOutside')}</span>
    </>
  )
}

/** The issues' state, known only from the readiness checks of the GitHub Issues source and its label. */
function issuesState(checks: readonly ReadinessCheck[]): ItemState {
  const issues = checks.filter((check) => check.id === 'issues_source' || check.id === 'issue_label')
  if (issues.length === 0) return 'unknown'
  if (issues.some((check) => check.status === 'fail')) return 'notMet'
  // (the label's presence on the repository is a read the server cannot make: `unknown` says so, never "done")
  return issues.some((check) => check.status === 'unknown') ? 'unknown' : 'met'
}

export function PrerequisitesStep({ facts }: Readonly<{ facts: GuideFacts }>) {
  const { t } = useTranslation('agents')
  const viaApp = facts.connections.filter(throughApp)
  const checks = prerequisiteChecks(facts)
  const connections = <Link className="link" to={agentsPath({ view: 'connections' })}>{t('setupGuide.prerequisites.openConnections')}</Link>
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border" aria-label={t('setupGuide.prerequisites.label')}>
        <Item state={facts.apps > 0 && viaApp.length > 0 ? 'met' : 'notMet'} text={t('setupGuide.prerequisites.github')}>
          {connections}
        </Item>
        <Item state={viaApp.some(isCiAttested) ? 'met' : 'notMet'} text={t('setupGuide.prerequisites.ci')}>
          {connections}
        </Item>
        <Item state={issuesState(checks)} text={t('setupGuide.prerequisites.issues')}>
          <SourcesLink />
        </Item>
      </ul>
      {checks.length === 0
        ? <p className="text-[12px] text-muted">{t('setupGuide.prerequisites.noReadiness')}</p>
        : (
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-strong">{t('setupGuide.prerequisites.checksTitle')}</h3>
            <ReadinessList checks={checks} label={t('setupGuide.prerequisites.checksTitle')} />
          </div>
        )}
    </div>
  )
}
