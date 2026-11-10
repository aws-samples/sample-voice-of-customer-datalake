/**
 * @fileoverview The run's artifacts for "What it produced": one per document (its latest
 * event), in the order each first appeared. Runs before 5.35.00 journalled a review's document
 * as an artifact too, so every PR/FAQ was listed twice.
 *
 * @module pages/Agents/producedArtifacts
 */
import type { RunEvent } from '../../api/agentsApi'

export function producedArtifacts(events: readonly RunEvent[]): RunEvent[] {
  // A Map keeps each key where it was first set, and set() on an existing key updates the value.
  const latest = new Map<string, RunEvent>()
  for (const event of events) {
    if (event.kind === 'artifact') latest.set(event.ref?.document_id ?? `seq:${String(event.seq)}`, event)
  }
  return [...latest.values()]
}
