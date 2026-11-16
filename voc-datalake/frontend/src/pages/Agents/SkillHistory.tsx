/**
 * @fileoverview Agents → Skills → a role's history (`GET /agents/engineering/skills/<role>/versions`): its versions a
 * page at a time, newest first, each with its status, the summary line, why it was made, who proposed it and when,
 * what happened to it since (accepted, rejected, rolled back, benchmarked: who, when, the comment) and its benchmark,
 * the rates the proposer claimed apart from the ones an administrator measured. A version opens its detail.
 * Read only: no action is offered here.
 *
 * @module pages/Agents/SkillHistory
 */
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { statusTone } from './skillsView'
import { useSkillFormats } from './skillFormats'
import { useSkillHistory } from './useSkillHistory'
import type { SkillRole, SkillVersionLine } from '../../api/engineeringSkillsApi'

export function SkillStatusBadge({ status, current }: Readonly<{ status: string; current: boolean }>) {
  const { t } = useTranslation('agents')
  const known = ['accepted', 'proposed', 'rejected'].includes(status)
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className={statusTone(status)}>{known ? t(`skills.status.${status}`) : status}</span>
      {current && <span className="badge badge-accent">{t('skills.current')}</span>}
    </span>
  )
}

/** Who proposed a version: the coach (an agent) or a person, by their id. */
function Proposer({ line }: Readonly<{ line: SkillVersionLine }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  const who = line.proposed_by_kind === 'agent' ? t('skills.byCoach', { who: line.proposed_by }) : line.proposed_by
  return <span>{t('skills.proposedBy', { who, at: format.at(line.proposed_at) })}</span>
}

/** The benchmark: what an administrator measured, and apart from it what the proposer only claimed. */
export function BenchmarkLines({ benchmark }: Readonly<{ benchmark: SkillVersionLine['benchmark'] }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  const { measured, claimed } = benchmark
  if (measured === null && claimed === null) return <p className="text-[12px] text-muted">{t('skills.notMeasured')}</p>
  return (
    <ul className="space-y-1 text-[12px]">
      {measured !== null && (
        <li>
          <span className="badge badge-info">{t('skills.measured')}</span>{' '}
          {t('skills.rates', { before: format.rate(measured.before), after: format.rate(measured.after) })}{' '}
          <span className={measured.passed ? 'text-ok' : 'text-danger'}>
            {measured.passed ? t('skills.benchmarkPassed') : t('skills.benchmarkFailed')}
          </span>
          {measured.failure_case !== '' && <> · {t('skills.failureCase', { name: measured.failure_case })}</>}
          {' '}<span className="text-muted">{t('skills.measuredBy', { who: measured.by, at: format.at(measured.at) })}</span>
          {measured.run_ref !== '' && <> · <span className="break-all">{t('skills.runRef', { ref: measured.run_ref })}</span></>}
        </li>
      )}
      {claimed !== null && (
        <li>
          <span className="badge badge-muted">{t('skills.claimed')}</span>{' '}
          {t('skills.rates', { before: format.rate(claimed.before), after: format.rate(claimed.after) })}{' '}
          <span className="text-muted">{t('skills.claimedHint')}</span>
        </li>
      )}
    </ul>
  )
}

/** What happened to a version since it was proposed, oldest first. */
export function VersionEvents({ events }: Readonly<{ events: SkillVersionLine['events'] }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  const known = new Set(['accepted', 'rejected', 'rolled_back', 'benchmarked'])
  if (events.length === 0) return null
  return (
    <ul className="space-y-0.5 text-[12px] text-muted">
      {events.map((event) => (
        <li key={`${event.event}-${event.at}`}>
          {t(`skills.event.${known.has(event.event) ? event.event : 'other'}`, { who: event.by, at: format.at(event.at), event: event.event })}
          {event.comment !== '' && <>: <q className="break-words [overflow-wrap:anywhere]">{event.comment}</q></>}
        </li>
      ))}
    </ul>
  )
}

/** Why a version was made: a person's comment, or the run and the failure the coach learned from. */
export function VersionWhy({ why, restores }: Readonly<{ why: SkillVersionLine['why']; restores: number }>) {
  const { t } = useTranslation('agents')
  return (
    <p className="text-sm break-words [overflow-wrap:anywhere]">
      {restores > 0 && <span className="font-semibold">{t('skills.restores', { version: restores })} </span>}
      {why.run_id !== '' && <span className="text-muted">{t('skills.fromRun', { run: why.run_id, failure: why.failure })} </span>}
      {why.comment}
    </p>
  )
}

function VersionItem({ line, current, onOpen }: Readonly<{ line: SkillVersionLine; current: boolean; onOpen: () => void }>) {
  const { t } = useTranslation('agents')
  return (
    <li className="card p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="link font-semibold" onClick={onOpen}
          aria-label={t('skills.openVersion', { version: line.version })}>
          {t('skills.version', { version: line.version })}
        </button>
        <SkillStatusBadge status={line.status} current={current} />
        <span className="text-[12px] text-muted"><Proposer line={line} /></span>
      </div>
      <p className="text-sm text-text-strong break-words [overflow-wrap:anywhere]">{line.summary}</p>
      <VersionWhy why={line.why} restores={line.restores} />
      <BenchmarkLines benchmark={line.benchmark} />
      <VersionEvents events={line.events} />
    </li>
  )
}

export function SkillHistory({ connection, role, onOpen }: Readonly<{
  connection: string; role: SkillRole; onOpen: (version: number) => void
}>) {
  const { t } = useTranslation('agents')
  const read = useSkillHistory(connection, role)
  const pages = read.data?.pages ?? []
  const versions = pages.flatMap((page) => page.versions)
  const current = pages[0]?.currentVersion ?? 0
  return (
    <section aria-labelledby="skill-history" aria-busy={read.isFetching} className="space-y-3">
      <h3 id="skill-history" className="text-sm font-semibold text-text-strong">{t('skills.historyTitle')}</h3>
      {read.isLoading && <div className="skeleton h-24" role="status" aria-label={t('skills.loading')} />}
      {read.isError && versions.length === 0 && (
        <LoadFailed message={t('skills.historyFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
      )}
      {read.isSuccess && versions.length === 0 && <p className="card p-6 text-center text-sm text-muted">{t('skills.historyEmpty')}</p>}
      {versions.length > 0 && (
        <ol className="space-y-2">
          {versions.map((line) => (
            <VersionItem key={line.version} line={line} current={line.version === current} onOpen={() => onOpen(line.version)} />
          ))}
        </ol>
      )}
      <OlderVersions read={read} />
    </section>
  )
}

/** The next page on request, and what to do when it failed. */
function OlderVersions({ read }: Readonly<{ read: {
  hasNextPage: boolean; isFetchingNextPage: boolean; isFetchNextPageError: boolean; fetchNextPage: () => Promise<unknown>
} }>) {
  const { t } = useTranslation('agents')
  return (
    <>
      {read.isFetchNextPageError && <p className="text-sm text-danger" role="alert">{t('skills.moreFailed')}</p>}
      {read.hasNextPage && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={read.isFetchingNextPage} onClick={() => void read.fetchNextPage()}>
          {t('skills.loadMore')}
        </button>
      )}
    </>
  )
}
