/**
 * @fileoverview The prototype page's "Feedback" button and the dialog it opens:
 * the feedback view of the whole series (project editors only, the route is
 * EDIT: the page renders this only for them). Nothing is fetched until it opens.
 * @module components/PrototypeFeedback/PrototypeFeedbackDialog
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessagesSquare, X } from 'lucide-react'
import ModalShell from '../ModalShell/ModalShell'
import PrototypeFeedbackView from './PrototypeFeedbackView'

interface PrototypeFeedbackDialogProps {
  readonly projectId: string
  readonly documentId: string
}

export default function PrototypeFeedbackDialog({ projectId, documentId }: PrototypeFeedbackDialogProps) {
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  const headingId = useId()
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <MessagesSquare size={12} aria-hidden /> {t('prototypeFeedback.open')}
      </button>
      {open ? (
        <ModalShell isOpen onClose={() => setOpen(false)} ariaLabelledBy={headingId}
          panelClassName="max-w-3xl max-h-[90vh]">
          <div className="dialog-header justify-between">
            <div className="min-w-0 space-y-1">
              <h2 id={headingId} className="dialog-title">{t('prototypeFeedback.heading')}</h2>
              <p className="dialog-description">{t('prototypeFeedback.hint')}</p>
            </div>
            <button type="button" className="dialog-close focus-ring flex-shrink-0" aria-label={t('prototypeFeedback.close')}
              title={t('prototypeFeedback.close')} onClick={() => setOpen(false)}>
              <X size={16} aria-hidden />
            </button>
          </div>
          <PrototypeFeedbackView projectId={projectId} documentId={documentId} />
        </ModalShell>
      ) : null}
    </>
  )
}
