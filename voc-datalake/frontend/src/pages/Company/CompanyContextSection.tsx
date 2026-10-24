/**
 * @fileoverview Company → Company context: the long-term vision (markdown) and
 * the company objectives.
 *
 * Everyone reads it — it is context for the assistant, the autonomous agents and
 * the memory extractor, and the tie-breaker for memory conflicts. Only admins
 * edit (the PUT is admin-gated server-side; others get a read-only view).
 *
 * @module pages/Company/CompanyContextSection
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Compass, Plus, Trash2 } from 'lucide-react'
import {
  companyContextApi, companyContextBody, companyContextKey, MAX_COMPANY_OBJECTIVES, MAX_VISION_CHARS, OBJECTIVE_HORIZONS,
} from '../../api/companyContextApi'
import type { CompanyContext, CompanyObjective, ObjectiveHorizon } from '../../api/companyContextApi'
import { newClientId } from '../../api/schemaList'
import { GroupLabel, MarkdownField, MarkdownView, SectionHeader, ViewOnlyBadge } from './ContextParts'
import { DraftSaveRow, LoadedSection } from './SectionParts'
import { useDraft, useDraftGuard } from './useDraft'
import { formatDateTime } from '../../utils/dateUtils'

const EMPTY: CompanyContext = { vision: '', objectives: [] }

/** Nothing has been written: no vision and no objectives. */
function isEmptyContext(context: CompanyContext): boolean {
  return context.vision.trim() === '' && context.objectives.length === 0
}

function isHorizon(value: string): value is ObjectiveHorizon {
  return OBJECTIVE_HORIZONS.some((h) => h === value)
}

export default function CompanyContextSection({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: companyContextKey(), queryFn: companyContextApi.getCompanyContext })
  const draft = useDraft<CompanyContext>(query.data ?? EMPTY, companyContextBody)
  const save = useMutation({
    mutationFn: companyContextApi.saveCompanyContext,
    onSuccess: (saved) => {
      queryClient.setQueryData(companyContextKey(), saved)
      draft.reset()
    },
  })

  const context = draft.value
  const tooLong = context.vision.length > MAX_VISION_CHARS
  const guard = useDraftGuard({ dirty: isAdmin && draft.dirty, reset: draft.reset, save: () => save.mutateAsync(context), canSave: !tooLong })
  // Live finding: an empty context still showed the editor and "Last updated … by …".
  // Empty and untouched, it says "Not set yet" with one action that opens the editor.
  const [editing, setEditing] = useState(false)

  return (
    <div className="card">
      <SectionHeader
        icon={Compass}
        title={t('companyContext.title')}
        description={t('companyContext.description')}
        aside={isAdmin ? null : <ViewOnlyBadge />}
      />
      <LoadedSection query={query}>
        {(data) => (isEmptyContext(data) && !editing && !draft.dirty ? (
          <NotSetYet isAdmin={isAdmin} onStart={() => setEditing(true)} />
        ) : (
          <>
            {isAdmin ? (
              <CompanyContextEditor context={context} onChange={draft.update} />
            ) : (
              <CompanyContextView context={context} />
            )}
            <UpdatedMeta context={data} />
            {isAdmin ? (
              <DraftSaveRow save={save} dirty={draft.dirty} onSave={() => save.mutate(context)} invalid={tooLong} />
            ) : null}
          </>
        ))}
      </LoadedSection>
      {guard.dialog}
    </div>
  )
}

function NotSetYet({ isAdmin, onStart }: Readonly<{ isAdmin: boolean; onStart: () => void }>) {
  const { t } = useTranslation('settings')
  return (
    <div className="text-center py-6">
      <p className="text-sm font-medium text-text-strong">{t('companyContext.notSetTitle')}</p>
      <p className="text-sm text-muted mt-1 mb-4">{isAdmin ? t('companyContext.notSetAdmin') : t('companyContext.notSetReader')}</p>
      {isAdmin ? <button type="button" onClick={onStart} className="btn btn-primary">{t('companyContext.notSetCta')}</button> : null}
    </div>
  )
}

/** "Last updated … by …", only when there is something that was updated. */
function UpdatedMeta({ context }: Readonly<{ context: CompanyContext }>) {
  const { t, i18n } = useTranslation('settings')
  if (context.updated_at === undefined || isEmptyContext(context)) return null
  return (
    <p className="text-xs text-muted mt-3">
      {t('companyContext.updatedMeta', {
        at: formatDateTime(context.updated_at, i18n.language),
        by: context.updated_by_username ?? t('companyContext.unknownEditor'),
      })}
    </p>
  )
}

function CompanyContextView({ context }: Readonly<{ context: CompanyContext }>) {
  const { t } = useTranslation('settings')
  return (
    <div className="space-y-5">
      <div>
        <GroupLabel>{t('companyContext.vision')}</GroupLabel>
        <MarkdownView source={context.vision} empty={t('companyContext.noVision')} />
      </div>
      <div>
        <GroupLabel>{t('companyContext.objectives')}</GroupLabel>
        {context.objectives.length === 0 ? (
          <p className="text-sm text-muted italic">{t('companyContext.noObjectives')}</p>
        ) : (
          <ul className="space-y-2">
            {context.objectives.map((objective) => (
              <li key={objective.id} className="border border-border rounded-md p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-strong">{objective.title}</span>
                  <HorizonBadge objective={objective} />
                </div>
                {objective.description ? <p className="text-sm text-text mt-1">{objective.description}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** An objective's horizon: a descriptive label, so neutral — `aim` would announce "AI-generated" (labels vs status). */
function HorizonBadge({ objective }: Readonly<{ objective: CompanyObjective }>) {
  const { t } = useTranslation('settings')
  const label = t(`companyContext.horizons.${objective.horizon}`)
  const due = objective.horizon === 'date' && objective.due !== undefined ? ` · ${objective.due}` : ''
  return <span className="badge badge-muted">{label}{due}</span>
}

function CompanyContextEditor({ context, onChange }: Readonly<{
  context: CompanyContext
  onChange: (change: (current: CompanyContext) => CompanyContext) => void
}>) {
  const { t } = useTranslation('settings')
  const setObjective = (id: string, patch: Partial<CompanyObjective>) =>
    onChange((c) => ({ ...c, objectives: c.objectives.map((o) => (o.id === id ? { ...o, ...patch } : o)) }))
  const removeObjective = (id: string) =>
    onChange((c) => ({ ...c, objectives: c.objectives.filter((o) => o.id !== id) }))
  const addObjective = () =>
    onChange((c) => ({
      ...c,
      objectives: [...c.objectives, { id: newClientId('obj'), title: '', description: '', horizon: 'long', due: undefined }],
    }))
  const atLimit = context.objectives.length >= MAX_COMPANY_OBJECTIVES

  return (
    <div className="space-y-5">
      <MarkdownField
        label={t('companyContext.vision')}
        value={context.vision}
        onChange={(vision) => onChange((c) => ({ ...c, vision }))}
        maxChars={MAX_VISION_CHARS}
        placeholder={t('companyContext.visionPlaceholder')}
      />
      <div>
        <GroupLabel>{t('companyContext.objectives')}</GroupLabel>
        <div className="space-y-3">
          {context.objectives.map((objective, index) => (
            <ObjectiveRow
              key={objective.id}
              index={index}
              objective={objective}
              onChange={(patch) => setObjective(objective.id, patch)}
              onRemove={() => removeObjective(objective.id)}
            />
          ))}
        </div>
        <button type="button" onClick={addObjective} disabled={atLimit} className="btn btn-secondary btn-sm flex items-center gap-1.5 mt-3">
          <Plus size={14} /> {t('companyContext.addObjective')}
        </button>
        {atLimit ? <p className="text-xs text-muted mt-1">{t('companyContext.objectiveLimit', { max: MAX_COMPANY_OBJECTIVES })}</p> : null}
      </div>
    </div>
  )
}

function ObjectiveRow({ index, objective, onChange, onRemove }: Readonly<{
  index: number
  objective: CompanyObjective
  onChange: (patch: Partial<CompanyObjective>) => void
  onRemove: () => void
}>) {
  const { t } = useTranslation('settings')
  const prefix = `company-objective-${objective.id}`
  return (
    <fieldset className="border border-border rounded-md p-3 space-y-2">
      <legend className="sr-only">{t('companyContext.objectiveLegend', { n: index + 1 })}</legend>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          id={`${prefix}-title`}
          aria-label={t('companyContext.objectiveTitle')}
          placeholder={t('companyContext.objectiveTitle')}
          value={objective.title}
          onChange={(e) => onChange({ title: e.target.value })}
          className="input flex-1"
        />
        <select
          aria-label={t('companyContext.horizon')}
          value={objective.horizon}
          onChange={(e) => { if (isHorizon(e.target.value)) onChange({ horizon: e.target.value }) }}
          className="select sm:w-40"
        >
          {OBJECTIVE_HORIZONS.map((h) => <option key={h} value={h}>{t(`companyContext.horizons.${h}`)}</option>)}
        </select>
        {objective.horizon === 'date' ? (
          <input
            type="date"
            aria-label={t('companyContext.due')}
            value={objective.due ?? ''}
            onChange={(e) => onChange({ due: e.target.value === '' ? undefined : e.target.value })}
            className="input sm:w-44"
          />
        ) : null}
        <button type="button" onClick={onRemove} className="icon-btn self-end sm:self-center" aria-label={t('companyContext.removeObjective')} title={t('companyContext.removeObjective')}>
          <Trash2 size={16} />
        </button>
      </div>
      <textarea
        aria-label={t('companyContext.objectiveDescription')}
        placeholder={t('companyContext.objectiveDescription')}
        value={objective.description}
        rows={2}
        onChange={(e) => onChange({ description: e.target.value })}
        className="input"
      />
    </fieldset>
  )
}
