/**
 * @fileoverview The library routes of one workflow (`agents/workflows/:workflowId` in routes.tsx) and of a default
 * engineering flow's unsaved copy (`agents/workflows/templates/:templateId`), and the run monitor's of a run started
 * from a flow (`agents/engineering/:runId`).
 *
 * @module pages/Agents/workflowPaths
 */

export const workflowPath = (workflowId: string): string => `/agents/workflows/${encodeURIComponent(workflowId)}`

export const workflowTemplatePath = (templateId: string): string =>
  `/agents/workflows/templates/${encodeURIComponent(templateId)}`

/**
 * Where a flow's runs are listed: Agents → Spend grouped by run, narrowed to the flow (`?tab=spend&by=run&workflow=`;
 * there is no other list of runs yet). A run is listed there once it has used something (its MicroVM time or tokens).
 */
export const flowRunsPath = (workflowId: string): string =>
  `/agents?${new URLSearchParams({ tab: 'spend', by: 'run', workflow: workflowId }).toString()}`

/** An engineering run's monitor (`agents/engineering/:runId`), where a run started from a flow's page opens. */
export const engineeringRunPagePath = (runId: string): string => `/agents/engineering/${encodeURIComponent(runId)}`
