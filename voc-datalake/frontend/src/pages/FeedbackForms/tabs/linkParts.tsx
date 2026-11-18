/**
 * @fileoverview The parts the Test and Share tabs show a form address with (UX §9): the address in a read-only mono
 * field with Copy (it announces "Copied") and QR, and the new-form state ("Save the form to get its links.").
 *
 * @module pages/FeedbackForms/tabs/linkParts
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Link2, Save } from 'lucide-react'
import Notice from '../../../components/Notice/Notice'
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard'
import { useDraft } from '../builder/formDraftContext'
import { QrButton } from './QrDialog'

/** An address in a read-only mono field, with Copy, QR and the caller's own actions after them. */
export function LinkField({ label, url, qrTitle, formName, hint, children }: Readonly<{
  label: string
  url: string | null
  qrTitle: string
  formName: string
  hint?: ReactNode
  children?: ReactNode
}>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const { copy, copiedKey } = useCopyToClipboard()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-text">{label}</label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input id={id} readOnly value={url ?? ''} aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          className="input min-w-0 flex-1 font-mono text-[12px]" onFocus={(event) => event.target.select()} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" disabled={url === null} onClick={() => { if (url !== null) copy(url, 'link') }}>
            {copiedKey === 'link' ? <Check size={14} className="text-ok" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copiedKey === 'link' ? t('share.copied') : t('share.copy')}
          </button>
          <QrButton url={url} title={qrTitle} formName={formName} />
          {children}
        </div>
      </div>
      <span role="status" className="sr-only">{copiedKey === 'link' ? t('share.copied') : ''}</span>
      {hint !== undefined && <p id={`${id}-hint`} className="text-[12px] text-muted">{hint}</p>}
    </div>
  )
}

/** A new form has no address yet: "Save the form to get its links." with Save (UX §13.4). */
export function SaveFirstNotice() {
  const { t } = useTranslation('feedbackForms')
  const { save, status, errors } = useDraft()
  return (
    <Notice variant="empty" icon={Link2} title={t('share.saveFirstTitle')} text={t('share.saveFirst')}
      action={{ label: t('share.save'), icon: Save, emphasis: 'primary', busy: status.kind === 'saving', disabled: errors.length > 0,
        onClick: () => { void save() } }} />
  )
}
