/**
 * @fileoverview Agents → Skills → one version (`GET /agents/engineering/skills/<role>/versions/<n>`), on the shared
 * document component (§6.4 [52] step 1): its status, who proposed it and why, its base, its benchmark and its
 * events; its instructions read as the document they are (DocumentSurface: Rendered / Source, Contents on its page,
 * its tools, model and harness as Properties above them, on the `model` policy); its examples as a list; and, for a
 * version written on another, **Changes**: the instructions compared with its base's as the document reads (the
 * rendered block diff, the line diff under Source) and what else moved (SkillChanges.tsx). A proposal opens on its
 * changes. Its actions are the approval cards (SkillActions.tsx: Accept the one primary, Reject, Record benchmark,
 * Roll back); on the version in use, **Propose a version** writes one's own (SkillProposeSheet.tsx, gap M).
 *
 * The page variant lives at `/agents/skills/<role>/versions/<n>` (agentsPaths.ts); the history opens the same body in
 * a sheet (SkillVersionSheet.tsx) with Open full page.
 *
 * @module pages/Agents/SkillVersionDetail
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, PenLine } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import PressedChoices from '../../components/PressedChoices/PressedChoices'
import { ApiError } from '../../lib/errors'
import { BenchmarkLines, SkillStatusBadge, VersionEvents, VersionWhy } from './SkillHistory'
import { useSkillFormats, useSkillTitle } from './skillFormats'
import { SkillActions } from './SkillActions'
import { SkillChanges } from './SkillChanges'
import { isVersionInUse } from './skillActionRules'
import { skillAdapter, skillDocumentOf, skillMarkdown } from './documents/skillDocument'
import { useSkillVersion, useSkillVersionTarget } from './useSkillInUse'
import ReadOnlySurface from './documents/ReadOnlySurface'
import type { ActionTarget } from './SkillActionParts'
import type { SurfaceCompare } from '../../components/Document/DocumentSurface'
import type { SurfaceVariant } from '../../components/Document/types'
import type { SkillRole, SkillVersionDetail as Detail } from '../../api/engineeringSkillsApi'

type SkillView = 'read' | 'changes'
const VIEWS: readonly SkillView[] = ['read', 'changes']

/** Its status, and who wrote it: the coach's in `aim` ("Written by an agent"), a person's by their id. */
export function SkillProvenance({ detail, current }: Readonly<{ detail: Detail; current: boolean }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  const coach = detail.proposed_by_kind === 'agent'
  return (
    <span className="flex flex-wrap items-center gap-2">
      <SkillStatusBadge status={detail.status} current={current} />
      {coach && <span className="badge badge-aim">{t('skills.provenance.coach')}</span>}
      <span className="text-[12px] text-muted">
        {t('skills.proposedBy', { who: coach ? t('skills.byCoach', { who: detail.proposed_by }) : detail.proposed_by, at: format.at(detail.proposed_at) })}
      </span>
    </span>
  )
}

/** The version it was written on: the scope's own, the shared skill's, or none. */
function BaseText({ base }: Readonly<{ base: Detail['base'] }>) {
  const { t } = useTranslation('agents')
  if (base === null) return t('skills.noBase')
  return t(base.shared ? 'skills.baseShared' : 'skills.base', { version: base.version })
}

/** Why it was made, its base, its benchmark and what happened to it since. */
function VersionFacts({ detail }: Readonly<{ detail: Detail }>) {
  const { t } = useTranslation('agents')
  const made = detail.made_with
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-strong break-words [overflow-wrap:anywhere]">{detail.summary}</p>
      <VersionWhy why={detail.why} restores={detail.restores} />
      <p className="text-[12px] text-muted">
        <BaseText base={detail.base} />
        {detail.expected_case !== '' && <> · {t('skills.expectedCase', { name: detail.expected_case })}</>}
        {made !== null && <> · {t('skills.madeWith', { model: made.model, prompt: made.prompt })}</>}
      </p>
      <BenchmarkLines benchmark={detail.benchmark} />
      <VersionEvents events={detail.events} />
    </div>
  )
}

/** Its examples, each a situation and what to do: a list, never Markdown. */
function SkillExamples({ examples }: Readonly<{ examples: Detail['record']['examples'] }>) {
  const { t } = useTranslation('agents')
  return (
    <section aria-label={t('skills.document.examples', { n: examples.length })} className="space-y-2">
      <h4 className="text-sm font-semibold text-text-strong">{t('skills.document.examples', { n: examples.length })}</h4>
      {examples.length === 0 ? <p className="text-sm text-muted">{t('skills.document.noExamples')}</p> : (
        <ol className="space-y-2">
          {examples.map((example) => (
            <li key={`${example.situation}-${example.action}`} className="rounded-md border border-border p-3 text-sm">
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt className="text-[12px] font-semibold text-muted">{t('skills.document.situation')}</dt>
                <dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{example.situation}</dd>
                <dt className="text-[12px] font-semibold text-muted">{t('skills.document.action')}</dt>
                <dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{example.action}</dd>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** The base's SKILL.md for the compare: '' for a first version (everything is new), else read (null meanwhile). */
function useBaseText(connection: string, role: SkillRole, detail: Detail) {
  const base = detail.base
  const read = useSkillVersion(base === null ? null : { scope: base.shared ? '' : connection, version: base.version }, role)
  if (detail.diff.first || base === null) return { text: '', failed: null }
  return { text: read.data === undefined ? null : skillMarkdown(read.data.record), failed: read.isError ? read : null }
}

/** What the compare calls each side, and says when the two are the same. */
function useCompareOf(detail: Detail) {
  const { t } = useTranslation('agents')
  return (before: string): SurfaceCompare => ({
    before, beforeLabel: detail.base === null ? t('skills.document.nothing') : `v${String(detail.base.version)}`,
    afterLabel: `v${String(detail.version)}`, identicalText: t('skills.document.identical'),
  })
}

/** The instructions on the surface: read, or (`changes`) compared with the base's once it is read. */
function Instructions({ target, variant, changes }: Readonly<{ target: ActionTarget; variant: SurfaceVariant; changes: boolean }>) {
  const { t } = useTranslation('agents')
  const title = useSkillTitle()
  const { connection, role, detail } = target
  const base = useBaseText(connection, role, detail)
  const compareOf = useCompareOf(detail)
  const { failed } = base
  if (changes && failed !== null) {
    return <LoadFailed message={t('skills.document.baseFailed')} onRetry={() => void failed.refetch()} retrying={failed.isFetching} />
  }
  const compare = changes && base.text !== null ? compareOf(base.text) : null
  const waiting = changes && compare === null
  return (
    <ReadOnlySurface adapter={skillAdapter(connection, role, detail.status, (version) => title(role, version))} variant={variant}
      title={t('skills.document.instructions')} headingLevel={3} meta={null}
      stored={waiting ? undefined : skillDocumentOf(connection, role, detail, title(role, detail.version))}
      mode={compare === null ? 'read' : 'compare'} compare={compare}
      fullPath={null} />
  )
}

/** The instructions (read, or compared with its base's), then its examples or what else it changes. */
export function SkillVersionBody({ target, variant }: Readonly<{ target: ActionTarget; variant: SurfaceVariant }>) {
  const { t } = useTranslation('agents')
  const { detail } = target
  const comparable = detail.base !== null || detail.diff.first
  const [view, setView] = useState<SkillView>(detail.status === 'proposed' && comparable ? 'changes' : 'read')
  const changes = view === 'changes' && comparable
  return (
    <div className="space-y-4">
      <VersionFacts detail={detail} />
      {comparable && (
        <PressedChoices label={t('skills.document.view.label')} choices={VIEWS} value={view} onChange={setView}
          display={(choice) => t(`skills.document.view.${choice}`)} className="tabs-track w-fit" pressedClassName="tab tab-active"
          idleClassName="tab" />
      )}
      {changes && detail.base !== null && (
        <p className="text-[12px] text-muted">{t('skills.document.comparedWith', { version: detail.base.version })}</p>
      )}
      <Instructions target={target} variant={variant} changes={changes} />
      {changes ? <SkillChanges diff={detail.diff} /> : <SkillExamples examples={detail.record.examples} />}
    </div>
  )
}

/** The version's actions: its approval cards, and Propose a version on the version in use. */
export function SkillVersionActions({ target, onPropose }: Readonly<{ target: ActionTarget; onPropose: (() => void) | null }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SkillActions target={target} />
      {onPropose !== null && isVersionInUse(target) && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onPropose}>
          <PenLine size={14} aria-hidden="true" />{t('skills.propose.button')}
        </button>
      )}
    </div>
  )
}

export function SkillVersionDetail({ connection, role, version, current, onBack, onPropose }: Readonly<{
  connection: string; role: SkillRole; version: number
  /** The scope's own current version, and the shared skill's (what a connection with none of its own runs). */
  current: Readonly<{ own: number; shared: number }>
  onBack: () => void
  /** Open the Propose sheet on the version in use (null: not offered here). */
  onPropose: (() => void) | null
}>) {
  const { t } = useTranslation('agents')
  const title = useSkillTitle()
  const { read, target } = useSkillVersionTarget(connection, role, version, current)
  const missing = read.error instanceof ApiError && read.error.status === 404
  return (
    <section aria-labelledby="skill-version" aria-busy={read.isFetching} className="space-y-3">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBack()}>
        <ArrowLeft size={14} aria-hidden="true" /> {t('skills.backToHistory')}
      </button>
      <h3 id="skill-version" className="text-base font-semibold text-text-strong">{title(role, version)}</h3>
      {read.isLoading && <div className="skeleton h-24" role="status" aria-label={t('skills.loading')} />}
      {missing && <p className="card p-6 text-center text-sm text-muted">{t('skills.versionMissing', { version })}</p>}
      {read.isError && !missing && (
        <LoadFailed message={t('skills.versionFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
      )}
      {target !== null && (
        <>
          <SkillProvenance detail={target.detail} current={target.detail.version === target.current} />
          <SkillVersionActions target={target} onPropose={onPropose} />
          <SkillVersionBody target={target} variant="page" />
        </>
      )}
    </section>
  )
}
