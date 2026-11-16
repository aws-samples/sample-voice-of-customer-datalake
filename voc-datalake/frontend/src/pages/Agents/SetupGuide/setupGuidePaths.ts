/**
 * @fileoverview The setup guide's addresses (7.50.00), as paths (utils/pathPlace.ts): `/agents/setup` is the guide at
 * the step it recommends, `/agents/setup/<step>` one step (`prerequisites`, `understand`, `tenets`, `triage`,
 * `bug-fixer`, `feature-builder`, `ready`), so Back walks the steps. An unknown step, or anything after it, is
 * replaced by the guide's own path, in place. `setup` is never an agent's id (`ag_<12 hex>`): routes.tsx lists the
 * guide before `agents/:id`.
 *
 * @module pages/Agents/SetupGuide/setupGuidePaths
 */
import { pathOf, segmentsUnder } from '../../../utils/pathPlace'
import { SETUP_STEP_IDS } from '../../../api/engineeringSetupApi'
import type { Address, PlaceRead } from '../../../utils/pathPlace'
import type { SetupStepId } from '../../../api/engineeringSetupApi'

export const SETUP_GUIDE_PATH = '/agents/setup'

/** A step as its path segment (`bug_fixer` → `bug-fixer`). */
const segmentOf = (step: SetupStepId): string => step.replaceAll('_', '-')

/** The guide (`/agents/setup`), or one of its steps (`/agents/setup/bug-fixer`). */
export function setupGuidePath(step?: SetupStepId): string {
  return step === undefined ? SETUP_GUIDE_PATH : pathOf(['agents', 'setup', segmentOf(step)])
}

/**
 * The step an address of the guide names (null: the guide, at the step it recommends) and the address to replace it
 * with (null: its own); null when the address is not the guide's.
 */
export function readSetupGuideAddress(address: Address): PlaceRead<SetupStepId | null> | null {
  const segments = segmentsUnder(SETUP_GUIDE_PATH, address.pathname)
  if (segments === null) return null
  const [first, ...rest] = segments
  if (first === undefined) return { place: null, replaceWith: null }
  const step = SETUP_STEP_IDS.find((id) => segmentOf(id) === first) ?? null
  const own = step !== null && rest.length === 0
  return { place: step, replaceWith: own ? null : { pathname: setupGuidePath(step ?? undefined), search: address.search } }
}
