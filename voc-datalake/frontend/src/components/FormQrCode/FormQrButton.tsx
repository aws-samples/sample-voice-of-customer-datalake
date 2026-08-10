/**
 * @fileoverview A "Show QR code" trigger that opens one feedback form's QR in a
 * dialog.
 *
 * Extracted from the Prioritization row (where it was `LinkedFormQrButton`)
 * because a second surface — the Feedback Forms card — now needs the identical
 * behaviour. Same move, and for the same reason, as `PrototypeRenderer`: two
 * pages wanting one artifact is a component, not a copy. Every property below
 * that matters is a property of the *trigger*, so duplicating it would mean
 * duplicating the accessibility too, and the copy would be the one that rots.
 *
 * Behind a button rather than inline. A QR needs around 200px before it scans
 * from a few metres, and a room looks at one artifact at a time, so an
 * always-visible QR is noise on a page that lists many forms — and `ModalShell`
 * renders nothing at all until it is asked for. On the Feedback Forms card this
 * also replaces a QR that was only reachable by expanding "Show Embed Code", a
 * developer-facing disclosure about iframe snippets: a facilitator wanting a QR
 * for a room had no reason to look there.
 *
 * No request is made here. The caller already holds the form, and the QR is
 * derived from `formId` alone, so opening the dialog costs nothing.
 *
 * The endpoint arrives as a prop rather than out of the config store, the way
 * `FormCard` already receives it. A store subscription here would make this
 * component re-render for every unrelated config change (time range, date basis,
 * brand) on pages that render one of these per form, and it would make the
 * component impossible to render without a store.
 *
 * @module components/FormQrCode/FormQrButton
 */
import clsx from 'clsx'
import { QrCode } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import FormQrCode from './FormQrCode'
import ModalShell from '../ModalShell'
import type { ReactElement } from 'react'

/**
 * The trigger, and the dialog it opens.
 *
 * @param apiEndpoint the configured API base. An endpoint that cannot address the
 *   form is not this component's problem to detect — `FormQrCode` reports it
 *   inside the dialog, which is the only place a viewer can be told that the
 *   symbol they were about to point a room at resolves nowhere.
 * @param formId the form whose public page the QR opens.
 * @param formName shown in the dialog under the heading, and used by `FormQrCode`
 *   to name the QR for assistive technology.
 * @param className sizing and spacing for the trigger, supplied by the caller
 *   because the two consumers sit in differently-scaled type. Deliberately no
 *   size in the base classes, so a caller's `text-sm` cannot end up fighting a
 *   built-in `text-xs` with the winner decided by stylesheet order.
 */
export default function FormQrButton({
  apiEndpoint, formId, formName, className,
}: {
  readonly apiEndpoint: string
  readonly formId: string
  readonly formName: string
  readonly className?: string
}): ReactElement {
  const { t } = useTranslation('components')
  const [isOpen, setIsOpen] = useState(false)
  // Names the dialog after the heading it already shows, so the accessible name
  // cannot drift from what is on screen. `useId` because one page can render
  // several of these — a form card per form, or several linked forms on a row —
  // each with its own dialog.
  const headingId = useId()
  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={clsx('inline-flex items-center gap-1.5 text-blue-600 hover:text-blue-700', className)}
      >
        <QrCode size={14} />
        {t('formQrCode.show')}
      </button>
      <ModalShell
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabelledBy={headingId}
        panelClassName="max-w-xs"
      >
        <div className="p-4 space-y-3">
          <h3 id={headingId} className="font-medium text-gray-900 text-center">
            {t('formQrCode.title')}
          </h3>
          <p className="text-sm text-gray-600 text-center truncate">{formName}</p>
          <FormQrCode apiEndpoint={apiEndpoint} formId={formId} formName={formName} />
          {/* Not a duplicate of anything the shell provides: `ModalShell` renders
              the overlay, the panel and these children, and nothing else — its
              own dismissal affordances are Escape and an overlay click, neither
              of which is visible. This is also the panel's first focusable, so it
              is where the shell puts focus on open. */}
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="w-full px-3 py-2 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
          >
            {t('formQrCode.close')}
          </button>
        </div>
      </ModalShell>
    </>
  )
}
