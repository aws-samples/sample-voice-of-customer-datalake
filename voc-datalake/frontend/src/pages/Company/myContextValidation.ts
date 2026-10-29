/**
 * @fileoverview Field-level validation of "My objectives & KPIs" before Save,
 * and the mapping of a server 400 (`objectives[0].kpis[0].target is required`)
 * back to the field it names.
 *
 * The rules mirror `lambda/shared/company_context.py` → `validate_my_context`: a
 * row left wholly blank is dropped by the PUT body (`myContextBody`), any other
 * objective needs a title and any other KPI needs a name and a target; every text
 * has the server's length cap. The server stays the authority: whatever it still
 * refuses is shown next to the field its path names (the body drops blank rows, so
 * its indexes are translated back to the draft's rows here).
 *
 * @module pages/Company/myContextValidation
 */
import { z } from 'zod'
import type { Kpi, MyContext, PersonalObjective } from '../../api/companyContextApi'

/** Server caps (`MAX_TITLE_CHARS`, `MAX_DESCRIPTION_CHARS`, `MAX_KPI_FIELD_CHARS`). */
const MAX_TITLE_CHARS = 200
const MAX_DESCRIPTION_CHARS = 2000
const MAX_KPI_FIELD_CHARS = 120

export type ObjectiveField = 'title' | 'description'
export type KpiField = 'name' | 'target' | 'unit'

/** `obj:<id>:title` or `obj:<id>:kpi:<index>:target`: one draft field. */
export const objectiveFieldKey = (objectiveId: string, field: ObjectiveField) => `obj:${objectiveId}:${field}`
export const kpiFieldKey = (objectiveId: string, index: number, field: KpiField) => `obj:${objectiveId}:kpi:${String(index)}:${field}`

/** What is wrong with one field: a known rule (translated by the form) or the server's own words. */
export type FieldProblem =
  | { readonly code: 'required' }
  | { readonly code: 'tooLong'; readonly max: number }
  | { readonly code: 'server'; readonly text: string }

export type FieldErrors = ReadonlyMap<string, FieldProblem>

/** One server-named field (its draft key) and what is wrong with it. */
export interface ServerFieldProblem {
  readonly key: string
  readonly problem: FieldProblem
}

const blank = (value: string | undefined) => (value ?? '').trim() === ''
const isBlankKpi = (kpi: Kpi) => blank(kpi.name) && blank(kpi.target) && blank(kpi.unit)
const isBlankObjective = (o: PersonalObjective) =>
  blank(o.title) && blank(o.description) && o.due === undefined && o.kpis.every(isBlankKpi)

function capped(ctx: z.RefinementCtx, value: string | undefined, max: number, path: (string | number)[]) {
  if ((value ?? '').length > max) ctx.addIssue({ code: 'custom', path, message: 'tooLong', params: { max } })
}

function required(ctx: z.RefinementCtx, value: string, path: (string | number)[]) {
  if (blank(value)) ctx.addIssue({ code: 'custom', path, message: 'required' })
}

function checkKpi(ctx: z.RefinementCtx, kpi: Kpi, at: number) {
  if (isBlankKpi(kpi)) return
  required(ctx, kpi.name, ['kpis', at, 'name'])
  required(ctx, kpi.target, ['kpis', at, 'target'])
  for (const field of ['name', 'target', 'unit'] as const) capped(ctx, kpi[field], MAX_KPI_FIELD_CHARS, ['kpis', at, field])
}

const ObjectiveDraftSchema = z.custom<PersonalObjective>().superRefine((objective, ctx) => {
  if (isBlankObjective(objective)) return
  required(ctx, objective.title, ['title'])
  capped(ctx, objective.title, MAX_TITLE_CHARS, ['title'])
  capped(ctx, objective.description, MAX_DESCRIPTION_CHARS, ['description'])
  objective.kpis.forEach((kpi, at) => checkKpi(ctx, kpi, at))
})

const IssueParamsSchema = z.object({ max: z.number() })

function problemOf(issue: z.core.$ZodIssue): FieldProblem {
  const params = IssueParamsSchema.safeParse(issue.code === 'custom' ? issue.params : undefined)
  return issue.message === 'tooLong' && params.success ? { code: 'tooLong', max: params.data.max } : { code: 'required' }
}

function keyOf(objectiveId: string, path: readonly PropertyKey[]): string | undefined {
  const [first, index, field] = path
  if (first === 'title' || first === 'description') return objectiveFieldKey(objectiveId, first)
  if (first === 'kpis' && typeof index === 'number' && (field === 'name' || field === 'target' || field === 'unit')) {
    return kpiFieldKey(objectiveId, index, field)
  }
  return undefined
}

/** Every field Save would be refused for, keyed by `objectiveFieldKey` / `kpiFieldKey`. Empty = valid. */
export function validateMyContext(context: MyContext): FieldErrors {
  const errors = new Map<string, FieldProblem>()
  for (const objective of context.objectives) {
    for (const issue of ObjectiveDraftSchema.safeParse(objective).error?.issues ?? []) {
      const key = keyOf(objective.id, issue.path)
      if (key !== undefined && !errors.has(key)) errors.set(key, problemOf(issue))
    }
  }
  return errors
}

// `objectives[2].kpis[0].target is required` / `objectives[1].title must be at most 200 characters`
const SERVER_FIELD_RE = /^objectives\[(\d+)\](?:\.kpis\[(\d+)\])?\.(title|description|name|target|unit) (.+)$/

function sentIndexes<T>(rows: readonly T[], kept: (row: T) => boolean): number[] {
  return rows.flatMap((row, index) => (kept(row) ? [index] : []))
}

const isObjectiveField = (field: string): field is ObjectiveField => field === 'title' || field === 'description'
const isKpiField = (field: string): field is KpiField => field === 'name' || field === 'target' || field === 'unit'

/** The draft key of a body path: the body's objective / KPI indexes skip the rows it dropped. */
function draftKey(objective: PersonalObjective, kpiAt: string | undefined, field: string): string | null {
  if (kpiAt === undefined) return isObjectiveField(field) ? objectiveFieldKey(objective.id, field) : null
  const kpiIndex = sentIndexes(objective.kpis, (k) => !blank(k.name))[Number(kpiAt)]
  return kpiIndex !== undefined && isKpiField(field) ? kpiFieldKey(objective.id, kpiIndex, field) : null
}

/**
 * The draft field a server validation message names, with its problem — or null
 * when the message names no field (then the generic "Could not save" stands).
 * Indexes are into the PUT body, which drops untitled objectives and unnamed KPIs.
 */
export function serverFieldError(error: unknown, context: MyContext): ServerFieldProblem | null {
  const match = error instanceof Error ? SERVER_FIELD_RE.exec(error.message) : null
  if (match === null) return null
  const [, objectiveAt = '', kpiAt, field = '', reason = ''] = match
  const sent = sentIndexes(context.objectives, (o) => !blank(o.title))
  const objective = context.objectives[sent[Number(objectiveAt)] ?? -1]
  const key = objective === undefined ? null : draftKey(objective, kpiAt, field)
  if (key === null) return null
  return { key, problem: reason === 'is required' ? { code: 'required' } : { code: 'server', text: reason } }
}
