/**
 * `validatePlan` — the cross-step rules of `voc-plan/1` on top of the zod shape
 * (docs/assistant-plan-mode.md → "Plan format", "Matching"). Pure: no I/O.
 *
 * Checks, each reported as `{step?, field?, message}` (none silently repaired):
 *   1. shape (`planSchema`) — stops here when it fails
 *   2. limits (writes / waits / thinks) and the canonical JSON size
 *   3. unique step ids, unique `produces` names, `after` naming known other steps,
 *      and a dependency graph without cycles
 *   4. the step's pack is allowed for the caller (ctx.packsAllowed, and
 *      ADMIN_ONLY_PACKS only for admins); a write's tool belongs to that pack
 *      (`planWriteTools`) and admin-only tools need an admin
 *   5. placeholders: `{{s<n>.<output>}}` only to a step in the transitive `after`
 *      chain that `produces` that name — and to a `think` step's output only on a
 *      FREE_TEXT_FIELDS field (model text never becomes an id or a target)
 *      `{{free}}` only on that tool's FREE_TEXT_FIELDS; nothing else may contain
 *      `{{` or `}}`
 *   6. literals against the tool's own argument schema (`ctx.argsSchemaFor`).
 *
 * How 6 works with placeholders: every placeholder string is replaced by the
 * dummy `"x"`, the args are parsed with the tool's schema, and any issue whose
 * path lies at or under a placeholder is ignored (that value is only known at
 * run time and is re-validated then). Every other issue — a wrong literal, a
 * missing required field, an unknown key — is an error. A tool with no schema
 * (`argsSchemaFor` returns undefined, e.g. a plan-mode tool not built yet) is
 * not literal-checked here; its REST route still validates at run time.
 *
 * LOCKSTEP: SPA mirror of `lambda/stream/src/assistant/plan/validate.ts`
 * (pinned by `plan.lockstep.test.ts`); change both together, and
 * `lambda/shared/plan_schema.py` implements 1-5 (not 6: Python has no zod).
 */
import { ADMIN_ONLY_CLIENT_TOOLS, ADMIN_ONLY_PACKS, PLAN_TOOL_NAMES, type ToolPack } from '../contract'
import { CanonicalJsonError, canonicalJson } from './canonical'
import { ancestorsOf, stepsInCycles } from './graph'
import { dottedPath, findPlaceholders, isUnder, substitutePlaceholders, type PlaceholderLeaf } from './placeholders'
import { FREE_TEXT_FIELDS, PLAN_FIELD_LIMITS, PLAN_LIMITS, planSchema, planWriteTools, type PlanStep, type VocPlan } from './schema'

interface PlanValidationError {
  step?: string
  field?: string
  message: string
}

export type PlanValidation = { ok: true; plan: VocPlan } | { ok: false; errors: PlanValidationError[] }

/** The part of a zod schema the literal check needs (any zod instance). */
export interface ArgsSchemaLike {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }
}

export interface PlanValidationContext {
  isAdmin: boolean
  /** Packs the caller may use in a plan (the planner's catalogue). */
  packsAllowed: readonly ToolPack[]
  /** The write tool's argument schema, for the literal check; undefined → not checked. */
  argsSchemaFor?: (tool: string) => ArgsSchemaLike | undefined
}

const LITERAL_DUMMY = 'x'
const ADMIN_ONLY_WRITE_TOOLS: ReadonlySet<string> = new Set([...ADMIN_ONLY_CLIENT_TOOLS, ...PLAN_TOOL_NAMES.adminOnlyClient])

type Errors = PlanValidationError[]

function shapeErrors(raw: unknown, issues: readonly { path: readonly PropertyKey[]; message: string }[]): Errors {
  const steps = typeof raw === 'object' && raw !== null && 'steps' in raw && Array.isArray(raw.steps) ? raw.steps : []
  return issues.map((issue) => {
    const [head, index, ...rest] = issue.path
    if (head !== 'steps' || typeof index !== 'number') return { field: dottedPath(issue.path) || undefined, message: issue.message }
    const candidate: unknown = steps[index]
    const id = typeof candidate === 'object' && candidate !== null && 'id' in candidate && typeof candidate.id === 'string' ? candidate.id : undefined
    return { step: id, field: dottedPath(id === undefined ? issue.path : rest) || undefined, message: issue.message }
  })
}

function jsonSize(plan: VocPlan): number | undefined {
  try {
    return canonicalJson(plan).length
  } catch (error) {
    if (error instanceof CanonicalJsonError) return undefined
    throw error
  }
}

function limitErrors(plan: VocPlan): Errors {
  const count = (kind: PlanStep['kind']) => plan.steps.filter((step) => step.kind === kind).length
  const limits = [['write', PLAN_LIMITS.writes], ['wait', PLAN_LIMITS.waits], ['think', PLAN_LIMITS.thinks]] as const
  const over: Errors = limits.filter(([kind, max]) => count(kind) > max)
    .map(([kind, max]) => ({ field: 'steps', message: `at most ${max} ${kind} steps` }))
  const size = jsonSize(plan)
  if (size === undefined) return [...over, { message: 'the plan contains text that is not valid Unicode' }]
  return size > PLAN_FIELD_LIMITS.planJsonChars
    ? [...over, { message: `the plan is ${size} characters of JSON; the limit is ${PLAN_FIELD_LIMITS.planJsonChars}` }]
    : over
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function graphErrors(plan: VocPlan): Errors {
  const ids = plan.steps.map((step) => step.id)
  const duplicateIds: Errors = duplicates(ids).map((id) => ({ step: id, field: 'id', message: `step id ${id} is used more than once` }))
  const badAfter: Errors = plan.steps.flatMap((step) => (step.after ?? [])
    .filter((dep) => dep === step.id || !ids.includes(dep))
    .map((dep) => ({ step: step.id, field: 'after', message: dep === step.id ? 'a step cannot run after itself' : `unknown step ${dep}` })))
  const badProduces: Errors = plan.steps.flatMap((step) => duplicates(step.produces ?? [])
    .map((name) => ({ step: step.id, field: 'produces', message: `output ${name} is declared twice` })))
  const errors = [...duplicateIds, ...badAfter, ...badProduces]
  if (errors.length > 0) return errors
  return stepsInCycles(plan.steps).map((id) => ({ step: id, field: 'after', message: 'the step is on or behind a dependency cycle' }))
}

function packErrors(step: PlanStep, ctx: PlanValidationContext): Errors {
  const packOk = ctx.packsAllowed.includes(step.pack) && (ctx.isAdmin || !ADMIN_ONLY_PACKS.includes(step.pack))
  if (!packOk) return [{ step: step.id, field: 'pack', message: `pack ${step.pack} is not available to you` }]
  if (step.kind !== 'write') return []
  const { tool } = step.write
  if (!planWriteTools(step.pack).includes(tool)) {
    return [{ step: step.id, field: 'write.tool', message: `${tool} is not a write tool of pack ${step.pack}` }]
  }
  return !ctx.isAdmin && ADMIN_ONLY_WRITE_TOOLS.has(tool)
    ? [{ step: step.id, field: 'write.tool', message: `${tool} is only available to administrators` }]
    : []
}

interface StepFacts {
  byId: ReadonlyMap<string, PlanStep>
  ancestors: ReadonlyMap<string, ReadonlySet<string>>
}

function isFreeTextField(tool: string | undefined, leaf: PlaceholderLeaf): boolean {
  if (tool === undefined || leaf.path.some((part) => typeof part === 'number')) return false
  return (FREE_TEXT_FIELDS[tool] ?? []).includes(dottedPath(leaf.path))
}

function referenceError(step: PlanStep, leaf: Extract<PlaceholderLeaf, { kind: 'reference' }>, tool: string | undefined, facts: StepFacts): string | undefined {
  const target = facts.byId.get(leaf.step)
  if (target === undefined || facts.ancestors.get(step.id)?.has(leaf.step) !== true) {
    return `{{${leaf.step}.${leaf.output}}} must name a step this one runs after`
  }
  if (!(target.produces ?? []).includes(leaf.output)) return `step ${leaf.step} does not produce ${leaf.output}`
  if (target.kind === 'think' && !isFreeTextField(tool, leaf)) {
    return `the text output of think step ${leaf.step} may only fill a free-text field`
  }
  return undefined
}

function leafError(step: PlanStep, leaf: PlaceholderLeaf, tool: string | undefined, facts: StepFacts): string | undefined {
  if (leaf.kind === 'malformed') return 'a value containing {{ or }} must be exactly {{free}} or {{s<n>.<output>}}'
  if (leaf.kind === 'free') return isFreeTextField(tool, leaf) ? undefined : '{{free}} is only allowed on a free-text field of the tool'
  return referenceError(step, leaf, tool, facts)
}

/** Where a step's placeholder-bearing values live, and the write tool they belong to. */
function stepPayload(step: PlanStep): { prefix: string; value: unknown; tool?: string } {
  if (step.kind === 'write') return { prefix: 'write.args', value: step.write.args, tool: step.write.tool }
  if (step.kind === 'wait') return { prefix: 'wait', value: step.wait }
  return { prefix: 'think', value: step.think }
}

function placeholderErrors(step: PlanStep, facts: StepFacts): Errors {
  const { prefix, value, tool } = stepPayload(step)
  return findPlaceholders(value).flatMap((leaf) => {
    const message = leafError(step, leaf, tool, facts)
    return message === undefined ? [] : [{ step: step.id, field: `${prefix}.${dottedPath(leaf.path)}`, message }]
  })
}

function literalErrors(step: PlanStep, ctx: PlanValidationContext): Errors {
  if (step.kind !== 'write') return []
  const schema = ctx.argsSchemaFor?.(step.write.tool)
  if (schema === undefined) return []
  const parsed = schema.safeParse(substitutePlaceholders(step.write.args, LITERAL_DUMMY))
  if (parsed.success) return []
  const placeholderPaths = findPlaceholders(step.write.args).map((leaf) => leaf.path)
  return parsed.error.issues
    .filter((issue) => !placeholderPaths.some((path) => isUnder(issue.path, path)))
    .map((issue) => ({ step: step.id, field: ['write', 'args', ...issue.path.map(String)].join('.'), message: issue.message }))
}

function stepErrors(plan: VocPlan, ctx: PlanValidationContext): Errors {
  const facts: StepFacts = { byId: new Map(plan.steps.map((step) => [step.id, step])), ancestors: ancestorsOf(plan.steps) }
  return plan.steps.flatMap((step) => [...packErrors(step, ctx), ...placeholderErrors(step, facts), ...literalErrors(step, ctx)])
}

/** Validate a `voc-plan/1` plan for a caller. */
export function validatePlan(raw: unknown, ctx: PlanValidationContext): PlanValidation {
  const parsed = planSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: shapeErrors(raw, parsed.error.issues) }
  const plan = parsed.data
  const structural = [...limitErrors(plan), ...graphErrors(plan)]
  const errors = structural.length > 0 ? structural : stepErrors(plan, ctx)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, plan }
}
