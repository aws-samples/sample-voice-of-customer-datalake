/**
 * @fileoverview The Test tab's recent test responses (UX §9.1, Keep only): the last 20, newest first, read again
 * every 10 s while the page is visible; each with its day and time ("Today 10:20", "Nov 18, 23:25"), Test, language,
 * ending and hidden values (an empty value
 * reads "—" with a warning mark, so an integrator sees at once what the app did not pass). Open shows the response
 * in the Results sheet; Delete all… removes every test response (D2), offered only to an admin or the form's creator
 * (the owner's decision of 2026-11-18: test responses are kept until one of them deletes them). A delete that fails
 * says so in its dialog (`role="alert"`), which stays open for another try.
 *
 * @module pages/FeedbackForms/tabs/RecentTestResponses
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FlaskConical, Trash2 } from 'lucide-react'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import type { FormResponse } from '../../../api/feedbackFormsV2Results'
import type { TFunction } from 'i18next'
import { isSameDay } from 'date-fns'
import { formatDateTime, formatTime } from '../../../utils/dateUtils'
import { useDraft } from '../builder/formDraftContext'
import type { FormV2 } from '../model/formsV2'
import { endingTitle, hiddenValues } from '../results/answers'
import ResponseSheet from '../results/ResponseSheet'
import { recentTestResponsesKey } from './testToken'

const POLL_MS = 10_000
const RECENT = 20
const ALL_TEST: ResultsFilters = { days: null, language: '', ending: '', hidden: {}, includeTest: true }

/** Whether the page is in view (polling stops while the tab is hidden). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

function HiddenLine({ form, response }: Readonly<{ form: FormV2; response: FormResponse }>) {
  const { t } = useTranslation('feedbackForms')
  const values = hiddenValues(form, response)
  if (values.length === 0) return null
  const empty = values.some((field) => field.value === '')
  return (
    <span className="min-w-0 break-words text-[12px] text-text">
      {values.map((field) => `${field.id}: ${field.value === '' ? '—' : field.value}`).join(' · ')}
      {empty && (
        <span className="ml-2 inline-flex items-center gap-1 text-warn">
          <AlertTriangle size={12} aria-hidden="true" />{t('test.emptyValue')}
        </span>
      )}
    </span>
  )
}

/**
 * When a test response came, with its day, so the order reads across midnight: "Today 10:20", else "Nov 18, 23:25"
 * (the year too when it is not this year), in the reader's locale.
 */
function testResponseTime(t: TFunction<'feedbackForms'>, submittedAt: string, language: string, nowMs: number = Date.now()): string {
  const date = new Date(submittedAt)
  if (submittedAt === '' || Number.isNaN(date.getTime())) return '—'
  if (isSameDay(date, nowMs)) return t('test.todayAt', { time: formatTime(date, language) })
  return formatDateTime(date, language, '—', date.getFullYear() === new Date(nowMs).getFullYear() ? 'short' : 'long')
}

function TestRow({ form, response, onOpen }: Readonly<{ form: FormV2; response: FormResponse; onOpen: () => void }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const time = testResponseTime(t, response.submitted_at, i18n.language)
  return (
    <li className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center">
      <span className="flex flex-wrap items-center gap-2 text-sm text-text">
        <span className="font-mono tabular-nums">{time}</span>
        <span className="badge badge-info inline-flex items-center gap-1"><FlaskConical size={12} aria-hidden="true" />{t('results.test')}</span>
        {response.language !== '' && <span className="badge badge-muted">{response.language}</span>}
        {response.ending_id !== '' && <span className="text-[12px] text-muted">{endingTitle(form, response.ending_id)}</span>}
      </span>
      <span className="min-w-0 flex-1"><HiddenLine form={form} response={response} /></span>
      <button type="button" className="btn btn-secondary btn-sm self-start" onClick={onOpen}
        aria-label={t('test.openResponse', { time })}>{t('test.open')}</button>
    </li>
  )
}

/** The recent test responses, polled while the page is in view, newest first; and Delete all. */
function useRecentTests(formId: string) {
  const visible = usePageVisible()
  const [deleting, setDeleting] = useState(false)
  const query = useQuery({
    queryKey: recentTestResponsesKey(formId),
    queryFn: () => feedbackFormsV2Api.getResponses(formId, ALL_TEST, { limit: RECENT, testOnly: true }),
    refetchInterval: visible ? POLL_MS : false,
  })
  // (newest first, whatever order the server sent)
  const rows = [...(query.data?.responses ?? [])].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
  /** Delete them all; resolves false when the delete failed (the dialog stays open and says so). */
  const deleteAll = async (): Promise<boolean> => {
    setDeleting(true)
    try {
      await feedbackFormsV2Api.deleteTestResponses(formId)
    } catch {
      setDeleting(false)
      return false
    }
    try {
      await query.refetch()
    } finally {
      setDeleting(false)
    }
    return true
  }
  return { query, rows, deleting, deleteAll }
}

function DeleteAll({ disabled, deleting, onDelete }: Readonly<{ disabled: boolean; deleting: boolean; onDelete: () => Promise<boolean> }>) {
  const { t } = useTranslation('feedbackForms')
  const [confirming, setConfirming] = useState(false)
  const [failed, setFailed] = useState(false)
  const confirm = async () => {
    setFailed(false)
    const deleted = await onDelete()
    if (deleted) setConfirming(false)
    else setFailed(true)
  }
  const close = () => {
    setConfirming(false)
    setFailed(false)
  }
  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" disabled={disabled} onClick={() => setConfirming(true)}>
        <Trash2 size={14} aria-hidden="true" />{t('test.deleteAll')}
      </button>
      <ConfirmModal isOpen={confirming} title={t('test.deleteTitle')} message={t('test.deleteMessage')}
        confirmLabel={t('test.deleteConfirm')} variant="danger" isLoading={deleting}
        onConfirm={() => { void confirm() }} onCancel={close}>
        {failed && <p role="alert" className="mt-3 text-[13px] text-danger">{t('test.deleteFailed')}</p>}
      </ConfirmModal>
    </>
  )
}

/** Delete all for an admin or the form's creator; for anyone else, who can (once there is something to delete). */
function DeleteControl({ allowed, count, deleting, onDelete }: Readonly<{
  allowed: boolean; count: number; deleting: boolean; onDelete: () => Promise<boolean>
}>) {
  const { t } = useTranslation('feedbackForms')
  if (allowed) return <DeleteAll disabled={count === 0} deleting={deleting} onDelete={onDelete} />
  return count > 0 ? <span>{t('test.keptUntilDeleted')}</span> : null
}

export default function RecentTestResponses({ formId }: Readonly<{ formId: string }>) {
  const { t } = useTranslation('feedbackForms')
  const { form, meta } = useDraft()
  const { query, rows, deleting, deleteAll } = useRecentTests(formId)
  const [open, setOpen] = useState<number | null>(null)
  const at = (index: number) => (index >= 0 && index < rows.length ? () => setOpen(index) : undefined)
  return (
    <section className="card space-y-3" aria-labelledby="recent-tests-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="recent-tests-heading" className="text-base font-semibold tracking-tight text-text-strong">{t('test.recentTitle')}</h2>
        <span className="flex items-center gap-2 text-[12px] text-muted">
          {t('test.refreshes')}
          <DeleteControl allowed={meta?.can_delete_test_responses === true} count={rows.length} deleting={deleting} onDelete={deleteAll} />
        </span>
      </div>
      {query.isError && query.data === undefined && <LoadFailed onRetry={() => { void query.refetch() }} retrying={query.isFetching} />}
      {query.isSuccess && rows.length === 0 && <p className="text-sm text-muted">{t('test.noneYet')}</p>}
      {rows.length > 0 && (
        <ul className="divide-y divide-border" aria-label={t('test.recentTitle')}>
          {rows.map((response, index) => <TestRow key={response.response_id} form={form} response={response} onOpen={() => setOpen(index)} />)}
        </ul>
      )}
      <ResponseSheet form={form} response={open === null ? null : rows[open] ?? null} onClose={() => setOpen(null)}
        onPrevious={open === null ? undefined : at(open - 1)} onNext={open === null ? undefined : at(open + 1)} />
    </section>
  )
}
