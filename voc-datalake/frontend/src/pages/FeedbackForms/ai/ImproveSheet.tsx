/**
 * @fileoverview "Improve with AI" (UX §12.2): a SideSheet opened from the Questions tab and the header's ⋯. Step 1 is
 * an instruction (with "Try" examples, and "Improve question N" when a question is selected); the AI reads the form
 * as it is now, unsaved edits included; while it drafts, Stop (asked first) ends it and drops what it would answer.
 * Step 2 is its changes as a diff to accept or reject (FormDiff). Apply writes them into the draft, unsaved; nothing
 * the AI makes is saved until the person saves.
 *
 * @module pages/FeedbackForms/ai/ImproveSheet
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Sparkles } from 'lucide-react'
import SideSheet from '../../../components/SideSheet/SideSheet'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import { useAiDraftRequest } from './useAiDraftRequest'
import type { AiDraftRequest } from './useAiDraftRequest'
import { useImproveProposal } from './useImproveProposal'
import type { Proposal } from './useImproveProposal'
import FormDiff from './FormDiff'
import ImproveInstruction from './ImproveInstruction'
import StopDraftButton from './StopDraftButton'

const HELD_ID = 'improve-held'

function InstructionFooter({ request, onCancel, onDraft }: Readonly<{ request: AiDraftRequest; onCancel: () => void; onDraft: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const off = request.busy || request.waitMinutes > 0
  return (
    <>
      <span />
      <div className="flex gap-2">
        {request.busy
          ? <StopDraftButton onStop={request.cancel} />
          : <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('ai.improve.cancel')}</button>}
        <button type="button" className="btn btn-primary" aria-busy={request.busy} aria-disabled={off ? true : undefined}
          onClick={() => { if (!off) onDraft() }}>
          {request.busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
          {t('ai.improve.draft')}
        </button>
      </div>
    </>
  )
}

function ReviewFooter({ proposal, count, held, onBack, onApply }: Readonly<{
  proposal: Proposal; count: number; held: string | null; onBack: () => void; onApply: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={onBack}>{t('ai.improve.back')}</button>
      {proposal.diff.changes.length > 0 && (
        <div className="flex flex-col items-end gap-1">
          <button type="button" className="btn btn-primary" aria-disabled={held === null ? undefined : true}
            aria-describedby={held === null ? undefined : HELD_ID} onClick={onApply}>
            {t('ai.diff.applyCount', { count })}
          </button>
          {held !== null && <p id={HELD_ID} className="text-[12px] text-danger">{held}</p>}
        </div>
      )}
    </>
  )
}

function ReviewBody({ improve, proposal }: Readonly<{ improve: ReturnType<typeof useImproveProposal>; proposal: Proposal }>) {
  const { t } = useTranslation('feedbackForms')
  if (proposal.diff.changes.length === 0) return <p role="status" className="text-sm text-text">{t('ai.improve.nothing')}</p>
  return (
    <FormDiff before={proposal.before} after={proposal.after} diff={proposal.diff} notes={proposal.notes} warnings={proposal.warnings}
      accepted={improve.accepted} onAccepted={improve.setAccepted} checked={improve.checked} onChecked={improve.setChecked} />
  )
}

export default function ImproveSheet({ isOpen, onClose }: Readonly<{ isOpen: boolean; onClose: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const ui = useBuilderUi()
  const request = useAiDraftRequest()
  const improve = useImproveProposal(draft, t)
  const [instruction, setInstruction] = useState('')
  const [empty, setEmpty] = useState(false)
  const [applied, setApplied] = useState(0)
  const asked = useRef('')
  const selectedAt = draft.form.questions.findIndex((question) => question.id === ui.rest[0])
  const { proposal } = improve

  const close = () => {
    request.cancel()
    improve.reset()
    onClose()
  }
  const ask = async (text: string) => {
    asked.current = text
    // (7.58.01: the removed questions' ids, which none of the AI's questions takes)
    const answer = await request.run({ description: text, instruction: text, language: draft.form.language, channel: 'link', base_form: draft.form,
      retired_ids: [...draft.retiredIds] })
    if (answer !== null) improve.propose(draft.form, answer)
  }
  const submit = () => {
    const text = instruction.trim()
    setEmpty(text === '')
    if (text !== '') void ask(text)
  }
  const apply = () => {
    const count = improve.apply()
    if (count === 0) return
    setApplied(count)
    close()
  }
  const footer = proposal === null
    ? <InstructionFooter request={request} onCancel={close} onDraft={submit} />
    : <ReviewFooter proposal={proposal} count={improve.effective.size} held={improve.held} onBack={improve.reset} onApply={apply} />
  return (
    <>
      <SideSheet isOpen={isOpen} onClose={close} size="wide" icon={Sparkles} title={t('ai.improve.title')}
        description={t('ai.improve.description')} footer={footer}>
        {proposal === null
          ? (
            <ImproveInstruction instruction={instruction} onInstruction={setInstruction} empty={empty} request={request}
              selected={selectedAt === -1 ? null : selectedAt + 1} onRetry={() => { void ask(asked.current) }} />
          )
          : <ReviewBody improve={improve} proposal={proposal} />}
      </SideSheet>
      <p role="status" className="sr-only">{applied > 0 ? t('ai.improve.applied', { count: applied }) : ''}</p>
    </>
  )
}
