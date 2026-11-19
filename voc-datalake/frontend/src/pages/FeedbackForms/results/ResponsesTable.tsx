/**
 * @fileoverview Results › Responses (UX §10.4): the responses under the filters, newest first, 50 at a time with Load
 * more; each row's time, a summary of its answers, Test on a test response, its language, ending and hidden values,
 * and › to open it in the side sheet (`/results/responses/<id>`, so Back closes it). Below md each response is a card
 * (time · ending · language, then its first answers): the 40rem table pushed a 390 px page to 649 px (WCAG 1.4.10).
 *
 * @module pages/FeedbackForms/results/ResponsesTable
 */
import { useTranslation } from 'react-i18next'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronRight, FlaskConical, Inbox } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import Notice from '../../../components/Notice/Notice'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import type { FormResponse } from '../../../api/feedbackFormsV2Results'
import { formatDateTime } from '../../../utils/dateUtils'
import type { FormV2 } from '../model/formsV2'
import { endingTitle, hiddenValues, responseSummary } from './answers'
import ResponseSheet from './ResponseSheet'

const PAGE = 50

const responsesKey = (formId: string, filters: ResultsFilters) => ['feedback-forms', formId, 'responses', filters] as const
/** The first page has no cursor. */
const FIRST_PAGE: string | null = null

function Row({ form, response, onOpen }: Readonly<{ form: FormV2; response: FormResponse; onOpen: () => void }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const time = formatDateTime(response.submitted_at, i18n.language, '—', 'short')
  const hidden = hiddenValues(form, response).filter((field) => field.value !== '').map((field) => `${field.id} ${field.value}`).join(' · ')
  const open = t('results.responses.open', { time })
  return (
    <tr className="border-b border-border last:border-0">
      <td className="whitespace-nowrap py-2 pr-3 text-[12px] tabular-nums text-text">{time}</td>
      <td className="max-w-[24rem] py-2 pr-3 text-sm text-text">
        <span className="flex items-center gap-2">
          <TruncatedText as="span" className="line-clamp-2 min-w-0" text={responseSummary(t, form, response)} />
          {response.is_test && <span className="badge badge-info inline-flex flex-shrink-0 items-center gap-1"><FlaskConical size={12} aria-hidden="true" />{t('results.test')}</span>}
        </span>
      </td>
      <td className="py-2 pr-3 text-[12px] text-text">{response.language === '' ? '—' : response.language}</td>
      <td className="py-2 pr-3 text-[12px] text-text">{response.ending_id === '' ? '—' : endingTitle(form, response.ending_id)}</td>
      <td className="py-2 pr-3 text-[12px] text-muted break-all">{hidden === '' ? '—' : hidden}</td>
      <td className="py-2 text-right">
        <Tooltip kind="label" content={open}>
          <button type="button" className="icon-btn" aria-label={open} onClick={onOpen}><ChevronRight size={16} aria-hidden="true" /></button>
        </Tooltip>
      </td>
    </tr>
  )
}

/** Below md, one response as a card: time · ending · language, then the first answers and the hidden values. */
function ResponseCard({ form, response, onOpen }: Readonly<{ form: FormV2; response: FormResponse; onOpen: () => void }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const time = formatDateTime(response.submitted_at, i18n.language, '—', 'short')
  const hidden = hiddenValues(form, response).filter((field) => field.value !== '').map((field) => `${field.id} ${field.value}`).join(' · ')
  const open = t('results.responses.open', { time })
  const meta = [time, response.ending_id === '' ? '' : endingTitle(form, response.ending_id), response.language].filter((part) => part !== '')
  return (
    <li className="card space-y-1.5 p-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words text-[12px] tabular-nums text-muted">{meta.join(' · ')}</p>
        {response.is_test && <span className="badge badge-info inline-flex flex-shrink-0 items-center gap-1"><FlaskConical size={12} aria-hidden="true" />{t('results.test')}</span>}
        <Tooltip kind="label" content={open}>
          <button type="button" className="icon-btn -my-1 flex-shrink-0" aria-label={open} onClick={onOpen}><ChevronRight size={16} aria-hidden="true" /></button>
        </Tooltip>
      </div>
      <p className="line-clamp-3 break-words text-sm text-text">{responseSummary(t, form, response)}</p>
      {hidden !== '' && <p className="break-all text-[12px] text-muted">{hidden}</p>}
    </li>
  )
}

export default function ResponsesTable({ form, formId, filters, openId, onOpen, onClose }: Readonly<{
  form: FormV2
  formId: string
  filters: ResultsFilters
  /** The response open in the sheet (from the path), or null. */
  openId: string | null
  onOpen: (responseId: string) => void
  onClose: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const query = useInfiniteQuery({
    queryKey: responsesKey(formId, filters),
    queryFn: ({ pageParam }) => feedbackFormsV2Api.getResponses(formId, filters, { limit: PAGE, ...(pageParam === null ? {} : { cursor: pageParam }) }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.next_cursor,
  })
  if (query.isError && query.data === undefined) return <LoadFailed onRetry={() => { void query.refetch() }} retrying={query.isFetching} />
  if (query.data === undefined) return <p role="status" className="text-sm text-muted">{t('results.loading')}</p>
  const rows = query.data.pages.flatMap((page) => page.responses)
  if (rows.length === 0) return <Notice variant="empty" icon={Inbox} title={t('results.responses.title')} text={t('results.responses.none')} />
  const at = rows.findIndex((response) => response.response_id === openId)
  const neighbour = (index: number) => {
    const target = rows[index]
    return target === undefined ? undefined : () => onOpen(target.response_id)
  }
  // Below md each response is a card; from md the table (its 40rem scrolls inside its card, never the page).
  return (
    <div className="min-w-0 space-y-3">
      <ul className="space-y-2 md:hidden" aria-label={t('results.responses.caption')}>
        {rows.map((response) => <ResponseCard key={response.response_id} form={form} response={response} onOpen={() => onOpen(response.response_id)} />)}
      </ul>
      <div className="card hidden min-w-0 overflow-x-auto md:block">
        <table className="w-full min-w-[40rem] text-left">
          <caption className="sr-only">{t('results.responses.caption')}</caption>
          <thead>
            <tr className="border-b border-border text-[11px] font-semibold uppercase tracking-[.04em] text-muted-strong">
              <th scope="col" className="py-2 pr-3">{t('results.responses.time')}</th>
              <th scope="col" className="py-2 pr-3">{t('results.responses.answers')}</th>
              <th scope="col" className="py-2 pr-3">{t('results.responses.language')}</th>
              <th scope="col" className="py-2 pr-3">{t('results.responses.ending')}</th>
              <th scope="col" className="py-2 pr-3">{t('results.responses.hidden')}</th>
              <th scope="col" className="py-2"><span className="sr-only">{t('results.responses.openColumn')}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((response) => <Row key={response.response_id} form={form} response={response} onOpen={() => onOpen(response.response_id)} />)}
          </tbody>
        </table>
      </div>
      {query.hasNextPage && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage() }}>
          {t('results.responses.more')}
        </button>
      )}
      <ResponseSheet form={form} response={at === -1 ? null : rows[at] ?? null} onClose={onClose}
        onPrevious={neighbour(at - 1)} onNext={at === -1 ? undefined : neighbour(at + 1)} />
    </div>
  )
}
