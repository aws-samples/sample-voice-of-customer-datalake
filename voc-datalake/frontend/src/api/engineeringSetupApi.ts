/**
 * @fileoverview The engineering setup guide's progress (7.50.00; administrators, while the engineering agents are on;
 * lambda/shared/agents_engineering_setup_routes.py): what a person chose, never what is set up (the guide reads that
 * from the deployment, pages/Agents/SetupGuide/setupGuideRules.ts).
 *
 * - `GET /agents/engineering/setup` → `{steps: {<step>: pending | skipped | done}, intro, revision, updated_at,
 *   updated_by}`; a deployment that never saved one reads as nothing chosen at revision 0;
 * - `PUT /agents/engineering/setup` `{revision, steps?, intro?}`: changes only the steps it names, from the revision
 *   read (409 once it moved), each change audited with its history row.
 *
 * @module api/engineeringSetupApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { put } from './requestKit'
import { isRecord } from '../lib/typeGuards'

/** The guide's steps, in the order it recommends them (agents_engineering_setup_routes.py STEP_IDS, in lockstep). */
export const SETUP_STEP_IDS = ['prerequisites', 'understand', 'tenets', 'triage', 'bug_fixer', 'feature_builder', 'ready'] as const
export type SetupStepId = (typeof SETUP_STEP_IDS)[number]
/** What a person chose for a step (STEP_STATES). */
const STEP_CHOICES = ['pending', 'skipped', 'done'] as const
export type StepChoice = (typeof STEP_CHOICES)[number]
/** The first visit's choice (INTROS): not made, "Help me set up", "Skip". */
const INTROS = ['unseen', 'started', 'skipped'] as const
type SetupIntro = (typeof INTROS)[number]

export interface SetupProgress {
  readonly steps: Readonly<Record<SetupStepId, StepChoice>>
  readonly intro: SetupIntro
  /** The revision read: what a change names, so another administrator's change since is a 409, never overwritten. */
  readonly revision: number
  readonly updatedAt: string | null
  readonly updatedBy: string | null
}

export interface SetupChange {
  readonly revision: number
  readonly steps?: Partial<Record<SetupStepId, StepChoice>>
  readonly intro?: Exclude<SetupIntro, 'unseen'>
}

const Choice = z.enum(STEP_CHOICES).catch('pending')
/** Every step, a missing or unknown state as nothing chosen (in lockstep with SETUP_STEP_IDS: engineeringSetupApi.test.ts). */
const StepsSchema = z.object({
  prerequisites: Choice, understand: Choice, tenets: Choice, triage: Choice, bug_fixer: Choice, feature_builder: Choice,
  ready: Choice,
})
const AnswerSchema = z.object({
  steps: StepsSchema,
  // (an intro or a step state the page does not know reads as nothing chosen)
  intro: z.enum(INTROS).catch('unseen'),
  revision: z.number().int().nonnegative(),
  updated_at: z.string().nullable().catch(null),
  updated_by: z.string().nullable().catch(null),
})

/** The answer as the guide reads it; an answer without its steps or its revision is an error, never "nothing chosen". */
export function parseSetupProgress(raw: unknown): SetupProgress {
  const parsed = AnswerSchema.safeParse(raw)
  if (!isRecord(raw) || !parsed.success) throw new Error('The setup guide answer was unreadable')
  const { steps, intro, revision, updated_at: updatedAt, updated_by: updatedBy } = parsed.data
  return { steps, intro, revision, updatedAt, updatedBy }
}

const SETUP_PATH = '/agents/engineering/setup'

export const engineeringSetupKeys = { progress: () => ['engineering-setup'] as const }

export const engineeringSetupApi = {
  get: async (): Promise<SetupProgress> => parseSetupProgress(await fetchApi<unknown>(SETUP_PATH)),
  save: async (change: SetupChange): Promise<SetupProgress> =>
    parseSetupProgress(await fetchApi<unknown>(SETUP_PATH, put(change))),
}
