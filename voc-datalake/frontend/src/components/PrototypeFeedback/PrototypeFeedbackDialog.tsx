/**
 * @fileoverview The prototype page's "Feedback" button and the dialog it opens:
 * the feedback view of the whole series (project editors only, the route is
 * EDIT: the page renders this only for them). Nothing is fetched until it opens.
 *
 * **Incorporate** (docs/prototype-builder.md Part 3) starts a draft of the series from the
 * selected items' pin ids, never their text (the server reads the pins and writes the
 * instruction); the dialog closes and the project's jobs are read again, so the prototype's
 * draft banner shows the draft, with its per-item outcomes, when it is ready.
 * @module components/PrototypeFeedback/PrototypeFeedbackDialog
 */
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { MessagesSquare, X } from 'lucide-react'
import { projectsApi } from '../../api/projectsApi'
import { projectJobsKey } from '../../api/projectQueryKeys'
import { refusalReason } from '../../lib/errors'
import ModalShell from '../ModalShell/ModalShell'
import PrototypeFeedbackView from './PrototypeFeedbackView'

interface PrototypeFeedbackDialogProps {
  readonly projectId: string
  readonly documentId: string
}

export default function PrototypeFeedbackDialog({ projectId, documentId }: PrototypeFeedbackDialogProps) {
  const { t, i18n } = useTranslation('components')
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const headingId = useId()
  const incorporate = useMutation({
    mutationFn: (pinIds: string[]) =>
      projectsApi.startPrototypeDraft(projectId, documentId, { pin_ids: pinIds }, i18n.language === '' ? 'en' : i18n.language),
    onSuccess: () => {
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: projectJobsKey(projectId) })
    },
  })
  const close = () => {
    setOpen(false)
    incorporate.reset()
  }
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <MessagesSquare size={12} aria-hidden /> {t('prototypeFeedback.open')}
      </button>
      {open ? (
        <ModalShell isOpen onClose={close} ariaLabelledBy={headingId} dismissable={!incorporate.isPending}
          panelClassName="max-w-3xl max-h-[90vh]">
          <div className="dialog-header justify-between">
            <div className="min-w-0 space-y-1">
              <h2 id={headingId} className="dialog-title">{t('prototypeFeedback.heading')}</h2>
              <p className="dialog-description">{t('prototypeFeedback.hint')}</p>
            </div>
            <button type="button" className="dialog-close focus-ring flex-shrink-0" aria-label={t('prototypeFeedback.close')}
              title={t('prototypeFeedback.close')} onClick={close} disabled={incorporate.isPending}>
              <X size={16} aria-hidden />
            </button>
          </div>
          {incorporate.isError ? (
            // A refusal the server explains (a pin of another series, every pin withheld) in its words; else try again.
            <p role="alert" className="px-6 pt-3 text-sm text-danger">
              {refusalReason(incorporate.error) ?? t('prototypeFeedback.incorporateFailed')}
            </p>
          ) : null}
          <PrototypeFeedbackView projectId={projectId} documentId={documentId}
            onIncorporate={(pinIds) => { incorporate.mutate(pinIds) }} incorporating={incorporate.isPending} />
        </ModalShell>
      ) : null}
    </>
  )
}
