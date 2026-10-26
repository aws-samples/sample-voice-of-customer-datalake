/**
 * Plan step outputs shared by voc-plan-step (`plan-step/think.ts`), the plan
 * rules the model reads (`tools/server/plan.ts`) and the conductor (through
 * `lambda/shared/plan_contract.json`, key `think_default_output`).
 */

/** The output a `think` step's answer is stored under when the step declares no `produces`. */
export const THINK_DEFAULT_OUTPUT = 'summary';
