/**
 * @fileoverview Step 0 of the setup guide, the prerequisites. First the deployment's own facts (7.50.01: apart from any
 * automation's readiness, so the two never read as one), each with where it stands and the page that sets it:
 *
 * - GitHub connected with the deployment's GitHub App, in two clicks (7.45.00: Agents → Connections → Connect GitHub),
 *   naming the connections made so;
 * - the repository's CI points attested on its connection (the broker serves no push or pull request until then),
 *   naming the connections attested;
 * - its issues ingested by the GitHub Issues source, deployment-wide (Administration → Data sources, the deployment's:
 *   the engineering automations read deployment-wide feedback only), signed in with that App, and the `voc-agent`
 *   label on the issues the agents may take: "Not configured" while the deployment's integration status says the
 *   source is not (`GET /integrations/status`, no workspace header), else what the readiness says of the source and
 *   the label.
 *
 * Under them, each found automation's prerequisite checks, "for <automation>, once set up", with each fix and its doc
 * link: asked of the deployment's only connection while the automation names none (setupGuideRules.ts
 * `guideSubject`).
 *
 * @module pages/Agents/SetupGuide/PrerequisitesStep
 */
import { useId } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useIsPlatformAdmin } from '../../../store/authStore'
import { adminPath } from '../../Settings/adminPaths'
import { agentsPath } from '../agentsPaths'
import { ReadinessList } from '../ReadinessChecks'
import {
  AUTOMATION_STEPS, attestedConnections, findAutomations, prerequisiteChecks, prerequisiteChecksOf, throughApp,
} from './setupGuideRules'
import type { ReactNode } from 'react'
import type { ReadinessCheck } from '../../../api/engineeringReadinessApi'
import type { GuideFacts } from './setupGuideRules'

/** The deployment's Data sources (platform administrators; docs/multi-workspace.md "The deployment's Data sources"). */
const DEPLOYMENT_SOURCES_PATH = adminPath({ tab: 'data-sources', section: null })

type ItemState = 'met' | 'notMet' | 'unknown' | 'notConfigured'

const BADGES: Readonly<Record<ItemState, string>> = {
  met: 'badge badge-ok', notMet: 'badge badge-muted', unknown: 'badge badge-muted', notConfigured: 'badge badge-muted',
}

function Item({ state, text, detail, children }: Readonly<{ state: ItemState; text: string; detail?: string; children: ReactNode }>) {
  const { t } = useTranslation('agents')
  return (
    <li className="space-y-1 py-2">
      <p className="flex flex-wrap items-start gap-2 text-sm text-text">
        <span className={BADGES[state]}>{t(`setupGuide.prerequisites.${state}`)}</span>
        <span className="min-w-0 flex-1">{text}</span>
      </p>
      {detail !== undefined && <p className="text-[12px] text-muted break-words [overflow-wrap:anywhere]">{detail}</p>}
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

/**
 * The issues' state: not configured while the deployment's integration status says so, else what the readiness
 * checks of the GitHub Issues source and its label say.
 */
function issuesState(configured: boolean | null, checks: readonly ReadinessCheck[]): ItemState {
  if (configured === false) return 'notConfigured'
  const issues = checks.filter((check) => check.id === 'issues_source' || check.id === 'issue_label')
  if (issues.length === 0) return 'unknown'
  if (issues.some((check) => check.status === 'fail')) return 'notMet'
  // (the label's presence on the repository is a read the server cannot make: `unknown` says so, never "done")
  return issues.some((check) => check.status === 'unknown') ? 'unknown' : 'met'
}

/** The deployment's own facts: what holds whichever automation runs. */
function DeploymentFacts({ facts }: Readonly<{ facts: GuideFacts }>) {
  const { t } = useTranslation('agents')
  const headingId = useId()
  const viaApp = facts.connections.filter(throughApp)
  const attested = attestedConnections(facts)
  const list = (connections: typeof viaApp) => connections.map((connection) => connection.connection_id).join(', ')
  const connections = <Link className="link" to={agentsPath({ view: 'connections' })}>{t('setupGuide.prerequisites.openConnections')}</Link>
  return (
    <section className="space-y-1" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold text-text-strong">{t('setupGuide.prerequisites.deploymentTitle')}</h3>
      <ul className="divide-y divide-border" aria-label={t('setupGuide.prerequisites.label')}>
        <Item state={facts.apps > 0 && viaApp.length > 0 ? 'met' : 'notMet'} text={t('setupGuide.prerequisites.github')}
          detail={viaApp.length > 0 ? t('setupGuide.prerequisites.connectedAs', { list: list(viaApp) }) : undefined}>
          {connections}
        </Item>
        <Item state={attested.length > 0 ? 'met' : 'notMet'} text={t('setupGuide.prerequisites.ci')}
          detail={attested.length > 0 ? t('setupGuide.prerequisites.ciFor', { list: list(attested) }) : undefined}>
          {connections}
        </Item>
        <Item state={issuesState(facts.issuesSource, prerequisiteChecks(facts))} text={t('setupGuide.prerequisites.issues')}>
          <SourcesLink />
        </Item>
      </ul>
    </section>
  )
}

/** Each found automation's prerequisite checks, as its readiness answers them once it is set up. */
function AutomationsReadiness({ facts }: Readonly<{ facts: GuideFacts }>) {
  const { t } = useTranslation('agents')
  const automations = findAutomations(facts.agents)
  const read = AUTOMATION_STEPS.flatMap((step) => {
    const agent = automations[step]
    const checks = facts.readiness[step]
    return agent === null || checks === undefined ? [] : [{ step, name: agent.name, checks: prerequisiteChecksOf(checks) }]
  })
  if (read.length === 0) return <p className="text-[12px] text-muted">{t('setupGuide.prerequisites.noReadiness')}</p>
  return (
    <>
      {read.map(({ step, name, checks }) => {
        const title = t('setupGuide.readinessFor', { name })
        return (
          <section key={step} className="space-y-1" aria-label={title} data-testid={`setup-readiness-${step}`}>
            <h3 className="text-sm font-semibold text-text-strong break-words [overflow-wrap:anywhere]">{title}</h3>
            <ReadinessList checks={checks} label={title} />
          </section>
        )
      })}
    </>
  )
}

export function PrerequisitesStep({ facts }: Readonly<{ facts: GuideFacts }>) {
  return (
    <div className="space-y-4">
      <DeploymentFacts facts={facts} />
      <AutomationsReadiness facts={facts} />
    </div>
  )
}
