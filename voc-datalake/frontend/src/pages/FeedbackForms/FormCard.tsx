/**
 * @fileoverview One form on the Feedback Forms list (UX §14.2): its name (a link to the form; the builder opens it on
 * Results when it is Live with responses, else on Questions), the Live / Off switch, "Test link on", a summary line
 * (its questions and languages), its responses and the headline figure of its first measuring question, then
 * Results and ⋯ (Edit · Copy link · QR code · Preview · Duplicate · Delete…).
 *
 * The card reads the record as v2 (a v1 record is read migrated). Turning on a form with problems is refused in words
 * with a way to fix them. Preview is the full-screen preview that never submits: the old Preview link counted (F4).
 * Every figure excludes test responses (the list's stats do).
 *
 * @module pages/FeedbackForms/FormCard
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { BarChart3, Copy, Eye, FlaskConical, Pencil, QrCode, Trash2, CopyPlus } from 'lucide-react'
import type { FeedbackForm } from '../../api/types'
import { api } from '../../api/client'
import { formStatsKey, FORM_STATS_STALE_TIME_MS } from '../../api/feedbackFormQueryKeys'
import { feedbackFormPublicUrl } from '../../api/feedbackFormUrls'
import { parseStoredForm } from '../../api/feedbackFormsV2Api'
import type { FormStats } from '../../api/feedbackFormStatsSchema'
import Switch from '../../components/Switch/Switch'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { languageNames } from '../../i18n/languages'
import { formatCount, formatDecimal } from '../../utils/numberFormat'
import type { FormV2 } from './model/formsV2'
import { isScale } from './model/formsV2'
import { blockingProblems, validateForm } from './model/validateForm'
import { builderPath, formPreviewPath } from './builder/builderPaths'
import { handoffState } from './builder/newFormHandoff'
import ActionsMenu from './ui/ActionsMenu'
import { QrDialog } from './tabs/QrDialog'

/** What a card is told besides its form; FormsList passes it through to every card. */
export interface FormCardHandlers {
  readonly onDelete: (formId: string) => void
  readonly onToggle: (formId: string, enabled: boolean) => void
  readonly apiEndpoint: string
  /** The page is re-reading the list and every card's stats. */
  readonly statsRefreshing: boolean
}

interface FormCardProps extends FormCardHandlers {
  readonly form: FeedbackForm
}

/** "Average 4.1 of 5" for a first measuring question that is a rating, when the stats have its average. */
function HeadlineFigure({ form, stats }: Readonly<{ form: FormV2 | null; stats: FormStats | null | undefined }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const first = form?.questions.find(isScale)
  if (first?.type !== 'rating' || typeof stats?.avg_rating !== 'number') return null
  return <span className="badge badge-muted">{t('card.average', { average: formatDecimal(stats.avg_rating, i18n.language, 1), max: first.range })}</span>
}

function Summary({ form }: Readonly<{ form: FormV2 | null }>) {
  const { t } = useTranslation('feedbackForms')
  if (form === null) return null
  const languages = form.languages.map((language) => languageNames[language]).join(', ')
  return <p className="text-sm text-muted">{t('card.summary', { count: form.questions.length, languages })}</p>
}

function ResponsesLine({ stats, busy }: Readonly<{ stats: FormStats | null | undefined; busy: boolean }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  // (never a stale or invented count while the figures are read: a placeholder, then the count or nothing)
  if (busy) {
    return <p aria-busy="true" className="text-sm text-muted"><span className="skeleton inline-block h-4 w-24 align-middle" aria-hidden="true" /><span className="sr-only">{t('card.reading')}</span></p>
  }
  if (stats == null) return null
  const count = stats.total_submissions
  return <p className="text-sm text-text tabular-nums">{t('card.responses', { count, formatted: formatCount(count, i18n.language) })}</p>
}

/** The refusal to turn on a form with problems, in words, with the way to them. */
function PublishRefusal({ formId, count }: Readonly<{ formId: string; count: number }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <p role="alert" className="text-[12px] text-danger">
      {t('card.fixFirst', { count })}{' '}
      <Link to={builderPath(formId, 'questions')} className="link">{t('card.open')}</Link>
    </p>
  )
}

function useCardActions(record: FeedbackForm, form: FormV2 | null, publicUrl: string | null, openQr: () => void, onDelete: (id: string) => void) {
  const { t } = useTranslation('feedbackForms')
  const navigate = useNavigate()
  const { copy } = useCopyToClipboard()
  const id = record.form_id
  return [
    { label: t('card.edit'), icon: Pencil, onSelect: () => { void navigate(builderPath(id, 'questions')) } },
    { label: t('card.copyLink'), icon: Copy, disabledReason: publicUrl === null ? t('configureApiFirst') : undefined, onSelect: () => { if (publicUrl !== null) copy(publicUrl, 'link') } },
    { label: t('card.qr'), icon: QrCode, onSelect: openQr },
    { label: t('card.preview'), icon: Eye, onSelect: () => { void navigate(formPreviewPath(id)) } },
    {
      label: t('card.duplicate'), icon: CopyPlus, disabledReason: form === null ? t('card.cannotRead') : undefined,
      onSelect: () => {
        if (form === null) return
        const copyForm: FormV2 = { ...form, name: t('card.copyName', { name: form.name }), enabled: false }
        void navigate(builderPath(null, 'questions'), { state: handoffState({ form: copyForm, templateId: null, ai: null }) })
      },
    },
    null,
    { label: t('card.delete'), icon: Trash2, danger: true, onSelect: () => onDelete(id) },
  ]
}

export default function FormCard({ form: record, onDelete, onToggle, apiEndpoint, statsRefreshing }: FormCardProps) {
  const { t } = useTranslation('feedbackForms')
  const [qrOpen, setQrOpen] = useState(false)
  const [refused, setRefused] = useState(0)
  const form = parseStoredForm(record)?.form ?? null
  const publicUrl = feedbackFormPublicUrl(apiEndpoint, record.form_id)
  const items = useCardActions(record, form, publicUrl, () => setQrOpen(true), onDelete)
  const { data: statsData, isFetching: statsFetching } = useQuery({
    queryKey: formStatsKey(record.form_id),
    queryFn: () => api.getFeedbackFormStats(record.form_id),
    staleTime: FORM_STATS_STALE_TIME_MS,
  })
  const toggle = (on: boolean) => {
    const errors = on && form !== null ? blockingProblems(validateForm(form)).length : 0
    setRefused(errors)
    if (errors === 0) onToggle(record.form_id, on)
  }
  const name = record.name.trim() === '' ? t('card.unnamed') : record.name
  return (
    <div className="card space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 break-words text-base font-semibold tracking-tight text-text-strong">
              <Link to={`/feedback-forms/${encodeURIComponent(record.form_id)}`} className="link">{name}</Link>
            </h3>
            {record.form_type === 'prototype_pin' && <span className="badge badge-muted">{t('card.prototypePins')}</span>}
            {form?.settings.test.link_enabled === true && (
              <span className="badge badge-info inline-flex items-center gap-1"><FlaskConical size={12} aria-hidden="true" />{t('card.testLinkOn')}</span>
            )}
            <HeadlineFigure form={form} stats={statsData?.stats} />
          </div>
          <Summary form={form} />
          <ResponsesLine stats={statsData?.stats} busy={statsFetching || statsRefreshing} />
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Switch label={record.enabled ? t('card.live') : t('card.off')} checked={record.enabled} onChange={toggle} disabled={false} />
          <Link to={builderPath(record.form_id, 'results')} className="btn btn-secondary btn-sm">
            <BarChart3 size={14} aria-hidden="true" />{t('card.results')}
          </Link>
          <ActionsMenu label={t('card.actions', { name })} items={items} />
        </div>
      </div>
      {refused > 0 && <PublishRefusal formId={record.form_id} count={refused} />}
      <QrDialog isOpen={qrOpen} onClose={() => setQrOpen(false)} url={publicUrl} title={t('card.qrTitle')} formName={name} />
    </div>
  )
}
