/**
 * @fileoverview Reads the evidence for each onboarding step and derives the
 * checklist (`deriveSteps`).
 *
 * Request budget on Home: the categories config is already read there; the
 * onboarding GET (preference + signals) is one call; the caller's assistant
 * sessions and projects are one call each, under the SAME query keys the
 * assistant sidebar and the Projects page use (shared cache, shared
 * invalidation). The scraper list and the app configs (review pages, app
 * connectors) are read only when the signals cannot prove a source. Only the visible buddy mounts this hook, so a hidden buddy costs
 * nothing beyond the preference GET.
 *
 * A failed read counts as "not done yet" rather than spinning forever: the
 * step's link still takes the user where to do it.
 *
 * @module pages/Home/onboarding/useOnboardingSteps
 */
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '../../../api/projectsApi'
import { projectsKey } from '../../../api/projectQueryKeys'
import { scrapersApi } from '../../../api/scrapersApi'
import { listSessions } from '../../../assistant/sessions/sessionsApi'
import { SESSIONS_QUERY_KEY } from '../../../assistant/sessions/queryKeys'
import { useCanSetUp } from '../../../components/ScopeNotice/useViewerScope'
import { useCategoriesConfig } from '../../../hooks/useCategories'
import { useAuthStore } from '../../../store/authStore'
import { useConfigStore } from '../../../store/configStore'
import { deriveSteps, needsScraperList } from './onboardingSteps'
import type { OnboardingPreference } from '../../../api/onboardingApi'
import type { OnboardingStep } from './onboardingSteps'
import { allAppConfigsKey, scrapersKey } from '../../../api/queryKeys'
import { getPluginManifests } from '../../../plugins'
import { supportsAppConfigs } from '../../Scrapers/scraper-helpers'

/** The plugins whose app configs are Data sources cards (pages/Scrapers/Scrapers.tsx). */
const appConfigPluginIds = (): string[] =>
  getPluginManifests().filter((p) => supportsAppConfigs(p.id)).map((p) => p.id)

/** The query's data, the `fallback` once it failed, or undefined while it is loading. */
function settled<T>(query: { data: T | undefined; isError: boolean }, fallback: T): T | undefined {
  return query.isError ? fallback : query.data
}

export function useOnboardingSteps(signals: OnboardingPreference['signals'] | undefined): OnboardingStep[] {
  const canSetUp = useCanSetUp()
  const userSub = useAuthStore().user?.sub
  const enabled = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const categories = useCategoriesConfig()
  const sessions = useQuery({ queryKey: SESSIONS_QUERY_KEY, queryFn: listSessions, enabled })
  const projects = useQuery({ queryKey: projectsKey(), queryFn: projectsApi.getProjects, enabled })
  // Only the source step (an administrator's) needs the scraper list and the app configs.
  const needsSources = enabled && canSetUp && needsScraperList(signals)
  const scrapers = useQuery({ queryKey: scrapersKey(), queryFn: scrapersApi.getScrapers, enabled: needsSources })
  // Under the all-app-configs root: every save, delete and approval that invalidates it refreshes this count.
  const appConfigs = useQuery({
    queryKey: allAppConfigsKey('count'),
    queryFn: () => scrapersApi.countAppConfigs(appConfigPluginIds()),
    enabled: needsSources,
  })

  return deriveSteps({
    canSetUp,
    userSub,
    categories: categories.isError ? [] : categories.data?.categories,
    signals,
    scraperCount: settled(scrapers, { scrapers: [] })?.scrapers.length,
    appConfigCount: settled(appConfigs, 0),
    sessionCount: settled(sessions, [])?.length,
    projects: settled(projects, { projects: [] })?.projects,
  })
}
