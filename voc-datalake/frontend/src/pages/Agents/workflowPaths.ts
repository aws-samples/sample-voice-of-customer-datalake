/**
 * @fileoverview The library routes of one workflow (`agents/workflows/:workflowId` in routes.tsx) and of a default
 * engineering flow's unsaved copy (`agents/workflows/templates/:templateId`).
 *
 * @module pages/Agents/workflowPaths
 */

export const workflowPath = (workflowId: string): string => `/agents/workflows/${encodeURIComponent(workflowId)}`

export const workflowTemplatePath = (templateId: string): string =>
  `/agents/workflows/templates/${encodeURIComponent(templateId)}`
