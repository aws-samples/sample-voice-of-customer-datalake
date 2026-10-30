/**
 * PersonasTab - Personas list and detail view
 */
import clsx from 'clsx'
import {
  Users, Sparkles, Upload, Copy,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import PersonaAvatar from './PersonaAvatar'
import PersonasEmptyCard from './PersonasEmptyCard'
import PersonaDetailView from './PersonaDetailView'
import type { NoteItem } from './types'
import type { PersonaScope } from './personaScope'
import type { ProjectPersona } from '../../api/projectTypes'

interface PersonasTabProps {
  /** A project's personas, or the company library (Knowledge → Company → Personas). */
  readonly scope: PersonaScope
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
  /** "Copy from…" (a project copying in from the library or another project); absent = no button. */
  readonly onCopyPersonas?: () => void
  /** Replaces the default empty state (the library explains itself differently). */
  readonly emptyState?: ReactNode
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
}

export default function PersonasTab({
  scope,
  personas,
  canEdit,
  selectedPersona,
  onSelectPersona,
  onEditPersona,
  onDeletePersona,
  onSaveNotes,
  onGeneratePersonas,
  onImportPersona,
  onCopyPersonas,
  emptyState,
  isDeleting,
  isSavingNotes,
}: PersonasTabProps) {
  const { t } = useTranslation('projectDetail')

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="flex flex-col sm:flex-row justify-end gap-2">
          {onCopyPersonas ? (
            <button type="button" onClick={onCopyPersonas} className="btn btn-secondary">
              <Copy size={16} aria-hidden />{t('personas.copy.open')}
            </button>
          ) : null}
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
        emptyState ?? <EmptyPersonasState onGenerate={canEdit ? onGeneratePersonas : undefined} />
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
                  // Named by the persona alone (the avatar's alt and the tagline would
                  // otherwise repeat in the name); the tagline describes it.
                  aria-label={p.name}
                  aria-describedby={`persona-tagline-${p.persona_id}`}
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
                          broke the page outline (h1 → h4).
                          The name wraps (it is the button's label and must be whole);
                          the tagline keeps two lines with its full text as a tooltip. */}
                      <p className="font-medium break-words hyphens-auto text-sm lg:text-base text-text-strong" data-testid="persona-list-name">{p.name}</p>
                      <p id={`persona-tagline-${p.persona_id}`} className={clsx('text-xs line-clamp-2 break-words', selected ? 'text-text' : 'text-muted')} title={p.tagline}>{p.tagline}</p>
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
                scope={scope}
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
    <PersonasEmptyCard title={t('personas.noPersonasYet')} body={t('personas.generateFromFeedback')}>
      {onGenerate ? (
        <button type="button" onClick={onGenerate} className="btn btn-secondary">
          <Sparkles size={16} aria-hidden />{t('overview.generate')}
        </button>
      ) : null}
    </PersonasEmptyCard>
  )
}
