/**
 * @fileoverview What a node says beside its title (7.52.00 C2; docs/ux part 5 §5.3), from its definition and what the
 * canvas knows: an agent's role and chips (its model's short name, its skill version or pin, its share), a gate's
 * packs, rounds and reviewers, a call's child flow and revision, a platform step's setting in words. Pure given `t`,
 * so the canvas, the drag preview and the inspector say the same thing.
 *
 * @module components/WorkflowEditor/nodes/nodeText
 */
import { parseCardRef } from '../../../api/flowSetupApi'
import { parseFlowRef } from '../../../api/workflowsApi'
import type { TFunction } from 'i18next'
import type { RegistryCard } from '../../../api/flowSetupApi'
import type { WorkflowNode } from '../../../api/workflowsApi'
import type { FlowName } from './nodeData'

type Params = Readonly<Record<string, unknown>>

/** A chip on a node (R15: descriptive, `badge-muted`; `info` only for "Update available"). */
export interface NodeChip { readonly text: string; readonly tone: 'muted' | 'info' }

/** Chips shown on a node at most; the rest fold into "+N". */
export const MAX_CHIPS = 3

const FAMILY = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i

/** A model id's short name ("Sonnet 5.5" for `global.anthropic.claude-sonnet-5-5`); the id's last part otherwise. */
export function modelShortName(id: string): string {
  const match = FAMILY.exec(id)
  if (match === null) return id.split(/[.:/]/).filter(Boolean).at(-1) ?? id
  const [, family = '', major = '', minor] = match
  const version = minor === undefined ? major : [major, minor].join('.')
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${version}`
}

/** An engineering role's name ("Commit reviewer"), its id when the catalogue has none. */
export const roleName = (t: TFunction<'agents'>, role: unknown): string =>
  (typeof role === 'string' && role !== '' ? t(`skills.role.${role}`, { defaultValue: role }) : t('canvas.kinds.agent'))

const text = (params: Params, key: string): string | undefined => {
  const value = params[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** The card a step runs: its `params.card` (a made card), else its role's own card (every role has one). */
export function cardIdOf(params: Params): string | undefined {
  return parseCardRef(params.card)?.card ?? text(params, 'role')
}

/** The model a step runs: its own override, else its card's (none known: undefined). */
export const stepModel = (params: Params, card: RegistryCard | undefined): string | undefined =>
  text(params, 'model') ?? (card === undefined || card.model === '' ? undefined : card.model)

/** The version chip: a pin ("v3 pinned"), else the card's current version ("v4"), else nothing known. */
function versionChip(t: TFunction<'agents'>, params: Params, card: RegistryCard | undefined): NodeChip | undefined {
  const pinned = text(params, 'skill_version')
  if (pinned !== undefined && pinned !== 'latest') return { text: t('canvas.chips.pinned', { version: pinned }), tone: 'muted' }
  const version = card?.skill.version ?? card?.skill.template_version ?? null
  if (card?.skill.template_newer === true) return { text: t('canvas.chips.updateAvailable'), tone: 'info' }
  return version === null ? undefined : { text: `v${version}`, tone: 'muted' }
}

/** A share of each run's budget as a percent chip ("10 %"); none when the step takes no share of its own. */
export function shareChip(t: TFunction<'agents'>, params: Params): NodeChip | undefined {
  const share = params.budget_share
  return typeof share === 'number' && share > 0 ? { text: t('canvas.chips.share', { percent: Math.round(share * 100) }), tone: 'muted' } : undefined
}

const present = <V>(items: ReadonlyArray<V | undefined>): V[] => items.filter((item): item is V => item !== undefined)

/** An agent's chips while building or viewing: its model, its version (or "Update available"), its share. */
export function agentChips(t: TFunction<'agents'>, params: Params, card: RegistryCard | undefined): NodeChip[] {
  const model = stepModel(params, card)
  return present([model === undefined ? undefined : { text: modelShortName(model), tone: 'muted' }, versionChip(t, params, card),
    shareChip(t, params)])
}

/** An agent's second line: its role's name, and a made card's id ("Fixer · fixer-careful"). */
export function agentLine(t: TFunction<'agents'>, params: Params): string {
  const card = parseCardRef(params.card)
  const role = roleName(t, params.role)
  return card === null ? role : `${role} · ${card.card}`
}

/** A board's line: who claims its tasks, and who posts them ("Fixer, Commit reviewer · posted by Hunter"). */
export function teamLine(t: TFunction<'agents'>, params: Params): string {
  const names = (key: string) => {
    const roles: unknown = params[key]
    return Array.isArray(roles) ? roles.map((role: unknown) => roleName(t, role)) : []
  }
  return t('canvas.team.line', { claimers: names('claimers').join(', '), posters: names('posters').join(', ') })
}

/** A gate's packs in words: "Auto-detect", or the packs it names. */
export function gatePacksText(t: TFunction<'agents'>, params: Params): string {
  const packs = params.packs
  if (!Array.isArray(packs)) return t('canvas.gate.autoDetect')
  return packs.filter((pack): pack is string => typeof pack === 'string').join(', ')
}

/** A gate's second line: its packs, its rounds at most, its reviewers ("Python · ≤ 3 rounds · 3 reviewers"). */
export function gateLine(t: TFunction<'agents'>, params: Params): string {
  const rounds = typeof params.max_rounds === 'number' ? params.max_rounds : 3
  const reviewers = Array.isArray(params.reviewers) ? params.reviewers.length : 3
  return [gatePacksText(t, params), t('canvas.gate.rounds', { n: rounds }), t('canvas.gate.reviewers', { count: reviewers })].join(' · ')
}

/** A call's child flow and revision ("Issue triage · r2"), or what it lacks. */
export function callLine(t: TFunction<'agents'>, params: Params, flows: ReadonlyMap<string, FlowName>): string {
  const ref = parseFlowRef(params.flow)
  if (ref === null) return t('canvas.call.noFlow')
  const name = flows.get(ref.workflowId)?.name ?? ref.workflowId
  return t('canvas.call.line', { name, revision: ref.revision })
}

/** A platform step's setting in words ("By package · at most 50", "Reads the repository's memory · 10"). */
export function platformLine(t: TFunction<'agents'>, step: Pick<WorkflowNode, 'type' | 'data'>): string {
  const params = step.data.params ?? {}
  if (step.type === 'map') {
    const by = text(params, 'shard_by') ?? 'packages'
    const cap = typeof params.shard_cap === 'number' ? params.shard_cap : 200
    return t('canvas.platform.map', { by: t(`editor.engineering.shardByOptions.${by}`, { defaultValue: by }), n: cap })
  }
  if (step.type === 'memory') {
    const scope = text(params, 'scope') ?? 'repo'
    const whose = t(`editor.engineering.scopeOptions.${scope}`, { defaultValue: scope })
    return params.mode === 'write' ? t('canvas.platform.memoryWrite', { whose })
      : t('canvas.platform.memoryRead', { whose, n: typeof params.limit === 'number' ? params.limit : 10 })
  }
  return t('canvas.platform.reduce')
}

/** A trigger's or an end's second line: Start's PR state, an end's outcome, a stop at PR's state. */
export function terminalLine(t: TFunction<'agents'>, step: Pick<WorkflowNode, 'type' | 'data'>, pr: string): string {
  if (step.type === 'start') return t('canvas.trigger.line')
  if (step.type === 'stop_at_pr') return t(pr === 'draft' ? 'canvas.end.prDraft' : 'canvas.end.prReady')
  return t('canvas.end.completed')
}

/** The flow's pull-request state, from Start's settings (`params.pr`: ready, unless it says draft). */
export function flowPrState(nodes: readonly Pick<WorkflowNode, 'type' | 'data'>[]): string {
  const start = nodes.find((node) => node.type === 'start')
  return start?.data.params?.pr === 'draft' ? 'draft' : 'ready'
}

/** At most {@link MAX_CHIPS} chips, and how many more there are. */
export function foldChips(chips: readonly NodeChip[]): { shown: NodeChip[]; more: number } {
  return { shown: chips.slice(0, MAX_CHIPS), more: Math.max(0, chips.length - MAX_CHIPS) }
}
