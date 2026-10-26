/**
 * @fileoverview Operational alerting (`/logs/alerts*`, logs Lambda,
 * `lambda/shared/ops_alerts*.py`): whether the runtime CloudWatch alarms exist
 * and who gets their email. Every route is admin-only.
 *
 * Every response is normalized through a lenient Zod schema: a drifted or
 * missing field reads as "not configured / off / nobody", never as "on".
 *
 * @module api/alertsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { lenientText, optionalText, parsedList } from './schemaList'

const RECIPIENT_STATUSES = ['confirmed', 'pending'] as const

const RecipientSchema = z.object({
  email: z.string().min(1),
  status: z.enum(RECIPIENT_STATUSES).catch('pending'),
})
export type AlertRecipient = z.output<typeof RecipientSchema>

const AlarmSchema = z.object({ name: z.string().min(1), state: lenientText })

/** MAX_SUBSCRIBERS in shared/ops_alerts.py, for an answer that omits it. */
const DEFAULT_MAX_RECIPIENTS = 10

const count = z.number().int().nonnegative().catch(0)

const AlertsStatusSchema = z.object({
  configured: z.boolean().catch(false),
  enabled: z.boolean().catch(false),
  updated_at: optionalText,
  updated_by: optionalText,
  alarms: parsedList(AlarmSchema),
  expected_alarm_count: count,
  billed_metric_count: count,
  subscribers: parsedList(RecipientSchema),
  max_subscribers: z.number().int().positive().catch(DEFAULT_MAX_RECIPIENTS),
})
export type AlertsStatus = z.output<typeof AlertsStatusSchema>

export const DEFAULT_ALERTS_STATUS: AlertsStatus = AlertsStatusSchema.parse({})

export function normalizeAlertsStatus(raw: unknown): AlertsStatus {
  const parsed = AlertsStatusSchema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_ALERTS_STATUS
}

export const alertsKey = () => ['logs', 'alerts'] as const

const PATH = '/logs/alerts'
const RECIPIENTS_PATH = '/logs/alerts/recipients'
const REMOVE_RECIPIENT_PATH = '/logs/alerts/recipients/remove'

export const alertsApi = {
  get: async (): Promise<AlertsStatus> => normalizeAlertsStatus(await fetchApi<unknown>(PATH)),
  setEnabled: (enabled: boolean) => fetchApi<unknown>(PATH, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  addRecipient: (email: string) =>
    fetchApi<unknown>(RECIPIENTS_PATH, { method: 'POST', body: JSON.stringify({ email }) }),
  removeRecipient: (email: string) =>
    fetchApi<unknown>(REMOVE_RECIPIENT_PATH, { method: 'POST', body: JSON.stringify({ email }) }),
}
