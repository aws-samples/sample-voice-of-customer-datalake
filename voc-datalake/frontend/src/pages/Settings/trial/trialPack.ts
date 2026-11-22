/**
 * @fileoverview Applying a new trial's starter pack (7.71.00; docs/multi-workspace.md "Trial workspaces"), one step
 * after another through trialPackApi.ts: the invite list's members (each with the role playbook suggested to them),
 * the forms from the pack's templates (schemas/trial-pack.json, made in the admin's language, Off) and the sample
 * categories. A step that fails is reported and the others still run: the trial exists either way, and its admin can
 * finish by hand.
 *
 * @module pages/Settings/trial/trialPack
 */
import starter from '../../../../../schemas/trial-pack.json'
import { serverReason } from '../../../lib/errors'
import type { FormV2 } from '../../FeedbackForms/model/formsV2'
import { templateById } from '../../FeedbackForms/formTemplates'
import type { TemplateFlow } from '../../FeedbackForms/templates/templateKit'
import { trialPackApi } from './trialPackApi'
import type { Invitee, StarterCategory } from './trialPackApi'

/** The pack's templates, in its order, as this build knows them. */
export const STARTER_TEMPLATES: readonly TemplateFlow[] = starter.forms
  .map((id) => templateById(id)).filter((flow): flow is TemplateFlow => flow !== undefined)
export const STARTER_CATEGORIES: readonly StarterCategory[] = starter.categories

/** What the admin chose to apply. */
interface PackChoice {
  readonly invitees: readonly Invitee[]
  /** The template ids of the forms to make. */
  readonly forms: readonly string[]
  readonly categories: boolean
}

/** One applied step: who or what, and whether it worked (with the server's reason when it did not). */
export interface PackStep {
  readonly kind: 'member' | 'form' | 'categories'
  readonly subject: string
  readonly ok: boolean
  readonly reason: string | null
}

async function step(kind: PackStep['kind'], subject: string, run: () => Promise<unknown>): Promise<PackStep> {
  try {
    await run()
    return { kind, subject, ok: true, reason: null }
  } catch (error: unknown) {
    return { kind, subject, ok: false, reason: serverReason(error) }
  }
}

/**
 * Apply `choice` in workspace `workspaceId`, in order: members, forms (each made by `formOf` from its template), then
 * the categories; every step's outcome, in that order.
 */
export async function applyStarterPack(workspaceId: string, choice: PackChoice,
  formOf: (flow: TemplateFlow) => FormV2): Promise<PackStep[]> {
  const steps: PackStep[] = []
  for (const invitee of choice.invitees) {
    steps.push(await step('member', invitee.email, () => trialPackApi.addMember(workspaceId, invitee)))
  }
  for (const flow of STARTER_TEMPLATES.filter((candidate) => choice.forms.includes(candidate.id))) {
    const form = formOf(flow)
    steps.push(await step('form', form.name, () => trialPackApi.createForm(workspaceId, form)))
  }
  if (choice.categories) {
    steps.push(await step('categories', String(STARTER_CATEGORIES.length),
      () => trialPackApi.saveCategories(workspaceId, STARTER_CATEGORIES)))
  }
  return steps
}
