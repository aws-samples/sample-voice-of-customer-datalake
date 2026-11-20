/**
 * @fileoverview The model an engineering agent runs on (7.58.00), as a person chooses it: one choice for both harnesses,
 * mapped to each (the backend's `lambda/engineering/runtime/harness/model_choice.py`, the same table):
 *
 * - `auto`: Kiro chooses per task (`auto`); Kiro only, so on the native harness the role's default model;
 * - `opus`, `sonnet`, `haiku`: Claude Opus, Sonnet or Haiku 5.5 (Kiro's `claude-<family>-5.5`, Bedrock's
 *   `global.anthropic.claude-<family>-5-5`);
 * - any other model id ("Other model…"): typed by a person, used as it is on the harness the role runs on (a Kiro model
 *   id, or a Bedrock model or inference profile id this deployment enables); on Kiro a Claude Bedrock id by Kiro's name.
 *
 * On a role the native harness runs, a select offers no Auto (Kiro's alone: the role's default there) and its "Other
 * model…" is one of the Bedrock models this deployment enables (the Registry's `bedrock_enabled`: granted and priced)
 * beyond the three named, never an id typed (`choicesOn`, `otherModelsOn`). A card names no choice of its own.
 *
 * No choice (null or '') is the role's default: its card's model, on Kiro by Kiro's name for it
 * (`global.anthropic.claude-sonnet-5-5` → `claude-sonnet-5.5`, the backend's `kiro_pin.py` `kiro_model`; a model Kiro
 * has no name for is asked as it is, and the step stops for a person). Pure: the forms (ModelChoiceField.tsx), the
 * Registry and the run page read it.
 *
 * @module pages/Agents/modelChoice
 */

/** The named choices, in the order a select offers them. */
export const NAMED_MODEL_CHOICES = ['auto', 'opus', 'sonnet', 'haiku'] as const
export type NamedModelChoice = (typeof NAMED_MODEL_CHOICES)[number]
/** The harness a role runs on in a deployment (`-c engineeringHarness`). */
export type ModelHarness = 'native' | 'kiro'

/** Each named choice's Kiro model id. */
export const KIRO_MODELS: Readonly<Record<NamedModelChoice, string>> = {
  auto: 'auto', opus: 'claude-opus-5.5', sonnet: 'claude-sonnet-5.5', haiku: 'claude-haiku-5.5',
}
/** Each named choice's Bedrock model id (Auto has none: the role's default runs). */
export const BEDROCK_MODELS: Readonly<Record<Exclude<NamedModelChoice, 'auto'>, string>> = {
  opus: 'global.anthropic.claude-opus-5-5',
  sonnet: 'global.anthropic.claude-sonnet-5-5',
  haiku: 'global.anthropic.claude-haiku-5-5',
}

/** A typed model id: a letter or digit, then letters, digits and `._:/-`, 128 characters at most. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

/** Whether `value` is a model id a person may type: the shape above, and never `//` (no URL). */
export function isModelId(value: string): boolean {
  return MODEL_ID.test(value) && !value.includes('//')
}

export function isNamedChoice(value: unknown): value is NamedModelChoice {
  return typeof value === 'string' && NAMED_MODEL_CHOICES.some((name) => name === value)
}

/** What a form's select holds: the role's default (''), a named choice, or another id typed beside it. */
export type ModelPick = '' | NamedModelChoice | 'other'
export interface ModelDraft {
  readonly pick: ModelPick
  readonly other: string
}

/** The form's state for a stored choice (null or '' is the role's default). */
export function draftOf(choice: string | null): ModelDraft {
  if (choice === null || choice === '') return { pick: '', other: '' }
  return isNamedChoice(choice) ? { pick: choice, other: '' } : { pick: 'other', other: choice }
}

/** The choice a form's state says (null: the role's default); another id is trimmed. */
export function modelChoiceOf(draft: ModelDraft): string | null {
  if (draft.pick === '') return null
  return draft.pick === 'other' ? draft.other.trim() : draft.pick
}

/** The picks a select offers on a harness (`any`: the run's roles may be on either): the default, the named choices and
 * "Other model…"; on the native harness no Auto, unless it is the pick already (saved while the role ran on Kiro: shown
 * as it is). */
export function choicesOn(harness: ModelHarness | 'any', current: ModelPick = ''): readonly ModelPick[] {
  const named = harness === 'native' && current !== 'auto' ? NAMED_MODEL_CHOICES.filter((name) => name !== 'auto') : NAMED_MODEL_CHOICES
  return ['', ...named, 'other']
}

/** What a native role's "Other model…" offers: the models this deployment enables beyond the three named ones, sorted;
 * with `current` first when it is none of them (a choice saved earlier, which `modelIssue` says is not enabled). */
export function otherModelsOn(enabled: readonly string[], current: string): string[] {
  const named = new Set<string>(Object.values(BEDROCK_MODELS))
  const others = [...new Set(enabled)].filter((id) => !named.has(id)).sort((a, b) => a.localeCompare(b))
  const id = current.trim()
  return id === '' || others.includes(id) ? others : [id, ...others]
}

/** Why a form's other id cannot be saved: none typed, off its shape, or (native) a model this deployment does not
 * enable; null when it can, or when the pick is not "Other model…". */
export type ModelIssue = 'empty' | 'format' | 'notEnabled'
export function modelIssue(draft: ModelDraft, enabled: readonly string[] | null = null): ModelIssue | null {
  if (draft.pick !== 'other') return null
  const id = draft.other.trim()
  if (id === '') return 'empty'
  if (!isModelId(id)) return 'format'
  return enabled !== null && !isNamedChoice(id) && !enabled.includes(id) ? 'notEnabled' : null
}

/** A Claude model's Bedrock id (its family, major and minor version), as the backend's `kiro_pin.py` reads one. */
const CLAUDE_MODEL = /^(?:[a-z]+\.)?anthropic\.claude-(opus|sonnet|haiku)-(\d+)(?:-(\d))?(?:-\d{8}-v\d+:\d+)?$/

/** Kiro's name for the Claude model a Bedrock id names (`claude-sonnet-5.5`); the id itself for any other model. */
export function kiroName(id: string): string {
  const found = CLAUDE_MODEL.exec(id)
  if (found === null) return id
  const [, family = '', major = '', minor] = found
  return minor === undefined ? `claude-${family}-${major}` : `claude-${family}-${major}.${minor}`
}

/** The model a choice runs on a harness: on Kiro its Kiro id (none: the role's default by Kiro's name), on the native
 * harness its Bedrock id (the role's default for none and for Auto). */
export function modelOn(choice: string | null, harness: ModelHarness, roleDefault: string): string {
  const named = isNamedChoice(choice) ? choice : null
  const given = choice === null || choice === '' ? null : choice
  if (harness === 'kiro') return named === null ? kiroName(given ?? roleDefault) : KIRO_MODELS[named]
  if (named === null) return given ?? roleDefault
  return named === 'auto' ? roleDefault : BEDROCK_MODELS[named]
}
