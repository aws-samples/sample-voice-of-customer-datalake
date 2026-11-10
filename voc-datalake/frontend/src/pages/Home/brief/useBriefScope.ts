/**
 * @fileoverview What every morning-brief hook needs: the caller (their `sub` keys the
 * self-scoped cache entries), whether an API is configured, the query client, and the
 * app's language (the brief follows it unless the reader chose one; docs/briefing.md).
 * @module pages/Home/brief/useBriefScope
 */
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../../store/authStore'
import { useConfigStore } from '../../../store/configStore'

export interface BriefScope {
  sub: string
  enabled: boolean
  queryClient: QueryClient
  appLanguage: string
}

export function useBriefScope(): BriefScope {
  const { i18n } = useTranslation()
  const sub = useAuthStore().user?.sub ?? ''
  const enabled = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return { sub, enabled, queryClient: useQueryClient(), appLanguage: i18n.language }
}
