/**
 * @fileoverview The Validate step (7.68.00, docs/project-workspace.md → Validate): tenet 2's "review", after the
 * prototype. On the projects API's `/projects/{id}/validation…` (lambda/shared/project_validation_routes.py), every
 * route at edit:
 *
 * - `GET  …/validation` → the step's state, the card on the prototype's pin form, the synthetic run's figures (always
 *   labelled synthetic), the real testers' results, each criterion judged (met / not met / not enough data, from real
 *   testers only) and the decision prefill;
 * - `PUT  …/validation/criteria` → the criteria edited by hand; `POST` → parsed from the PRD (an assist job);
 * - `POST …/validation/plan` → the interview guide and test script (an assist job), or a blank one to write by hand;
 * - `POST …/validation/synthetic` → the personas try the script (an assist job; never counts towards "met");
 * - `PUT  …/validation/form` → the tasks and the "Tell us how it went" card on the prototype's own pin form;
 * - `POST …/validation/report` → the report document (an assist job), with the decision prefill.
 *
 * Every answer is parsed leniently: a field the server drops or a later release adds never breaks the page.
 * @module api/validationApi
 */
import { z } from 'zod'
import { runAssistJob } from './assistJobs'
import { fetchApi } from './client'
import { optionalMethodologyBlock } from './methodologySchema'
import { projectsApi } from './projectsApi'
import { post, put } from './requestKit'

const text = z.string().catch('')
const maybeText = z.string().nullish().catch(null).transform((value) => value ?? null)
const count = z.number().int().nonnegative().catch(0)
const maybeNumber = z.number().nullish().catch(null).transform((value) => value ?? null)

const criterionSchema = z.object({ id: z.string().min(1), text, target: z.number().optional().catch(undefined) })
const taskSchema = z.object({ id: z.string().min(1), text })

/** Only the valid rows of a list (one bad row never drops the others). */
function rows<T extends z.ZodType>(row: T) {
  return z.array(z.unknown()).catch(() => []).transform((raw) => raw.flatMap((one) => {
    const parsed = row.safeParse(one)
    return parsed.success ? [parsed.data] : []
  }))
}

const blockSchema = z.object({
  criteria: rows(criterionSchema),
  tasks: rows(taskSchema),
  prd_document_id: maybeText,
  prototype_document_id: maybeText,
  plan_document_id: maybeText,
  run_document_id: maybeText,
  report_document_id: maybeText,
  form_id: maybeText,
  form_open: z.boolean().catch(false),
  form_language: maybeText,
  /** Whether the version the card was saved on draws it (its widget is from 7.68.00 on). */
  card_in_prototype: z.boolean().catch(true),
  status: z.string().catch('not_started'),
  revision: count,
  updated_at: maybeText,
})

export type ValidationCriterion = z.infer<typeof criterionSchema>
export type ValidationTask = z.infer<typeof taskSchema>
type ValidationBlock = z.infer<typeof blockSchema>

const EMPTY_BLOCK: ValidationBlock = blockSchema.parse({})

const synthetic = z.object({ synthetic: z.literal(true) })

const criterionResultSchema = z.object({
  id: z.string(), text, target: z.number().catch(4), target_set: z.boolean().catch(false),
  real: z.object({ n: count, average: maybeNumber }).catch({ n: 0, average: null }),
  outcome: z.enum(['met', 'not_met', 'not_enough_data']).catch('not_enough_data'),
  synthetic: synthetic.extend({ n: count, average: maybeNumber, reading: maybeText }).nullable().catch(null),
})

const taskResultSchema = z.object({
  id: z.string(), text,
  real: z.object({ n: count, yes: count, no: count, rate: maybeNumber }).catch({ n: 0, yes: 0, no: 0, rate: null }),
  synthetic: synthetic.extend({ completed: count, struggled: count, failed: count, n: count }).nullable().catch(null),
})

const realSchema = z.object({
  responses: count,
  last_response_at: maybeText,
  ces: z.object({ n: count, average: maybeNumber, score: maybeNumber }).catch({ n: 0, average: null, score: null }),
  missing: rows(z.object({ text, at: maybeText, response_id: text })),
})

const formSchema = z.object({
  form_id: z.string(), revision: count, open: z.boolean().catch(false), questions: count,
  has_responses: z.boolean().catch(false), stale: z.boolean().catch(false),
})

const prefillSchema = z.object({
  title: text, verdict: z.enum(['pursue', 'park', 'reject']).catch('park'), rationale: text, success_metric: text,
  evidence: z.object({ document_ids: z.array(z.string()).catch([]), feedback_ids: z.array(z.string()).catch([]) })
    .catch({ document_ids: [], feedback_ids: [] }),
})

const viewSchema = z.object({
  validation: blockSchema.catch(EMPTY_BLOCK),
  form: formSchema.nullable().catch(null),
  synthetic: synthetic.extend({ document_id: z.string(), created_at: maybeText, personas: count }).nullable().catch(null),
  real: realSchema.nullable().catch(null),
  criteria: rows(criterionResultSchema),
  tasks: rows(taskResultSchema),
  decision_prefill: prefillSchema.nullable().catch(null),
  methodology: optionalMethodologyBlock,
})

export type ValidationView = z.infer<typeof viewSchema>
export type CriterionResult = z.infer<typeof criterionResultSchema>
export type TaskResult = z.infer<typeof taskResultSchema>
export type DecisionPrefill = z.infer<typeof prefillSchema>

const blockAnswer = z.object({ validation: blockSchema.catch(EMPTY_BLOCK) })
const documentAnswer = z.object({ document_id: z.string().catch(''), decision_prefill: prefillSchema.nullable().catch(null) })

/** The editor's criterion: an id once saved, a target only when the person set one. */
export interface CriterionInput {
  readonly id?: string
  readonly text: string
  readonly target?: number
}

export interface TaskInput {
  readonly id?: string
  readonly text: string
}

interface CardInput {
  readonly tasks: readonly TaskInput[]
  readonly open: boolean
  readonly language: string
  readonly expectedRevision: number
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/validation`
const poll = (projectId: string) => (jobId: string) => projectsApi.getJobStatus(projectId, jobId)

export const validationKeys = {
  view: (projectId: string) => ['validation', projectId] as const,
}

export const validationApi = {
  get: async (projectId: string): Promise<ValidationView> =>
    viewSchema.parse(await fetchApi<unknown>(base(projectId))),

  saveCriteria: async (projectId: string, criteria: readonly CriterionInput[], expectedRevision: number): Promise<ValidationBlock> =>
    blockAnswer.parse(await fetchApi<unknown>(`${base(projectId)}/criteria`,
      put({ criteria, expected_revision: expectedRevision }))).validation,

  /** Parse the PRD's Success Metrics (one model call); `replace` asks again over saved criteria. */
  extractCriteria: (projectId: string, replace: boolean, language: string): Promise<ValidationBlock> => runAssistJob(
    () => fetchApi<unknown>(`${base(projectId)}/criteria`, post({ replace, response_language: language })),
    poll(projectId), (result) => blockAnswer.parse(result).validation),

  /** The plan by AI (a job), or the blank template a person writes (now). */
  writePlan: (projectId: string, mode: 'ai' | 'blank', language: string): Promise<unknown> => mode === 'blank'
    ? fetchApi<unknown>(`${base(projectId)}/plan`, post({ mode: 'blank' }))
    : runAssistJob(() => fetchApi<unknown>(`${base(projectId)}/plan`, post({ mode: 'ai', response_language: language })),
      poll(projectId), (result) => result),

  runSynthetic: (projectId: string): Promise<unknown> => runAssistJob(
    () => fetchApi<unknown>(`${base(projectId)}/synthetic`, post({})), poll(projectId), (result) => result),

  saveCard: async (projectId: string, card: CardInput): Promise<ValidationBlock> =>
    blockAnswer.parse(await fetchApi<unknown>(`${base(projectId)}/form`, put({
      tasks: card.tasks, open: card.open, language: card.language, expected_revision: card.expectedRevision,
    }))).validation,

  writeReport: (projectId: string, language: string) => runAssistJob(
    () => fetchApi<unknown>(`${base(projectId)}/report`, post({ response_language: language })),
    poll(projectId), (result) => documentAnswer.parse(result)),
}
