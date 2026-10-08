/**
 * Minimal valid arguments for the memory / agents / company write tools
 * (imported by *.test.ts only). Every id is explicit, so they validate on any page.
 */

import { ServiceError } from '../../../lib/errors.js';

/** A small valid workflow: start → aggregate → PR/FAQ ⇄ persona review (loop) → end. */
export const SAMPLE_WORKFLOW = {
  schema: 'voc-workflow/1',
  name: 'Reviews → PR/FAQ',
  nodes: [
    { id: 'n_start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start' } },
    { id: 'n_agg', type: 'aggregate_reviews', position: { x: 0, y: 100 }, data: { title: 'Aggregate reviews', role: 'worker' } },
    { id: 'n_prfaq', type: 'write_prfaq', position: { x: 0, y: 200 }, data: { title: 'Write PR/FAQ', role: 'worker' } },
    {
      id: 'n_review', type: 'persona_review', position: { x: 0, y: 300 },
      data: { title: 'Persona review', role: 'persona', params: { target: 'prfaq' } },
    },
    { id: 'n_end', type: 'end', position: { x: 0, y: 400 }, data: { title: 'End' } },
  ],
  edges: [
    { id: 'e1', source: 'n_start', target: 'n_agg' },
    { id: 'e2', source: 'n_agg', target: 'n_prfaq' },
    { id: 'e3', source: 'n_prfaq', target: 'n_review' },
    { id: 'e4', source: 'n_review', target: 'n_prfaq', label: 'not_agreed' },
    { id: 'e5', source: 'n_review', target: 'n_end', label: 'agreed' },
  ],
  loops: [{ node_ids: ['n_prfaq', 'n_review'], until: 'persona_agreement', max_rounds: 3 }],
};

export const NEW_TOOL_VALID_ARGS: Record<string, Record<string, unknown>> = {
  remember: { scope: 'personal', statement: 'Prefers short answers.', kind: 'working_style' },
  update_company_memory: {
    memory_id: 'mem_1', previous_statement: 'Pricing is per seat.', statement: 'Pricing is per workspace.',
    kind: 'product', supporters: 10, reason: 'Pricing changed in Q3',
  },
  forget_memory: { memory_id: 'mem_1', statement: 'Old fact.', reason: 'Wrong' },
  confirm_memory: { memory_id: 'mem_1', statement: 'Customers want SSO.' },
  merge_memories: { memory_ids: ['mem_1', 'mem_2'], statement: 'Customers want SSO and SCIM.' },
  resolve_memory_conflict: { memory_id: 'mem_1', action: 'keep', winner_id: 'mem_2' },
  create_agent: { name: 'Checkout watcher', scope: { all: false, categories: ['checkout'], subcategories: [] } },
  update_agent: { agent_id: 'ag_1', updates: { instructions: 'Focus on mobile.' }, change_summary: 'Mobile focus' },
  enable_agent: { agent_id: 'ag_1' },
  disable_agent: { agent_id: 'ag_1' },
  run_agent: { agent_id: 'ag_1' },
  cancel_agent_run: { agent_id: 'ag_1', run_id: 'ar_0123456789ab' },
  create_workflow: { definition: SAMPLE_WORKFLOW },
  update_workflow: { workflow_id: 'wf_1', expected_revision: 2, definition: SAMPLE_WORKFLOW, change_summary: 'Added a loop' },
  duplicate_workflow: { workflow_id: 'wf_default' },
  update_company_context: { vision: '# Be the easiest checkout' },
  update_my_context: { objectives: [{ title: 'Cut churn', description: 'Q3', kpis: [{ name: 'Churn', target: 3, unit: '%' }] }] },
  update_design_system: { guidelines: 'Use the primary colour for one action per screen.' },
};

/** The minimal valid arguments of `name`; fails the spec when the fixture has none. */
export function validArgs(name: string): Record<string, unknown> {
  // Via a Map: a lookup that may miss is typed as one, whatever the compiler flags say.
  const args = new Map(Object.entries(NEW_TOOL_VALID_ARGS)).get(name);
  if (!args) throw new ServiceError(`no NEW_TOOL_VALID_ARGS fixture for ${name}`);
  return args;
}
