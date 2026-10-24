/**
 * The step dependency graph of a plan (`after` edges): cycle detection and the
 * transitive `after` chain of each step. Pure and mutation-free (the SPA mirror
 * is linted against mutation); plans have at most 20 steps.
 *
 * LOCKSTEP: `frontend/src/assistant/plan/graph.ts` mirrors this file.
 */

export interface GraphStep {
  id: string;
  after?: readonly string[];
}

/** Steps in dependency order, and the steps left over (on or behind a cycle, or after an unknown id). */
function layer(pending: readonly GraphStep[], done: readonly GraphStep[]): { ordered: readonly GraphStep[]; stuck: readonly GraphStep[] } {
  const doneIds = new Set(done.map((step) => step.id));
  const ready = pending.filter((step) => (step.after ?? []).every((dep) => doneIds.has(dep)));
  if (ready.length === 0) return { ordered: done, stuck: pending };
  return layer(pending.filter((step) => !ready.includes(step)), [...done, ...ready]);
}

/** Ids of the steps that can never become ready (on or behind a cycle), in plan order. */
export function stepsInCycles(steps: readonly GraphStep[]): string[] {
  return layer(steps, []).stuck.map((step) => step.id);
}

/** Every step reachable backwards through `after` from each step (acyclic input). */
export function ancestorsOf(steps: readonly GraphStep[]): ReadonlyMap<string, ReadonlySet<string>> {
  return layer(steps, []).ordered.reduce<ReadonlyMap<string, ReadonlySet<string>>>((known, step) => {
    const parents = step.after ?? [];
    const chain = new Set(parents.flatMap((parent) => [parent, ...(known.get(parent) ?? [])]));
    return new Map([...known, [step.id, chain]]);
  }, new Map());
}
