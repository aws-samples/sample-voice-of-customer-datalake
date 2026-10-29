/**
 * @fileoverview "Share for review": the document series' review link (docs/document-review.md).
 *
 * No link yet: choose who may open it (anyone with the link who confirms their email, or listed
 * domains / addresses) and how long it lasts, then create it. A link: its address with a Copy
 * button, when it expires, who it admits, and "Turn off". Reviewers sign in with an emailed code
 * and can read the newest version and comment; they see only their own comments.
 *
 * @module pages/ProjectDetail/ShareForReviewDialog
 */
import { Check, Copy, Link2, Loader2, Unlink } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { serverReason } from '../../lib/errors'
import { formatDate } from '../../utils/dateUtils'
import { SHARE_MODES } from '../../api/documentReviewSchema'
import type { ShareSettings } from '../../api/documentReviewApi'
import type { ReviewShare, ShareMode } from '../../api/documentReviewSchema'

const EXPIRY_CHOICES = [7, 30, 90] as const
const DEFAULT_EXPIRY_DAYS = 30

/** Split a free-text list (commas, spaces, new lines) into entries. */
function entries(text: string): string[] {
  return text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '')
}

function settingsFrom(mode: ShareMode, listText: string, days: number): ShareSettings {
  const listed = mode === 'list' ? entries(listText) : []
  return {
    audience: { mode, domains: listed.filter((entry) => !entry.includes('@')), emails: listed.filter((entry) => entry.includes('@')) },
    expires_in_days: days,
  }
}

function CreateLinkForm({ onCreate }: Readonly<{ onCreate: (settings: ShareSettings) => Promise<unknown> }>) {
  const { t } = useTranslation('components')
  const listId = useId()
  const expiryId = useId()
  const [mode, setMode] = useState<ShareMode>('anyone')
  const [listText, setListText] = useState('')
  const [days, setDays] = useState<number>(DEFAULT_EXPIRY_DAYS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onCreate(settingsFrom(mode, listText, days))
    } catch (failure) {
      setError(serverReason(failure) ?? t('reviewShare.createFailed'))
    } finally {
      setBusy(false)
    }
  }
  const listEmpty = mode === 'list' && entries(listText).length === 0
  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text">{t('reviewShare.whoMayOpen')}</legend>
        {SHARE_MODES.map((choice) => (
          <label key={choice} className="flex items-start gap-2 text-sm">
            <input type="radio" name="review-audience" checked={mode === choice} onChange={() => setMode(choice)} className="mt-1" />
            <span>
              <span className="text-text">{t(`reviewShare.mode.${choice}`)}</span>
              <span className="block text-xs text-muted">{t(`reviewShare.modeHint.${choice}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {mode === 'list' ? (
        <div>
          <label htmlFor={listId} className="block text-sm font-medium text-text mb-1">{t('reviewShare.listLabel')}</label>
          <textarea id={listId} className="input text-sm" rows={3} value={listText}
            placeholder={t('reviewShare.listPlaceholder')} onChange={(event) => setListText(event.target.value)} />
        </div>
      ) : null}
      <div>
        <label htmlFor={expiryId} className="block text-sm font-medium text-text mb-1">{t('reviewShare.expiresIn')}</label>
        <select id={expiryId} className="input w-auto" value={days} onChange={(event) => setDays(Number(event.target.value))}>
          {EXPIRY_CHOICES.map((choice) => <option key={choice} value={choice}>{t('reviewShare.days', { count: choice })}</option>)}
        </select>
      </div>
      {error === null ? null : <p role="alert" className="text-sm text-danger">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || listEmpty}>
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Link2 size={14} aria-hidden />}
        {t('reviewShare.create')}
      </button>
    </form>
  )
}

function ActiveLink({ share, onRevoke }: Readonly<{ share: ReviewShare; onRevoke: () => Promise<unknown> }>) {
  const { t, i18n } = useTranslation('components')
  const urlId = useId()
  const { copy, copiedKey } = useCopyToClipboard()
  const copied = copiedKey !== null
  const [busy, setBusy] = useState(false)
  const url = `${window.location.origin}${share.path}`
  const audience = share.audience.mode === 'anyone'
    ? t('reviewShare.mode.anyone')
    : [...share.audience.domains, ...share.audience.emails].join(', ')
  return (
    <div className="space-y-3">
      <label htmlFor={urlId} className="block text-sm font-medium text-text">{t('reviewShare.linkLabel')}</label>
      <div className="flex gap-2">
        <input id={urlId} className="input font-mono text-xs" readOnly value={url} onFocus={(event) => event.target.select()} />
        <button type="button" className="btn btn-secondary shrink-0" onClick={() => copy(url)}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? t('reviewShare.copied') : t('reviewShare.copy')}
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">{t('reviewShare.audience')}</dt><dd className="text-text break-words">{audience}</dd>
        <dt className="text-muted">{t('reviewShare.expires')}</dt><dd className="text-text">{formatDate(share.expires_at, i18n.language)}</dd>
      </dl>
      <p className="text-xs text-muted">{t('reviewShare.reviewerHint')}</p>
      <button type="button" className="btn btn-ghost btn-sm text-danger" disabled={busy}
        onClick={() => { setBusy(true); void onRevoke().finally(() => setBusy(false)) }}>
        <Unlink size={14} aria-hidden />{t('reviewShare.revoke')}
      </button>
    </div>
  )
}

interface ShareForReviewDialogProps {
  readonly share: ReviewShare | null
  readonly onCreate: (settings: ShareSettings) => Promise<unknown>
  readonly onRevoke: () => Promise<unknown>
  readonly onClose: () => void
}

export default function ShareForReviewDialog({ share, onCreate, onRevoke, onClose }: ShareForReviewDialogProps) {
  const { t } = useTranslation('components')
  const headingId = useId()
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={headingId} panelClassName="max-w-lg">
      <div className="dialog-header justify-between">
        <h2 id={headingId} className="dialog-title">{t('reviewShare.title')}</h2>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body space-y-3">
        <p className="text-sm text-muted">{t('reviewShare.intro')}</p>
        {share === null ? <CreateLinkForm onCreate={onCreate} /> : <ActiveLink share={share} onRevoke={onRevoke} />}
      </div>
    </ModalShell>
  )
}
