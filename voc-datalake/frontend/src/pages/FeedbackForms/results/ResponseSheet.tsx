/**
 * @fileoverview One response in a dialog (UX §10.4): every answer in form order with its question
 * (a skipped question and one the respondent's path never showed are listed as such), the hidden values, the
 * language, the ending, the time and the form revision it was answered on, and Open in Feedback. Previous and Next
 * walk the list it was opened from. The Test tab opens its test responses in the same sheet.
 *
 * @module pages/FeedbackForms/results/ResponseSheet
 */
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, ExternalLink, FlaskConical, MessageSquareText } from 'lucide-react'
import { Link } from 'react-router-dom'
import FormDialog from '../ui/FormDialog'
import type { FormResponse } from '../../../api/feedbackFormsV2Results'
import { formatDateTime } from '../../../utils/dateUtils'
import type { FormV2 } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { answerText, endingTitle, hiddenValues } from './answers'

function AnswerList({ form, response }: Readonly<{ form: FormV2; response: FormResponse }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <ol className="space-y-3" aria-label={t('results.sheet.answers')}>
      {form.questions.filter((q) => q.type !== 'statement').map((question, index) => {
        const value = response.answers[question.id]
        return (
          <li key={question.id} className="space-y-0.5">
            <p className="text-[12px] text-muted">{t('results.sheet.question', { number: index + 1, headline: textIn(question.headline, form.language) })}</p>
            {value === undefined
              ? <p className="text-sm italic text-muted">{t('results.sheet.notAnswered')}</p>
              : <p className="text-sm text-text-strong break-words">{answerText(t, form, question, value)}</p>}
          </li>
        )
      })}
    </ol>
  )
}

function Details({ form, response }: Readonly<{ form: FormV2; response: FormResponse }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const hidden = hiddenValues(form, response)
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted">{t('results.sheet.time')}</dt><dd className="text-text">{formatDateTime(response.submitted_at, i18n.language, '—')}</dd>
      <dt className="text-muted">{t('results.sheet.language')}</dt><dd className="text-text">{response.language === '' ? '—' : response.language}</dd>
      <dt className="text-muted">{t('results.sheet.ending')}</dt><dd className="text-text">{response.ending_id === '' ? '—' : endingTitle(form, response.ending_id)}</dd>
      {response.form_revision !== null && (
        <><dt className="text-muted">{t('results.sheet.revisionLabel')}</dt><dd className="text-text">{t('results.sheet.revision', { number: response.form_revision })}</dd></>
      )}
      {hidden.map((field) => (
        <div key={field.id} className="contents">
          <dt className="font-mono text-[12px] text-muted">{field.id}</dt>
          <dd className="text-text break-all">{field.value === '' ? '—' : field.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export interface ResponseSheetProps {
  readonly form: FormV2
  readonly response: FormResponse | null
  readonly onClose: () => void
  /** Open the previous / next response of the list (absent: none). */
  readonly onPrevious?: () => void
  readonly onNext?: () => void
}

export default function ResponseSheet({ form, response, onClose, onPrevious, onNext }: ResponseSheetProps) {
  const { t, i18n } = useTranslation('feedbackForms')
  if (response === null) return null
  const footer = (
    <>
      <div className="flex gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={onPrevious === undefined} onClick={onPrevious}>
          <ChevronLeft size={14} aria-hidden="true" />{t('results.sheet.previous')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={onNext === undefined} onClick={onNext}>
          {t('results.sheet.next')}<ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      {response.feedback_id !== undefined && (
        <Link to={`/feedback/${encodeURIComponent(response.feedback_id)}`} className="btn btn-secondary btn-sm">
          {t('results.openInFeedback')}<ExternalLink size={14} aria-hidden="true" />
        </Link>
      )}
    </>
  )
  return (
    <FormDialog isOpen onClose={onClose} icon={MessageSquareText} footer={footer}
      title={t('results.sheet.title', { time: formatDateTime(response.submitted_at, i18n.language, '—', 'short') })}
      description={response.is_test ? <span className="badge badge-info inline-flex items-center gap-1"><FlaskConical size={12} aria-hidden="true" />{t('results.test')}</span> : undefined}>
      <AnswerList form={form} response={response} />
      <Details form={form} response={response} />
    </FormDialog>
  )
}
