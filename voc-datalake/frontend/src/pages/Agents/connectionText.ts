/**
 * @fileoverview What Agents → Connections says in a sentence:
 *
 * - a refused connection save or removal: for a field off its rule (400) or a conflict (409: live runs on the
 *   connection, the connection limit), the server's own reason, which names the field or what to do; else the
 *   status's message;
 * - a connection's CI attestation (7.52.00, the row's details): who recorded or withdrew it and when, or why none
 *   holds (none yet, voided by a repository change or a removal);
 * - why a public repository takes no contribution from here (7.57.00: archived, no licence).
 *
 * @module pages/Agents/connectionText
 */
import { useTranslation } from 'react-i18next'
import { apiErrorStatus, messageKeyForStatus } from '../../api/apiErrorStatus'
import { serverReason } from '../../lib/errors'
import { formatDateTime } from '../../utils/dateUtils'
import type { CiAttestation, EngineeringConnection } from '../../api/engineeringConnectionsApi'

const CONNECTION_ERRORS = [
  { status: 400, messageKey: 'agents:connections.errors.invalid' },
  { status: 403, messageKey: 'agents:connections.errors.forbidden' },
  { status: 404, messageKey: 'agents:connections.errors.notFound' },
  { status: 409, messageKey: 'agents:connections.errors.conflict' },
  { status: 503, messageKey: 'agents:connections.errors.unavailable' },
] as const
const CONNECTION_ERROR = { messageKey: 'agents:connections.errors.generic' } as const
/** The refusals whose own reason says more than the status. */
const SERVER_REASONS: ReadonlySet<number> = new Set([400, 409])

export function useConnectionError(): (error: unknown) => string {
  const { t } = useTranslation()
  return (error) => {
    const key = messageKeyForStatus(error, CONNECTION_ERRORS, CONNECTION_ERROR)
    return (SERVER_REASONS.has(apiErrorStatus(error) ?? 0) ? serverReason(error) : null) ?? t(key)
  }
}

/** What the connection's newest CI attestation version says, in a sentence: who and when, or why none holds. */
export function useAttestationText(): (attestation: CiAttestation | null) => string {
  const { t, i18n } = useTranslation('agents')
  return (attestation) => {
    if (attestation === null) return t('connections.ci.none')
    const who = attestation.by ?? t('connections.ci.unknownPerson')
    const when = formatDateTime(attestation.at, i18n.language, '')
    if (attestation.state === 'attested') return t('connections.ci.attestedBy', { who, when })
    if (attestation.state === 'withdrawn') return t('connections.ci.withdrawnBy', { who, when })
    return attestation.cause === 'connection_removed' ? t('connections.ci.voidedRemoved') : t('connections.ci.voidedRepository')
  }
}

/** (7.57.00) Why a public repository takes no contribution from here (archived, no licence), or null when it does. */
export function useContributionHeld(connection: EngineeringConnection): string | null {
  const { t } = useTranslation('agents')
  if (connection.public?.archived === true) return t('connections.contribute.archived')
  return (connection.public?.licence ?? null) === null ? t('connections.contribute.noLicence') : null
}
