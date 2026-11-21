/**
 * @fileoverview In-app micro-feedback (7.66.00, docs/micro-feedback.md): its settings (`GET|PUT /settings/app-feedback`,
 * settings Lambda, `lambda/shared/app_feedback_routes.py`) and the response the control sends.
 *
 * The settings say which feedback form of the workspace receives the thumbs, whether they show and after which
 * actions; `active` is the server's word that they may show now (on, and the form found, fit and taking answers). Off
 * by default. Read leniently: a drifted answer reads as off.
 *
 * The response goes to the form's own PUBLIC submit route (`POST /feedback-forms/{id}/submit`) with no credentials,
 * exactly as a respondent's widget sends it, so the forms' validation, throttles and access rules apply and nothing
 * new sits on the public path. It carries ids only (the action, the page, the app's version, the person's workspace
 * role), never who they are.
 *
 * @module api/appFeedbackApi
 */
import { z } from 'zod'
import { getBaseUrl } from './baseUrl'
import { fetchApi } from './client'
import { put } from './requestKit'
import { optionalText } from './schemaList'

/** The key actions the control follows (`ACTIONS` in lambda/shared/app_feedback.py), in the Settings card's order. */
export const APP_FEEDBACK_ACTIONS = [
  'personas', 'research', 'prfaq', 'prd', 'prototype', 'form_draft', 'import', 'engineering_run',
] as const
export type AppFeedbackAction = typeof APP_FEEDBACK_ACTIONS[number]

/** Why a chosen form cannot receive the control's responses (`form_problems`); `form_off` alone still saves. */
const APP_FEEDBACK_PROBLEMS = ['not_tagged', 'no_verdict', 'no_missing', 'hidden_fields', 'form_off'] as const
export type AppFeedbackProblem = typeof APP_FEEDBACK_PROBLEMS[number]

const FormSchema = z.object({
  form_id: z.string(),
  found: z.boolean().catch(false),
  name: z.string().nullable().catch(null),
  enabled: z.boolean().catch(false),
  languages: z.array(z.string()).catch([]),
  problems: z.array(z.string()).catch([]).transform((problems) =>
    problems.filter((problem): problem is AppFeedbackProblem => APP_FEEDBACK_PROBLEMS.some((known) => known === problem))),
})

const ConfigSchema = z.object({
  enabled: z.boolean().catch(false),
  form_id: z.string().nullable().catch(null),
  actions: z.array(z.string()).catch([]).transform((actions) =>
    actions.filter((action): action is AppFeedbackAction => APP_FEEDBACK_ACTIONS.some((known) => known === action))),
  updated_at: optionalText,
  form: FormSchema.nullable().catch(null),
  active: z.boolean().catch(false),
})
export type AppFeedbackConfig = z.output<typeof ConfigSchema>

/** No row, or an unreadable answer: off. */
export const APP_FEEDBACK_OFF: AppFeedbackConfig = ConfigSchema.parse({})

function normalizeAppFeedback(raw: unknown): AppFeedbackConfig {
  const parsed = ConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : APP_FEEDBACK_OFF
}

/** A save names only what it changes. */
export interface AppFeedbackChanges {
  readonly enabled?: boolean
  readonly form_id?: string | null
  readonly actions?: readonly AppFeedbackAction[]
}

/** The response the control sends (lambda/shared/forms_v2_responses.py's version 2 body). */
export interface AppFeedbackResponse {
  readonly answers: { readonly q_verdict: { readonly code: 'up' | 'down' }; readonly q_missing?: string }
  readonly hidden: { readonly action: AppFeedbackAction; readonly page: string; readonly app_version: string;
    readonly workspace_role: string }
  readonly language?: string
}

export const appFeedbackKey = () => ['settings', 'app-feedback'] as const

const PATH = '/settings/app-feedback'

export const appFeedbackApi = {
  get: async (): Promise<AppFeedbackConfig> => normalizeAppFeedback(await fetchApi<unknown>(PATH)),
  save: async (changes: AppFeedbackChanges): Promise<AppFeedbackConfig> =>
    normalizeAppFeedback(await fetchApi<unknown>(PATH, put(changes))),
  /** PUBLIC: the response to the form's own submit route, without credentials. True once the form took it. */
  submit: async (formId: string, response: AppFeedbackResponse): Promise<boolean> => {
    const reply = await fetch(`${getBaseUrl()}/feedback-forms/${encodeURIComponent(formId)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(response),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
    return reply.ok
  },
}
