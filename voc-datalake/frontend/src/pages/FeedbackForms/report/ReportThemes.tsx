/**
 * @fileoverview The Report's themes (7.63.00), deterministic: per open-text question, its answers grouped by the
 * category and subcategory the processing gave each response, with the sentiment mix and two or three real quotes,
 * each opening its response.
 *
 * @module pages/FeedbackForms/report/ReportThemes
 */
import { useTranslation } from 'react-i18next'
import { Quote } from 'lucide-react'
import type { QuestionThemes, ReportTheme } from '../../../api/feedbackFormsReport'
import { formatCount } from '../../../utils/numberFormat'
import { humanizeId } from '../../../utils/displayLabels'
import type { FormV2 } from '../model/formsV2'
import { useBuilderUi } from '../builder/builderUi'
import { questionHeadline } from './reportLabels'

const SENTIMENT_ORDER = ['positive', 'neutral', 'mixed', 'negative', 'unknown'] as const

function ThemeItem({ theme }: Readonly<{ theme: ReportTheme }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const { go } = useBuilderUi()
  const name = theme.category === '' ? t('report.themes.unprocessed')
    : [theme.category, theme.subcategory].filter((part) => part !== '').map(humanizeId).join(' · ')
  return (
    <li className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-text-strong">{name}</span>
        <span className="text-[12px] tabular-nums text-muted">{t('report.themes.answers', { count: theme.count, formatted: formatCount(theme.count, i18n.language) })}</span>
        {SENTIMENT_ORDER.filter((label) => (theme.sentiment[label] ?? 0) > 0).map((label) => (
          <span key={label} className="badge badge-muted tabular-nums">{t(`report.sentiment.${label}`)} {theme.sentiment[label]}</span>
        ))}
      </div>
      <ul className="space-y-1">
        {theme.quotes.map((quote) => (
          <li key={quote.response_id}>
            <button type="button" className="flex w-full items-start gap-2 rounded-md p-1 text-left text-[13px] text-text hover:bg-bg-hover focus-ring"
              onClick={() => go('results', ['responses', quote.response_id])} aria-label={t('report.themes.openQuote', { text: quote.text })}>
              <Quote size={12} className="mt-1 shrink-0 text-muted" aria-hidden="true" />
              <q className="min-w-0 break-words">{quote.text}</q>
            </button>
          </li>
        ))}
      </ul>
    </li>
  )
}

export default function ReportThemes({ form, themes }: Readonly<{ form: FormV2; themes: readonly QuestionThemes[] }>) {
  const { t } = useTranslation('feedbackForms')
  const answered = themes.filter((entry) => entry.answered > 0)
  if (answered.length === 0) return <p className="text-sm text-muted">{t('report.themes.none')}</p>
  return (
    <div className="space-y-4">
      {answered.map((entry) => (
        <section key={entry.question_id} className="card space-y-3" aria-labelledby={`themes-${entry.question_id}`}>
          <h3 id={`themes-${entry.question_id}`} className="text-sm font-semibold tracking-tight text-text-strong">{questionHeadline(form, entry.question_id)}</h3>
          <ul className="space-y-3">{entry.themes.map((theme) => <ThemeItem key={`${theme.category}#${theme.subcategory}`} theme={theme} />)}</ul>
        </section>
      ))}
    </div>
  )
}
