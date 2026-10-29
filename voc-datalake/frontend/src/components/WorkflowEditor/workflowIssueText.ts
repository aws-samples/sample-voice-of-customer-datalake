/**
 * @fileoverview A workflow issue as people read it.
 *
 * The rule messages are the server's (`lambda/shared/workflow_schema.py`, mirrored by
 * graphRules.ts so the two stay comparable). The ones written in field names — "instructions
 * is required", "persona_review needs params.target: …" — read as developer text in the
 * editor, so they are shown as plain translated sentences (`editor.issues.*`). Any other
 * message is shown as written.
 *
 * @module components/WorkflowEditor/workflowIssueText
 */
import type { TFunction } from 'i18next'

/** Exact server/client message → `agents:editor.issues.<key>`. */
const EXACT: Readonly<Record<string, string>> = {
  'instructions is required': 'instructionsRequired',
  'title is required': 'titleRequired',
  'node id is used more than once': 'duplicateStep',
  'edge id is used more than once': 'duplicateArrow',
}

/** Message prefix → key, for the messages that list the allowed values. */
const PREFIXES: readonly (readonly [string, string])[] = [
  ['persona_review needs params.target', 'reviewTarget'],
  ['end params.status must be one of', 'endStatus'],
]

export function workflowIssueText(t: TFunction<'agents'>, message: string): string {
  const key = EXACT[message] ?? PREFIXES.find(([prefix]) => message.startsWith(prefix))?.[1]
  return key === undefined ? message : t(`editor.issues.${key}`)
}
