/**
 * @fileoverview The parts the Test and Share tabs show a form address with (UX §9): the address in a read-only mono
 * field with Copy (it announces "Copied") and QR, and the new-form state ("Save the form to get its links.", with why
 * Save is off while problems block it).
 *
 * @module pages/FeedbackForms/tabs/linkParts
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Check, Copy, Link2, Loader2, Save } from 'lucide-react'
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard'
import { useBuilderUi } from '../builder/builderUi'
import { useDraft } from '../builder/formDraftContext'
import { goToProblem, openProblemsList } from '../builder/problemText'
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

/**
 * Why Save is off while problems block it, as words under the button: "Fix 1 problem to save. Go to" (Go to selects
 * that problem), or "Fix 3 problems to save. Show problems" (opens the header's list, where each has its Go to).
 * `id` is on the reason alone, for the button's `aria-describedby`. Nothing while the form can be saved.
 */
export function SaveBlockedReason({ id, className }: Readonly<{ id: string; className?: string }>) {
  const { t } = useTranslation('feedbackForms')
  const { errors } = useDraft()
  const ui = useBuilderUi()
  const [only] = errors
  if (only === undefined) return null
  const single = errors.length === 1
  return (
    <p className={clsx('text-[13px] text-text', className)}>
      <span id={id}>{t('builder.save.fixToSave', { count: errors.length })}</span>{' '}
      <button type="button" className="link" onClick={() => { if (single) goToProblem(ui, only.at); else openProblemsList() }}>
        {single ? t('problems.goTo') : t('share.showProblems')}
      </button>
    </p>
  )
}

/**
 * A new form has no address yet: "Save the form to get its links." with Save (UX §13.4). While problems block Save,
 * the button stays focusable (`aria-disabled`) and the reason, with the way to it, is under it (F27).
 */
export function SaveFirstNotice() {
  const { t } = useTranslation('feedbackForms')
  const { save, status, errors } = useDraft()
  const reasonId = useId()
  const busy = status.kind === 'saving'
  const blocked = errors.length > 0
  return (
    <div className="card py-12 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-accent-subtle">
        <Link2 size={20} className="text-accent-text" aria-hidden="true" />
      </div>
      <h2 className="mb-1 text-base font-semibold tracking-tight text-text-strong">{t('share.saveFirstTitle')}</h2>
      <p className="mb-4 px-4 text-sm text-muted">{t('share.saveFirst')}</p>
      <button type="button" className="btn btn-primary justify-center" aria-disabled={blocked || busy}
        aria-describedby={blocked ? reasonId : undefined} onClick={() => { if (!blocked && !busy) void save() }}>
        {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
        {t('share.save')}
      </button>
      <SaveBlockedReason id={reasonId} className="mt-3 px-4" />
    </div>
  )
}
