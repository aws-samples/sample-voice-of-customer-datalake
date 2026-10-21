/**
 * @fileoverview "View source feedback" for one persona: the reviews it cites, and
 * every review its generation batch read.
 *
 * Opened from the persona's export menu. A review opens in FeedbackDetailOverlay
 * on top of this dialog; ModalShell's stacking makes Escape close only the
 * top-most of the two.
 *
 * @module pages/ProjectDetail/PersonaSourceFeedbackModal
 */
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import FeedbackDetailOverlay from '../../components/FeedbackDetailOverlay'
import ModalShell from '../../components/ModalShell'
import { PERSONA_FEEDBACK_SCOPES } from '../../api/personaFeedbackSchema'
import PersonaSourceFeedbackList from './PersonaSourceFeedbackList'
import { summarizePersonaFeedbackPages, usePersonaSourceFeedback } from './usePersonaSourceFeedback'
import type { PersonaFeedbackScope } from '../../api/personaFeedbackSchema'
import type { FeedbackItem, PersonaFeedbackProvenance, ProjectPersona } from '../../api/types'

interface PersonaSourceFeedbackModalProps {
  readonly projectId: string
  readonly persona: ProjectPersona
  readonly onClose: () => void
}

/**
 * "Built from …" for a provenance. A lower-bound match count is treated as sampled
 * even when it reads no larger than the sample: the true match is at least that
 * many, and the row cap it stopped at is far above the sample size.
 */
function provenanceText(t: TFunction, provenance: PersonaFeedbackProvenance): string {
  const { items_used: used, items_matched: matched, matched_is_lower_bound: lowerBound } = provenance
  if (!lowerBound && matched <= used) {
    return t('personas.sourceFeedback.provenanceAll', { count: used })
  }
  return lowerBound
    ? t('personas.sourceFeedback.provenanceSampledAtLeast', { used, matched })
    : t('personas.sourceFeedback.provenanceSampled', { used, matched })
}

function ProvenanceLine({ provenance }: { readonly provenance: PersonaFeedbackProvenance | null }) {
  const { t } = useTranslation('projectDetail')
  if (provenance === null) return null
  return <p className="px-5 pt-3 text-xs text-gray-500">{provenanceText(t, provenance)}</p>
}

interface ScopeTabsProps {
  readonly scope: PersonaFeedbackScope
  readonly counts: Readonly<Record<PersonaFeedbackScope, number | undefined>>
  readonly tabId: (scope: PersonaFeedbackScope) => string
  readonly panelId: string
  readonly onChange: (scope: PersonaFeedbackScope) => void
}

function ScopeTabs({ scope, counts, tabId, panelId, onChange }: ScopeTabsProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <div role="tablist" aria-label={t('personas.sourceFeedback.tabsLabel')} className="flex gap-1 px-5 pt-3 border-b">
      {PERSONA_FEEDBACK_SCOPES.map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          id={tabId(value)}
          aria-selected={value === scope}
          aria-controls={panelId}
          onClick={() => onChange(value)}
          className={clsx(
            '-mb-px px-3 py-2 text-sm border-b-2 transition-colors',
            value === scope ? 'border-purple-600 text-purple-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700',
          )}
        >
          {value === 'cited' ? t('personas.sourceFeedback.tabCited') : t('personas.sourceFeedback.tabUsed')}
          {counts[value] === undefined ? null : <span className="ml-1 text-gray-400">({counts[value]})</span>}
        </button>
      ))}
    </div>
  )
}

function ModalHeader({ headingId, name, onClose }: {
  readonly headingId: string
  readonly name: string
  readonly onClose: () => void
}) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4">
      <h2 id={headingId} className="text-base font-semibold text-gray-900 truncate">
        {t('personas.sourceFeedback.title', { name })}
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('personas.sourceFeedback.close')}
        className="p-1 text-gray-400 hover:text-gray-700"
      >
        <X size={18} />
      </button>
    </div>
  )
}

export default function PersonaSourceFeedbackModal({ projectId, persona, onClose }: PersonaSourceFeedbackModalProps) {
  const headingId = useId()
  const panelId = useId()
  const [scope, setScope] = useState<PersonaFeedbackScope>('cited')
  const [openFeedback, setOpenFeedback] = useState<FeedbackItem | null>(null)
  const query = usePersonaSourceFeedback(projectId, persona.persona_id, scope)
  const summary = query.data ? summarizePersonaFeedbackPages(query.data.pages) : null
  const tabId = (value: PersonaFeedbackScope) => `${panelId}-${value}`

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={headingId} panelClassName="max-w-2xl">
      <div className="flex flex-col max-h-[85vh]">
        <ModalHeader headingId={headingId} name={persona.name} onClose={onClose} />
        <ProvenanceLine provenance={persona.feedback_provenance ?? summary?.provenance ?? null} />
        <ScopeTabs
          scope={scope}
          counts={{ cited: persona.evidence_feedback_ids?.length, used: persona.input_feedback_ids?.length }}
          tabId={tabId}
          panelId={panelId}
          onChange={setScope}
        />
        <div role="tabpanel" id={panelId} aria-labelledby={tabId(scope)} className="flex-1 overflow-y-auto px-5 py-4">
          <PersonaSourceFeedbackList scope={scope} query={query} summary={summary} onOpenFeedback={setOpenFeedback} />
        </div>
      </div>
      <FeedbackDetailOverlay feedback={openFeedback} onClose={() => setOpenFeedback(null)} />
    </ModalShell>
  )
}
