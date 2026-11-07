/**
 * The assist-job poll answer (`lambda/shared/assist_jobs.py`): `{status, result, error, ...}`,
 * where `result` is exactly the body the route used to answer synchronously. Read by
 * `assist-job.ts` here and by the SPA's `frontend/src/api/assistJobs.ts`, which imports
 * this module.
 *
 * Pure on purpose: zod only, because the SPA bundles it.
 */
import { z } from 'zod';

export const assistJobPollSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  result: z.unknown().optional(),
  error: z.string().nullish(),
});
