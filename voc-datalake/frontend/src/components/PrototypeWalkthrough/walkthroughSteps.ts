/**
 * @fileoverview The walkthrough editor's list rules (docs/prototype-builder.md Part 1), as pure functions: move a
 * step, add a picked element as a new step, describe where a step points, and the first problem that stops a save.
 * @module components/PrototypeWalkthrough/walkthroughSteps
 */
import { projectKey } from '../../api/projectQueryKeys'
import { WALKTHROUGH_LIMITS, stepProblem } from '../../api/prototypeWalkthroughSchema'
import type { WalkthroughStep } from '../../api/prototypeWalkthroughSchema'

/** The version's steps (VIEW), under the project's key so a save or a project refresh reads them again. */
export const walkthroughQueryKey = (projectId: string, documentId: string) =>
  [...projectKey(projectId), 'prototype-walkthrough', documentId] as const

/** The list with the step at `from` moved to `to` (unchanged when either is out of range). */
export function moveStep(steps: readonly EditorStep[], from: number, to: number): EditorStep[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return [...steps]
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  if (moved !== undefined) next.splice(to, 0, moved)
  return next
}

/**
 * A step as the editor holds it: `check` marks a drafted step whose place is the server's placeholder (the draft
 * cannot see the screen), to be re-pointed with the picker. Never saved.
 */
export type EditorStep = WalkthroughStep & { readonly check?: boolean }

type Picked = { readonly selector?: string; readonly anchor: NonNullable<WalkthroughStep['anchor']> }

/** Where a pick points a step: its selector (when it has one) and position, the "check" mark gone. */
function pointedAt(step: EditorStep, picked: Picked): EditorStep {
  const base: EditorStep = { title: step.title, body: step.body, anchor: picked.anchor }
  return picked.selector === undefined ? base : { ...base, selector: picked.selector }
}

/**
 * A picked element: re-points step `target` when one is being re-pointed, else becomes a new step with no text
 * yet (at most ten steps).
 */
export function withPickedStep(steps: readonly EditorStep[], picked: Picked, target: number | null = null): EditorStep[] {
  if (target !== null && target >= 0 && target < steps.length) return steps.map((step, i) => (i === target ? pointedAt(step, picked) : step))
  if (steps.length >= WALKTHROUGH_LIMITS.steps) return [...steps]
  return [...steps, pointedAt({ title: '', body: '' }, picked)]
}

/** Drafted steps: each marked "check its place" until re-pointed. */
export const draftedSteps = (steps: readonly WalkthroughStep[]): EditorStep[] => steps.map((step) => ({ ...step, check: true }))

/** The first step that cannot be saved, 1-based, with what is missing; null when every step can. */
export function firstProblem(steps: readonly WalkthroughStep[]): { readonly step: number; readonly field: 'title' | 'body' | 'anchor' } | null {
  for (const [index, step] of steps.entries()) {
    const field = stepProblem(step)
    if (field !== null) return { step: index + 1, field }
  }
  return null
}

/** The steps as saved and previewed: texts trimmed, the editor's marks dropped. */
export const trimmedSteps = (steps: readonly EditorStep[]): WalkthroughStep[] => steps.map((step) => {
  const saved: WalkthroughStep = { title: step.title.trim(), body: step.body.trim() }
  return {
    ...saved,
    ...(step.selector === undefined ? {} : { selector: step.selector }),
    ...(step.anchor === undefined ? {} : { anchor: step.anchor }),
  }
})
