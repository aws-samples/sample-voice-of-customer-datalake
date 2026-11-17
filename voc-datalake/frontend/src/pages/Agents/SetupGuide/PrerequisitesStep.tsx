/**
 * @fileoverview Step 0 of the setup guide, the prerequisites. First the deployment's own facts (7.50.01: apart from any
 * automation's readiness, so the two never read as one), each with where it stands and the page that sets it:
 *
 * - GitHub connected with the deployment's GitHub App, in two clicks (7.45.00: Agents → Connections → Connect GitHub),
 *   naming the connections made so;
 * - the repository's CI points attested on its connection (the broker serves no push or pull request until then),
 *   naming the connections attested;
 * - since 7.50.02, two automatic ticks that follow the connection (`GET /agents/engineering/issues-source`, no
 *   workspace header): "Issues: read automatically from N repositories" (the deployment's GitHub Issues source reads a
 *   connected repository's issues, signed in with that App: the engineering automations read deployment-wide feedback
 *   only), and "Label voc-agent: created" on each repository it reads. Nothing to do for either but connect GitHub;
 *   a source an administrator set to a token says so, with its card (`/admin/data-sources/github_issues`).
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
import { adminPath, deploymentSourcePath } from '../../Settings/adminPaths'
import { agentsPath } from '../agentsPaths'
import { ReadinessList } from '../ReadinessChecks'
import {
  AUTOMATION_STEPS, attestedConnections, findAutomations, issuesTick, labelTick, prerequisiteChecksOf, readingConnections,
  throughApp,
} from './setupGuideRules'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { IssuesSourceView } from '../../../api/issuesSourceApi'
import type { AutoTick, GuideFacts } from './setupGuideRules'

/** The deployment's GitHub Issues card (platform administrators; docs/multi-workspace.md "The deployment's Data sources"). */
const DEPLOYMENT_SOURCES_PATH = deploymentSourcePath('github_issues')

type ItemState = AutoTick

const BADGES: Readonly<Record<ItemState, string>> = {
  met: 'badge badge-ok', notMet: 'badge badge-muted', unknown: 'badge badge-muted',
}

function Item({ state, text, detail, automatic = false, children }: Readonly<{
  state: ItemState; text: string; detail?: string; automatic?: boolean; children: ReactNode
}>) {
  const { t } = useTranslation('agents')
  return (
    <li className="space-y-1 py-2" data-automatic={automatic ? 'true' : undefined}>
      <p className="flex flex-wrap items-start gap-2 text-sm text-text">
        <span className={BADGES[state]}>{t(`setupGuide.prerequisites.${state}`)}</span>
        <span className="min-w-0 flex-1">{text}</span>
        {automatic && <span className="text-[12px] text-muted">{t('setupGuide.prerequisites.automatic')}</span>}
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

/** What the issues tick says: how many repositories are read, else why none (a token, no source, nothing yet). */
function issuesText(issues: IssuesSourceView | null, t: TFunction<'agents'>): string {
  if (issues === null) return t('setupGuide.prerequisites.issuesUnknown')
  const reading = readingConnections(issues).length
  if (reading > 0) return t('setupGuide.prerequisites.issuesRead', { count: reading })
  if (!issues.deployed) return t('setupGuide.prerequisites.issuesNotDeployed')
  return issues.signs_in === 'token' ? t('setupGuide.prerequisites.issuesToken') : t('setupGuide.prerequisites.issuesNone')
}

/** The two automatic ticks: the issues read and the label created, each following the connection. */
function AutomaticTicks({ issues, connections }: Readonly<{ issues: IssuesSourceView | null; connections: ReactNode }>) {
  const { t } = useTranslation('agents')
  const label = issues?.label ?? 'voc-agent'
  const read = issuesTick(issues)
  const labels = labelTick(issues)
  const token = issues !== null && issues.signs_in === 'token' && read !== 'met'
  const labelText = labels === 'met' ? t('setupGuide.prerequisites.labelCreated', { label })
    : t('setupGuide.prerequisites.labelPending', { label })
  return (
    <>
      <Item state={read} text={issuesText(issues, t)} automatic>
        {token ? <SourcesLink /> : read !== 'met' && connections}
      </Item>
      <Item state={labels} text={labelText} automatic>
        {labels === 'notMet' && connections}
      </Item>
    </>
  )
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
        <AutomaticTicks issues={facts.issues} connections={connections} />
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
