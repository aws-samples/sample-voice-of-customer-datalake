/**
 * @fileoverview A QR code of a form address in a dialog (the live link, or the test link with its token, UX §9.1):
 * the one QR the app draws (`components/FormQrCode/QrPanel`), under its heading. `QrButton` is the trigger beside an
 * address; the forms list card opens the dialog from its ⋯ menu.
 *
 * @module pages/FeedbackForms/tabs/QrDialog
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QrCode } from 'lucide-react'
import ModalShell from '../../../components/ModalShell/ModalShell'
import QrPanel from '../../../components/FormQrCode/QrPanel'

export interface QrDialogProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  /** The address the symbol encodes; null: none (said in words). */
  readonly url: string | null
  /** The dialog's heading ("QR code", "Test link QR code"). */
  readonly title: string
  readonly formName: string
}

export function QrDialog({ isOpen, onClose, url, title, formName }: QrDialogProps) {
  const { t } = useTranslation('components')
  const headingId = useId()
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} ariaLabelledBy={headingId} panelClassName="max-w-md">
      <div className="space-y-3 p-4">
        <h3 id={headingId} className="text-center font-semibold tracking-tight text-text-strong">{title}</h3>
        <p className="truncate text-center text-sm text-text">{formName}</p>
        <QrPanel url={url} title={t('formQrCode.accessibleName', { formName })}
          unavailable={<p className="text-sm text-muted">{t('formQrCode.unavailable')}</p>}>
          <p className="text-[12px] text-muted">{t('formQrCode.caption')}</p>
        </QrPanel>
        <button type="button" onClick={onClose} className="btn btn-secondary w-full">{t('formQrCode.close')}</button>
      </div>
    </ModalShell>
  )
}

/** The QR trigger beside an address, and its dialog. */
export function QrButton({ url, title, formName }: Readonly<{ url: string | null; title: string; formName: string }>) {
  const { t } = useTranslation('feedbackForms')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <QrCode size={14} aria-hidden="true" />{t('share.qr')}
      </button>
      <QrDialog isOpen={open} onClose={() => setOpen(false)} url={url} title={title} formName={formName} />
    </>
  )
}
