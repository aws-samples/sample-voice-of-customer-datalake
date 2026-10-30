/**
 * @fileoverview "Copy from…" on a project's Personas tab (5.60): pick a source (the
 * company library, or another project the caller owns or belongs to), tick up to 20
 * personas, copy them in. Each copy is independent (a new id; later edits on either
 * side do not travel) and starts without research notes.
 *
 * @module pages/ProjectDetail/CopyPersonasModal
 */
import { Copy, Loader2, AlertCircle } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import { MAX_PERSONAS_PER_COPY } from '../../api/companyPersonasSchema'
import type { PersonaSourceProject, PersonaSummary } from '../../api/companyPersonasSchema'
import { serverReason } from '../../lib/errors'
import PersonaAvatar from './PersonaAvatar'
import { COMPANY_SOURCE, useCopyPersonas } from './useCopyPersonas'
import type { ProjectPersona } from '../../api/projectTypes'

type CopyState = ReturnType<typeof useCopyPersonas>

interface CopyPersonasModalProps {
  readonly projectId: string
  readonly onClose: () => void
  /** After a copy: the copies written (the modal then closes itself). */
  readonly onCopied?: (copies: ProjectPersona[]) => void
}

function SourcePicker({ value, projects, onChange }: Readonly<{
  value: string
  projects: readonly PersonaSourceProject[]
  onChange: (value: string) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="font-medium block mb-2">{t('personas.copy.sourceLabel')}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="input">
        <option value={COMPANY_SOURCE}>{t('personas.copy.companySource')}</option>
        {projects.map((p) => (
          <option key={p.project_id} value={p.project_id}>
            {t('personas.copy.projectSource', { name: p.name, count: p.persona_count })}
          </option>
        ))}
      </select>
    </div>
  )
}

function PersonaChoice({ persona, checked, disabled, onToggle }: Readonly<{
  persona: PersonaSummary
  checked: boolean
  disabled: boolean
  onToggle: () => void
}>) {
  return (
    <li>
      <label className="flex items-center gap-3 p-2 rounded-lg border border-border hover:bg-bg-hover">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} className="rounded-sm flex-shrink-0" />
        <PersonaAvatar persona={{ name: persona.name, avatar_url: persona.avatar_url ?? undefined }} size="sm" />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-text-strong break-words">{persona.name}</span>
          <span className="block text-xs text-muted break-words">{persona.tagline}</span>
        </span>
      </label>
    </li>
  )
}

function PersonaChoices({ state }: Readonly<{ state: CopyState }>) {
  const { t } = useTranslation('projectDetail')
  if (state.isLoadingPersonas) {
    return <p role="status" className="text-sm text-muted inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden />{t('personas.copy.loading')}</p>
  }
  if (state.loadFailed) return <p role="alert" className="text-sm text-danger">{t('personas.copy.loadFailed')}</p>
  if (state.personas.length === 0) return <p className="text-sm text-muted">{t('personas.copy.sourceEmpty')}</p>
  const full = state.selected.length >= MAX_PERSONAS_PER_COPY
  return (
    <fieldset>
      <legend className="font-medium mb-2">{t('personas.copy.choose', { max: MAX_PERSONAS_PER_COPY })}</legend>
      <ul className="space-y-2 max-h-[40vh] overflow-y-auto">
        {state.personas.map((p) => {
          const checked = state.selected.includes(p.persona_id)
          return (
            <PersonaChoice key={p.persona_id} persona={p} checked={checked}
              disabled={!checked && full} onToggle={() => state.toggle(p.persona_id)} />
          )
        })}
      </ul>
    </fieldset>
  )
}

export default function CopyPersonasModal({ projectId, onClose, onCopied }: CopyPersonasModalProps) {
  const { t } = useTranslation('projectDetail')
  const titleId = useId()
  const state = useCopyPersonas(projectId, (copies) => { onCopied?.(copies); onClose() })
  const { copy } = state
  const count = state.selected.length
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-2xl max-h-[90vh]" dismissable={!copy.isPending}>
      <div className="dialog-header justify-between">
        <h2 id={titleId} className="dialog-title">{t('personas.copy.title')}</h2>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body space-y-5">
        <p className="text-sm text-muted">{t('personas.copy.explain')}</p>
        <SourcePicker value={state.source} projects={state.projects} onChange={state.setSource} />
        <PersonaChoices state={state} />
        {copy.isError ? (
          <p role="alert" className="text-sm text-danger inline-flex items-center gap-1.5">
            <AlertCircle size={14} aria-hidden />{serverReason(copy.error) ?? t('personas.copy.failed')}
          </p>
        ) : null}
      </div>
      <div className="dialog-footer flex-col-reverse sm:flex-row">
        <button type="button" onClick={onClose} className="btn btn-secondary w-full sm:w-auto">{t('personas.copy.cancel')}</button>
        <button type="button" onClick={() => copy.mutate()} disabled={count === 0 || copy.isPending} className="btn btn-primary w-full sm:w-auto">
          {copy.isPending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Copy size={16} aria-hidden />}
          {t('personas.copy.submit', { count })}
        </button>
      </div>
    </ModalShell>
  )
}
