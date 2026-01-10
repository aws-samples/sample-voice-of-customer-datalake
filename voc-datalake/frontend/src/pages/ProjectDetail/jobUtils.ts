/**
 * Utility functions for job-related operations
 */

/**
 * Helper to get job type display name
 */
export function getJobTypeLabel(jobType: string): string {
  switch (jobType) {
    case 'research': return 'Research'
    case 'generate_prd': return 'PRD Generation'
    case 'generate_prfaq': return 'PR-FAQ Generation'
    case 'generate_personas': return 'Persona Generation'
    case 'import_persona': return 'Persona Import'
    default: return 'Document Merge'
  }
}

/**
 * Check if a job is stale (running but not updated in 10+ minutes)
 */
export function isJobStale(status: string, updatedAt: string | undefined, currentTime: number): boolean {
  if (status !== 'running' && status !== 'pending') return false
  if (!updatedAt) return false
  const TEN_MINUTES_MS = 10 * 60 * 1000
  return new Date(updatedAt).getTime() < currentTime - TEN_MINUTES_MS
}
