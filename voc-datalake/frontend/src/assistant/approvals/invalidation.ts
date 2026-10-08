/**
 * @fileoverview The react-query keys each write tool must refresh, so a page
 * that is open behind the assistant shows the write without a reload.
 *
 * Shared keys are imported from where the pages read them; the rest are the
 * literal keys the owning page uses (grep the page for `queryKey`), listed once
 * here with the page that owns them.
 *
 * @module assistant/approvals/invalidation
 */
import { allProjectDetailsKey, projectKey, projectsKey } from '../../api/projectQueryKeys'
import { feedbackFormsKey } from '../../api/feedbackFormQueryKeys'
import { CATEGORY_CHANGE_KEYS } from '../../api/feedbackCategoryApi'
import { projectJobsKey, productContextKey } from '../../pages/ProjectDetail/useProjectData'
import { agentsKeys } from '../../api/agentsApi'
import { workflowsKeys } from '../../api/workflowsApi'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

/** ProblemAnalysis/useProblemResolution.ts */
const RESOLVED_PROBLEMS_KEY = ['resolved-problems'] as const
/** Settings/Settings.tsx */
const BRAND_SETTINGS_KEY = ['brand-settings'] as const
/** Scrapers/Scrapers.tsx, Settings/LogsSection.tsx */
const SCRAPERS_KEY = ['scrapers'] as const
/** api/memoryApi.ts `memoryKeys.all()` — every Memory page list, review queue and import. */
const MEMORY_KEY = ['memory'] as const
/** api/companyContextApi.ts `companyContextKey()` / `myContextKey()` (Settings). */
const COMPANY_CONTEXT_KEY = ['company-context'] as const
const MY_CONTEXT_KEY = ['my-context'] as const
/** api/designSystemApi.ts `designSystemKey()` (Settings). */
const DESIGN_SYSTEM_KEY = ['design-system'] as const
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
  resolvedProblems: (): QueryKey[] => [RESOLVED_PROBLEMS_KEY],
  /** Every feedback list/detail and category-bucketed metric (owned by api/feedbackCategoryApi). */
  feedbackCategory: (): QueryKey[] => [...CATEGORY_CHANGE_KEYS],
  feedbackForms: (): QueryKey[] => [feedbackFormsKey()],
  scrapers: (): QueryKey[] => [SCRAPERS_KEY],
  brandSettings: (): QueryKey[] => [BRAND_SETTINGS_KEY],
  memory: (): QueryKey[] => [MEMORY_KEY],
  companyContext: (): QueryKey[] => [COMPANY_CONTEXT_KEY, companyPreviewKeys.companyContext()],
  myContext: (): QueryKey[] => [MY_CONTEXT_KEY, companyPreviewKeys.myContext()],
  designSystem: (): QueryKey[] => [DESIGN_SYSTEM_KEY, companyPreviewKeys.designSystem()],
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
