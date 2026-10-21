/**
 * PersonaDetailView - Displays full persona details with all sections
 */
import clsx from 'clsx'
import {
  Pencil, Trash2, Loader2, Lock, LockOpen,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import PersonaExportMenu from '../../components/PersonaExportMenu'
import PersonaAvatar from './PersonaAvatar'
import { getConfidenceClass } from './personaHelpers'
import PersonaSection from './PersonaSection'
import PersonaSourceFeedbackModal from './PersonaSourceFeedbackModal'
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
import type { NoteItem } from './types'
import type { ProjectPersona } from '../../api/types'

interface PersonaDetailViewProps {
  readonly projectId: string
  readonly persona: ProjectPersona
  readonly onEdit: () => void
  readonly onDelete: () => void
  readonly onSaveNotes: (notes: NoteItem[]) => void
  /** Flip whether this persona survives regeneration. */
  readonly onToggleProtected: () => void
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
  readonly isTogglingProtected: boolean
}

/**
 * Header button that protects the persona from regeneration, or releases it.
 * The icon shows the current state; the label names what a click does.
 */
function ProtectToggleButton({
  isProtected, isPending, onToggle,
}: { readonly isProtected: boolean; readonly isPending: boolean; readonly onToggle: () => void }) {
  const { t } = useTranslation('projectDetail')
  const label = isProtected ? t('personas.unprotect') : t('personas.protect')
  const icon = isProtected ? <Lock size={18} /> : <LockOpen size={18} />
  return (
    <button
      onClick={onToggle}
      disabled={isPending}
      aria-pressed={isProtected}
      aria-label={label}
      title={label}
      className={clsx(
        'p-2 rounded-lg disabled:opacity-50',
        isProtected ? 'text-amber-600 hover:bg-amber-100' : 'text-gray-500 hover:bg-gray-100',
      )}
    >
      {isPending ? <Loader2 size={18} className="animate-spin" /> : icon}
    </button>
  )
}

/**
 * The header's "• N reviews" suffix. `feedback_count` is the model's own estimate,
 * so a persona that recorded the reviews it cites shows that real count instead;
 * a persona generated before that keeps the old text unchanged.
 */
function reviewCountSuffix(t: TFunction, persona: ProjectPersona): string {
  if (Array.isArray(persona.evidence_feedback_ids)) {
    return ` • ${t('personas.citedReviews', { count: persona.evidence_feedback_ids.length })}`
  }
  return persona.feedback_count == null ? '' : ` • ${persona.feedback_count} reviews`
}

export default function PersonaDetailView({
  projectId,
  persona,
  onEdit,
  onDelete,
  onSaveNotes,
  onToggleProtected,
  isDeleting,
  isSavingNotes,
  isTogglingProtected,
}: PersonaDetailViewProps) {
  const { t } = useTranslation('projectDetail')
  const [showSourceFeedback, setShowSourceFeedback] = useState(false)
  const isProtected = persona.protected === true
  return (
    <div className="h-full overflow-y-auto">
      {/* Header with Avatar */}
      <div className="p-4 sm:p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-center gap-3 sm:gap-4">
            <PersonaAvatar persona={persona} size="lg" />
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900 truncate">@{persona.name}</h2>
              <p className="text-gray-600 text-sm sm:text-base line-clamp-2">{persona.tagline}</p>
              {persona.confidence == null ? null : <span className={clsx('inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium', getConfidenceClass(persona.confidence))}>
                {persona.confidence} confidence
                {reviewCountSuffix(t, persona)}
              </span>}
              {isProtected ? (
                <span
                  className="inline-flex items-center gap-1 mt-1 ml-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800"
                  title={t('personas.protectedHint')}
                >
                  <Lock size={12} />{t('personas.protected')}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1 self-end sm:self-start">
            <ProtectToggleButton isProtected={isProtected} isPending={isTogglingProtected} onToggle={onToggleProtected} />
            <PersonaExportMenu persona={persona} onViewSourceFeedback={() => setShowSourceFeedback(true)} />
            <button onClick={onEdit} className="p-2 text-purple-500 hover:bg-purple-100 rounded-lg" title="Edit">
              <Pencil size={18} />
            </button>
            <button onClick={onDelete} disabled={isDeleting} className="p-2 text-red-500 hover:bg-red-100 rounded-lg" title="Delete">
              {isDeleting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        <IdentitySection persona={persona} />
        <GoalsSection persona={persona} />
        <PainPointsSection persona={persona} />
        <BehaviorsSection persona={persona} />
        <ContextSection persona={persona} />
        <QuotesSection persona={persona} />
        <ScenarioSection persona={persona} />

        <PersonaSection title={t('personas.researchNotes')} icon="📝" color="gray">
          <ResearchNotes
            key={persona.persona_id}
            persona={persona}
            onSave={onSaveNotes}
            isSaving={isSavingNotes}
          />
        </PersonaSection>
      </div>

      {showSourceFeedback ? (
        <PersonaSourceFeedbackModal
          key={persona.persona_id}
          projectId={projectId}
          persona={persona}
          onClose={() => setShowSourceFeedback(false)}
        />
      ) : null}
    </div>
  )
}
