/**
 * @fileoverview A fine-grained token connection's token on its row (7.60.00): "Fine-grained token · ‹login› · expires
 * ‹date› (in N days)", whose token is it (who saved it, "you" for the viewer), and a chip from 14 days before it
 * expires (a warning) and once it has (a danger): the run is refused at its start then, and the row's one action is
 * Replace token (connectionStatus.ts). The token itself is never on the page: only its login and its expiry.
 *
 * @module pages/Agents/TokenExpiryBadge
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CircleX, KeyRound } from 'lucide-react'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import { formatCalendarDay } from '../../utils/dateUtils'
import { tokenState } from './tokenConnectionRules'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'

/** The chip of a token within its warning (a warn) or past its expiry (a danger); nothing otherwise (also on
 *  Administration → Engineering agents, which lists the tokens to replace). */
export function TokenExpiryBadge({ daysLeft }: Readonly<{ daysLeft: number | null }>) {
  const { t } = useTranslation('agents')
  const state = tokenState(daysLeft)
  if (state === 'soon') {
    return <IconBadge toneClass="badge-warn" icon={AlertTriangle}>{t('connections.token.soonBadge', { count: daysLeft ?? 0 })}</IconBadge>
  }
  if (state === 'expired') return <IconBadge toneClass="badge-danger" icon={CircleX}>{t('connections.token.expiredBadge')}</IconBadge>
  return null
}

/** When the token expires, in words: its day and the days left, or that it is not known. */
function ExpiryWords({ expiresAt, daysLeft }: Readonly<{ expiresAt: string | null; daysLeft: number | null }>) {
  const { t, i18n } = useTranslation('agents')
  if (expiresAt === null || daysLeft === null) return <>{t('connections.token.expiryUnknown')}</>
  const date = formatCalendarDay(expiresAt, i18n.language)
  return <>{daysLeft <= 0 ? t('connections.token.expiredOn', { date }) : t('connections.token.expires', { date, count: daysLeft })}</>
}

/** The row's token line, and whose token it is. */
export function TokenConnectionLine({ connection }: Readonly<{ connection: EngineeringConnection }>) {
  const { t } = useTranslation('agents')
  const { credential } = connection
  if (!credential.set) return <p className="text-[12px] text-warn">{t('connections.token.notSet')}</p>
  const owner = credential.saved_by_you ? t('connections.token.ownerYou') : t('connections.token.owner', { owner: credential.owner ?? '?' })
  return (
    <div className="space-y-0.5 text-[12px]" data-testid={`token-line-${connection.connection_id}`}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text">
        <KeyRound size={12} aria-hidden="true" className="text-muted" />
        <span>
          {t('connections.token.kind')} · {credential.login ?? t('connections.token.loginUnknown')} ·{' '}
          <ExpiryWords expiresAt={credential.expires_at} daysLeft={credential.expires_in_days} />
        </span>
        <TokenExpiryBadge daysLeft={credential.expires_in_days} />
      </p>
      <p className="text-muted">{owner}</p>
    </div>
  )
}
