/**
 * @fileoverview The guided setup of contributing to a public repository, on its read-only connection (7.57.00). The
 * upstream is its owner's (an organization's, say); the fork and the pull requests are the person's. Two steps, each
 * with its status, then a plain summary with the connections' real names:
 *
 * 1. **Fork it on GitHub**: GitHub's own fork page, in a new tab, where the person picks their account or an
 *    organization. Done once a fork connection of this upstream exists.
 * 2. **Let the agents push to your fork**: where the fork goes and the licence acknowledged (ContributeDialog.tsx),
 *    then the App's install page, choosing only the fork; the app detects the fork when GitHub sends them back. Done
 *    once the fork connection exists.
 *
 * Each run then ends with its pull request on the upstream one click away on GitHub: the person clicks Create (7.58.00:
 * the app never opens it itself; a GitHub App's user token cannot open one on a repository the App is not installed on).
 *
 * An archived repository and one with no licence are not offered (said, and step 2 held).
 *
 * @module pages/Agents/ContributeCard
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Circle, ExternalLink, GitFork } from 'lucide-react'
import { useContributionHeld } from './connectionText'
import type { ReactNode } from 'react'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'

type StepStatus = 'done' | 'todo'

/** GitHub's own page that forks `upstream` (the person chooses the account or organization there). */
function forkPageUrl(upstream: string): string {
  return `https://github.com/${upstream}/fork`
}

/** The fork connection of `upstream` (by its public connection, else by the upstream's name), or null for none. */
function forkOf(connection: EngineeringConnection, connections: readonly EngineeringConnection[]): EngineeringConnection | null {
  const upstream = connection.repository.toLowerCase()
  return connections.find((other) => other.kind === 'fork' && other.fork !== null
    && (other.fork.upstream_connection === connection.connection_id || other.fork.upstream.toLowerCase() === upstream)) ?? null
}

function Step({ number, title, status, children }: Readonly<{
  number: number; title: string; status: StepStatus; children: ReactNode
}>) {
  const { t } = useTranslation('agents')
  const Icon = status === 'done' ? CircleCheck : Circle
  const said: Readonly<Record<StepStatus, string>> = {
    done: t('connections.contribute.statusDone'), todo: t('connections.contribute.statusTodo'),
  }
  return (
    <li className="flex gap-3" data-testid={`contribute-step-${number}`}>
      <Icon size={16} aria-hidden="true" className={status === 'done' ? 'mt-0.5 shrink-0 text-ok' : 'mt-0.5 shrink-0 text-muted'} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-semibold text-text-strong">
          <span>{t('connections.contribute.stepTitle', { number, title })}</span>
          <span className={status === 'done' ? 'badge badge-ok' : 'badge badge-muted'}>{said[status]}</span>
        </p>
        {children}
      </div>
    </li>
  )
}

/** The plain summary under the steps: where the agents read, where they push, whose the pull requests are. */
function Summary({ upstream, fork }: Readonly<{ upstream: string; fork: EngineeringConnection | null }>) {
  const { t } = useTranslation('agents')
  return (
    <ul className="space-y-0.5 border-t border-border pt-2 text-[12px] text-text" data-testid="contribute-summary">
      <li>{t('connections.contribute.summaryReads', { upstream })}</li>
      <li>{fork === null ? t('connections.contribute.summaryPushesPending')
        : t('connections.contribute.summaryPushes', { fork: fork.repository })}</li>
      <li>{t('connections.contribute.summaryPullRequests', { upstream })}</li>
    </ul>
  )
}

export function ContributeCard({ connection, connections, onInstall }: Readonly<{
  connection: EngineeringConnection
  /** Every stored connection: the fork of this upstream among them. */
  connections: readonly EngineeringConnection[]
  /** Step 2: where the fork goes and the licence, then the App's install page (ContributeDialog.tsx). */
  onInstall: () => void
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  const heldId = useId()
  const upstream = connection.repository
  const fork = forkOf(connection, connections)
  const held = useContributionHeld(connection)
  const forked: StepStatus = fork === null ? 'todo' : 'done'
  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-labelledby={titleId}
      data-testid={`contribute-card-${connection.connection_id}`}>
      <div>
        <h4 id={titleId} className="text-sm font-semibold text-text-strong">{t('connections.contribute.cardTitle', { upstream })}</h4>
        <p className="text-[12px] text-muted">{t('connections.contribute.cardIntro', { owner: upstream.split('/')[0] })}</p>
      </div>
      {held !== null && <p id={heldId} role="status" className="text-[12px] text-warn">{held}</p>}
      <ol className="space-y-3 text-sm">
        <Step number={1} title={t('connections.contribute.step1')} status={forked}>
          <p className="text-[12px] text-muted">{t('connections.contribute.step1Hint')}</p>
          {fork === null && (
            <a href={forkPageUrl(upstream)} target="_blank" rel="noopener noreferrer"
              className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"
              aria-label={t('engineeringRun.links.opens', { label: t('connections.contribute.forkOnGitHub') })}>
              <GitFork size={14} aria-hidden="true" />{t('connections.contribute.forkOnGitHub')}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </Step>
        <Step number={2} title={t('connections.contribute.step2')} status={forked}>
          <p className="text-[12px] text-muted">{t('connections.contribute.step2Hint')}</p>
          {fork === null && (
            <button type="button" className="btn btn-primary btn-sm" aria-disabled={held !== null || undefined}
              aria-describedby={held === null ? undefined : heldId} onClick={() => { if (held === null) onInstall() }}>
              {t('connections.contribute.installOnFork')}
            </button>
          )}
        </Step>
      </ol>
      <Summary upstream={upstream} fork={fork} />
    </section>
  )
}
