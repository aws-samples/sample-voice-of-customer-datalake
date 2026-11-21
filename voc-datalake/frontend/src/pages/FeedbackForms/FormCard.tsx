/**
 * @fileoverview One form on the Feedback Forms list (UX §14.2), in three zones: what it is (its name, "Test link on",
 * its questions and languages), its figures (the headline figure of its first measuring question as a number, "NPS
 * +32", and its responses), and its controls (the Live / Off switch, Results, ⋯: Edit · Copy link · QR code · Preview
 * · Duplicate · Delete…). The whole card is the link to the form (a stretched link on its name; the builder opens it
 * on Results when it is Live with responses, else on Questions); the controls sit above it.
 *
 * The card reads the record as v2 (a v1 record is read migrated). Turning on a form with problems is refused in words
 * with a way to fix them; turning off a Live form that has responses asks first, since its link and embeds stop
 * working for the next respondents. Preview opens the preview window on the stored form, which never submits: the old
 * Preview link counted (F4).
 * Every figure excludes test responses (the list's stats do).
 *
 * @module pages/FeedbackForms/FormCard
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { BarChart3, Copy, Eye, FlaskConical, Pencil, QrCode, Trash2, CopyPlus } from 'lucide-react'
import type { FeedbackForm } from '../../api/types'
import { api } from '../../api/client'
import { formStatsKey, FORM_STATS_STALE_TIME_MS } from '../../api/feedbackFormQueryKeys'
import { feedbackFormPublicUrl } from '../../api/feedbackFormUrls'
import { parseStoredForm } from '../../api/feedbackFormsV2Api'
import type { FormHeadline, FormStats } from '../../api/feedbackFormStatsSchema'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import Switch from '../../components/Switch/Switch'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { languageNames } from '../../i18n/languages'
import { formatRelativeDate } from '../../utils/dateUtils'
import { formatDecimal, formatCount, formatPercent } from '../../utils/numberFormat'
import type { FormV2 } from './model/formsV2'
import { publishBlockingProblems, validateForm } from './model/validateForm'
import { builderPath } from './builder/builderPaths'
import { handoffState } from './builder/newFormHandoff'
import { openStoredFormPreview } from './preview/openStoredFormPreview'
import ActionsMenu from './ui/ActionsMenu'
import { QrDialog } from './tabs/QrDialog'
import { signedScore } from './results/scoreMath'

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

/** The headline figure's number as people write it: "+32" (NPS), "84 %" (CSAT), "4.2 / 5" (an average). */
function figureValue(headline: FormHeadline, language: string, ofMax: (value: string, max: number) => string): string {
  if (headline.type === 'nps') return signedScore(Math.round(headline.value))
  if (headline.type === 'csat') return formatPercent(headline.value, language)
  const value = formatDecimal(headline.value, language, 1)
  return headline.scale_max === undefined ? value : ofMax(value, headline.scale_max)
}

/** The label under the figure, per measuring type (literal keys, so the i18n audit sees them). */
function figureLabel(t: TFunction<'feedbackForms'>, type: FormHeadline['type']): string {
  switch (type) {
    case 'nps': return t('card.figure.nps')
    case 'csat': return t('card.figure.csat')
    case 'ces': return t('card.figure.ces')
    case 'rating': return t('card.figure.rating')
  }
}

/** The first measuring question's figure as a number with its label under it; nothing without one. */
function HeadlineFigure({ headline }: Readonly<{ headline: FormHeadline | null | undefined }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  if (headline == null) return null
  const value = figureValue(headline, i18n.language, (average, max) => t('card.average', { average, max }))
  return (
    <p className="flex flex-col">
      <span className="text-lg font-semibold leading-tight tracking-tight text-text-strong tabular-nums">{value}</span>
      <span className="text-[12px] text-muted">{figureLabel(t, headline.type)}</span>
    </p>
  )
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
  const last = count > 0 ? formatRelativeDate(stats.last_response_at, i18n.language) : ''
  return (
    <div className="space-y-1">
      <p className="text-sm text-text tabular-nums">{t('card.responses', { count, formatted: formatCount(count, i18n.language) })}</p>
      {last !== '' && <p className="text-[12px] text-muted">{t('card.lastResponse', { when: last })}</p>}
      <ChannelChips channels={stats.channels} />
    </div>
  )
}

/** The card's channels, in this order: the ways the form was answered. */
const CHANNELS = ['link', 'script', 'iframe'] as const
/** A channel counts on the card while its last response is this recent. */
const CHANNEL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

function channelName(t: TFunction<'feedbackForms'>, channel: (typeof CHANNELS)[number]): string {
  switch (channel) {
    case 'link': return t('card.channels.link')
    case 'script': return t('card.channels.script')
    case 'iframe': return t('card.channels.iframe')
  }
}

/** The channels whose last response is under 30 days old, in the card's order. */
function recentChannels(channels: FormStats['channels'], now: number = Date.now()): (typeof CHANNELS)[number][] {
  return CHANNELS.filter((channel) => {
    const at = Date.parse(channels?.[channel] ?? '')
    return Number.isFinite(at) && at >= now - CHANNEL_WINDOW_MS
  })
}

/** Where the form was answered in the last 30 days ("Link · Website script · Embedded"), as labels; none: nothing. */
function ChannelChips({ channels }: Readonly<{ channels: FormStats['channels'] }>) {
  const { t } = useTranslation('feedbackForms')
  const seen = recentChannels(channels)
  if (seen.length === 0) return null
  return (
    <ul aria-label={t('card.channels.label')} className="flex flex-wrap gap-1">
      {seen.map((channel) => <li key={channel} className="badge badge-muted">{channelName(t, channel)}</li>)}
    </ul>
  )
}

/** The refusal to turn on a form with problems, in words, with the way to them. */
function PublishRefusal({ formId, count }: Readonly<{ formId: string; count: number }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <p role="alert" className="relative text-[12px] text-danger sm:col-span-2 lg:col-span-3">
      {t('card.fixFirst', { count })}{' '}
      <Link to={builderPath(formId, 'questions')} className="link">{t('card.open')}</Link>
    </p>
  )
}

function useCardActions(record: FeedbackForm, form: FormV2 | null, publicUrl: string | null, openQr: () => void, onDelete: (id: string) => void) {
  const { t, i18n } = useTranslation('feedbackForms')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { copy } = useCopyToClipboard()
  const id = record.form_id
  return [
    { label: t('card.edit'), icon: Pencil, onSelect: () => { void navigate(builderPath(id, 'questions')) } },
    { label: t('card.copyLink'), icon: Copy, disabledReason: publicUrl === null ? t('configureApiFirst') : undefined, onSelect: () => { if (publicUrl !== null) copy(publicUrl, 'link') } },
    { label: t('card.qr'), icon: QrCode, onSelect: openQr },
    // (the preview window, opened in the click itself, then given the stored form: preview/openStoredFormPreview)
    { label: t('card.preview'), icon: Eye, onSelect: () => { openStoredFormPreview(queryClient, id, { t, language: i18n.language }) } },
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

/** The card's stats, from the list's one read (seeded per form) or the form's own when the list had none. */
function useCardStats(formId: string) {
  const { data, isFetching } = useQuery({
    queryKey: formStatsKey(formId),
    queryFn: () => api.getFeedbackFormStats(formId),
    staleTime: FORM_STATS_STALE_TIME_MS,
  })
  return { stats: data?.stats, statsFetching: isFetching }
}

/** Has anyone answered it for real (the stats' count, else the record's own mark while they are read)? */
const answered = (stats: FormStats | null | undefined, hasResponses: boolean): boolean =>
  (stats?.total_submissions ?? 0) > 0 || hasResponses

/** The Live / Off switch: on refuses a form with problems in words; off asks first when people are answering it. */
function useLiveSwitch(record: FeedbackForm, form: FormV2 | null, answered: boolean, onToggle: FormCardHandlers['onToggle']) {
  const [refused, setRefused] = useState(0)
  const [askingOff, setAskingOff] = useState(false)
  const toggle = (on: boolean) => {
    if (!on && record.enabled && answered) {
      setAskingOff(true)
      return
    }
    // Turning a form on publishes it: whatever blocks Publish blocks it (an unreadable theme included).
    const errors = on && form !== null ? publishBlockingProblems(validateForm(form)).length : 0
    setRefused(errors)
    if (errors === 0) onToggle(record.form_id, on)
  }
  const confirmOff = () => {
    setAskingOff(false)
    onToggle(record.form_id, false)
  }
  return { refused, toggle, askingOff, confirmOff, cancelOff: () => setAskingOff(false) }
}

/** The card's first zone: its name (the stretched link that makes the whole card the way in), its marks, its summary. */
function Identity({ record, form, name, titleId }: Readonly<{ record: FeedbackForm; form: FormV2 | null; name: string; titleId: string }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="min-w-0 space-y-1 sm:col-span-2 lg:col-span-1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="min-w-0 break-words text-base font-semibold tracking-tight text-text-strong">
          <Link to={`/feedback-forms/${encodeURIComponent(record.form_id)}`}
            className="link-quiet after:absolute after:inset-0 after:rounded-lg">{name}</Link>
        </h3>
        {record.form_type === 'prototype_pin' && <span className="badge badge-muted">{t('card.prototypePins')}</span>}
        {record.imported !== undefined && <span className="badge badge-muted">{t('card.imported')}</span>}
        {form?.settings.test.link_enabled === true && (
          <span className="badge badge-info inline-flex items-center gap-1"><FlaskConical size={12} aria-hidden="true" />{t('card.testLinkOn')}</span>
        )}
      </div>
      <Summary form={form} />
      {/* Why its switch is off for good (7.67.00): an imported form has no public link. */}
      {record.imported !== undefined && <p className="text-xs text-muted">{t('card.importedFrom', { filename: record.imported.filename })}</p>}
    </div>
  )
}

export default function FormCard({ form: record, onDelete, onToggle, apiEndpoint, statsRefreshing }: FormCardProps) {
  const { t } = useTranslation('feedbackForms')
  const titleId = useId()
  const [qrOpen, setQrOpen] = useState(false)
  const loaded = parseStoredForm(record)
  const form = loaded?.form ?? null
  const publicUrl = feedbackFormPublicUrl(apiEndpoint, record.form_id)
  const items = useCardActions(record, form, publicUrl, () => setQrOpen(true), onDelete)
  const { stats, statsFetching } = useCardStats(record.form_id)
  const live = useLiveSwitch(record, form, answered(stats, loaded?.meta.has_responses === true), onToggle)
  const name = record.name.trim() === '' ? t('card.unnamed') : record.name
  // The controls are `relative` WITHOUT a z-index: they paint above the stretched link because they come after it
  // (the ⋯ menu opens in a portal, above every card).
  return (
    <article aria-labelledby={titleId}
      className="card relative grid gap-3 hover:border-border-strong sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-5 lg:grid-cols-[minmax(0,1fr)_10rem_auto] lg:items-start">
      <Identity record={record} form={form} name={name} titleId={titleId} />
      <div className="min-w-0 space-y-1">
        <HeadlineFigure headline={stats?.headline} />
        <ResponsesLine stats={stats} busy={statsFetching || statsRefreshing} />
      </div>
      <div className="relative flex flex-wrap items-center gap-2 sm:justify-end lg:flex-nowrap">
        <Switch label={record.enabled ? t('card.live') : t('card.off')} widthOf={[t('card.live'), t('card.off')]}
          checked={record.enabled} onChange={live.toggle} disabled={record.imported !== undefined} />
        <Link to={builderPath(record.form_id, 'results')} className="btn btn-secondary btn-sm">
          <BarChart3 size={14} aria-hidden="true" />{t('card.results')}
        </Link>
        <ActionsMenu label={t('card.actions', { name })} items={items} />
      </div>
      {live.refused > 0 && <PublishRefusal formId={record.form_id} count={live.refused} />}
      <QrDialog isOpen={qrOpen} onClose={() => setQrOpen(false)} url={publicUrl} title={t('card.qrTitle')} formName={name} />
      <ConfirmModal isOpen={live.askingOff} variant="warning" title={t('card.turnOff.title', { name })}
        message={t('card.turnOff.message')} confirmLabel={t('card.turnOff.confirm')}
        onConfirm={live.confirmOff} onCancel={live.cancelOff} />
    </article>
  )
}
