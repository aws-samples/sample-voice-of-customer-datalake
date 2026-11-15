/**
 * The project's Build Prototype flow, started from either place that offers it: the Overview's prototype card and the
 * Documents tab's Prototypes section ("New"). One wiring of `usePrototypeBuild` from the derived project state, so
 * both open the same build dialog with the same sources and the same "needs a PRD or PR/FAQ" rule.
 *
 * @module pages/ProjectDetail/useProjectPrototypeBuild
 */
import { usePrototypeBuild, type PrototypeBuildControl } from './usePrototypeBuild'
import type { OverviewState } from './overviewState'
import type { DesignSystem } from '../../api/designSystemApi'

interface ProjectPrototypeBuildInput {
  readonly projectId: string
  /** `deriveOverviewState`'s answer for the project (its prototype step and sources). */
  readonly state: Pick<OverviewState, 'steps' | 'prototypeSources'>
  /** The company design system for the dialog's "Design system" box; undefined = not known. */
  readonly designSystem?: DesignSystem
  /** Tells the Background Jobs panel to pick up a started build. */
  readonly onJobStarted?: () => void
}

export function useProjectPrototypeBuild({
  projectId, state, designSystem, onJobStarted,
}: ProjectPrototypeBuildInput): PrototypeBuildControl {
  const { steps, prototypeSources } = state
  return usePrototypeBuild({
    projectId,
    hasPrd: prototypeSources.hasPrd,
    hasPrfaq: prototypeSources.hasPrfaq,
    hasExistingPrototype: steps.prototype.hasOutput,
    prdOptions: prototypeSources.prdOptions,
    prfaqOptions: prototypeSources.prfaqOptions,
    researchOptions: prototypeSources.researchOptions,
    visualOptions: prototypeSources.visualOptions,
    visualsExtracting: prototypeSources.visualsExtracting,
    visualsFailed: prototypeSources.visualsFailed,
    design: designSystem,
    onJobStarted,
  })
}
