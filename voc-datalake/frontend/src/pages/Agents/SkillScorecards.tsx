/**
 * @fileoverview Agents → Skills → a role's scorecards on one connection (`GET /agents/engineering/scorecards/<role>`):
 * up to 10 versions side by side over each one's latest runs: the pass rate (tasks done over the tasks it ended),
 * tasks done, failed and needing a person, review rounds, attempts, cost and session time. Each row says where its
 * number comes from (the shipped skills', today), and the screen says plainly that the sessions do not name a
 * version's scope. By default the server's pick (the shipped versions); a person names others to compare. A
 * scorecard is a connection's own, so the shared skills have none: the screen says to pick a connection.
 *
 * @module pages/Agents/SkillScorecards
 */
import { useId, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { MAX_COMPARED, engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { useConfigStore } from '../../store/configStore'
import { formatCount } from '../../utils/numberFormat'
import { parseVersionsInput } from './skillsView'
import { useSkillFormats } from './skillFormats'
import type { SyntheticEvent } from 'react'
import type { ScoreCard, Scorecards, SkillRole } from '../../api/engineeringSkillsApi'

const TH = 'px-3 py-2 text-left text-[12px] font-semibold text-muted'
const TH_NUM = 'px-3 py-2 text-right text-[12px] font-semibold text-muted'
const TD_NUM = 'px-3 py-2 text-right text-sm font-mono whitespace-nowrap'

function useCardFormats() {
  const { i18n } = useTranslation()
  const format = useSkillFormats()
  const usd = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
  const minutes = new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'minute', unitDisplay: 'short', maximumFractionDigits: 1 })
  return {
    rate: format.rate,
    count: (value: number) => formatCount(value, i18n.language),
    usd: (value: number) => usd.format(value),
    time: (seconds: number) => minutes.format(seconds / 60),
  }
}

function CardsTable({ role, cards }: Readonly<{ role: SkillRole; cards: ScoreCard[] }>) {
  const { t } = useTranslation('agents')
  const format = useCardFormats()
  const columns = ['passRate', 'runs', 'done', 'failed', 'needsHuman', 'reviewRounds', 'attempts', 'cost', 'time'] as const
  const cells = (card: ScoreCard) => [format.rate(card.pass_rate), format.count(card.runs), format.count(card.tasks_done),
    format.count(card.tasks_failed), format.count(card.needs_human), format.count(card.review_rounds),
    format.count(card.attempts), format.usd(card.cost_usd), format.time(card.seconds)]
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[44rem]">
        <caption className="sr-only">{t('skills.scores.caption', { role: t(`skills.role.${role}`) })}</caption>
        <thead className="bg-bg-accent border-b border-border">
          <tr>
            <th scope="col" className={TH}>{t('skills.scores.version')}</th>
            <th scope="col" className={TH}>{t('skills.scores.sourceColumn')}</th>
            {columns.map((column) => <th key={column} scope="col" className={TH_NUM}>{t(`skills.scores.${column}`)}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {cards.map((card) => (
            <tr key={card.version}>
              <th scope="row" className="px-3 py-2 text-left text-sm font-normal text-text-strong">
                {t('skills.version', { version: card.version })}
                {card.more && <span className="block text-[12px] text-muted">{t('skills.scores.latestOnly')}</span>}
              </th>
              <td className="px-3 py-2 text-sm">{t(`skills.scores.source.${card.source ?? 'unknown'}`)}</td>
              {cells(card).map((value, index) => <td key={columns[index]} className={TD_NUM}>{value}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CompareForm({ onCompare }: Readonly<{ onCompare: (versions: number[]) => void }>) {
  const { t } = useTranslation('agents')
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = (event: SyntheticEvent) => {
    event.preventDefault()
    const parsed = parseVersionsInput(value)
    if (parsed.ok) {
      setProblem(null)
      onCompare(parsed.versions)
    } else setProblem(t(`skills.scores.invalid.${parsed.reason}`, { max: MAX_COMPARED }))
  }
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit} noValidate>
      <div>
        <label htmlFor={inputId} className="block text-[12px] font-semibold text-muted">{t('skills.scores.compareLabel')}</label>
        <input id={inputId} className="input w-48" value={value} inputMode="numeric" onChange={(e) => setValue(e.target.value)}
          aria-describedby={problem === null ? hintId : `${hintId} ${errorId}`} aria-invalid={problem !== null} />
      </div>
      <button type="submit" className="btn btn-secondary btn-sm">{t('skills.scores.compare')}</button>
      <p id={hintId} className="w-full text-[12px] text-muted">{t('skills.scores.compareHint', { max: MAX_COMPARED })}</p>
      {problem !== null && <p id={errorId} className="w-full text-sm text-danger" role="alert">{problem}</p>}
    </form>
  )
}

export function SkillScorecards({ connection, role }: Readonly<{ connection: string; role: SkillRole }>) {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const [versions, setVersions] = useState<number[]>([])
  const read = useQuery({
    queryKey: engineeringSkillsKeys.scorecards(connection, role, versions),
    queryFn: () => engineeringSkillsApi.scorecards(connection, role, versions),
    enabled: configured && connection !== '',
    placeholderData: keepPreviousData,
  })
  return (
    <section aria-labelledby="skill-scores" aria-busy={read.isFetching} className="space-y-3">
      <h3 id="skill-scores" className="text-sm font-semibold text-text-strong">{t('skills.scores.title')}</h3>
      {connection === '' ? <p className="text-sm text-muted">{t('skills.scores.pickConnection')}</p> : (
        <>
          <p className="text-[12px] text-muted max-w-prose">{t('skills.scores.hint')}</p>
          <CompareForm onCompare={setVersions} />
          {read.isLoading && <div className="skeleton h-24" role="status" aria-label={t('skills.loading')} />}
          {read.isError && <LoadFailed message={t('skills.scores.loadFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />}
          {read.data !== undefined && <ScoreResult role={role} scorecards={read.data} />}
        </>
      )}
    </section>
  )
}

/** The cards, with what their numbers are when the sessions do not say the scope (which they do not, today). */
function ScoreResult({ role, scorecards }: Readonly<{ role: SkillRole; scorecards: Scorecards }>) {
  const { t } = useTranslation('agents')
  const { cards, scopeKnown } = scorecards
  return (
    <>
      {!scopeKnown && <p className="text-[12px] text-warn max-w-prose">{t('skills.scores.scopeUnknown')}</p>}
      {cards.length === 0
        ? <p className="card p-6 text-center text-sm text-muted">{t('skills.scores.empty')}</p>
        : <CardsTable role={role} cards={cards} />}
    </>
  )
}
