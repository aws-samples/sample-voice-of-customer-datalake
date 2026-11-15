/**
 * @fileoverview What a refused connection save or removal says: for a field off its rule (400) or a conflict (409:
 * live runs on the connection, the connection limit), the server's own reason, which names the field or what to do;
 * else the status's message.
 *
 * @module pages/Agents/connectionText
 */
import { useTranslation } from 'react-i18next'
import { apiErrorStatus, messageKeyForStatus } from '../../api/apiErrorStatus'
import { serverReason } from '../../lib/errors'

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
