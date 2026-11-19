/**
 * @fileoverview Open text, consent, contact info and statement results (UX §10.2): the latest answers to an open
 * question with their sentiment ("Analysing…" until processed), a search over them and the way to all of them in
 * Responses; how many accepted a consent of those who saw it; how many left contact details (the values only in
 * Responses); a statement has no answer to show.
 *
 * @module pages/FeedbackForms/results/OpenTextResult
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ExternalLink, FlaskConical, Search } from 'lucide-react'
import SentimentBadge from '../../../components/SentimentBadge/SentimentBadge'
import type { QuestionAggregate } from '../../../api/feedbackFormsV2Results'
import { formatCount, formatPercent } from '../../../utils/numberFormat'
import { formatRelativeDate } from '../../../utils/dateUtils'
import { percentOf } from './scoreMath'

const LATEST = 5

export function OpenTextResult({ aggregate, onShowAll }: Readonly<{ aggregate: QuestionAggregate; onShowAll: () => void }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const [search, setSearch] = useState('')
  const needle = search.trim().toLocaleLowerCase(i18n.language)
  const latest = (aggregate.latest ?? []).filter((answer) => needle === '' || answer.text.toLocaleLowerCase(i18n.language).includes(needle)).slice(0, LATEST)
  return (
    <div className="space-y-3">
      {latest.length === 0
        ? <p className="text-sm text-muted">{needle === '' ? t('results.text.none') : t('results.text.noMatch')}</p>
        : (
          <ul className="divide-y divide-border" aria-label={t('results.text.latest')}>
            {latest.map((answer, index) => (
              <li key={answer.feedback_id ?? `${String(index)}-${answer.text}`} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 break-words text-text">{t('logic.values.quoted', { text: answer.text })}</span>
                {answer.is_test === true && <span className="badge badge-info inline-flex items-center gap-1"><FlaskConical size={12} aria-hidden="true" />{t('results.test')}</span>}
                {answer.sentiment == null || answer.sentiment === ''
                  ? <span className="badge badge-muted">{t('results.text.analysing')}</span>
                  : <SentimentBadge sentiment={answer.sentiment} />}
                {answer.submitted_at !== undefined && <span className="text-[12px] text-muted">{formatRelativeDate(answer.submitted_at, i18n.language)}</span>}
                {answer.feedback_id !== undefined && (
                  <Link to={`/feedback/${encodeURIComponent(answer.feedback_id)}`} className="btn btn-ghost btn-sm">
                    {t('results.text.open')}<ExternalLink size={12} aria-hidden="true" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('results.text.search')}</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input type="search" className="input pl-8" placeholder={t('results.text.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onShowAll}>
          {t('results.text.showAll', { count: aggregate.answered })}
        </button>
      </div>
    </div>
  )
}

export function ConsentResult({ aggregate }: Readonly<{ aggregate: QuestionAggregate }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const accepted = aggregate.accepted ?? 0
  const saw = aggregate.answered + aggregate.skipped
  return (
    <p className="text-sm text-text">
      {t('results.consent', {
        accepted: formatCount(accepted, i18n.language), saw: formatCount(saw, i18n.language),
        percent: formatPercent(percentOf(accepted, saw), i18n.language),
      })}
    </p>
  )
}

export function ContactResult({ aggregate }: Readonly<{ aggregate: QuestionAggregate }>) {
  const { t } = useTranslation('feedbackForms')
  const contact = aggregate.contact ?? { left: aggregate.answered, emails: null, phones: null }
  const { emails, phones } = contact
  return (
    <div className="space-y-1">
      <p className="text-sm text-text">{emails === null || phones === null
        ? t('results.contactLeft', { count: contact.left })
        : t('results.contact', { left: contact.left, emails, phones })}</p>
      <p className="text-[12px] text-muted">{t('results.contactHint')}</p>
    </div>
  )
}
