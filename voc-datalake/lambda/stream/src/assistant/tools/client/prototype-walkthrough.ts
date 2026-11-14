/**
 * `set_prototype_walkthrough` (project): a prototype's guided walkthrough saved as its next version
 * (docs/prototype-builder.md, Part 1). On approval the SPA calls `PUT /projects/{project_id}/prototypes/
 * {document_id}/walkthrough` with `{steps}`; the route re-validates them (its 400 names the step and the field)
 * and answers 409 when the series moved past `document_id`'s version. `steps: []` removes the steps.
 *
 * Drafting has no tool of its own: the model writes the steps itself from get_prototype_outline (the screens
 * and their text) and the PRD / PR/FAQ (get_documents), and the approval card previews them before anything is
 * saved. The page's **Draft with the assistant** is the draft route's job, not this tool. Card-only, never a
 * plan step (plan/schema.ts CARD_ONLY_WRITE_TOOLS).
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { idProperty, idSchema, type JsonSchemaProperties } from '../spec.js';
import { defineClientTool } from './define.js';

/** The route's bounds (shared/prototype_walkthrough.py). */
export const WALKTHROUGH_LIMITS = { steps: 10, titleChars: 80, bodyChars: 280, selectorChars: 512, routeChars: 300 } as const;

const share = z.number().min(0).max(1);
const stepSchema = z.object({
  title: z.string().trim().min(1).max(WALKTHROUGH_LIMITS.titleChars),
  body: z.string().trim().min(1).max(WALKTHROUGH_LIMITS.bodyChars),
  selector: z.string().trim().min(1).max(WALKTHROUGH_LIMITS.selectorChars).optional(),
  anchor: z.object({
    route: z.string().max(WALKTHROUGH_LIMITS.routeChars).optional(),
    bbox: z.object({ x: share, y: share, w: share, h: share }).strict(),
  }).strict().optional(),
}).strict().refine((step) => step.selector !== undefined || step.anchor !== undefined, {
  message: 'Each step needs a selector or an anchor.',
});

const STEP_PROPERTIES: JsonSchemaProperties[string] = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: WALKTHROUGH_LIMITS.titleChars },
    body: { type: 'string', maxLength: WALKTHROUGH_LIMITS.bodyChars, description: 'Plain text.' },
    selector: { type: 'string', maxLength: WALKTHROUGH_LIMITS.selectorChars },
    anchor: {
      type: 'object',
      description: 'When no selector fits: route = the hash of the prototype’s location without "#" ("" for any '
        + 'screen; leave it "" unless you know it), and a box as shares (0 to 1) of the viewport.',
      properties: {
        route: { type: 'string', maxLength: WALKTHROUGH_LIMITS.routeChars },
        bbox: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
      },
    },
  },
  required: ['title', 'body'],
};

export function createPrototypeWalkthroughClientTools(): ClientToolDefinition[] {
  return [defineClientTool({
    name: 'set_prototype_walkthrough',
    pack: 'project',
    description: 'Save a guided walkthrough on a prototype as its next version: up to 10 steps the viewer clicks '
      + 'through, each a short title, a plain-text body and where it points (a CSS selector, or an anchor: a screen '
      + 'route and a box as shares of the viewport). Write the steps from get_prototype_outline (screens and text) '
      + 'and the PRD / PR/FAQ, in the order a first-time viewer should follow; steps [] removes them. The user '
      + 'previews the steps on the card; the editor can point each one at an element afterwards.',
    properties: {
      project_id: idProperty('Project id (defaults to the project on screen).'),
      document_id: idProperty('Document id of the newest version of the prototype (defaults to the one on screen).'),
      steps: { type: 'array', maxItems: WALKTHROUGH_LIMITS.steps, items: STEP_PROPERTIES },
    },
    required: ['project_id', 'document_id', 'steps'],
    projectScoped: true,
    documentScoped: true,
    schema: z.object({
      project_id: idSchema,
      document_id: idSchema,
      steps: z.array(stepSchema).max(WALKTHROUGH_LIMITS.steps),
    }).strict(),
    summarize: (args) => (args.steps.length === 0
      ? `Remove the walkthrough of prototype ${args.document_id} in project ${args.project_id}.`
      : `Save a ${String(args.steps.length)}-step walkthrough on prototype ${args.document_id} in project ${args.project_id}.`),
  })];
}
