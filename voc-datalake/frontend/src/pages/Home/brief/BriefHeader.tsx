/**
 * @fileoverview "Good morning, <name>", the brief's freshness, Refresh, and the
 * Settings link to Account → Morning brief.
 * @module pages/Home/brief/BriefHeader
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { accountTabPath } from '../../Account/accountSections'
import { RefreshCw, Settings } from 'lucide-react'
import { useAuthStore } from '../../../store/authStore'
import { displayName, greetingKey } from './briefCards'
import { formatDateTime } from '../../../utils/dateUtils'
import type { Brief } from '../../../api/briefingApi'
import type { RefreshOutcome } from './useBrief'

function Freshness({ brief }: Readonly<{ brief: Brief }>) {
  const { t, i18n } = useTranslation('briefing')
  if (brief.status === 'failed') return <p className="text-sm text-danger">{t('freshness.failed')}</p>
  if (brief.generated_at === undefined) return <p className="text-sm text-muted">{t('freshness.none')}</p>
  return <p className="text-sm text-muted">{t('freshness.generatedAt', { time: formatDateTime(brief.generated_at, i18n.language) })}</p>
}

const OUTCOME_KEYS: Partial<Record<RefreshOutcome, 'refresh.upToDate' | 'refresh.failed'>> = {
  up_to_date: 'refresh.upToDate',
  failed: 'refresh.failed',
}

/** Opens Account → Morning brief, where the brief settings live (accessible name "Brief settings"). */
export function SettingsLink() {
  const { t } = useTranslation('briefing')
  return (
    <Link to={accountTabPath('briefing')} className="btn btn-ghost btn-sm" aria-label={t('settings.title')}>
      <Settings size={14} aria-hidden="true" />
      {t('settings.open')}
    </Link>
  )
}

export function RefreshButton({ generating, outcome, onRefresh, children }: Readonly<{
  generating: boolean
  outcome: RefreshOutcome
  onRefresh: () => void
  /** Buttons that sit next to Refresh, before its status line. */
  children?: ReactNode
}>) {
  const { t } = useTranslation('briefing')
  const message = generating ? undefined : OUTCOME_KEYS[outcome]
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn btn-secondary btn-sm" disabled={generating} onClick={() => { onRefresh() }}>
        <RefreshCw size={14} aria-hidden="true" className={generating ? 'motion-safe:animate-spin' : undefined} />
        {generating ? t('refresh.generating') : t('refresh.label')}
      </button>
      {children}
      <span role="status" className={outcome === 'failed' ? 'text-sm text-danger' : 'text-sm text-muted'}>
        {message === undefined ? '' : t(message)}
      </span>
    </div>
  )
}

export default function BriefHeader({ brief, now, children }: Readonly<{
  brief: Brief
  /** Injected for tests; the greeting follows the reader's local hour. */
  now: Date
  /** The page's own actions (dashboard link, start page, Refresh). */
  children?: ReactNode
}>) {
  const { t } = useTranslation('briefing')
  const user = useAuthStore().user
  return (
    <header className="space-y-1 pt-2">
      <h1 className="text-2xl font-bold tracking-tight text-text-strong sm:text-3xl">
        {t(greetingKey(now.getHours()), { name: displayName(user) })}
      </h1>
      <Freshness brief={brief} />
      {children}
    </header>
  )
}
