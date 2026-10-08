/**
 * @fileoverview Status meaning and formatting for Settings model tests
 * (POST /settings/model/test), shared by the row pill, the "Test all" table and
 * the save confirmation.
 *
 * Each status maps to a MEANING tone (KiroCrew rule 2): ok = runnable,
 * warn = wait / retry, danger = this account cannot use it, muted / info = not
 * offered here / not ready. `no_capacity` deliberately offers no action: the
 * model is subscribed but its quota is 0, and the only thing to do is wait.
 */
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, CloudOff, Hourglass, Lock, MapPinOff, Timer } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Tone } from '../../theme/tones'
import type { ModelTestStatus } from '../../api/modelTestSchema'

interface StatusMeta {
  readonly tone: Tone
  readonly icon: LucideIcon
  readonly labelKey: string
  readonly detailKey: string
}

export const STATUS_META: Record<ModelTestStatus, StatusMeta> = {
  available: { tone: 'ok', icon: CheckCircle2, labelKey: 'settings:aiModel.test.status.available', detailKey: 'settings:aiModel.test.detail.available' },
  no_access: { tone: 'danger', icon: Lock, labelKey: 'settings:aiModel.test.status.no_access', detailKey: 'settings:aiModel.test.detail.no_access' },
  not_in_region: { tone: 'muted', icon: MapPinOff, labelKey: 'settings:aiModel.test.status.not_in_region', detailKey: 'settings:aiModel.test.detail.not_in_region' },
  no_capacity: { tone: 'warn', icon: Hourglass, labelKey: 'settings:aiModel.test.status.no_capacity', detailKey: 'settings:aiModel.test.detail.no_capacity' },
  throttled: { tone: 'warn', icon: Timer, labelKey: 'settings:aiModel.test.status.throttled', detailKey: 'settings:aiModel.test.detail.throttled' },
  not_ready: { tone: 'info', icon: Hourglass, labelKey: 'settings:aiModel.test.status.not_ready', detailKey: 'settings:aiModel.test.detail.not_ready' },
  unavailable: { tone: 'warn', icon: CloudOff, labelKey: 'settings:aiModel.test.status.unavailable', detailKey: 'settings:aiModel.test.detail.unavailable' },
  error: { tone: 'danger', icon: AlertCircle, labelKey: 'settings:aiModel.test.status.error', detailKey: 'settings:aiModel.test.detail.error' },
}

/** The translated status label, for tables and the save confirmation. */
export function useModelTestStatusLabel(): (status: ModelTestStatus) => string {
  const { t } = useTranslation('settings')
  return (status) => t(STATUS_META[status].labelKey)
}

/** "1,234 ms · 30,000,000 tokens/min" parts of an available result, localised. */
export function useModelTestFigures() {
  const { t, i18n } = useTranslation('settings')
  const format = (value: number) => value.toLocaleString(i18n.language)
  return {
    latency: (ms: number | null) => (ms === null ? '' : t('aiModel.test.latency', { ms: format(ms) })),
    tokensPerMinute: (count: number | null | undefined) =>
      (count === null || count === undefined ? t('aiModel.test.quotaUnknown') : t('aiModel.test.tokensPerMinute', { count: format(count) })),
  }
}
