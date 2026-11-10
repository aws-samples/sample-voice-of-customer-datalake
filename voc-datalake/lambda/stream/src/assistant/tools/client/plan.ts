/**
 * Plan-mode client tools of the `core` pack.
 *
 *   - `propose_plan` (deviation 2 of the integrator's brief): its arguments ARE a
 *     `voc-plan/1` plan. `validate` runs `validatePlan` for this caller (packs
 *     they may use, admin gating, every literal against the write tool's own
 *     schema): a valid plan ends the run with the ordinary approval interrupt and
 *     the SPA shows a plan card; an invalid one is answered with the error list
 *     so the model can fix it — no card. On approval the SPA calls
 *     `POST /agents/plans` and resumes with `{status:'executed', data:{plan_id}}`.
 *     Never a plan step itself (`PLAN_CONTROL_TOOLS`) and never pre-approvable.
 *   - `cancel_plan {plan_id}`: the SPA calls `POST /agents/plans/{plan_id}/cancel`.
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { catalogueArgsSchemaFor } from '../../plan/catalogue-args.js';
import { PLAN_FIELD_LIMITS, PLAN_LIMITS, PLAN_SCHEMA } from '../../plan/schema.js';
import { validatePlan } from '../../plan/validate.js';
import { clip } from '../format.js';
import { toolSpec } from '../spec.js';
import { planIdSchema, planPacksFor, type CatalogueSource } from '../server/plan.js';
import { defineClientTool, q } from './define.js';

const MAX_ERROR_TEXT = 4000;

const STEP_PROPERTY = {
  type: 'object',
  description: '{id: "s1", pack, kind: write|wait|think, title, after?: [step ids], produces?: [output names], '
    + 'write?: {tool, args}, wait?: {for, ...}, think?: {brief}} — see plan_catalogue for the rules.',
};

const PROPOSE_DESCRIPTION = 'Propose a multi-step plan the user approves ONCE; it then runs in the background '
  + 'step by step, across pages. Use it for a request with several steps (e.g. connect an app, import its reviews, '
  + 'analyse them, create a project with personas and a document). First call plan_catalogue, resolve ids and facts '
  + 'with plan_lookup, then send the whole plan here. Literal arguments are shown to the user exactly; put '
  + '"{{s<n>.<output>}}" where a value comes from an earlier step and "{{free}}" only on a free-text field. An '
  + 'invalid plan comes back as a list of errors: fix them and propose again. Requires the user\u2019s approval: '
  + 'they see a plan card and nothing runs unless they approve it; never say the plan ran before the result has status "executed".';

/** The validation errors as the tool result the model reads (bounded). */
function errorText(errors: readonly { step?: string; field?: string; message: string }[]): string {
  return clip(`the plan is not valid — fix every error and propose it again: ${JSON.stringify(errors)}`, MAX_ERROR_TEXT);
}

function proposePlan(catalogue: CatalogueSource): ClientToolDefinition {
  return {
    kind: 'client',
    name: 'propose_plan',
    pack: 'core',
    risk: 'write',
    spec: toolSpec('propose_plan', PROPOSE_DESCRIPTION, {
      schema: { type: 'string', enum: [PLAN_SCHEMA] },
      goal: { type: 'string', maxLength: PLAN_FIELD_LIMITS.goalChars, description: 'One line: what the plan achieves.' },
      steps: { type: 'array', maxItems: PLAN_LIMITS.steps, items: STEP_PROPERTY, description: 'The steps, in order.' },
    }, ['schema', 'goal', 'steps']),
    validate(input, ctx) {
      const result = validatePlan(input, {
        isAdmin: ctx.isAdmin,
        packsAllowed: planPacksFor(ctx.isAdmin),
        argsSchemaFor: catalogueArgsSchemaFor(catalogue()),
      });
      return result.ok ? { ok: true, args: result.plan } : { ok: false, error: errorText(result.errors) };
    },
    summarize(args) {
      const goal = typeof args.goal === 'string' ? args.goal : 'the plan';
      const steps = Array.isArray(args.steps) ? args.steps.length : 0;
      return `Run the plan ${q(goal, 160)} (${steps} steps).`;
    },
  };
}

const cancelPlan = defineClientTool({
  name: 'cancel_plan',
  pack: 'core',
  description: 'Cancel a running plan: no new step starts, a write already running finishes, waits stop.',
  properties: { plan_id: { type: 'string', maxLength: 15, description: 'Plan id (pl_…).' } },
  required: ['plan_id'],
  schema: z.object({ plan_id: planIdSchema }).strict(),
  summarize: (args) => `Cancel plan ${args.plan_id}.`,
});

export function createPlanClientTools(catalogue: CatalogueSource): ClientToolDefinition[] {
  return [proposePlan(catalogue), cancelPlan];
}

