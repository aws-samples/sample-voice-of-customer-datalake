/**
 * @fileoverview The Overview's research and documents hints, from the server's methodology list.
 *
 * `GET /projects/{id}` answers, per step, the upstream steps the project has not produced yet
 * (lambda/shared/methodology.py overview). `deriveOverviewState` hands that list on as
 * `missingSteps`; these helpers turn it into the card's hint, one sentence per known step, so every
 * client names the same gaps. Without the list (an older API) the card keeps its earlier hint.
 * @module pages/ProjectDetail/methodologyHint
 */
import type { TFunction } from 'i18next'
import type { OverviewStepState } from './overviewState'

/** The sentence for one missing step on a card, or null for a step the card does not name. */
type StepSentence = (t: TFunction<'projectDetail'>, step: string) => string | null

/** The hint: the server's steps as sentences, else `fallback` (also when none is known). */
function hintFrom(state: OverviewStepState, t: TFunction<'projectDetail'>, sentence: StepSentence, fallback: string): string | undefined {
  if (!state.missingUpstream) return undefined
  const sentences = (state.missingSteps ?? []).flatMap((step) => sentence(t, step) ?? [])
  return sentences.length > 0 ? sentences.join(' ') : fallback
}

const researchSentence: StepSentence = (t, step) => (
  step === 'personas' ? t('overview.hint.researchNeedsPersonas') : null
)

function documentsSentence(t: TFunction<'projectDetail'>, step: string): string | null {
  switch (step) {
    case 'personas': return t('overview.hint.documentsNeedPersonas')
    case 'prfaq': return t('overview.hint.prdNeedsPrfaq')
    default: return null
  }
}

/** The research card's hint (personas missing), or undefined when nothing is missing. */
export function researchHint(state: OverviewStepState, t: TFunction<'projectDetail'>): string | undefined {
  return hintFrom(state, t, researchSentence, t('overview.hint.researchNeedsPersonas'))
}

/** The PR/FAQ + PRD card's hint (personas, a PR/FAQ before the PRD), or undefined. */
export function documentsHint(state: OverviewStepState, t: TFunction<'projectDetail'>): string | undefined {
  return hintFrom(state, t, documentsSentence, t('overview.hint.documentsNeedContext'))
}
