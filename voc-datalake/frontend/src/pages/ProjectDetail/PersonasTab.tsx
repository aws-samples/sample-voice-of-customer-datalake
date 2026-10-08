/**
 * PersonasTab - Personas list and detail view
 */
import clsx from 'clsx'
import {
  Users, Sparkles, Upload,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import PersonaAvatar from './PersonaAvatar'
import PersonaDetailView from './PersonaDetailView'
import type { NoteItem } from './types'
import type { ProjectPersona } from '../../api/projectTypes'

interface PersonasTabProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  /** Viewers (`can_edit: false`) get the list and detail, but no import / generate / edit / delete / notes controls. */
  readonly canEdit: boolean
  readonly selectedPersona: ProjectPersona | null
  readonly onSelectPersona: (persona: ProjectPersona) => void
  readonly onEditPersona: () => void
  readonly onDeletePersona: () => void
  readonly onSaveNotes: (notes: NoteItem[]) => void
  readonly onGeneratePersonas: () => void
  readonly onImportPersona: () => void
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
}

export default function PersonasTab({
  projectId,
  personas,
  canEdit,
  selectedPersona,
  onSelectPersona,
  onEditPersona,
  onDeletePersona,
  onSaveNotes,
  onGeneratePersonas,
  onImportPersona,
  isDeleting,
  isSavingNotes,
}: PersonasTabProps) {
  const { t } = useTranslation('projectDetail')

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="flex flex-col sm:flex-row justify-end gap-2">
          <button
            type="button"
            onClick={onImportPersona}
            className="btn btn-secondary"
          >
            <Upload size={16} aria-hidden />{t('personas.importPersona')}
          </button>
          <button
            type="button"
            onClick={onGeneratePersonas}
            className="btn btn-primary"
          >
            <Sparkles size={16} aria-hidden />{t('personas.generatePersonas')}
          </button>
        </div>
      ) : null}

      {personas.length === 0 ? (
        <EmptyPersonasState onGenerate={canEdit ? onGeneratePersonas : undefined} />
      ) : (
        <div className="flex flex-col lg:grid lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Persona List */}
          <div className="flex lg:flex-col gap-3 overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0 -mx-4 px-4 lg:mx-0 lg:px-0">
            {personas.map((p) => {
              const selected = selectedPersona?.persona_id === p.persona_id
              return (
                <button
                  key={p.persona_id}
                  type="button"
                  onClick={() => onSelectPersona(p)}
                  aria-current={selected ? 'true' : undefined}
                  className={clsx(
                    'flex-shrink-0 w-48 lg:w-full text-left p-3 lg:p-4 rounded-lg border transition-colors focus-ring',
                    selected
                      ? 'bg-accent-subtle border-accent/40'
                      : 'bg-card border-border hover:border-border-strong hover:bg-bg-hover',
                  )}
                >
                  <div className="flex items-center gap-3">
                    <PersonaAvatar persona={p} size="sm" />
                    <div className="flex-1 min-w-0">
                      {/* Plain text, not a heading: a heading inside a button is
                          flattened into the button's name anyway, and six of them
                          broke the page outline (h1 → h4). */}
                      <p className="font-medium truncate text-sm lg:text-base text-text-strong" title={`@${p.name}`}>@{p.name}</p>
                      <p className={clsx('text-xs truncate', selected ? 'text-text' : 'text-muted')} title={p.tagline}>{p.tagline}</p>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Persona Detail */}
          <div className="lg:col-span-2 bg-card rounded-xl border overflow-hidden">
            {selectedPersona ? (
              <PersonaDetailView
                // Remounted per persona: a pending or failed avatar regeneration
                // belongs to the persona it was started for.
                key={selectedPersona.persona_id}
                projectId={projectId}
                persona={selectedPersona}
                canEdit={canEdit}
                onEdit={onEditPersona}
                onDelete={onDeletePersona}
                onSaveNotes={onSaveNotes}
                isDeleting={isDeleting}
                isSavingNotes={isSavingNotes}
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 h-full min-h-[240px] lg:min-h-[500px] text-sm text-muted p-6 text-center">
                <Users size={20} className="text-muted" aria-hidden />
                {t('personas.selectToView')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** No `onGenerate` means the caller may not generate (a viewer): the empty state then has no call to action. */
function EmptyPersonasState({ onGenerate }: { readonly onGenerate?: () => void }) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="card text-center py-12 sm:py-16">
      <div className="w-12 h-12 mx-auto mb-4 rounded-lg bg-aim-subtle flex items-center justify-center">
        <Users size={20} className="text-aim" aria-hidden />
      </div>
      <h2 className="text-base font-semibold tracking-tight text-text-strong mb-1">{t('personas.noPersonasYet')}</h2>
      <p className={clsx('text-sm text-muted', onGenerate && 'mb-5')}>{t('personas.generateFromFeedback')}</p>
      {onGenerate ? (
        <button type="button" onClick={onGenerate} className="btn btn-secondary">
          <Sparkles size={16} aria-hidden />{t('overview.generate')}
        </button>
      ) : null}
    </div>
  )
}
