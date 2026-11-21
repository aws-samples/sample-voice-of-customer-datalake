/**
 * @fileoverview The response the in-app micro-feedback control sends (7.66.00, docs/micro-feedback.md): the verdict
 * (`q_verdict`: up or down, a choice and never a rating), what is missing (`q_missing`, at most 500 characters, left
 * out when blank) and four hidden fields that are ids only: the action, the page (the route's first segment, never an
 * id or a name), the app's version and the person's workspace role. Nothing that says who they are: no name, email,
 * user id, workspace id or URL. The language is the app's when the form has it, else the form's own.
 *
 * @module components/MicroFeedback/microFeedbackPayload
 */
import type { AppFeedbackAction, AppFeedbackResponse } from '../../api/appFeedbackApi'

/** The longest "What's missing?" the control takes. */
export const MAX_MISSING_CHARS = 500
/** A page name: the route's first segment as the app spells its routes. */
const PAGE_SEGMENT = /^[a-z][a-z0-9-]{0,39}$/

export type Verdict = 'up' | 'down'

export interface MicroFeedbackInput {
  readonly verdict: Verdict
  readonly missing: string
  readonly action: AppFeedbackAction
  /** The app's pathname (inside the workspace, without its prefix: workspace/workspacePath.ts `appPathname`). */
  readonly pathname: string
  readonly appVersion: string
  /** The person's role in the workspace, or null outside one. */
  readonly workspaceRole: string | null
  readonly uiLanguage: string
  readonly formLanguages: readonly string[]
}

/** The route's first segment (`/projects/p_1/personas` → `projects`); `home` for `/`, `other` for anything odd. */
export function feedbackPageOf(pathname: string): string {
  const first = pathname.split('/').find((segment) => segment !== '') ?? ''
  if (first === '') return 'home'
  return PAGE_SEGMENT.test(first) ? first : 'other'
}

export function microFeedbackResponse(input: MicroFeedbackInput): AppFeedbackResponse {
  const missing = input.missing.trim().slice(0, MAX_MISSING_CHARS)
  const language = input.uiLanguage.split('-')[0] ?? ''
  return {
    answers: { q_verdict: { code: input.verdict }, ...(missing === '' ? {} : { q_missing: missing }) },
    hidden: {
      action: input.action,
      page: feedbackPageOf(input.pathname),
      app_version: input.appVersion,
      workspace_role: input.workspaceRole ?? 'none',
    },
    ...(input.formLanguages.includes(language) ? { language } : {}),
  }
}
