/**
 * @fileoverview The library routes of one workflow (`agents/workflows/:workflowId` in routes.tsx) and of a default
 * engineering flow's unsaved copy (`agents/workflows/templates/:templateId`), and the run monitor's of a run started
 * from a flow (`agents/engineering/:runId`).
 *
 * @module pages/Agents/workflowPaths
 */
import { agentsPath } from './agentsPaths'

export const workflowPath = (workflowId: string): string => `/agents/workflows/${encodeURIComponent(workflowId)}`

export const workflowTemplatePath = (templateId: string): string =>
  `/agents/workflows/templates/${encodeURIComponent(templateId)}`

/**
 * Where a flow's runs are listed (7.51.00): Agents → Runs narrowed to the flow (`/agents/runs?flow=`, this month's;
 * RunWorkspace/runsFilters.ts reads the filter).
 */
export const flowRunsPath = (workflowId: string): string =>
  `${agentsPath({ view: 'runs' })}?${new URLSearchParams({ flow: workflowId }).toString()}`

/** An engineering run's workspace (`agents/engineering/:runId`), where a run started from a flow's page opens. */
export const engineeringRunPagePath = (runId: string): string => `/agents/engineering/${encodeURIComponent(runId)}`
