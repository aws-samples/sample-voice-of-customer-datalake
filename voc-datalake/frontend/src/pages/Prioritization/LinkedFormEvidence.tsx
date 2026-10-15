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
 * WHAT ONE EXPANSION COSTS, now that a row holds a SET of documents: one stats read
 * per LINKED FORM across every document the row holds, not one per row. Evidence
 * belongs to the document a form validates, so a row of a PRD and a PR/FAQ with two
 * forms each opens four — and a form whose stored document id names nothing live falls
 * back to the whole project, so it appears under each of the row's documents and is
 * read once per panel (the key is shared, so the cache collapses those to one call,
 * but that is a cache and not a bound).
 *
 * The bound is therefore `MAX_ROW_DOCUMENT_IDS` (25) × the forms linked to those
 * documents, per expansion, paid only when a reviewer opens the row. That is the same
 * shape as before — expand-only, one read per panel on screen — with the multiplier a
 * row's composition now carries. Should a project appear with dozens of forms per
 * document, the fix is per-document lazy disclosure inside the expansion rather than
 * moving these reads back onto the page load.
 *
 * This panel only displays evidence. It deliberately does not derive, suggest or
 * pre-fill any score — the reviewer reads it and moves the sliders themselves.
 *
 * @module pages/Prioritization/LinkedFormEvidence
 */

import { useQuery } from '@tanstack/react-query'
import { MessageSquare, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { formStatsKey, FORM_STATS_STALE_TIME_MS } from '../../api/feedbackFormQueryKeys'
import FormQrButton from '../../components/FormQrCode/FormQrButton'
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
              gone too, so the QR would send the room to a 404.

              The same trigger the Feedback Forms card uses — see
              components/FormQrCode/FormQrButton. */}
          <FormQrButton
            apiEndpoint={apiEndpoint}
            formId={form.form_id}
            formName={form.name}
            className="mt-2 text-xs"
          />
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
