/**
 * @fileoverview Stop, while an AI draft is generating (the picker's "Describe your form" and "Improve with AI"; the
 * owner's decision of 2026-11-18): it asks "Stop drafting?" and, confirmed, ends the request (useAiDraftRequest
 * `cancel`: the poll of the draft's job stops at once and whatever it would have answered is dropped). The job itself
 * is not cancelled on the server (an assist job has no cancel, shared/assist_jobs.py): it finishes on its own, nobody
 * reads its result and its row expires.
 *
 * @module pages/FeedbackForms/ai/StopDraftButton
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Square } from 'lucide-react'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'

export default function StopDraftButton({ onStop }: Readonly<{ onStop: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
        <Square size={14} aria-hidden="true" />{t('ai.stop.button')}
      </button>
      <ConfirmModal isOpen={confirming} title={t('ai.stop.title')} message={t('ai.stop.message')}
        confirmLabel={t('ai.stop.confirm')} cancelLabel={t('ai.stop.keep')} variant="danger"
        onConfirm={() => { setConfirming(false); onStop() }} onCancel={() => setConfirming(false)} />
    </>
  )
}
