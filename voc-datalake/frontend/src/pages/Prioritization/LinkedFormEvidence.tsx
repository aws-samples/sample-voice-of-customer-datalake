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
 * The query key and `staleTime` match `FormCard`'s (`['form-stats', form_id]`,
 * 30s) on purpose: opening a row after visiting the Feedback Forms page reuses
 * the cached payload rather than paying for it twice.
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
function LinkedFormStats({ form }: { readonly form: LinkedForm }): ReactElement {
  const { t } = useTranslation('prioritization')
  const {
    data, isPending, isError,
  } = useQuery({
    queryKey: ['form-stats', form.form_id],
    queryFn: () => api.getFeedbackFormStats(form.form_id),
    staleTime: 30000,
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
      {isError ? (
        <p className="text-xs text-gray-500 mt-1">{t('evidence.unavailable')}</p>
      ) : (
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
      )}
      {!isError && !isPending && stats && average === null ? (
        <p className="text-xs text-gray-500 mt-2">{t('evidence.noRatings')}</p>
      ) : null}
    </div>
  )
}

/**
 * The collected-evidence panel for one row.
 *
 * @param forms every form that validates this row's document — possibly none,
 *   possibly several.
 */
export default function LinkedFormEvidence({
  forms,
}: {
  readonly forms: readonly LinkedForm[]
}): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <div className="space-y-2">
      <h4 className="font-medium text-gray-900">{t('evidence.title')}</h4>
      {forms.length === 0 ? (
        <p className="text-sm text-gray-500">{t('evidence.noLinkedForm')}</p>
      ) : (
        <div className="space-y-2">
          {forms.map((form) => <LinkedFormStats key={form.form_id} form={form} />)}
        </div>
      )}
    </div>
  )
}
