/**
 * @fileoverview REST executor of `draft_prototype_revision` (docs/prototype-builder.md, parts 2 and 3): the
 * approved instruction, or the approved pin ids, exactly as the card showed them, start one draft job. The
 * draft is a preview: when the job finishes, the prototype's page shows it with Apply and Discard (and, for
 * pins, each one's outcome); nothing is saved before.
 *
 * The summary goes to the model, in English, and names the job (= the draft id) so it can refer back.
 *
 * @module assistant/approvals/prototypeExecutors
 */
import { projectsApi } from '../../api/projectsApi'
import { startProjectJob } from './projectJobStart'
import type { WriteToolExecutionContext } from '../types'
import { keysFor, refreshAfterWrite } from './invalidation'
import type { DraftPrototypeRevisionArgs, SetPrototypeWalkthroughArgs } from './prototypeSchemas'

export async function draftPrototypeRevision(
  args: DraftPrototypeRevisionArgs, ctx: WriteToolExecutionContext,
): Promise<{ summary: string; data: { job_id: string; draft_id: string } }> {
  const request = 'pin_ids' in args ? { pin_ids: args.pin_ids } : { instruction: args.instruction }
  const jobId = await startProjectJob(ctx, args.project_id, (responseLanguage) =>
    projectsApi.startPrototypeDraft(args.project_id, args.document_id, request, responseLanguage))
  const what = 'pin_ids' in args ? `incorporating ${String(args.pin_ids.length)} tester pin(s)` : 'from the instruction'
  return {
    summary: `Started prototype draft job ${jobId} (${what}). When it finishes, the draft shows on the prototype's page `
      + 'with Apply and Discard; nothing is saved until the editor applies it there.',
    data: { job_id: jobId, draft_id: jobId },
  }
}

/** `set_prototype_walkthrough` (Part 1): the approved steps saved as the next version (`[]` removes them). */
export async function setPrototypeWalkthrough(
  args: SetPrototypeWalkthroughArgs, ctx: WriteToolExecutionContext,
): Promise<{ summary: string; data: { document_id: string | null; version: number | null } }> {
  const saved = await projectsApi.savePrototypeWalkthrough(args.project_id, args.document_id, args.steps, crypto.randomUUID())
  refreshAfterWrite(ctx, keysFor.projectRecord(args.project_id))
  const what = args.steps.length === 0 ? 'Removed the walkthrough' : `Saved a ${String(args.steps.length)}-step walkthrough`
  const version = saved?.version ?? null
  return {
    summary: `${what} as version ${version === null ? '(unknown)' : String(version)} of the prototype (document ${saved?.document_id ?? 'unknown'}).`,
    data: { document_id: saved?.document_id ?? null, version },
  }
}
