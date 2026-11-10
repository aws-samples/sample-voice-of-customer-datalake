/**
 * @fileoverview The library route of one workflow (`agents/workflows/:workflowId` in routes.tsx).
 *
 * @module pages/Agents/workflowPaths
 */

export const workflowPath = (workflowId: string): string => `/agents/workflows/${encodeURIComponent(workflowId)}`
