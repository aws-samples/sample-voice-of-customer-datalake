/**
 * @fileoverview Which half of a persona scenario's "trigger → desired outcome"
 * pair is worth rendering — shared by the on-screen persona view
 * (`pages/ProjectDetail/PersonaSections`) and the PDF export
 * (`PersonaPDFSections`), so the two cannot disagree about when the row shows.
 *
 * @module components/PersonaExportMenu/scenarioTriggerOutcome
 */
import { isNonEmptyString } from '../../api/lenientFields'
import type { ProjectPersona } from '../../api/projectTypes'

type Scenario = NonNullable<ProjectPersona['scenario']>

/** The non-empty trigger and outcome (each `null` when blank), or `null` when neither is set. */
export function scenarioTriggerOutcome(
  scenario: Scenario,
): { readonly trigger: string | null; readonly outcome: string | null } | null {
  const trigger = isNonEmptyString(scenario.trigger) ? scenario.trigger : null
  const outcome = isNonEmptyString(scenario.outcome) ? scenario.outcome : null
  if (trigger === null && outcome === null) return null
  return { trigger, outcome }
}
