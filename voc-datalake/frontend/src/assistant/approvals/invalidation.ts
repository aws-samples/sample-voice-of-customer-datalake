/**
 * @fileoverview The react-query keys each write tool must refresh, so a page
 * that is open behind the assistant shows the write without a reload.
 *
 * Shared keys are imported from where the pages read them (`api/queryKeys.ts`
 * and the api modules); the rest are the literal keys the owning page uses (grep
 * the page for `queryKey`), listed once here with the page that owns them.
 *
 * @module assistant/approvals/invalidation
 */
import { allProjectDetailsKey, projectKey, projectsKey } from '../../api/projectQueryKeys'
import { feedbackFormsKey } from '../../api/feedbackFormQueryKeys'
import { CATEGORY_CHANGE_KEYS } from '../../api/feedbackCategoryApi'
import { userCategoryAccessKey } from '../../api/categoryAccessApi'
import { projectJobsKey, productContextKey } from '../../pages/ProjectDetail/useProjectData'
import { agentsKeys } from '../../api/agentsApi'
import { workflowsKeys } from '../../api/workflowsApi'
import { plansKeys } from '../../api/plansApi'
import { memoryKeys } from '../../api/memoryApi'
import { companyContextKey, myContextKey } from '../../api/companyContextApi'
import { designSystemKey } from '../../api/designSystemApi'
import {
  allAppConfigsKey, appConfigsKey, resolvedProblemsKey, scrapersKey, sourceRunStatusKey, sourcesStatusKey, usersKey,
} from '../../api/queryKeys'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

/** Settings/Settings.tsx */
const BRAND_SETTINGS_KEY = ['brand-settings'] as const
/** Settings/useSourceSchedule.ts (every plugin's schedule on/off and circuit). */
const SOURCES_STATUS_KEY = sourcesStatusKey()
/** api/radarApi.ts `radarKeys` (the Radar page and Settings → Sources → Radar) all start with this. */
const RADAR_KEY = ['radar'] as const
/** Card-local keys of the company previews' current-value reads (not shared with Settings, like the brand preview). */
export const companyPreviewKeys = {
  companyContext: () => ['assistant', 'company-context-preview'] as const,
  myContext: () => ['assistant', 'my-context-preview'] as const,
  designSystem: () => ['assistant', 'design-system-preview'] as const,
}

export const keysFor = {
  projectList: (): QueryKey[] => [projectsKey()],
  projectRecord: (projectId: string): QueryKey[] => [projectKey(projectId), projectsKey(), allProjectDetailsKey()],
  projectJobs: (projectId: string): QueryKey[] => [projectJobsKey(projectId)],
  productContext: (projectId: string): QueryKey[] => [productContextKey(projectId)],
  resolvedProblems: (): QueryKey[] => [resolvedProblemsKey()],
  /** Every feedback list/detail and category-bucketed metric (owned by api/feedbackCategoryApi). */
  feedbackCategory: (): QueryKey[] => [...CATEGORY_CHANGE_KEYS],
  feedbackForms: (): QueryKey[] => [feedbackFormsKey()],
  scrapers: (): QueryKey[] => [scrapersKey()],
  /** Every Radar read (brands, overview, releases after a scan). */
  radar: (): QueryKey[] => [RADAR_KEY],
  /** A manual source run (every plugin's latest-run badge). */
  sourceRuns: (): QueryKey[] => [sourceRunStatusKey()],
  /** A plugin schedule turned on or off. */
  sources: (): QueryKey[] => [SOURCES_STATUS_KEY],
  /** Every assistant plan list and progress view (api/plansApi.ts). */
  plans: (): QueryKey[] => [plansKeys.all()],
  /** A new app-review connector: that plugin's list and the all-plugins list. */
  appConfigs: (source: string): QueryKey[] => [appConfigsKey(source), allAppConfigsKey()],
  brandSettings: (): QueryKey[] => [BRAND_SETTINGS_KEY],
  /** The Cognito user list (a created or edited user). */
  users: (): QueryKey[] => [usersKey()],
  /** One user's stored category/source grant (Settings → Users → Category access). */
  userAccess: (username: string): QueryKey[] => [userCategoryAccessKey(username)],
  memory: (): QueryKey[] => [memoryKeys.all()],
  companyContext: (): QueryKey[] => [companyContextKey(), companyPreviewKeys.companyContext()],
  myContext: (): QueryKey[] => [myContextKey(), companyPreviewKeys.myContext()],
  designSystem: (): QueryKey[] => [designSystemKey(), companyPreviewKeys.designSystem()],
  /** The agent list (a new agent). */
  agents: (): QueryKey[] => [agentsKeys.list()],
  /** One agent: its record, runs and the list (enabled / last run show there). */
  agent: (agentId: string): QueryKey[] => [agentsKeys.detail(agentId), agentsKeys.runs(agentId), agentsKeys.list()],
  /** The workflow library and every workflow detail (agents read their workflow from there). */
  workflows: (): QueryKey[] => [workflowsKeys.all()],
}

export async function invalidateKeys(queryClient: QueryClient, keys: readonly QueryKey[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}

/** Fire-and-forget after a write: it already succeeded, so a slow refetch must not hold the outcome. */
export function refreshAfterWrite(ctx: { readonly queryClient: QueryClient }, keys: readonly QueryKey[]): void {
  void invalidateKeys(ctx.queryClient, keys)
}
