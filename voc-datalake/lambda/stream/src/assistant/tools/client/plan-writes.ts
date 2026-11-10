/**
 * Write tools added for plan mode that are useful on their own too
 * (docs/assistant-plan-mode.md → "New tools"):
 *
 *   - `run_source` (scrapers, admin): `POST /sources/{source}/run` — starts the
 *     source's ingestor now; the result carries the `execution_id` get_source_run
 *     and a plan's `source_run` wait read.
 *   - `set_source_enabled` (scrapers, admin): `PUT /sources/{source}/enable|disable`.
 *   - `build_prototype` (project): `POST /projects/{project_id}/build-prototype`
 *     — a background job. Its arguments keep the route's body names
 *     (`projects_handler.api_build_prototype`): `title`, `feedback` (the two
 *     FREE_TEXT_FIELDS), `base_prototype_id` (the prototype `feedback` revises),
 *     `source_prd_id` / `source_prfaq_id` (build from these instead of the newest).
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { idProperty, idSchema } from '../spec.js';
import { defineClientTool, presentParts, q, stringProperty } from './define.js';
import { RUN_SOURCE_IDS, SCHEDULED_SOURCE_IDS } from './scraper-schemas.js';

const runSource = defineClientTool({
  name: 'run_source',
  pack: 'scrapers',
  description: 'Run a data source\u2019s import now (admin): every configured app of an app-review source, the GitHub '
    + 'Issues repositories, the S3 import folder, the synthetic generator or every web_reviews page. New reviews arrive in the background; '
    + 'the result has an execution_id for get_source_run. Web scrapers run with run_scraper instead.',
  properties: { source: { type: 'string', enum: [...RUN_SOURCE_IDS], description: 'The data source to run.' } },
  required: ['source'],
  schema: z.object({ source: z.enum(RUN_SOURCE_IDS) }).strict(),
  summarize: (args) => `Run the ${args.source} import now.`,
});

/**
 * `set_source_enabled` (scrapers, admin): `PUT /sources/{source}/enable|disable`
 * — turns a plugin's schedule on or off. Enabling also closes a tripped circuit
 * breaker (integrations_handler.enable_source). Plan-mode eligible like run_source.
 */
const setSourceEnabled = defineClientTool({
  name: 'set_source_enabled',
  pack: 'scrapers',
  description: 'Turn a data source plugin\u2019s schedule on or off (admin). enabled=true starts its scheduled imports '
    + '(and closes a tripped circuit breaker); enabled=false stops them — nothing already imported is touched. '
    + 'Only plugins with a schedule can be toggled; run a source once with run_source instead.',
  properties: {
    source: { type: 'string', enum: [...SCHEDULED_SOURCE_IDS], description: 'The plugin whose schedule changes.' },
    enabled: { type: 'boolean', description: 'true = scheduled imports on; false = off.' },
  },
  required: ['source', 'enabled'],
  schema: z.object({ source: z.enum(SCHEDULED_SOURCE_IDS), enabled: z.boolean() }).strict(),
  summarize: (args) => `${args.enabled ? 'Enable' : 'Disable'} the ${args.source} schedule.`,
});

const PROTOTYPE_LIMITS = { titleChars: 200, feedbackChars: 4000 } as const;

const buildPrototype = defineClientTool({
  name: 'build_prototype',
  pack: 'project',
  description: 'Build an interactive HTML prototype from the project\u2019s PRD and/or PR/FAQ (the newest of each '
    + 'unless source_prd_id / source_prfaq_id name others). With feedback and base_prototype_id it revises that '
    + 'prototype around the feedback. A background job (minutes); list_project_jobs reports progress.',
  properties: {
    project_id: idProperty('Project id (defaults to the project on screen).'),
    title: stringProperty('Prototype title (default "Prototype").', PROTOTYPE_LIMITS.titleChars),
    feedback: stringProperty('What to change in a revision of base_prototype_id.', PROTOTYPE_LIMITS.feedbackChars),
    base_prototype_id: idProperty('The prototype to revise (with feedback).'),
    source_prd_id: idProperty('Build from this PRD instead of the newest.'),
    source_prfaq_id: idProperty('Build from this PR/FAQ instead of the newest.'),
  },
  required: ['project_id'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    title: z.string().trim().min(1).max(PROTOTYPE_LIMITS.titleChars).optional(),
    feedback: z.string().trim().min(1).max(PROTOTYPE_LIMITS.feedbackChars).optional(),
    base_prototype_id: idSchema.optional(),
    source_prd_id: idSchema.optional(),
    source_prfaq_id: idSchema.optional(),
  }).strict(),
  summarize: (args) => {
    const parts = presentParts([
      args.title !== undefined && `title ${q(args.title)}`,
      args.base_prototype_id !== undefined && `revising ${args.base_prototype_id}`,
    ]);
    const detail = parts === '' ? '' : ` (${parts})`;
    return `Build a prototype in project ${args.project_id}${detail}.`;
  },
});

export function createPlanWriteClientTools(): ClientToolDefinition[] {
  return [runSource, setSourceEnabled, buildPrototype];
}
