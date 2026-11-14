/**
 * `draft_prototype_revision` (project): a change to a prototype drafted as a preview (docs/prototype-builder.md,
 * parts 2 and 3), from either an instruction in words or the ids of tester pins to incorporate. On approval the
 * SPA calls `POST /projects/{project_id}/prototypes/{document_id}/drafts` with `{instruction}` or `{pin_ids}`
 * and reports the job id; the draft is made on the newest version of that prototype's series and shows on the
 * prototype's page, where the editor previews it and applies or discards it. There is NO apply tool on purpose:
 * the only in-app Apply is the one beside the full preview.
 *
 * Pin ids only, never feedback text: the route reads the pins itself, refuses another series' and withholds
 * flagged ones, and writes the instruction. The approval card shows the instruction verbatim, or the selected
 * pins, and names the prototype (card-only, never a plan step: plan/schema.ts CARD_ONLY_WRITE_TOOLS).
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { idProperty, idSchema } from '../spec.js';
import { defineClientTool, idListProperty, q, stringProperty } from './define.js';

/** The drafts route's bounds (shared/prototype_drafts.py MAX_INSTRUCTION_CHARS, prototype_pins.py MAX_BATCH_PINS). */
export const MAX_DRAFT_INSTRUCTION_CHARS = 2000;
export const MAX_DRAFT_PINS = 50;

const draftSchema = z.object({
  project_id: idSchema,
  document_id: idSchema,
  instruction: z.string().trim().min(1).max(MAX_DRAFT_INSTRUCTION_CHARS).optional(),
  pin_ids: z.array(idSchema).min(1).max(MAX_DRAFT_PINS).optional(),
}).strict().refine((args) => (args.instruction === undefined) !== (args.pin_ids === undefined), {
  message: 'Give either instruction or pin_ids.',
});

export function createPrototypeDraftClientTools(): ClientToolDefinition[] {
  return [defineClientTool({
    name: 'draft_prototype_revision',
    pack: 'project',
    description: 'Propose a change to a prototype: the server drafts it on the newest version of that prototype as '
      + 'a preview; nothing is saved. Give either instruction (the change in words: read get_prototype_outline '
      + 'first to name screens and elements; one change per draft, said plainly, the user sees it verbatim) or '
      + 'pin_ids (up to 50 tester pins to incorporate: read get_prototype_feedback first and pass the pin ids of '
      + 'the items the user chose, never their text; flagged pins cannot be sent). The user previews the draft on '
      + 'the prototype’s page and applies or discards it there: you cannot apply it, and never say it was applied. '
      + 'A background job (minutes); list_project_jobs reports it.',
    properties: {
      project_id: idProperty('Project id (defaults to the project on screen).'),
      document_id: idProperty('Document id of the prototype (any version; defaults to the one on screen).'),
      instruction: stringProperty('The change, in the user’s words where they gave them.', MAX_DRAFT_INSTRUCTION_CHARS),
      pin_ids: idListProperty('Tester pin ids to incorporate (from get_prototype_feedback).', MAX_DRAFT_PINS),
    },
    required: ['project_id', 'document_id'],
    projectScoped: true,
    documentScoped: true,
    schema: draftSchema,
    summarize: (args) => {
      const pins = args.pin_ids?.length ?? 0;
      const plural = pins === 1 ? '' : 's';
      const what = args.pin_ids === undefined ? q(args.instruction ?? '', 300) : `incorporate ${String(pins)} tester pin${plural}`;
      return `Draft a revision of prototype ${args.document_id} in project ${args.project_id} `
        + `(a preview to apply on its page): ${what}`;
    },
  })];
}
