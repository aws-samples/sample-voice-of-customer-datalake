/**
 * @fileoverview The run workspace's addresses (7.51.00), as paths (utils/pathPlace.ts): a run is
 * `/agents/engineering/<run>`, and one of its agents open in it `/agents/engineering/<run>/a/<agent>` (inside a
 * workspace, `/workspace/<slug>/…`: the router's basename). The orchestrator's thread is the run's own address. The
 * Runs list is `/agents/runs`, a view of the Agents list (agentsPaths.ts), whose filters stay in the query
 * (`?month=&flow=&status=`, runsFilters.ts).
 *
 * @module pages/Agents/RunWorkspace/runWorkspacePaths
 */
import { pathOf, segmentsUnder } from '../../../utils/pathPlace'
import type { Address, PlaceRead } from '../../../utils/pathPlace'

const RUNS_BASE = '/agents/engineering'
const AGENT_SEGMENT = 'a'

/** Where the workspace is: the agent open in it (null: the orchestrator); the run is the route's own `:runId`. */
export interface RunPlace {
  readonly agent: string | null
}

/** The address of a run, or of one of its agents open in it. */
export function runWorkspacePath(runId: string, agent: string | null = null): string {
  return pathOf(['agents', 'engineering', runId, ...(agent === null ? [] : [AGENT_SEGMENT, agent])])
}

/**
 * The place an address names, and the address to replace it with when it names it off its form (an unknown segment
 * after the run: the run itself, query kept); null when the address is not a run's.
 */
export function readRunAddress(address: Address): PlaceRead<RunPlace> | null {
  const [runId, marker, agent, ...rest] = segmentsUnder(RUNS_BASE, address.pathname) ?? []
  if (runId === undefined) return null
  const named = marker === AGENT_SEGMENT && agent !== undefined && rest.length === 0
  const place: RunPlace = { agent: named ? agent : null }
  const own = marker === undefined || named
  return { place, replaceWith: own ? null : { pathname: runWorkspacePath(runId), search: address.search } }
}
