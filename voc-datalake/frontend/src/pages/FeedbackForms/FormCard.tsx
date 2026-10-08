/**
 * FormCard Component - displays a single feedback form with embed options and stats
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Trash2, Copy, Check, Code, ExternalLink, ToggleLeft, ToggleRight, Edit2, MessageSquare, Star, BarChart3, PowerOff, Power } from 'lucide-react'
import type { FeedbackForm } from '../../api/types'
import { api } from '../../api/client'
import { formStatsKey, FORM_STATS_STALE_TIME_MS } from '../../api/feedbackFormQueryKeys'
import { feedbackFormPublicUrl } from '../../api/feedbackFormUrls'
import FormQrButton from '../../components/FormQrCode/FormQrButton'
import { normalizeFormTheme } from './formSchema'
import clsx from 'clsx'
import SubmissionsModal from './SubmissionsModal'

interface FormCardProps {
  readonly form: FeedbackForm
  readonly onEdit: (form: FeedbackForm) => void
  readonly onDelete: (formId: string) => void
  readonly onToggle: (formId: string, enabled: boolean) => void
  readonly apiEndpoint: string
}

type Translate = (key: string) => string

/** The editor's own option labels, so the card and the select it summarises
 *  always say the same thing in the same language. */
function getRatingTypeLabel(ratingType: string, t: Translate): string {
  if (ratingType === 'stars') return t('editor.ratingStars')
  if (ratingType === 'emoji') return t('editor.ratingEmoji')
  return t('editor.ratingNumeric')
}

function getCollectsLabel(collectName: boolean, collectEmail: boolean, t: Translate): string {
  const parts = [collectName && t('card.collectsName'), collectEmail && t('card.collectsEmail')].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : t('card.ratingAndText')
}

interface FormStatsProps {
  readonly stats: { total_submissions: number; avg_rating: number | null } | undefined
  readonly onViewSubmissions: () => void
}

function FormStats({ stats, onViewSubmissions }: FormStatsProps) {
  const { t } = useTranslation('feedbackForms')
  // A neutral panel (not accent-tinted): `text-muted` captions fail contrast on
  // `bg-accent-subtle` in Kiro Dark, and a purple block on every card competed
  // with the page's one primary action. The tone lives in the icon chips.
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 p-3 bg-bg-accent rounded-lg border border-border">
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-accent-subtle rounded-md">
          <MessageSquare size={14} className="text-accent-text" aria-hidden="true" />
        </div>
        <div>
          <p className="text-lg font-bold font-mono text-text-strong">{stats?.total_submissions ?? '—'}</p>
          <p className="text-xs text-muted">{t('card.submissions')}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-warn-subtle rounded-md">
          <Star size={14} className="text-warn" aria-hidden="true" />
        </div>
        <div>
          <p className="text-lg font-bold font-mono text-text-strong">
            {stats?.avg_rating !== null && stats?.avg_rating !== undefined 
              ? stats.avg_rating.toFixed(1) 
              : '—'}
          </p>
          <p className="text-xs text-muted">{t('card.avgRating')}</p>
        </div>
      </div>
      <div className="col-span-2 sm:col-span-2 flex items-center justify-end">
        <button
          onClick={onViewSubmissions}
          className="btn btn-secondary btn-sm w-full sm:w-auto"
          disabled={!stats || stats.total_submissions === 0}
        >
          <BarChart3 size={14} aria-hidden="true" />
          {t('card.viewSubmissions')}
        </button>
      </div>
    </div>
  )
}

/**
 * A form name safe to sit inside a double-quoted HTML attribute.
 *
 * The snippet below is pasted verbatim into a customer's own page, so a name
 * containing a double quote closes `title="` early and hands them broken markup
 * to debug. `&` is escaped first, or the `&` this very substitution introduces
 * would be escaped a second time.
 */
function escapeAttributeValue(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

interface EmbedCodeSectionProps {
  /** Just the two fields the snippets need — not the whole form record. */
  readonly formId: string
  readonly formName: string
  readonly apiEndpoint: string
  readonly copied: string | null
  readonly onCopy: (text: string, id: string) => void
}

function EmbedCodeSection({ formId, formName, apiEndpoint, copied, onCopy }: EmbedCodeSectionProps) {
  const { t } = useTranslation('feedbackForms')
  // Built here, from the one shared builder, because this section is the only
  // consumer of both spellings — and the card's QR encodes the same string from
  // the same builder, so a second construction site would let the printed URL
  // and the scanned one drift.
  const iframeUrl = feedbackFormPublicUrl(apiEndpoint, formId)
  if (iframeUrl === null) {
    // Without an addressable endpoint both the link and the snippet are dead, so
    // say the one useful thing once instead of printing two broken artifacts for a
    // customer to paste into their site. The QR says the same thing in its own
    // words, inside its dialog, because that is the only place a viewer can be
    // told before pointing a room at it.
    return <p className="mt-3 text-xs text-muted">{t('configureApiFirst')}</p>
  }
  const iframeEmbed = `<iframe 
  src="${iframeUrl}"
  style="width: 100%; min-height: 400px; border: none;"
  title="${escapeAttributeValue(formName)}"
></iframe>`
  return (
    <div className="mt-3 space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-muted">{t('card.directLink')}</span>
          <div className="flex gap-1">
            <a href={iframeUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm text-accent-text">
              {t('card.preview')} <ExternalLink size={12} aria-hidden="true" />
            </a>
            <button onClick={() => onCopy(iframeUrl, 'url')} className="btn btn-ghost btn-sm">
              {copied === 'url' ? <Check size={12} className="text-ok" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              {t('card.copy')}
            </button>
          </div>
        </div>
        <code className="block bg-bg-accent border border-border text-text font-mono p-2 rounded-sm text-xs break-all">{iframeUrl}</code>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-muted">{t('card.iframeEmbed')}</span>
          <button onClick={() => onCopy(iframeEmbed, 'iframe')} className="btn btn-ghost btn-sm">
            {copied === 'iframe' ? <Check size={12} className="text-ok" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            {t('card.copy')}
          </button>
        </div>
        {/* Focusable + named: a scrolling region a keyboard user cannot reach is
            unreadable past its right edge on a phone. */}
        <pre tabIndex={0} role="region" aria-label={t('card.iframeEmbed')} className="bg-bg-accent text-text border border-border font-mono p-2 rounded-sm text-xs overflow-x-auto focus-ring">
          <code>{iframeEmbed}</code>
        </pre>
      </div>
      {/* No QR here. It used to sit under the snippet, which made the room-facing
          artifact reachable only by opening a developer-facing disclosure about
          iframes — a facilitator had no reason to look. It is now a first-class
          affordance on the card itself (see FormQrButton below), and putting one
          back here would give the card two entry points to the same thing. */}
    </div>
  )
}

/**
 * Says what "Disabled" means to the people who will open the link, with the
 * one action that fixes it (E2E F6). New forms are created disabled on purpose
 * — nothing is public until the owner says so — but a badge alone left the
 * owner sharing a link that answered "Feedback form unavailable.".
 */
function DisabledNotice({ enabled, onEnable }: Readonly<{ enabled: boolean; onEnable: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  if (enabled) return null
  return (
    <div role="note" className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg border border-warn/30 bg-warn-subtle">
      <PowerOff size={16} className="text-warn flex-shrink-0" aria-hidden="true" />
      <p className="text-sm text-text flex-1">{t('card.disabledNotice')}</p>
      <button type="button" onClick={onEnable} className="btn btn-primary btn-sm self-start sm:self-auto">
        <Power size={14} aria-hidden="true" />
        {t('createdDisabled.enable')}
      </button>
    </div>
  )
}

export default function FormCard({ form, onEdit, onDelete, onToggle, apiEndpoint }: FormCardProps) {
  const { t } = useTranslation('feedbackForms')
  // Hoisted so the label is computed once and shared by aria-label and title,
  // which also keeps this component under the ESLint complexity ceiling.
  const toggleLabel = form.enabled ? t('card.disableForm') : t('card.enableForm')
  const [copied, setCopied] = useState<string | null>(null)
  const [showEmbed, setShowEmbed] = useState(false)
  const [showSubmissions, setShowSubmissions] = useState(false)
  // Belt-and-braces for issue #171: the list normalizes at its query boundary,
  // but FormCard must stay render-safe standalone (sparse records pre-dating
  // the theme field crashed the whole /feedback-forms route).
  const theme = normalizeFormTheme(form.theme)

  const { data: statsData } = useQuery({
    queryKey: formStatsKey(form.form_id),
    queryFn: () => api.getFeedbackFormStats(form.form_id),
    staleTime: FORM_STATS_STALE_TIME_MS,
  })

  const copyToClipboard = (text: string, id: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <>
      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h3 className="font-semibold tracking-tight text-base text-text-strong min-w-0 break-words">{form.name}</h3>
              <span className={clsx('badge', form.enabled ? 'badge-ok' : 'badge-muted')}>
                {form.enabled ? t('card.active') : t('card.disabled')}
              </span>
              {form.form_type === 'prototype_pin' ? (
                <span className="badge badge-info">{t('card.prototypePins')}</span>
              ) : null}
            </div>
            <p className="text-sm text-muted mt-1 line-clamp-2">{form.title}</p>
            {form.category && (
              <p className="text-xs text-accent-text mt-2">
                {t('card.category')} <span className="font-medium">{form.category}</span>
                {form.subcategory && <span> → {form.subcategory}</span>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            {/* aria-label as well as title: title is hover-only, so on its own it
                leaves these icon-only controls poorly described for AT users. */}
            <button
              onClick={() => onToggle(form.form_id, !form.enabled)}
              className="icon-btn p-2 focus-ring"
              aria-label={toggleLabel}
              title={toggleLabel}
            >
              {form.enabled ? <ToggleRight size={20} className="text-ok" aria-hidden="true" /> : <ToggleLeft size={20} aria-hidden="true" />}
            </button>
            <button
              onClick={() => onEdit(form)}
              className="icon-btn p-2 focus-ring"
              aria-label={t('card.editForm')}
              title={t('card.editForm')}
            >
              <Edit2 size={16} aria-hidden="true" />
            </button>
            <button
              onClick={() => onDelete(form.form_id)}
              className="icon-btn p-2 hover:bg-danger-subtle focus-ring"
              aria-label={t('card.deleteForm')}
              title={t('card.deleteForm')}
            >
              <Trash2 size={16} className="text-danger" aria-hidden="true" />
            </button>
          </div>
        </div>

        <DisabledNotice enabled={form.enabled} onEnable={() => onToggle(form.form_id, true)} />

        <FormStats stats={statsData?.stats} onViewSubmissions={() => setShowSubmissions(true)} />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-4 p-3 bg-bg-accent border border-border rounded-lg">
          <div>
            <p className="text-xs text-muted">{t('card.ratingType')}</p>
            <p className="font-medium text-sm text-text-strong">{getRatingTypeLabel(form.rating_type, t)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">{t('card.collects')}</p>
            <p className="font-medium text-sm text-text-strong">{getCollectsLabel(form.collect_name, form.collect_email, t)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">{t('card.themeLabel')}</p>
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded-sm flex-shrink-0 border border-border" style={{ backgroundColor: theme.primary_color }} />
              <span className="text-sm font-mono text-text truncate">{theme.primary_color}</span>
            </div>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-4">
            {/* Translated because it sits immediately beside the QR trigger, which
                is: one row, two controls, and only one of them in the reader's
                language reads as a bug rather than as a gap. The keys already
                existed in all eight catalogues — they were simply never wired up. */}
            <button onClick={() => setShowEmbed(!showEmbed)} aria-expanded={showEmbed} className="flex items-center gap-2 text-sm link focus-ring rounded-md">
              <Code size={16} aria-hidden="true" />
              {showEmbed ? t('card.hideEmbedCode') : t('card.showEmbedCode')}
            </button>
            {/* Beside the embed disclosure rather than inside it: a facilitator
                wanting a QR for a room is not looking for an iframe snippet. Same
                trigger the Prioritization row uses. */}
            <FormQrButton
              apiEndpoint={apiEndpoint}
              formId={form.form_id}
              formName={form.name}
              className="text-sm"
            />
          </div>
          
          {showEmbed && (
            <EmbedCodeSection
              formId={form.form_id}
              formName={form.name}
              apiEndpoint={apiEndpoint}
              copied={copied}
              onCopy={copyToClipboard}
            />
          )}
        </div>
      </div>

      {showSubmissions && (
        <SubmissionsModal
          formId={form.form_id}
          formName={form.name}
          onClose={() => setShowSubmissions(false)}
        />
      )}
    </>
  )
}
