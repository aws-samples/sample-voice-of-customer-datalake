/**
 * The plan contract as JSON for the Python validator
 * (`lambda/shared/plan_contract.json`, read by `lambda/shared/plan_schema.py`).
 *
 * Regenerate after changing `plan/schema.ts` or the tool lists in `contract.ts`
 * (from `voc-datalake/lambda/stream`):
 *   npx jiti scripts/write-plan-contract.mjs > ../shared/plan_contract.json
 * `plan/schema.test.ts` fails when the committed file differs from this output.
 */
import { ADMIN_ONLY_CLIENT_TOOLS, ADMIN_ONLY_PACKS, ADMIN_ONLY_SERVER_TOOLS, PLAN_TOOL_NAMES, SERVER_TOOLS, TOOL_PACKS } from '../contract.js';
import {
  CARD_ONLY_WRITE_TOOLS,
  FREE_PLACEHOLDER,
  FREE_TEXT_FIELDS,
  NEVER_PREAPPROVABLE_TOOLS,
  OUTPUT_NAME_RE,
  PLAN_FIELD_LIMITS,
  PLAN_ID_RE,
  PLAN_LIMITS,
  PLAN_SCHEMA,
  PLAN_STATUSES,
  PLAN_STEP_KINDS,
  PLAN_STEP_STATUSES,
  PLAN_WAIT_KINDS,
  REFERENCE_RE,
  SOURCE_ID_RE,
  STEP_ID_RE,
  WAIT_VALUE_RE,
  planWriteTools,
} from './schema.js';
import { THINK_DEFAULT_OUTPUT } from './outputs.js';

const PLAN_CONTRACT_REGENERATE = 'cd voc-datalake/lambda/stream && npx jiti scripts/write-plan-contract.mjs > ../shared/plan_contract.json';

/** The JSON object (key order is the file's order). */
function planContract(): Record<string, unknown> {
  return {
    $comment: `GENERATED from lambda/stream/src/assistant/plan/schema.ts + contract.ts — do not edit. Regenerate: ${PLAN_CONTRACT_REGENERATE}`,
    schema: PLAN_SCHEMA,
    limits: PLAN_LIMITS,
    field_limits: PLAN_FIELD_LIMITS,
    patterns: {
      plan_id: PLAN_ID_RE.source,
      step_id: STEP_ID_RE.source,
      output_name: OUTPUT_NAME_RE.source,
      reference: REFERENCE_RE.source,
      wait_value: WAIT_VALUE_RE.source,
      source_id: SOURCE_ID_RE.source,
    },
    free_placeholder: FREE_PLACEHOLDER,
    think_default_output: THINK_DEFAULT_OUTPUT,
    step_kinds: PLAN_STEP_KINDS,
    wait_kinds: PLAN_WAIT_KINDS,
    step_statuses: PLAN_STEP_STATUSES,
    plan_statuses: PLAN_STATUSES,
    packs: TOOL_PACKS,
    admin_only_packs: ADMIN_ONLY_PACKS,
    write_tools: Object.fromEntries(TOOL_PACKS.map((pack) => [pack, planWriteTools(pack)])),
    admin_only_write_tools: [...ADMIN_ONLY_CLIENT_TOOLS, ...PLAN_TOOL_NAMES.adminOnlyClient],
    // Packs with an admin-only READ tool: a think step there runs with `admins` when the approver still is one.
    admin_read_packs: TOOL_PACKS.filter((pack) => SERVER_TOOLS[pack].some((tool) => ADMIN_ONLY_SERVER_TOOLS.includes(tool))),
    never_preapprovable_tools: NEVER_PREAPPROVABLE_TOOLS,
    card_only_write_tools: CARD_ONLY_WRITE_TOOLS,
    free_text_fields: FREE_TEXT_FIELDS,
  };
}

/** The exact file text: 2-space JSON plus a trailing newline (Python checks the same formatting). */
export function planContractJson(): string {
  return `${JSON.stringify(planContract(), null, 2)}\n`;
}
