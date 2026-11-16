/**
 * @fileoverview Agents → Skills, "Template updated" (7.50.00, docs/autonomous-agents.md "Template updated"): a role's
 * bundled template (`voc-datalake/templates/orchestration/agents/<role>/`) is newer than every version of the scope
 * seeded from one, as the role's history says (`template: {version, label, newer}`, useSkillHistory.ts). Its panel
 * says so with a badge, shows the template's diff against the scope's current version (`GET …/skills/<role>/template`),
 * and **Adopt** makes the template a new version proposed by the administrator who pressed it (`POST …/template/
 * adopt`), which an administrator then accepts in the role's history like any other proposal. Nothing is ever adopted
 * or accepted by itself: an update only offers itself.
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
import { DiffView } from './SkillVersionDetail'
import { useSkillHistory } from './useSkillHistory'
import type { SkillRole, SkillTemplate, SkillTemplateUpdate as Update } from '../../api/engineeringSkillsApi'

/** "Template updated (v3)" for a role whose template is newer than its versions; nothing otherwise. */
function TemplateBadge({ template }: Readonly<{ template: SkillTemplate | null }>) {
  const { t } = useTranslation('agents')
  if (template?.newer !== true) return null
  return <span className="badge badge-warn">{t('skills.template.badge', { version: template.version })}</span>
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
        {t('skills.template.adopt')}
      </button>
      <p className="text-[12px] text-muted">{t('skills.template.adoptHint')}</p>
      {adopt.isError && <p role="alert" className="text-[12px] text-danger">{serverReason(adopt.error) ?? t('skills.template.adoptFailed')}</p>}
    </div>
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
      <DiffView diff={update.diff} title={update.current_version === 0
        ? t('skills.template.diffTitleFirst', { version: update.template.version })
        : t('skills.template.diffTitle', { version: update.template.version, current: update.current_version })} />
      {update.template.newer
        ? <AdoptBar connection={connection} role={role} update={update} onProposed={onProposed} />
        : <p className="text-sm text-muted">{t('skills.template.notNewer')}</p>}
    </div>
  )
}

/**
 * The role's template update, when its history says the template is newer (module doc): the badge's explanation, the
 * diff once asked for, then Adopt; after an adoption, the version it proposed, which `onOpen` opens.
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
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen(proposed)}>
          {t('skills.template.openProposed', { version: proposed })}
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
