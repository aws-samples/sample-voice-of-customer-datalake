/**
 * @fileoverview A skill version as a document (§6.3 "Skills are records, not files"; §6.4 [52] step 1): the adapter
 * Agents → Skills hands DocumentSurface, and the rules of a person's own version (gap M, D6-2).
 *
 * A version is a record: its instructions (the SKILL.md body above `## Examples`), its examples, and the tools, model
 * and harness it runs with. As a document it reads as a SKILL.md: a front-matter of the version's own properties
 * (model, harness, tools; flat `key: value` lines, so the surface shows them as Properties) above the instructions,
 * with `frontMatter: 'split'` so the editor only ever sees the body and the front-matter is joined back byte for byte
 * (components/Document/text/frontMatter.ts). The examples are a structured list beside it, never Markdown.
 *
 * Who decides: an accepted or rejected version never changes (`decided`); a proposal is accepted or rejected, never
 * edited (`proposalOnly`). A person changes a skill by proposing a version of their own on the one the scope runs
 * (`POST …/skills/<role>/versions`), accepted like any other; it never applies itself.
 *
 * @module pages/Agents/documents/skillDocument
 */
import { engineeringSkillsApi } from '../../../api/engineeringSkillsApi'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { unlessGone } from './readOnly'
import { joinFrontMatter, splitFrontMatter } from '../../../components/Document/text/frontMatter'
import type { DocumentAdapter, ReadOnlyReason, StoredDocument } from '../../../components/Document/types'
import type { ProposeBody } from '../../../api/engineeringSkillActionsApi'
import type { SkillRole, SkillTemplateUpdate, SkillVersionDetail } from '../../../api/engineeringSkillsApi'

/** The server's bounds on a version (runtime/harness/skills.py, skills/model.py, skills/actions.py). */
export const SKILL_LIMITS = {
  maxInstructionsChars: 20_000,
  maxInstructionLines: 500,
  maxExamples: 20,
  maxExampleChars: 2_000,
  maxSummaryChars: 200,
  maxReasonChars: 400,
} as const

export interface SkillExample { readonly situation: string; readonly action: string }

/** A skill version as the surface holds it: its SKILL.md text (front-matter and instructions), named by its scope. */
export interface SkillDocument extends StoredDocument {
  readonly connection: string
  readonly role: SkillRole
  readonly version: number
}

/** A value on one front-matter line: never empty, never a YAML block or a comment (Properties reads it as flat). */
const flat = (value: string) => {
  const one = value.replace(/\s+/gu, ' ').trim()
  return one === '' || /^[#|>]/u.test(one) ? `'${one.replaceAll("'", "''")}'` : one
}

/** The version's properties as a SKILL.md front-matter (flat lines: model, harness, tools). */
export function skillFrontMatter(record: SkillVersionDetail['record']): string {
  const lines = [`model: ${flat(record.model)}`, `harness: ${flat(record.harness)}`, `tools: ${flat(record.tool_policy.join(', '))}`]
  return `---\n${lines.join('\n')}\n---\n`
}

/** The version as a SKILL.md: its properties' front-matter, then its instructions. */
export function skillMarkdown(record: SkillVersionDetail['record']): string {
  return joinFrontMatter(skillFrontMatter(record), record.instructions)
}

/** The instructions a SKILL.md's body is (what a proposal sends), the front-matter left as it was read. */
export function instructionsOf(markdown: string): string {
  return splitFrontMatter(markdown).body
}

export function skillDocumentOf(connection: string, role: SkillRole, detail: SkillVersionDetail, title: string): SkillDocument {
  return { title, content: skillMarkdown(detail.record), connection, role, version: detail.version }
}

/** Why a version is read only: an accepted or rejected one is decided; a proposal is decided on, never edited. */
export function skillReadOnlyReason(status: string): ReadOnlyReason {
  return status === 'accepted' || status === 'rejected' ? 'decided' : 'proposalOnly'
}

/**
 * The surface's adapter for one version of a role's skill in a scope (`''`: the shared skills). Read only: a change is
 * a proposal of its own (`proposalIssues`, `proposeBody`), sent through the Propose sheet. `load` reads the version
 * again (undefined: gone from the scope).
 */
export function skillAdapter(connection: string, role: SkillRole, status: string, title: (version: number) => string):
DocumentAdapter<SkillDocument> {
  return {
    id: `skill:${connection}:${role}`,
    contentType: 'markdown',
    frontMatter: 'split',
    // A skill is a prompt; the coach's text included: no images, only safe links.
    policy: 'model',
    limits: { maxChars: SKILL_LIMITS.maxInstructionsChars, maxLines: SKILL_LIMITS.maxInstructionLines },
    permissions: { edit: skillReadOnlyReason(status) },
    versionOf: (stored) => ({ token: `${stored.connection}/${stored.role}/v${String(stored.version)}`, number: stored.version }),
    load: async (stored) => {
      const detail = await unlessGone(() => engineeringSkillsApi.version(stored.connection, stored.role, stored.version))
      return detail && skillDocumentOf(stored.connection, stored.role, detail, title(detail.version))
    },
  }
}

/** A role's bundled template as a document ("Template updated", compared with the version in use). */
export interface SkillTemplateDocument extends StoredDocument {
  /** The template's label (`fixer@template-4`): it changes only with a release. */
  readonly label: string
}

export function skillTemplateDocumentOf(update: SkillTemplateUpdate, title: string): SkillTemplateDocument {
  return { title, content: skillMarkdown(update.record), label: update.template.label }
}

/**
 * The surface's adapter for a role's template (`managedByTemplate`: it ships with a release, in
 * templates/orchestration). Its record is the answer the panel read; `load` reads the template again.
 */
export function skillTemplateAdapter(connection: string, role: SkillRole, title: string): DocumentAdapter<SkillTemplateDocument> {
  return {
    id: `skill-template:${connection}:${role}`,
    contentType: 'markdown',
    frontMatter: 'split',
    policy: 'model',
    permissions: { edit: 'managedByTemplate' },
    versionOf: (stored) => ({ token: stored.label }),
    load: async () => skillTemplateDocumentOf(await engineeringSkillsApi.template(connection, role), title),
  }
}

/** A person's own version, as the Propose sheet holds it. */
export interface SkillProposal {
  readonly summary: string
  /** The SKILL.md body (the instructions) as the editor gives it. */
  readonly instructions: string
  readonly examples: readonly SkillExample[]
  readonly reason: string
}

export type ProposalIssue =
  | 'summaryMissing' | 'summaryLong' | 'summaryLines'
  | 'instructionsMissing' | 'instructionsLong' | 'instructionsLines' | 'examplesHeading'
  | 'examplesTooMany' | 'exampleMissing' | 'exampleLong'
  | 'reasonLong' | 'unchanged'

/**
 * A line the next compile would read as the start of the examples (compile.py: the body above `## Examples`): an
 * ATX heading of level 2 whose text is "Examples" (any case, closing `#`s allowed).
 */
function isExamplesHeading(line: string): boolean {
  const [marks, word, ...rest] = line.trim().split(/\s+/u)
  return marks === '##' && word?.toLowerCase() === 'examples' && rest.every((part) => /^#+$/u.test(part))
}

const exampleKey = (example: SkillExample) => `${example.situation.trim()}\u0000${example.action.trim()}`
const sameExamples = (a: readonly SkillExample[], b: readonly SkillExample[]) =>
  a.map(exampleKey).join('\u0001') === b.map(exampleKey).join('\u0001')

function summaryIssues(summary: string): ProposalIssue[] {
  if (summary === '') return ['summaryMissing']
  if (summary.includes('\n')) return ['summaryLines']
  return summary.length > SKILL_LIMITS.maxSummaryChars ? ['summaryLong'] : []
}

function instructionIssues(instructions: string): ProposalIssue[] {
  const lines = instructions.split('\n')
  const checks: readonly [boolean, ProposalIssue][] = [
    [instructions.trim() === '', 'instructionsMissing'],
    [instructions.length > SKILL_LIMITS.maxInstructionsChars, 'instructionsLong'],
    [lines.length > SKILL_LIMITS.maxInstructionLines, 'instructionsLines'],
    [lines.some(isExamplesHeading), 'examplesHeading'],
  ]
  return checks.filter(([failed]) => failed).map(([, issue]) => issue)
}

function exampleIssues(examples: readonly SkillExample[]): ProposalIssue[] {
  const halves = examples.flatMap((example) => [example.situation, example.action])
  const checks: readonly [boolean, ProposalIssue][] = [
    [examples.length > SKILL_LIMITS.maxExamples, 'examplesTooMany'],
    [halves.some((half) => half.trim() === ''), 'exampleMissing'],
    [halves.some((half) => half.length > SKILL_LIMITS.maxExampleChars), 'exampleLong'],
  ]
  return checks.filter(([failed]) => failed).map(([, issue]) => issue)
}

/**
 * What to fix before a proposal is sent (the server checks it all again): a one-line summary, instructions within the
 * bounds and without an `## Examples` heading, at most 20 examples each with both halves, and something changed from
 * the version it is written on.
 */
export function proposalIssues(proposal: SkillProposal, base: SkillVersionDetail['record']): ProposalIssue[] {
  const unchanged = proposal.instructions.trim() === base.instructions.trim() && sameExamples(proposal.examples, base.examples)
  return [
    ...summaryIssues(proposal.summary.trim()),
    ...instructionIssues(proposal.instructions),
    ...exampleIssues(proposal.examples),
    ...(proposal.reason.trim().length > SKILL_LIMITS.maxReasonChars ? ['reasonLong' as const] : []),
    ...(unchanged ? ['unchanged' as const] : []),
  ]
}

/** The examples a proposal adds and removes from its base's (by their text), as the server's diff lists them. */
export function exampleChanges(base: readonly SkillExample[], next: readonly SkillExample[]): ExampleChange[] {
  const keyOf = (example: SkillExample) => `${example.situation.trim()}\u0000${example.action.trim()}`
  const before = new Set(base.map(keyOf))
  const after = new Set(next.map(keyOf))
  const change = (op: '+' | '-', example: SkillExample): ExampleChange =>
    [op, { situation: example.situation.trim(), action: example.action.trim() }]
  return [
    ...base.filter((example) => !after.has(keyOf(example))).map((example) => change('-', example)),
    ...next.filter((example) => !before.has(keyOf(example))).map((example) => change('+', example)),
  ]
}

/** An example added (`+`) or removed (`-`), as the server's diff lists one. */
export type ExampleChange = ['+' | '-', { situation: string; action: string }]

/** What the proposal sends (gap M): the version it is written on as the screen showed it (0: none). */
export function proposeBody(proposal: SkillProposal, baseVersion: number): ProposeBody {
  const reason = proposal.reason.trim()
  return {
    base_version: baseVersion,
    instructions: proposal.instructions,
    examples: proposal.examples.map((example) => ({ situation: example.situation.trim(), action: example.action.trim() })),
    summary: proposal.summary.trim(),
    ...(reason === '' ? {} : { reason }),
  }
}

/** A refusal that means the scope runs another version now than the one the proposal was written on (409). */
export function isStaleBase(error: unknown): boolean {
  return apiErrorStatus(error) === 409
}
