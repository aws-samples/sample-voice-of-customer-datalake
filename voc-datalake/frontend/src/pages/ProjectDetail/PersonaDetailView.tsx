/**
 * PersonaDetailView - Displays full persona details with all sections
 */
import clsx from 'clsx'
import {
  Pencil, Trash2, Loader2, NotebookPen, RefreshCw,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import PersonaExportMenu from '../../components/PersonaExportMenu/PersonaExportMenu'
import PersonaAvatar from './PersonaAvatar'
import { getConfidenceClass } from './personaHelpers'
import PersonaSection from './PersonaSection'
import {
  IdentitySection,
  GoalsSection,
  PainPointsSection,
  BehaviorsSection,
  ContextSection,
  QuotesSection,
  ScenarioSection,
} from './PersonaSections'
import ResearchNotes from './ResearchNotes'
import { useRegenerateAvatar } from './useRegenerateAvatar'
import type { NoteItem } from './types'
import type { ProjectPersona } from '../../api/projectTypes'

interface PersonaDetailViewProps {
  readonly projectId: string
  readonly persona: ProjectPersona
  /** False for a viewer: no Edit / Delete, and the research notes are read-only. Export stays — it is a read. */
  readonly canEdit: boolean
  readonly onEdit: () => void
  readonly onDelete: () => void
  readonly onSaveNotes: (notes: NoteItem[]) => void
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
}

export default function PersonaDetailView({
  projectId,
  persona,
  canEdit,
  onEdit,
  onDelete,
  onSaveNotes,
  isDeleting,
  isSavingNotes,
}: PersonaDetailViewProps) {
  const { t } = useTranslation('projectDetail')
  const avatar = useRegenerateAvatar(projectId, persona.persona_id)
  const shown = avatar.avatarUrl === undefined ? persona : { ...persona, avatar_url: avatar.avatarUrl }
  return (
    <div className="h-full overflow-y-auto">
      {/* Header with Avatar */}
      <div className="p-4 sm:p-6 border-b border-border bg-bg-accent">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-center gap-3 sm:gap-4">
            <PersonaAvatar persona={shown} size="lg" />
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-text-strong truncate" title={`@${persona.name}`}>@{persona.name}</h2>
              <p className="text-text text-sm line-clamp-2">{persona.tagline}</p>
              {persona.confidence == null ? null : <span className={clsx('badge mt-1.5', getConfidenceClass(persona.confidence))}>
                {t('personas.confidence', { level: persona.confidence })}
                {persona.feedback_count == null ? '' : <> · <span className="font-mono">{t('personas.reviews', { count: persona.feedback_count })}</span></>}
              </span>}
            </div>
          </div>
          <div className="flex items-center gap-1 self-end sm:self-start">
            <PersonaExportMenu persona={persona} />
            {canEdit ? (
              <>
                <button
                  type="button"
                  onClick={avatar.regenerate}
                  disabled={avatar.isPending}
                  className="icon-btn p-2"
                  title={t('personas.regenerateAvatar')}
                  aria-label={t('personas.regenerateAvatar')}
                >
                  {avatar.isPending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <RefreshCw size={16} aria-hidden />}
                </button>
                <button
                  type="button"
                  onClick={onEdit}
                  className="icon-btn p-2"
                  title={t('personas.editPersona')}
                  aria-label={t('personas.editPersona')}
                >
                  <Pencil size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={isDeleting}
                  className="icon-btn p-2 hover:text-danger"
                  title={t('personas.deletePersona')}
                  aria-label={t('personas.deletePersona')}
                >
                  {isDeleting ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}
                </button>
              </>
            ) : null}
          </div>
        </div>
        <AvatarRegenerationStatus isPending={avatar.isPending} failed={avatar.failed} />
      </div>

      <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
        <IdentitySection persona={persona} />
        <GoalsSection persona={persona} />
        <PainPointsSection persona={persona} />
        <BehaviorsSection persona={persona} />
        <ContextSection persona={persona} />
        <QuotesSection persona={persona} />
        <ScenarioSection persona={persona} />

        <PersonaSection title={t('personas.researchNotes')} icon={NotebookPen} color="muted">
          <ResearchNotes
            key={persona.persona_id}
            persona={persona}
            canEdit={canEdit}
            onSave={onSaveNotes}
            isSaving={isSavingNotes}
          />
        </PersonaSection>
      </div>
    </div>
  )
}

/** Progress while the image model runs (~5 s), and the failure, announced politely. */
function AvatarRegenerationStatus({ isPending, failed }: Readonly<{ isPending: boolean; failed: boolean }>) {
  const { t } = useTranslation('projectDetail')
  if (isPending) {
    return <p role="status" className="mt-3 text-[12px] text-muted">{t('personas.regeneratingAvatar')}</p>
  }
  if (failed) {
    return <p role="alert" className="mt-3 text-[12px] text-danger">{t('personas.regenerateAvatarFailed')}</p>
  }
  return null
}
