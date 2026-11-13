/**
 * @fileoverview REST executor of `draft_prototype_revision` (docs/prototype-builder.md, part 2): the
 * approved instruction, exactly as the card showed it, starts one draft job. The draft is a preview:
 * when the job finishes, the prototype's page shows it with Apply and Discard; nothing is saved before.
 *
 * The summary goes to the model, in English, and names the job (= the draft id) so it can refer back.
 *
 * @module assistant/approvals/prototypeExecutors
 */
import { projectsApi } from '../../api/projectsApi'
import { startProjectJob } from './projectJobStart'
import type { WriteToolExecutionContext } from '../types'
import type { DraftPrototypeRevisionArgs } from './prototypeSchemas'

export async function draftPrototypeRevision(
  args: DraftPrototypeRevisionArgs, ctx: WriteToolExecutionContext,
): Promise<{ summary: string; data: { job_id: string; draft_id: string } }> {
  const jobId = await startProjectJob(ctx, args.project_id, (responseLanguage) =>
    projectsApi.startPrototypeDraft(args.project_id, args.document_id, args.instruction, responseLanguage))
  return {
    summary: `Started prototype draft job ${jobId}. When it finishes, the draft shows on the prototype's page `
      + 'with Apply and Discard; nothing is saved until the editor applies it there.',
    data: { job_id: jobId, draft_id: jobId },
  }
}
