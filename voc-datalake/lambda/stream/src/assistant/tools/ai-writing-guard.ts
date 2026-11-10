/**
 * Refuses, before any approval card, a PR/FAQ / PRD write the caller's way of working
 * forbids (runtime/ai-writing.ts, docs/ways-of-working.md):
 *
 *   - `generate_document` / `merge_documents` into a type the AI may not write with them;
 *   - `propose_plan` with a step that would have a PR/FAQ or PRD written autonomously
 *     (generate_document, or merge_documents into anything but `custom`) when the person
 *     is not AI-driven. A plan's `update_document` step is refused by the Projects API at
 *     run time when its target is a PR/FAQ / PRD (the target's type is not in the plan).
 *
 * `update_document` checks its target's stored type in its own precheck
 * (client/project.ts), because that needs a read. The REST routes enforce the same
 * rules; this keeps the user from approving a card that would only be refused.
 */
import { z } from 'zod';
import { docTypeLabel, isGatedDocType, mayWriteInteractively, type AiWritingPolicy } from '../runtime/ai-writing.js';

/** What the model reads when a card is refused for an interactive write. */
export function interactiveRefusal(docType: unknown): string {
  const label = isGatedDocType(docType) ? docTypeLabel(docType) : 'this document';
  return `not permitted — the user works Human-driven on ${label}s: they write it, you coach. Do not draft or `
    + `rewrite it. Offer to coach them section by section or to review their draft; an administrator can unlock `
    + `"${label} with AI" for them.`;
}

const AUTONOMOUS_REFUSAL = 'not permitted — agents and approved plans may not write a PR/FAQ or PRD for this user '
  + '(they do not work AI-driven). Leave that step out of the plan; the user can write the document, or generate it '
  + 'in the chat when their way of working allows.';

const planStepsSchema = z.object({
  steps: z.array(z.object({
    write: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }).loose().optional(),
  }).loose()),
}).loose();

/** True when a plan step would have a PR/FAQ or PRD written (a placeholder type counts). */
function writesGatedDocument(tool: string, args: Record<string, unknown> | undefined): boolean {
  if (tool === 'generate_document') return true;
  return tool === 'merge_documents' && args?.output_type !== 'custom';
}

function planRefusal(args: Record<string, unknown>, policy: AiWritingPolicy): string | undefined {
  if (policy.autonomous) return undefined;
  const parsed = planStepsSchema.safeParse(args);
  if (!parsed.success) return undefined;
  const gated = parsed.data.steps.some((step) => step.write !== undefined && writesGatedDocument(step.write.tool, step.write.args));
  return gated ? AUTONOMOUS_REFUSAL : undefined;
}

/** The argument naming the written document's type, per interactive write tool. */
const DOC_TYPE_ARG: Readonly<Record<string, string>> = { generate_document: 'doc_type', merge_documents: 'output_type' };

/** The refusal text for a client tool call, or undefined when the policy allows it. */
export function aiWritingRefusal(
  toolName: string, args: Record<string, unknown>, policy: AiWritingPolicy | undefined,
): string | undefined {
  if (policy === undefined) return undefined;
  if (toolName === 'propose_plan') return planRefusal(args, policy);
  const typeArg = DOC_TYPE_ARG[toolName];
  if (typeArg === undefined) return undefined;
  const docType = args[typeArg];
  return mayWriteInteractively(policy, docType) ? undefined : interactiveRefusal(docType);
}
