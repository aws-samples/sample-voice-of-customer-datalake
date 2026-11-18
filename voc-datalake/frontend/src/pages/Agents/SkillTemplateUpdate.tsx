/**
 * @fileoverview Agents → Skills, "Template updated" (7.50.00; part 2 S10; §6.4 [52] step 1): a role's bundled template
 * (`voc-datalake/templates/orchestration/agents/<role>/`) is newer than every version of the scope seeded from one, as
 * the role's history says (`template: {version, label, newer}`, useSkillHistory.ts). Its panel says so in `badge-info`
 * ("Update available (v4)": an informational state, never a warning), shows the template as a **compare** with the
 * version the scope runs (`GET …/skills/<role>/template`: the instructions as the document reads, what else changes
 * listed), and **Propose v4 from the template** makes it a new version proposed by the administrator who pressed it
 * (`POST …/template/adopt`), which an administrator then accepts like any other proposal. Nothing is ever adopted or
 * accepted by itself: an update only offers itself. After proposing, **Open the proposal** goes straight to its
 * Accept.
 *
 * @module pages/Agents/SkillTemplateUpdate
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { engineeringSkillActionsApi } from '../../api/engineeringSkillActionsApi'
import { serverReason } from '../../lib/errors'
import { SkillChanges } from './SkillChanges'
import { skillMarkdown, skillTemplateAdapter, skillTemplateDocumentOf } from './documents/skillDocument'
import { useSkillHead, useSkillVersion } from './useSkillInUse'
import { useSkillHistory } from './useSkillHistory'
import ReadOnlySurface from './documents/ReadOnlySurface'
import type { SkillRole, SkillTemplate, SkillTemplateUpdate as Update, SkillVersionDetail } from '../../api/engineeringSkillsApi'

/** "Update available (v3)" for a role whose template is newer than its versions; nothing otherwise. */
export function TemplateBadge({ template }: Readonly<{ template: SkillTemplate | null }>) {
  const { t } = useTranslation('agents')
  if (template?.newer !== true) return null
  return <span className="badge badge-info">{t('skills.template.badge', { version: template.version })}</span>
}

function AdoptBar({ connection, role, update, onProposed }: Readonly<{
  connection: string; role: SkillRole; update: Update; onProposed: (version: number) => void
}>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const adopt = useMutation({
    mutationFn: () => engineeringSkillActionsApi.adopt(connection, role, {
      expected_current: update.current_version, template_version: update.template.version,
    }),
    onSuccess: (result) => onProposed(result.version.version),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: engineeringSkillsKeys.all() }) },
  })
  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-primary btn-sm" disabled={adopt.isPending} onClick={() => adopt.mutate()}>
        {adopt.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {t('skills.template.adopt', { version: update.template.version })}
      </button>
      <p className="text-[12px] text-muted">{t('skills.template.adoptHint')}</p>
      {adopt.isError && <p role="alert" className="text-[12px] text-danger">{serverReason(adopt.error) ?? t('skills.template.adoptFailed')}</p>}
    </div>
  )
}

/** The compare's other side: '' with no version in use (everything is new), its SKILL.md once read, else null. */
function beforeText(none: boolean, current: SkillVersionDetail | undefined): string | null {
  if (none) return ''
  return current === undefined ? null : skillMarkdown(current.record)
}

/** The template compared with the version in use (none in use: everything is new). */
function TemplateCompare({ connection, role, update }: Readonly<{ connection: string; role: SkillRole; update: Update }>) {
  const { t } = useTranslation('agents')
  const { inUse } = useSkillHead(connection, role)
  const current = useSkillVersion(inUse, role)
  const title = t('skills.template.documentTitle', { version: update.template.version })
  const before = beforeText(inUse === null, current.data)
  if (current.isError) {
    return <LoadFailed message={t('skills.versionFailed')} onRetry={() => void current.refetch()} retrying={current.isFetching} />
  }
  return (
    <ReadOnlySurface adapter={skillTemplateAdapter(connection, role, title)} variant="inline" title={title} headingLevel={3}
      meta={null} stored={before === null ? undefined : skillTemplateDocumentOf(update, title)} mode="compare"
      compare={before === null ? null : {
        before, beforeLabel: inUse === null ? t('skills.document.nothing') : `v${String(inUse.version)}`,
        afterLabel: t('skills.template.label', { version: update.template.version }), identicalText: t('skills.document.identical'),
      }} fullPath={null} />
  )
}

function TemplateDiff({ connection, role, onProposed }: Readonly<{
  connection: string; role: SkillRole; onProposed: (version: number) => void
}>) {
  const { t } = useTranslation('agents')
  const read = useQuery({
    queryKey: engineeringSkillsKeys.template(connection, role),
    queryFn: () => engineeringSkillsApi.template(connection, role),
  })
  if (read.isLoading) return <div className="skeleton h-16" role="status" aria-label={t('skills.template.loading')} />
  if (read.isError || read.data === undefined) {
    return <LoadFailed message={t('skills.template.readFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
  }
  const update = read.data
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-text-strong">
        {update.current_version === 0
          ? t('skills.template.diffTitleFirst', { version: update.template.version })
          : t('skills.template.diffTitle', { version: update.template.version, current: update.current_version })}
      </h4>
      <TemplateCompare connection={connection} role={role} update={update} />
      <SkillChanges diff={update.diff} />
      {update.template.newer
        ? <AdoptBar connection={connection} role={role} update={update} onProposed={onProposed} />
        : <p className="text-sm text-muted">{t('skills.template.notNewer')}</p>}
    </div>
  )
}

/**
 * The role's template update, when its history says the template is newer (module doc): the badge's explanation, the
 * compare once asked for, then Propose; after it, the version it proposed, which `onOpen` opens.
 */
export function SkillTemplateUpdate({ connection, role, onOpen }: Readonly<{
  connection: string; role: SkillRole; onOpen: (version: number) => void
}>) {
  const { t } = useTranslation('agents')
  const template = useSkillHistory(connection, role).data?.pages[0]?.template ?? null
  const [open, setOpen] = useState(false)
  const [proposed, setProposed] = useState<number | null>(null)
  if (proposed !== null) {
    return (
      <section className="card p-3 space-y-2" aria-label={t('skills.template.title')}>
        <p role="status" className="text-sm text-text">{t('skills.template.proposed', { version: proposed })}</p>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen(proposed)}>
          {t('skills.template.openProposed')}
        </button>
      </section>
    )
  }
  if (template?.newer !== true) return null
  return (
    <section className="card p-3 space-y-2" aria-label={t('skills.template.title')}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-text-strong">{t('skills.template.title')}</h3>
        <TemplateBadge template={template} />
      </div>
      <p className="text-sm text-muted max-w-prose">{t('skills.template.explain')}</p>
      {open
        ? <TemplateDiff connection={connection} role={role} onProposed={setProposed} />
        : <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>{t('skills.template.show')}</button>}
    </section>
  )
}
