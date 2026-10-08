/**
 * @fileoverview Personas tab: the fixed personas every run consults (picked
 * from existing projects) and whether the crew may generate new ones from the
 * triggering reviews.
 *
 * @module pages/Agents/AgentPersonas
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { API_AGENT_LIMITS } from '../../api/agentsApi'
import { projectKey, projectsKey } from '../../api/projectQueryKeys'
import { projectsApi } from '../../api/projectsApi'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import type { SectionProps } from './AgentSections'

export function PersonasSection({ draft, readOnly, onChange }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const [projectId, setProjectId] = useState('')
  const [personaId, setPersonaId] = useState('')
  const { data: projects } = useQuery({ queryKey: projectsKey(), queryFn: projectsApi.getProjects })
  const { data: detail } = useQuery({
    queryKey: projectKey(projectId),
    queryFn: () => projectsApi.getProject(projectId),
    enabled: projectId !== '',
  })
  const { fixed, allow_generate: allowGenerate } = draft.personas
  const projectName = (id: string) => projects?.projects.find((p) => p.project_id === id)?.name ?? id
  const already = (pid: string, sid: string) => fixed.some((f) => f.project_id === pid && f.persona_id === sid)
  const add = () => {
    if (projectId === '' || personaId === '' || already(projectId, personaId)) return
    onChange({ ...draft, personas: { ...draft.personas, fixed: [...fixed, { project_id: projectId, persona_id: personaId }] } })
    setPersonaId('')
  }
  const full = fixed.length >= API_AGENT_LIMITS.maxFixedPersonas
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" className="accent-accent" disabled={readOnly} checked={allowGenerate}
          onChange={(e) => onChange({ ...draft, personas: { ...draft.personas, allow_generate: e.target.checked } })} />
        {t('personas.allowGenerate')}
      </label>
      <div>
        <p className="text-[12px] font-medium text-muted mb-1">{t('personas.fixed', { n: fixed.length, max: API_AGENT_LIMITS.maxFixedPersonas })}</p>
        {fixed.length === 0 && <p className="text-sm text-muted italic">{t('personas.none')}</p>}
        <ul className="space-y-1">
          {fixed.map((ref) => (
            <li key={`${ref.project_id}/${ref.persona_id}`} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
              <span className="text-text truncate">{projectName(ref.project_id)}</span>
              <span className="font-mono text-[12px] text-muted truncate mr-auto">{ref.persona_id}</span>
              {!readOnly && (
                <button type="button" className="icon-btn" aria-label={t('personas.remove')} title={t('personas.remove')}
                  onClick={() => onChange({ ...draft, personas: { ...draft.personas, fixed: fixed.filter((f) => f !== ref) } })}>
                  <Trash2 size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {!readOnly && !full && (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end">
          <LabeledField label={t('personas.project')}>
            {(id) => (
              <select id={id} className="select w-full" value={projectId} onChange={(e) => { setProjectId(e.target.value); setPersonaId('') }}>
                <option value="">{t('personas.chooseProject')}</option>
                {(projects?.projects ?? []).map((p) => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
              </select>
            )}
          </LabeledField>
          <LabeledField label={t('personas.persona')}>
            {(id) => (
              <select id={id} className="select w-full" value={personaId} disabled={projectId === ''} onChange={(e) => setPersonaId(e.target.value)}>
                <option value="">{t('personas.choosePersona')}</option>
                {(detail?.personas ?? []).filter((p) => !already(projectId, p.persona_id)).map((p) => (
                  <option key={p.persona_id} value={p.persona_id}>{p.name}</option>
                ))}
              </select>
            )}
          </LabeledField>
          <button type="button" className="btn btn-secondary" disabled={personaId === ''} onClick={add}>
            <Plus size={14} aria-hidden="true" /> {t('personas.add')}
          </button>
        </div>
      )}
    </div>
  )
}
