/**
 * @fileoverview Starting a project job from an approved card (a prototype build, a prototype draft): the job
 * runs in the reply language the card was shown with (else the app's current one), and the project's jobs list
 * is refreshed so the Background Jobs panel and the prototype's draft banner pick it up.
 *
 * @module assistant/approvals/projectJobStart
 */
import { keysFor, refreshAfterWrite } from './invalidation'
import { currentJobEnvironment, shownOf } from './shown'
import type { WriteToolExecutionContext } from '../types'

/** Runs `start` with the card's reply language, refreshes `projectId`'s jobs, and answers the new job's id. */
export async function startProjectJob(
  ctx: WriteToolExecutionContext, projectId: string,
  start: (responseLanguage: string) => Promise<{ job_id: string }>,
): Promise<string> {
  const env = shownOf(ctx)?.job ?? currentJobEnvironment()
  const { job_id: jobId } = await start(env.responseLanguage)
  refreshAfterWrite(ctx, keysFor.projectJobs(projectId))
  return jobId
}
