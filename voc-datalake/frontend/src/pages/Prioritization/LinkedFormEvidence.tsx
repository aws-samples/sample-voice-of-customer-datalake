/**
 * @fileoverview The ratings collected by the feedback forms that validate a
 * document, shown on that document's prioritization row.
 *
 * Rendered only inside the expanded part of a row. That is the whole cost
 * strategy: `GET /feedback-forms/{id}/stats` scans a brand-wide feedback
 * partition with a filter expression and no index on the submission-to-form
 * link, so it is expensive per call and gets more expensive as the corpus grows.
 * Mounting this component is what triggers the fetch, so a page of 40 rows makes
 * zero stats calls until a reviewer opens one — the sliders and the prototype
 * preview are already expand-only for the same reason.
 *
 * The query key and `staleTime` are shared with `FormCard` through
 * `api/feedbackFormQueryKeys` rather than spelled the same in both places:
 * opening a row after visiting the Feedback Forms page has to reuse the cached
 * payload rather than pay for it twice, and two matching literals would drift
 * without anything failing.
 *
 * This panel only displays evidence. It deliberately does not derive, suggest or
 * pre-fill any score — the reviewer reads it and moves the sliders themselves.
 *
 * @module pages/Prioritization/LinkedFormEvidence
 */

import { useQuery } from '@tanstack/react-query'
import { MessageSquare, QrCode, Star } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { formStatsKey, FORM_STATS_STALE_TIME_MS } from '../../api/feedbackFormQueryKeys'
import FormQrCode from '../../components/FormQrCode'
import ModalShell from '../../components/ModalShell'
import type { LinkedForm } from './formLinkUtils'
import type { ReactElement } from 'react'

/** One metric: a label and either a value or an em dash. */
function EvidenceMetric({
  icon, label, value,
}: {
  readonly icon: ReactElement
  readonly label: string
  readonly value: string
}): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <div className="p-1.5 bg-white rounded border">{icon}</div>
      <div>
        <p className="text-base font-bold text-gray-900">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  )
}

/**
 * The linked form's QR, behind a button rather than inline in the row.
 *
 * A QR needs around 200px before it scans from a few metres, and a pitch looks
 * at one artifact at a time, so one per row would be noise on a page that
 * already reads N+1 projects. The row's resting state — the submission count and
 * the average — is unchanged; opening this is a deliberate act, and `ModalShell`
 * renders nothing at all until it happens.
 *
 * No request is made here: `form` is already in hand from the forms list the
 * page fetched once, and the QR is derived from `form_id` alone.
 *
 * The endpoint arrives as a prop rather than out of the config store, the way
 * `FormCard` already receives it. A store subscription here would make this
 * component re-render for every unrelated config change (time range, date basis,
 * brand) on a page that renders one of these per linked form per row, and it
 * would make the component impossible to render without a store — this file's own
 * tests reach it only through the whole page for exactly that reason.
 */
function LinkedFormQrButton({
  form, apiEndpoint,
}: {
  readonly form: LinkedForm
  readonly apiEndpoint: string
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const [isOpen, setIsOpen] = useState(false)
  // Names the dialog after the heading it already shows, so the accessible name
  // cannot drift from what is on screen. `useId` because a document can have
  // several linked forms, each with its own dialog.
  const headingId = useId()
  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="mt-2 flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700"
      >
        <QrCode size={14} />
        {t('qr.show')}
      </button>
      <ModalShell
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabelledBy={headingId}
        panelClassName="max-w-xs"
      >
        <div className="p-4 space-y-3">
          <h3 id={headingId} className="font-medium text-gray-900 text-center">
            {t('qr.title')}
          </h3>
          <p className="text-sm text-gray-600 text-center truncate">{form.name}</p>
          <FormQrCode apiEndpoint={apiEndpoint} formId={form.form_id} formName={form.name} />
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
            {t('qr.close')}
          </button>
        </div>
      </ModalShell>
    </>
  )
}

/**
 * One linked form's collected ratings.
 *
 * Its own component, so each form owns its own `useQuery` — a hook cannot be
 * called in a loop, and several forms can validate the same document.
 */
function LinkedFormStats({
  form, apiEndpoint,
}: {
  readonly form: LinkedForm
  readonly apiEndpoint: string
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const {
    data, isPending, isError,
  } = useQuery({
    queryKey: formStatsKey(form.form_id),
    queryFn: () => api.getFeedbackFormStats(form.form_id),
    staleTime: FORM_STATS_STALE_TIME_MS,
  })

  const stats = data?.stats
  // A null average is what a ratings-disabled form (or one with only unrated
  // text submissions) actually returns. It must read as "no ratings", never as
  // a score of 0 — a 0 would look like unanimously terrible feedback. Held as
  // the narrowed number (not a boolean) so the render site cannot re-widen it.
  const average = typeof stats?.avg_rating === 'number' ? stats.avg_rating : null

  return (
    <div className="bg-gray-50 rounded-lg border p-3">
      <p className="text-sm font-medium text-gray-800 truncate">{form.name}</p>
      {/* One branch for the failed read and one for everything else, rather than
          three siblings each re-testing isError — that spelling put this
          component over the lint complexity ceiling. */}
      {isError ? (
        <p className="text-xs text-gray-500 mt-1">{t('evidence.unavailable')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <EvidenceMetric
              icon={<MessageSquare size={14} className="text-blue-600" />}
              label={t('evidence.submissions')}
              value={isPending || !stats ? '—' : String(stats.total_submissions)}
            />
            <EvidenceMetric
              icon={<Star size={14} className="text-yellow-600" />}
              label={t('evidence.avgRating')}
              value={average === null ? '—' : average.toFixed(1)}
            />
          </div>
          {!isPending && stats && average === null ? (
            <p className="text-xs text-gray-500 mt-2">{t('evidence.noRatings')}</p>
          ) : null}
          {/* Inside this branch, so a form whose stats read failed offers no QR:
              that is how a deleted form presents here, and its public page is
              gone too, so the QR would send the room to a 404. */}
          <LinkedFormQrButton form={form} apiEndpoint={apiEndpoint} />
        </>
      )}
    </div>
  )
}

/**
 * The collected-evidence panel for one row.
 *
 * @param forms every form that validates this row's document — possibly none,
 *   possibly several.
 * @param apiEndpoint the configured API base, threaded down from the page rather
 *   than read from the store here, so nothing in this file needs one to render.
 */
export default function LinkedFormEvidence({
  forms, apiEndpoint,
}: {
  readonly forms: readonly LinkedForm[]
  readonly apiEndpoint: string
}): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <div className="space-y-2">
      <h4 className="font-medium text-gray-900">{t('evidence.title')}</h4>
      {forms.length === 0 ? (
        <p className="text-sm text-gray-500">{t('evidence.noLinkedForm')}</p>
      ) : (
        <div className="space-y-2">
          {forms.map((form) => (
            <LinkedFormStats key={form.form_id} form={form} apiEndpoint={apiEndpoint} />
          ))}
        </div>
      )}
    </div>
  )
}
