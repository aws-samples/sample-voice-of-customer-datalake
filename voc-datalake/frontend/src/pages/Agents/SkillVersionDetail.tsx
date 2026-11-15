/**
 * @fileoverview Agents → Skills → one version (`GET /agents/engineering/skills/<role>/versions/<n>`): its status, why,
 * who and when, its benchmark, what changed from its base (instruction lines and examples added and removed, the tools
 * the policy adds and drops, the model and the harness when they move) and its whole record. Every text is the
 * record's own, shown as plain text (React escapes it): nothing in a skill is ever read as HTML.
 *
 * @module pages/Agents/SkillVersionDetail
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { useConfigStore } from '../../store/configStore'
import { ApiError } from '../../lib/errors'
import { BenchmarkLines, SkillStatusBadge, VersionEvents, VersionWhy } from './SkillHistory'
import { useSkillFormats } from './skillFormats'
import { diffIsEmpty } from './skillsView'
import type { ReactNode } from 'react'
import type { SkillDiff, SkillRole, SkillVersionDetail as Detail } from '../../api/engineeringSkillsApi'

const PRE = 'whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-[12px]'

/** One changed line: its sign, said to a screen reader as added or removed. */
function ChangedLine({ op, children }: Readonly<{ op: '+' | '-'; children: ReactNode }>) {
  const { t } = useTranslation('agents')
  const added = op === '+'
  return (
    <li className={`${PRE} ${added ? 'text-ok' : 'text-danger'}`}>
      <span aria-hidden="true">{op} </span><span className="sr-only">{added ? t('skills.diff.added') : t('skills.diff.removed')} </span>
      {children}
    </li>
  )
}

/** One part of a diff (its instruction lines, examples or tools), when it changed. */
function DiffPart({ title, lines }: Readonly<{ title: string; lines: readonly (readonly ['+' | '-', string])[] }>) {
  if (lines.length === 0) return null
  return (
    <div>
      <p className="text-[12px] font-semibold text-muted">{title}</p>
      <ul className="rounded-lg border border-border p-2 space-y-0.5">
        {lines.map(([op, line], index) => <ChangedLine key={`${String(index)}-${op}`} op={op}>{line}</ChangedLine>)}
      </ul>
    </div>
  )
}

/** A model or harness that moved: from what (or nothing, for a first version) to what. */
function Moved({ name, moved }: Readonly<{ name: 'model' | 'harness'; moved: readonly [string, string] | null }>) {
  const { t } = useTranslation('agents')
  if (moved === null) return null
  const from = moved[0] === '' ? t('skills.diff.nothing') : moved[0]
  return <p className="text-sm break-all">{t(`skills.diff.${name}`, { from, to: moved[1] })}</p>
}

function DiffView({ diff }: Readonly<{ diff: SkillDiff }>) {
  const { t } = useTranslation('agents')
  const examples = diff.examples.map(([op, example]) =>
    [op, t('skills.diff.example', { situation: example.situation, action: example.action })] as const)
  const tools = [...diff.tools_added.map((name) => ['+', name] as const), ...diff.tools_removed.map((name) => ['-', name] as const)]
  return (
    <section aria-labelledby="skill-diff" className="space-y-2">
      <h4 id="skill-diff" className="text-sm font-semibold text-text-strong">
        {diff.first ? t('skills.diff.firstTitle') : t('skills.diff.title')}
      </h4>
      {diffIsEmpty(diff) && <p className="text-sm text-muted">{t('skills.diff.none')}</p>}
      <DiffPart title={t('skills.diff.instructions')} lines={diff.instructions} />
      <DiffPart title={t('skills.diff.examples')} lines={examples} />
      <DiffPart title={t('skills.diff.tools')} lines={tools} />
      {diff.tools_reordered && <p className="text-sm">{t('skills.diff.reordered')}</p>}
      <Moved name="model" moved={diff.model} />
      <Moved name="harness" moved={diff.harness} />
    </section>
  )
}

function RecordView({ record }: Readonly<{ record: Detail['record'] }>) {
  const { t } = useTranslation('agents')
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-semibold text-text-strong">{t('skills.record.title')}</summary>
      <dl className="mt-2 space-y-2 text-sm">
        <div><dt className="text-[12px] font-semibold text-muted">{t('skills.record.model')}</dt><dd className="font-mono break-all">{record.model}</dd></div>
        <div><dt className="text-[12px] font-semibold text-muted">{t('skills.record.harness')}</dt><dd className="font-mono">{record.harness}</dd></div>
        <div><dt className="text-[12px] font-semibold text-muted">{t('skills.record.tools')}</dt><dd className="font-mono break-words">{record.tool_policy.join(', ')}</dd></div>
        <div><dt className="text-[12px] font-semibold text-muted">{t('skills.record.instructions')}</dt><dd className={PRE}>{record.instructions}</dd></div>
        <div>
          <dt className="text-[12px] font-semibold text-muted">{t('skills.record.examples', { n: record.examples.length })}</dt>
          <dd>
            <ul className="space-y-1">
              {record.examples.map((example) => (
                <li key={`${example.situation}-${example.action}`} className={PRE}>
                  {t('skills.diff.example', { situation: example.situation, action: example.action })}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </details>
  )
}

/** The version it was written on: the scope's own, the shared skill's, or none. */
function BaseText({ base }: Readonly<{ base: Detail['base'] }>) {
  const { t } = useTranslation('agents')
  if (base === null) return t('skills.noBase')
  return t(base.shared ? 'skills.baseShared' : 'skills.base', { version: base.version })
}

function DetailBody({ detail, current }: Readonly<{ detail: Detail; current: number }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  const { base, made_with: made } = detail
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SkillStatusBadge status={detail.status} current={detail.version === current} />
        <span className="text-[12px] text-muted">{t('skills.proposedBy', { who: detail.proposed_by, at: format.at(detail.proposed_at) })}</span>
      </div>
      <p className="text-sm text-text-strong break-words [overflow-wrap:anywhere]">{detail.summary}</p>
      <VersionWhy why={detail.why} restores={detail.restores} />
      <p className="text-[12px] text-muted">
        <BaseText base={base} />
        {detail.expected_case !== '' && <> · {t('skills.expectedCase', { name: detail.expected_case })}</>}
        {made !== null && <> · {t('skills.madeWith', { model: made.model, prompt: made.prompt })}</>}
      </p>
      <BenchmarkLines benchmark={detail.benchmark} />
      <VersionEvents events={detail.events} />
      <DiffView diff={detail.diff} />
      <RecordView record={detail.record} />
    </div>
  )
}

export function SkillVersionDetail({ connection, role, version, current, onBack }: Readonly<{
  connection: string; role: SkillRole; version: number; current: number; onBack: () => void
}>) {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const read = useQuery({
    queryKey: engineeringSkillsKeys.version(connection, role, version),
    queryFn: () => engineeringSkillsApi.version(connection, role, version),
    enabled: configured,
  })
  const missing = read.error instanceof ApiError && read.error.status === 404
  return (
    <section aria-labelledby="skill-version" aria-busy={read.isFetching} className="space-y-3">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBack()}>
        <ArrowLeft size={14} aria-hidden="true" /> {t('skills.backToHistory')}
      </button>
      <h3 id="skill-version" className="text-sm font-semibold text-text-strong">{t('skills.version', { version })}</h3>
      {read.isLoading && <div className="skeleton h-24" role="status" aria-label={t('skills.loading')} />}
      {missing && <p className="card p-6 text-center text-sm text-muted">{t('skills.versionMissing', { version })}</p>}
      {read.isError && !missing && (
        <LoadFailed message={t('skills.versionFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
      )}
      {read.data !== undefined && <DetailBody detail={read.data} current={current} />}
    </section>
  )
}
