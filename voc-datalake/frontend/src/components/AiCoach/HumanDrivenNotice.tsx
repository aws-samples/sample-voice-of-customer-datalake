/**
 * @fileoverview "Human-driven: you write, AI coaches" for a PR/FAQ or PRD (docs/ways-of-working.md).
 *
 * Shown where the AI would otherwise write (the document wizard, the document view)
 * when the person works Human-driven on that type. Two ways to get help instead:
 *
 * - **Coach me**: opens the assistant on a new conversation with a coaching prompt
 *   for this document (nothing is sent until the person presses send);
 * - **Review my draft** (once a draft exists): the same, asking for a review that
 *   quotes their own words.
 *
 * "Ask personas" stays where it is (the assistant's consult_personas). The assistant
 * itself coaches rather than writes for this person (the stream Lambda's guardrail).
 *
 * @module components/AiCoach/HumanDrivenNotice
 */
import { GraduationCap, MessageCircleQuestionMark, ScanSearch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openAssistant } from '../../assistant/store/openAssistant'
import { aiMayWrite, isGatedDocType } from '../../api/aiModeApi'
import type { GatedDocType } from '../../api/aiModeApi'
import { useMyAiMode } from '../../hooks/useMyAiMode'

interface HumanDrivenNoticeProps {
  readonly docType: GatedDocType
  /** The document's title, when it has one (named in the prompt). */
  readonly title?: string
  /** A draft exists: offer "Review my draft". */
  readonly canReview?: boolean
}

/** Literal keys, so the i18n audit sees both. */
const TYPE_KEYS: Record<GatedDocType, string> = { prfaq: 'aiCoach.docTypePrfaq', prd: 'aiCoach.docTypePrd' }

export default function HumanDrivenNotice({ docType, title = '', canReview = false }: HumanDrivenNoticeProps) {
  const { t } = useTranslation('components')
  const type = t(TYPE_KEYS[docType])
  const subject = title.trim() === '' ? type : t('aiCoach.namedDocument', { type, title: title.trim() })
  return (
    <div role="note" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-accent px-3 py-2 text-[13px] text-text">
      <GraduationCap size={16} className="flex-shrink-0 text-accent" aria-hidden="true" />
      <span className="mr-auto" title={t('aiCoach.tooltip')}>{t('aiCoach.banner')}</span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => openAssistant({ prompt: t('aiCoach.coachPrompt', { subject }) })}
      >
        <MessageCircleQuestionMark size={14} aria-hidden="true" />{t('aiCoach.coachMe')}
      </button>
      {canReview ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => openAssistant({ prompt: t('aiCoach.reviewPrompt', { subject }) })}
        >
          <ScanSearch size={14} aria-hidden="true" />{t('aiCoach.reviewMyDraft')}
        </button>
      ) : null}
    </div>
  )
}

/**
 * The notice on a stored document, only for a PR/FAQ / PRD the person writes themselves
 * (Human-driven, type not unlocked); nothing for every other document or mode.
 */
export function DocumentCoachingNotice({ documentType, title, hasContent }: Readonly<{
  documentType: string; title: string; hasContent: boolean
}>) {
  const aiMode = useMyAiMode()
  if (!isGatedDocType(documentType) || aiMayWrite(aiMode, documentType)) return null
  return <div className="mb-3"><HumanDrivenNotice docType={documentType} title={title} canReview={hasContent} /></div>
}
