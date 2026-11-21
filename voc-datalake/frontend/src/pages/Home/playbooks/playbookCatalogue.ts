/**
 * @fileoverview The role playbooks' catalogue (7.66.00, docs/playbooks.md): each role's first-week steps, in order,
 * with the screen each links to and the evidence that ticks it. Read from `voc-datalake/schemas/playbooks.json`, the
 * file `lambda/shared/playbooks.py` is pinned to, so the server's signals and the browser's checklist name the same
 * steps. Each step's words are in the `playbooks` namespace (`STEP_TEXT`: `steps.<id>.title`, `.why` and `.cta`; every
 * step id is listed in `STEP_IDS`, so a step the JSON adds without words in the app is left out, never shown blank).
 *
 * @module pages/Home/playbooks/playbookCatalogue
 */
import catalogue from '../../../../../schemas/playbooks.json'
import { PLAYBOOK_ROLES } from '../../../api/onboardingApi'
import type { PlaybookRole } from '../../../api/onboardingApi'

/** Evidence the onboarding GET computes, only for the chosen playbook's steps (shared/playbooks.py `SERVER_SIGNALS`). */
const SERVER_EVIDENCE = ['objectives_set', 'feedback_form_configured', 'form_test_response'] as const
export type ServerEvidence = typeof SERVER_EVIDENCE[number]
/** Evidence Home already reads in the browser (`BROWSER_EVIDENCE`): the brief's own settings among it. */
const BROWSER_EVIDENCE = [
  'brief_subscribed', 'personas_generated', 'document_written', 'project_shared', 'repository_connected', 'mcp_connected',
] as const
export type BrowserEvidence = typeof BROWSER_EVIDENCE[number]
export type Evidence = ServerEvidence | BrowserEvidence

const STEP_IDS = [
  'read_dashboard', 'generate_personas', 'write_document', 'set_objectives', 'subscribe_brief', 'review_problems',
  'share_project', 'create_form', 'read_form_results', 'test_form', 'search_feedback', 'watch_release',
  'connect_repository', 'run_engineering_agent', 'build_prototype', 'connect_mcp',
] as const
export type PlaybookStepId = typeof STEP_IDS[number]

/** One step of a playbook: what ticks it (null: the person ticks it) and where it is done. */
export interface PlaybookStepDef {
  readonly id: PlaybookStepId
  readonly path: string
  readonly evidence: Evidence | null
}

export const isServerEvidence = (value: Evidence): value is ServerEvidence =>
  SERVER_EVIDENCE.some((name) => name === value)

const isEvidence = (value: unknown): value is Evidence =>
  SERVER_EVIDENCE.some((name) => name === value) || BROWSER_EVIDENCE.some((name) => name === value)

const isPlaybookStepId = (value: unknown): value is PlaybookStepId => STEP_IDS.some((id) => id === value)

interface RawStep {
  readonly id: string
  readonly path: string
  readonly evidence: string | null
}

const RAW_STEPS: Readonly<Record<PlaybookRole, readonly RawStep[]>> = catalogue.steps

function stepsOf(role: PlaybookRole): PlaybookStepDef[] {
  return RAW_STEPS[role].flatMap((step): PlaybookStepDef[] => (isPlaybookStepId(step.id)
    ? [{ id: step.id, path: step.path, evidence: isEvidence(step.evidence) ? step.evidence : null }]
    : []))
}

/** Every role's steps, in order. */
export const PLAYBOOKS: Readonly<Record<PlaybookRole, readonly PlaybookStepDef[]>> = {
  product: stepsOf('product'),
  scrum_master: stepsOf('scrum_master'),
  qa: stepsOf('qa'),
  engineering: stepsOf('engineering'),
}

/** The roles in the picker's order. */
export const ROLES: readonly PlaybookRole[] = PLAYBOOK_ROLES

/** Whether a role's steps read `evidence`: Home reads only what the chosen playbook needs. */
export const needsEvidence = (role: PlaybookRole | null, evidence: Evidence): boolean =>
  role !== null && PLAYBOOKS[role].some((step) => step.evidence === evidence)

/** Each role's name and description (`playbooks:roles.*`). */
export const ROLE_TEXT: Readonly<Record<PlaybookRole, { readonly name: string; readonly desc: string }>> = {
  product: { name: 'roles.product.name', desc: 'roles.product.desc' },
  scrum_master: { name: 'roles.scrum_master.name', desc: 'roles.scrum_master.desc' },
  qa: { name: 'roles.qa.name', desc: 'roles.qa.desc' },
  engineering: { name: 'roles.engineering.name', desc: 'roles.engineering.desc' },
}

interface StepText {
  readonly title: string
  readonly why: string
  readonly cta: string
}

const stepText = (id: PlaybookStepId): StepText => ({ title: `steps.${id}.title`, why: `steps.${id}.why`, cta: `steps.${id}.cta` })

/** Each step's title, why it matters and its link's label (`playbooks:steps.<id>.*`). */
export const STEP_TEXT: Readonly<Record<PlaybookStepId, StepText>> = {
  read_dashboard: stepText('read_dashboard'),
  generate_personas: stepText('generate_personas'),
  write_document: stepText('write_document'),
  set_objectives: stepText('set_objectives'),
  subscribe_brief: stepText('subscribe_brief'),
  review_problems: stepText('review_problems'),
  share_project: stepText('share_project'),
  create_form: stepText('create_form'),
  read_form_results: stepText('read_form_results'),
  test_form: stepText('test_form'),
  search_feedback: stepText('search_feedback'),
  watch_release: stepText('watch_release'),
  connect_repository: stepText('connect_repository'),
  run_engineering_agent: stepText('run_engineering_agent'),
  build_prototype: stepText('build_prototype'),
  connect_mcp: stepText('connect_mcp'),
}
