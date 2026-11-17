/**
 * @fileoverview What the flow canvas reads of the setup behind a step (7.52.00 C2; docs/ux part 5 §5.4, §5.5): the
 * Registry's cards (`GET /agents/engineering/registry[/<card>]?connection=`), the quality gates' packs with their
 * steps, tools and briefs (`GET …/gates?connection=`; a brief's text is the Registry's read, engineeringRegistryApi.ts)
 * and the assertions' closed vocabulary (`GET …/assertions`), as `lambda/shared/agents_engineering_registry_routes.py`
 * answers them. The Registry's pages (7.52.00 C3) read the same routes through engineeringRegistryApi.ts: one client
 * for both is a follow-up (the two parse the same answers for different screens).
 *
 * Administrators only, and only where the engineering agents are on (404 elsewhere): the inspector and the palette
 * ask only then, and a canvas without them still draws every step from its definition. Every read is lenient: an
 * unreadable field costs itself, never the panel.
 *
 * @module api/flowSetupApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { eachOf } from './lenientFields'

const text = z.string().catch('')
const maybeText = z.string().nullable().catch(null)
const maybeNumber = z.number().nullable().catch(null)
const strings = z.array(z.string()).catch([])
const record = z.record(z.string(), z.unknown()).catch({})

/** The skill a card runs: the scope's version of it (the connection's own, else the shared one), or the template. */
const CardSkillSchema = z.object({
  source: z.enum(['store', 'template']).catch('template'),
  label: text,
  connection: maybeText.optional().transform((value) => value ?? null),
  version: maybeNumber.optional().transform((value) => value ?? null),
  status: maybeText.optional().transform((value) => value ?? null),
  provenance: maybeText.optional().transform((value) => value ?? null),
  template_version: maybeNumber.optional().transform((value) => value ?? null),
  /** A newer template than the version the scope runs (Skills' "Template updated"). */
  template_newer: z.boolean().catch(false),
})

/** An input or an output of a card's contract (`voc-agent-card/1`). */
const CardIoSchema = z.object({
  name: z.string().min(1),
  from: text,
  kind: text,
  required: z.boolean().catch(false),
  trust: text,
})
export type CardIo = z.output<typeof CardIoSchema>

/** A role's card over its connection's runs (null for the shared scope). */
const ScorecardSchema = z.object({
  label: text, runs: z.number().catch(0), pass_rate: maybeNumber, cost_usd: maybeNumber,
}).nullable().catch(null)

const SpendSchema = z.object({ month: text, usd: z.number().catch(0) }).nullable().catch(null)

/** The agent step a card makes in a flow (the palette's drop). */
const CardNodeSchema = z.object({
  type: z.literal('agent'),
  data: z.object({ title: text, params: record }),
}).nullable().catch(null)

/**
 * A card of the Registry: a role's (`kind: role`, id = the role; every role has one, so a step that names only a role
 * resolves to it) or one made from an accepted skill version (`kind: card`, `<role>-<slug>` at its version).
 */
const RegistryCardSchema = z.object({
  kind: z.enum(['role', 'card']).catch('role'),
  id: z.string().min(1),
  /** A made card's version (a role's card has none: its template has one). */
  version: maybeNumber.optional().transform((value) => value ?? null),
  base_role: text,
  title: text,
  purpose: text,
  launchable: z.boolean().catch(true),
  template: z.object({ version: maybeNumber, label: text }).nullable().catch(null).optional().transform((value) => value ?? null),
  skill: CardSkillSchema.catch(CardSkillSchema.parse({})),
  model: text,
  tools: strings,
  harness: text,
  broker_ops: strings,
  caps: record,
  inputs: eachOf(CardIoSchema),
  outputs: eachOf(CardIoSchema),
  evals: strings,
  scorecard: ScorecardSchema.optional().transform((value) => value ?? null),
  spend: SpendSchema.optional().transform((value) => value ?? null),
  node: CardNodeSchema.optional().transform((value) => value ?? null),
})
export type RegistryCard = z.output<typeof RegistryCardSchema>

const RegistrySchema = z.object({ connection: text, cards: eachOf(RegistryCardSchema) })

/** A made card's answer: the card at its current version (its versions and events are the Registry page's). */
const CardAnswerSchema = z.object({ card: RegistryCardSchema })

/** What a gate step says when it does not pass (`registry/views.py step_messages`). */
const StepMessageSchema = z.object({ status: text, reason: text, of: text })

/** A gate pack's step: its kind (setup, lint, types, test…), its name, when it applies, and how it fails. */
const GateStepSchema = z.object({
  id: z.string().min(1),
  language: text,
  name: text,
  kind: text,
  argv: strings,
  timeout_s: maybeNumber,
  /** Applies when any of these is in the repository (none: always). */
  when_any: eachOf(z.object({ file: text, contains: text, npm_script: text })),
  /** The vacuous-pass rule in words (how it fails when it checked nothing); null: an exit 0 passes. */
  looked_at_nothing: maybeText.optional().transform((value) => value ?? null),
  messages: eachOf(StepMessageSchema),
})
export type GateStep = z.output<typeof GateStepSchema>

const GatePackSchema = z.object({
  id: z.string().min(1),
  name: text,
  languages: strings,
  /** The image's pins (`{python: '3.12', node: '24'}`). */
  image: z.record(z.string(), z.string()).catch({}),
  /** The registries its setup steps reach (setup only). */
  network: strings,
  tools: eachOf(z.object({ name: z.string().min(1) })),
  steps: eachOf(GateStepSchema),
  briefs: strings,
  /** With `?connection=`: the tools' versions as the connection's newest gate record holds them, and when. */
  recorded: z.object({ tool_versions: z.record(z.string(), z.string()).catch({}), run_id: maybeText, at: maybeText })
    .nullable().catch(null).optional().transform((value) => value ?? null),
})
export type GatePack = z.output<typeof GatePackSchema>

/** An owner's brief, without its text (read on its own: engineeringRegistryApi.brief). */
const BriefSchema = z.object({ id: z.string().min(1), path: text, packs: strings, digest: text, bytes: z.number().catch(0) })
export type GateBrief = z.output<typeof BriefSchema>

/** Why a gate stops at a person: a code, its text key (`gates.stops.<code>`) and the English words. */
const GateStopSchema = z.object({ code: z.string().min(1), text: text, text_key: text })
export type GateStop = z.output<typeof GateStopSchema>

const GatesSchema = z.object({
  packs: eachOf(GatePackSchema),
  /** The two-language packs before 7.50.00, each standing for its two. */
  aliases: z.record(z.string(), strings).catch({}),
  own_gate: z.object({ file: text }).catch({ file: '' }),
  briefs: eachOf(BriefSchema),
  /** Who runs a gate that names nobody (`gate-runner@latest`, `final-go@latest`). */
  defaults: z.object({ runner: z.string().catch('gate-runner@latest'), final_go: z.string().catch('final-go@latest') })
    .catch({ runner: 'gate-runner@latest', final_go: 'final-go@latest' }),
  stops: eachOf(GateStopSchema),
  connection: maybeText.optional().transform((value) => value ?? null),
})
export type GatesView = z.output<typeof GatesSchema>


/** One argument of an assertion: `role` (a role id), `integer` (with its bounds) or text. */
const AssertionArgSchema = z.object({ name: z.string().min(1), type: text, minimum: maybeNumber, maximum: maybeNumber })
export type AssertionArg = z.output<typeof AssertionArgSchema>

/** One check of the vocabulary: what it asks, its text keys, its arguments, the steps it is checked on, its `on_fail`s. */
const AssertionCheckSchema = z.object({
  check: z.string().min(1),
  asks: text,
  label_key: text,
  description_key: text,
  args: eachOf(AssertionArgSchema),
  /** The step types (or `learn`, Start's Learn) it is checked on. */
  kinds: strings,
  on_fail: strings,
})
export type AssertionCheck = z.output<typeof AssertionCheckSchema>

const VocabularySchema = z.object({
  checks: eachOf(AssertionCheckSchema),
  on_fail: eachOf(z.object({ id: z.string().min(1), means: text })),
  default_on_fail: z.string().catch('block'),
  max: z.number().int().positive().catch(10),
  roles: strings,
})
export type AssertionVocabulary = z.output<typeof VocabularySchema>

function parsed<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.output<S> {
  const result = schema.safeParse(raw)
  if (!result.success) throw new Error(`The ${what} answer was unreadable`)
  return result.data
}

const scoped = (route: string, connection: string | null): string =>
  (connection === null || connection === '' ? route : `${route}?${new URLSearchParams({ connection }).toString()}`)

const REGISTRY = '/agents/engineering/registry'
const GATES = '/agents/engineering/gates'

export const flowSetupKeys = {
  all: () => ['flow-setup'] as const,
  registry: (connection: string | null) => ['flow-setup', 'registry', connection ?? ''] as const,
  card: (card: string, connection: string | null) => ['flow-setup', 'card', card, connection ?? ''] as const,
  gates: (connection: string | null) => ['flow-setup', 'gates', connection ?? ''] as const,
  assertions: () => ['flow-setup', 'assertions'] as const,
}

export const flowSetupApi = {
  /** Every card of the Registry for the scope (`connection` null: the shared skills). */
  registry: async (connection: string | null): Promise<RegistryCard[]> =>
    parsed(RegistrySchema, await fetchApi<unknown>(scoped(REGISTRY, connection)), 'Registry').cards,

  /** One card: a role's (`{card}`) or a made card at its current version (`{card, versions, events}`). */
  card: async (card: string, connection: string | null): Promise<RegistryCard> =>
    parsed(CardAnswerSchema, await fetchApi<unknown>(scoped(`${REGISTRY}/${encodeURIComponent(card)}`, connection)), 'card').card,

  gates: async (connection: string | null): Promise<GatesView> =>
    parsed(GatesSchema, await fetchApi<unknown>(scoped(GATES, connection)), 'gates'),


  assertions: async (): Promise<AssertionVocabulary> =>
    parsed(VocabularySchema, await fetchApi<unknown>('/agents/engineering/assertions'), 'assertions'),
}

/** A step's card reference (`params.card`, `<card>@v<n>`), split; null for none. A step without one uses the role's card. */
export function parseCardRef(ref: unknown): { card: string; version: number } | null {
  const match = typeof ref === 'string' ? /^([a-z][a-z0-9-]{0,63})@v([1-9]\d{0,5})$/.exec(ref) : null
  return match === null ? null : { card: match[1] ?? '', version: Number(match[2]) }
}
