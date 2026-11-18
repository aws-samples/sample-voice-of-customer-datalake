/**
 * @fileoverview The https addresses an AI draft suggests (an ending's button, a statement's link button): the
 * contract's rule is that the person confirms each one, so each is an error (`aiAddress`) until confirmed or removed
 * (UX §12.3). The server has already dropped any address that is not https.
 *
 * @module pages/FeedbackForms/ai/aiAddresses
 */
import type { FormV2 } from '../model/formsV2'
import type { ProblemLocation } from '../model/validateForm'

/** Every address in `form`, as where it is. */
export function draftAddresses(form: FormV2): ProblemLocation[] {
  const endings = form.endings.filter((ending) => ending.button !== undefined && ending.button.url !== '')
    .map((ending): ProblemLocation => ({ kind: 'ending', id: ending.id, field: 'button_url' }))
  const statements = form.questions.filter((question) => question.type === 'statement' && (question.cta?.url ?? '') !== '')
    .map((question): ProblemLocation => ({ kind: 'question', id: question.id, field: 'cta_url' }))
  return [...statements, ...endings]
}

/** The address at `location` in `form`, '' when there is none (no longer). */
export function addressAt(form: FormV2, location: ProblemLocation): string {
  if (location.kind === 'ending') return form.endings.find((ending) => ending.id === location.id)?.button?.url ?? ''
  const question = form.questions.find((q) => q.id === location.id)
  return question?.type === 'statement' ? question.cta?.url ?? '' : ''
}

/** `form` without the address at `location` (an ending's button goes; a statement's link loses its address). */
export function withoutAddress(form: FormV2, location: ProblemLocation): FormV2 {
  if (location.kind === 'ending') {
    return { ...form, endings: form.endings.map((ending) => (ending.id === location.id ? { ...ending, button: undefined } : ending)) }
  }
  return {
    ...form,
    questions: form.questions.map((q) => (q.id === location.id && q.type === 'statement' && q.cta !== undefined
      ? { ...q, cta: { ...q.cta, url: undefined } } : q)),
  }
}

export const sameLocation = (a: ProblemLocation, b: ProblemLocation): boolean =>
  a.kind === b.kind && a.id === b.id && a.field === b.field
