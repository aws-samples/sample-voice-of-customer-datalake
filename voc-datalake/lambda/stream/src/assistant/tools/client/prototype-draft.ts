/**
 * `draft_prototype_revision` (project): a change to a prototype asked for in words, drafted as a preview
 * (docs/prototype-builder.md, part 2). On approval the SPA calls
 * `POST /projects/{project_id}/prototypes/{document_id}/drafts` with `{instruction}` and reports the job id;
 * the draft is made on the newest version of that prototype's series and shows on the prototype's page,
 * where the editor previews it and applies or discards it. There is NO apply tool on purpose: the only
 * in-app Apply is the one beside the full preview.
 *
 * The instruction is the editor's own, shown verbatim on the approval card, which also names the
 * prototype (not a FREE_TEXT_FIELD of a plan: this tool is card-only, plan/schema.ts
 * CARD_ONLY_WRITE_TOOLS). The route checks access and the document itself.
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { idProperty, idSchema } from '../spec.js';
import { defineClientTool, q, stringProperty } from './define.js';

/** The drafts route's bound (shared/prototype_drafts.py MAX_INSTRUCTION_CHARS). */
export const MAX_DRAFT_INSTRUCTION_CHARS = 2000;

export function createPrototypeDraftClientTools(): ClientToolDefinition[] {
  return [defineClientTool({
    name: 'draft_prototype_revision',
    pack: 'project',
    description: 'Propose a change to a prototype in words: the server drafts it on the newest version of that '
      + 'prototype as a preview; nothing is saved. The user previews the draft on the prototype’s page and '
      + 'applies or discards it there: you cannot apply it, and never say it was applied. Read get_prototype_outline '
      + 'first to name screens and elements; one change per draft, said plainly (the user sees it verbatim). A '
      + 'background job (minutes); list_project_jobs reports it.',
    properties: {
      project_id: idProperty('Project id (defaults to the project on screen).'),
      document_id: idProperty('Document id of the prototype (any version; defaults to the one on screen).'),
      instruction: stringProperty('The change, in the user’s words where they gave them.', MAX_DRAFT_INSTRUCTION_CHARS),
    },
    required: ['project_id', 'document_id', 'instruction'],
    projectScoped: true,
    documentScoped: true,
    schema: z.object({
      project_id: idSchema,
      document_id: idSchema,
      instruction: z.string().trim().min(1).max(MAX_DRAFT_INSTRUCTION_CHARS),
    }).strict(),
    summarize: (args) => `Draft a revision of prototype ${args.document_id} in project ${args.project_id} `
      + `(a preview to apply on its page): ${q(args.instruction, 300)}`,
  })];
}
