/**
 * @fileoverview The in-app micro-feedback settings (`GET /settings/app-feedback`, 7.66.00), shared by every control on
 * the page: one GET, cached as configuration (api/queryPolicies.ts `settings`), never retried (an error reads as off),
 * and off until it answers.
 *
 * @module components/MicroFeedback/useAppFeedbackConfig
 */
import { useQuery } from '@tanstack/react-query'
import { APP_FEEDBACK_OFF, appFeedbackApi, appFeedbackKey } from '../../api/appFeedbackApi'
import type { AppFeedbackConfig } from '../../api/appFeedbackApi'
import { useConfigStore } from '../../store/configStore'

export function useAppFeedbackConfig(): AppFeedbackConfig {
  const enabled = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const query = useQuery({ queryKey: appFeedbackKey(), queryFn: appFeedbackApi.get, enabled, retry: false })
  return query.data ?? APP_FEEDBACK_OFF
}
