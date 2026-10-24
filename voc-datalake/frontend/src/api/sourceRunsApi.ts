/**
 * @fileoverview Start a plugin's ingestor by hand (`POST /sources/{source}/run`,
 * admin-only, `integrations_handler.py`), for the assistant's `run_source` tool.
 *
 * Its own module (not `api.runSource` in `client.ts`) so the call goes through
 * the imported `fetchApi` — the seam the approval-card specs and the plan
 * write-request lockstep observe. No body: every app config of the source runs.
 *
 * @module api/sourceRunsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'

const StartedSchema = z.object({
  source: z.string().catch(''),
  execution_id: z.string().catch(''),
})

export async function startSourceRun(source: string): Promise<{ source: string; execution_id: string }> {
  const raw = await fetchApi<unknown>(`/sources/${encodeURIComponent(source)}/run`, { method: 'POST' })
  return StartedSchema.parse(raw ?? {})
}
