/**
 * @fileoverview The Registry, the quality gates and the templates' source text (7.52.00, administrators only, while the
 * engineering agents are on; `lambda/shared/agents_engineering_registry_routes.py`):
 * - `GET /agents/engineering/registry?connection=` → `{month, connection, cards}`: every role's card (`kind: 'role'`,
 *   composed on the server for the scope's skill head: its template, skill, model, tools, gates, inputs and outputs,
 *   caps, scorecard on a connection, the month's spend), then the cards made from a skill (`kind: 'card'`);
 * - `GET …/registry/<card>?connection=` → `{card, versions, events}`, read as its card and versions (a role's card has
 *   neither);
 * - `POST …/registry/cards` `{from_skill: {role, connection?, version}, slug, purpose, title?, model?, caps?,
 *   expected_version?}` → 201 `{card}`; 400 a bad body, 404 no such skill version, 409 a proposal, a bad model or tool,
 *   a slug taken or a stale `expected_version`, each in the server's words;
 * - `GET …/gates?connection=` → the gate packs (steps with their messages and their vacuous-pass rule, tools, image
 *   pins, network, briefs) with, for a connection, each pack's tools' versions as its newest gate record holds them;
 *   the owner's briefs WITHOUT their text (gap N), the gate's stop reasons, who runs a gate that names nobody;
 * - `GET …/gates/briefs/<id>` → one brief with its text (45-156 KB; 404 for none);
 * - `GET …/templates/<kind>/<id>/source` → a template's source text as the repository holds it (gap S: a role's
 *   SKILL.md with its front-matter, its agent.yaml, a flow's YAML, a brief), read only.
 *
 * Every text is the server's as data: the screens show it through the document component (safe Markdown, or the code
 * view), never as HTML.
 *
 * @module api/engineeringRegistryApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { eachOf, parseEach } from './lenientFields'
import { post } from './requestKit'
import { isRecord } from '../lib/typeGuards'

const text = z.string().catch('')
const maybeText = z.string().nullable().catch(null)
const count = z.number().int().nonnegative().catch(0)
const rate = z.number().min(0).max(1).nullable().catch(null)
const names = z.array(z.string()).catch([])

/** The skill a card runs: the store's version the scope resolves to, or the role's bundled template. */
const SkillSchema = z.object({
  source: z.enum(['store', 'template']).catch('store'),
  label: text,
  /** '' for the shared skills (a made card's), a connection's id, or null (the template). */
  connection: maybeText,
  version: z.number().int().positive().nullable().catch(null),
  status: maybeText,
  /** Who wrote the version: `template`, `person`, `agent` (the coach). */
  provenance: maybeText,
  template_version: z.number().int().nullable().catch(null),
  /** Skills' "Template updated": the role's template is newer than every version of the scope seeded from one. */
  template_newer: z.boolean().catch(false),
})

const IoSchema = z.object({
  name: z.string(), from: text, required: z.boolean().catch(false), schema: text, kind: text, recorded_on: text, trust: text,
})
export type CardIo = z.output<typeof IoSchema>

const ScorecardSchema = z.object({
  label: text, runs: count, pass_rate: rate, tasks_done: count, tasks_failed: count, needs_human: count,
  cost_usd: z.number().nonnegative().catch(0), since: text, until: text,
})
const SpendSchema = z.object({
  month: text, usd: z.number().nonnegative().catch(0), tokens_in: count, tokens_out: count,
  microvm_seconds: z.number().nonnegative().catch(0),
})
const HeadSchema = z.object({ source: text, own: z.boolean().catch(false), label: text, connection: maybeText,
  version: z.number().int().positive().nullable().catch(null) })

const CardSchema = z.object({
  kind: z.enum(['role', 'card']),
  id: z.string().min(1),
  /** A made card's version (a role's card has none). */
  version: z.number().int().positive().nullable().catch(null),
  base_role: text,
  title: text,
  purpose: text,
  launchable: z.boolean().catch(true),
  template: z.object({ version: count, label: text, digest: text }).nullable().catch(null),
  skill: SkillSchema,
  model: text,
  tools: names,
  harness: text,
  caps: z.record(z.string(), z.number()).catch({}),
  inputs: eachOf(IoSchema),
  outputs: eachOf(IoSchema),
  gates: z.object({ packs: names }).nullable().catch(null),
  scorecard: ScorecardSchema.nullable().catch(null),
  spend: SpendSchema.nullable().catch(null),
  heads_by_connection: z.record(z.string(), HeadSchema).catch({}),
  created_by: text,
  created_at: text,
})
export type RegistryCard = z.output<typeof CardSchema>

export interface RegistryCardDetail {
  card: RegistryCard
  /** A made card's versions, newest first (none for a role's card). */
  versions: RegistryCard[]
}

const StepSchema = z.object({
  id: z.string(),
  language: text,
  name: text,
  /** `setup`, `lint`, `types`, `test` … */
  kind: text,
  argv: names,
  timeout_s: count,
  /** When the step applies: any of these markers in the repository (`{file}`, `{dir}`, `{glob}` …). */
  when_any: z.array(z.record(z.string(), z.unknown())).catch([]),
  empty_exit_codes: z.array(z.number()).catch([]),
  expect_output: text,
  messages: z.array(z.object({ status: text, reason: text, of: text })).catch([]),
  /** The vacuous-pass rule in words (how it fails when it checked nothing), or null. */
  looked_at_nothing: maybeText,
})
export type GateStep = z.output<typeof StepSchema>

const PackSchema = z.object({
  id: z.string(),
  name: text,
  languages: names,
  image: z.record(z.string(), z.string()).catch({}),
  network: names,
  tools: z.array(z.object({ name: z.string(), version_argv: names })).catch([]),
  steps: eachOf(StepSchema),
  briefs: names,
  /** The tools' versions a connection's newest gate record holds (with `?connection=`), else null. */
  recorded: z.object({ tool_versions: z.record(z.string(), z.string()).catch({}), run_id: maybeText, at: maybeText })
    .nullable().catch(null),
})
export type GatePack = z.output<typeof PackSchema>

const BriefSchema = z.object({ id: z.string().min(1), path: text, packs: names, digest: text, bytes: count })
export type GateBrief = z.output<typeof BriefSchema>
const BriefTextSchema = BriefSchema.extend({ text: z.string() })
export type GateBriefText = z.output<typeof BriefTextSchema>

const StopSchema = z.object({ code: z.string(), decision: text, actions: names, text_key: text, text })
export type GateStop = z.output<typeof StopSchema>

export interface QualityGates {
  packs: GatePack[]
  briefs: GateBrief[]
  ownGate: { file: string; argv: string[]; timeout_s: number } | null
  defaults: Record<string, string>
  stops: GateStop[]
}

const OwnGateSchema = z.object({ file: text, argv: names, timeout_s: count }).nullable().catch(null)

/** The kinds of template whose source text the server reads from the bundle. */
const SOURCE_KINDS = ['skill', 'card', 'flow', 'brief'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]
const SourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS), id: z.string(), path: text, text: z.string(), digest: text,
  template_version: z.number().int().nullable().catch(null),
})
export type TemplateSource = z.output<typeof SourceSchema>

/** What making a card from a skill sends. */
export interface CreateCardBody {
  from_skill: { role: string; connection?: string; version: number }
  slug: string
  purpose: string
  title?: string
  caps?: Record<string, number>
  /** 0 or left out: a new card; else the version of the card the screen read (its next version). */
  expected_version?: number
}

/** An answer with no list where the list should be is an error, never "no cards" (a false statement). */
function answerList(raw: unknown, name: string, what: string): unknown[] {
  if (!isRecord(raw) || !Array.isArray(raw[name])) throw new Error(`The ${what} answer was unreadable`)
  return raw[name]
}

export function parseRegistry(raw: unknown): RegistryCard[] {
  return parseEach(CardSchema, answerList(raw, 'cards', 'Registry'))
}

export function parseCardDetail(raw: unknown): RegistryCardDetail {
  const card = CardSchema.safeParse(isRecord(raw) ? raw.card : undefined)
  if (!card.success) throw new Error('The Registry card answer was unreadable')
  const record = isRecord(raw) ? raw : {}
  return { card: card.data, versions: parseEach(CardSchema, record.versions) }
}

export function parseGates(raw: unknown): QualityGates {
  const packs = parseEach(PackSchema, answerList(raw, 'packs', 'quality gates'))
  const record = isRecord(raw) ? raw : {}
  const defaults = z.record(z.string(), z.string()).catch({}).parse(record.defaults)
  return {
    packs, briefs: parseEach(BriefSchema, record.briefs), ownGate: OwnGateSchema.parse(record.own_gate),
    defaults, stops: parseEach(StopSchema, record.stops),
  }
}

/** A brief read strictly: one without its text is an error, never an empty brief. */
export function parseBriefText(raw: unknown): GateBriefText {
  const parsed = BriefTextSchema.safeParse(raw)
  if (!parsed.success) throw new Error('The gate brief answer was unreadable')
  return parsed.data
}

export function parseTemplateSource(raw: unknown): TemplateSource {
  const parsed = SourceSchema.safeParse(raw)
  if (!parsed.success) throw new Error('The template source answer was unreadable')
  return parsed.data
}

function parseCreatedCard(raw: unknown): RegistryCard {
  const parsed = CardSchema.safeParse(isRecord(raw) ? raw.card : undefined)
  if (!parsed.success) throw new Error('The answer to making the card was unreadable')
  return parsed.data
}

/** `?connection=` ('' is the shared skills: no query). */
const scoped = (connection: string) => (connection === '' ? '' : `?${new URLSearchParams({ connection }).toString()}`)

const cardsListPath = (connection: string) => `/agents/engineering/registry${scoped(connection)}`
const cardPath = (card: string, connection: string) =>
  `/agents/engineering/registry/${encodeURIComponent(card)}${scoped(connection)}`
const gatesPath = (connection: string) => `/agents/engineering/gates${scoped(connection)}`
const briefPath = (brief: string) => `/agents/engineering/gates/briefs/${encodeURIComponent(brief)}`
const sourcePath = (kind: SourceKind, id: string) =>
  `/agents/engineering/templates/${kind}/${encodeURIComponent(id)}/source`

export const engineeringRegistryKeys = {
  /** Every Registry read (what making a card makes stale). */
  all: () => ['engineering-registry'] as const,
  list: (connection: string) => ['engineering-registry', 'list', connection] as const,
  card: (card: string, connection: string) => ['engineering-registry', 'card', card, connection] as const,
  gates: (connection: string) => ['engineering-gates', connection] as const,
  brief: (brief: string) => ['engineering-gates', 'brief', brief] as const,
  source: (kind: SourceKind, id: string) => ['engineering-templates', kind, id] as const,
}

export const engineeringRegistryApi = {
  list: async (connection: string): Promise<RegistryCard[]> =>
    parseRegistry(await fetchApi<unknown>(cardsListPath(connection))),
  card: async (card: string, connection: string): Promise<RegistryCardDetail> =>
    parseCardDetail(await fetchApi<unknown>(cardPath(card, connection))),
  create: async (body: CreateCardBody): Promise<RegistryCard> =>
    parseCreatedCard(await fetchApi<unknown>('/agents/engineering/registry/cards', post(body))),
  gates: async (connection: string): Promise<QualityGates> =>
    parseGates(await fetchApi<unknown>(gatesPath(connection))),
  brief: async (brief: string): Promise<GateBriefText> =>
    parseBriefText(await fetchApi<unknown>(briefPath(brief))),
  source: async (kind: SourceKind, id: string): Promise<TemplateSource> =>
    parseTemplateSource(await fetchApi<unknown>(sourcePath(kind, id))),
}
