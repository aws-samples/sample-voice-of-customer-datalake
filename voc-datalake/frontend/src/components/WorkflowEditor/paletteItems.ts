/**
 * @fileoverview The palette's items (7.52.00 C2; docs/ux part 5 §5.5): in an engineering flow the palette is the
 * Registry inside the editor, grouped by kind: Start and end (with the decision preset, an `end` that needs a
 * person), Agents (the Registry's cards: each role's, then the ones made from a skill), Quality gates (Auto-detect,
 * then each pack), Flows (the library's other engineering flows, each a call at its current revision; one that calls
 * this flow is offered off, saying why: calling it would make a cycle) and Platform steps. Where the Registry or the
 * gates cannot be read (a viewer, the module off) each group offers its plain step. An agents workflow keeps its
 * groups of step types.
 *
 * Each item is a block, `{type, params, title}`, which is what a drag carries (`BLOCK_MIME`) and what a click or
 * Enter adds: a dropped item is the step it names.
 *
 * @module components/WorkflowEditor/paletteItems
 */
import { WORKFLOW_ALL_NODE_TYPES, WORKFLOW_SCHEMA_V2 } from '@stream/assistant/tools/agent-limits'
import { NODE_CATALOGUE, paletteGroupsFor } from './model'
import { modelShortName, roleName } from './nodes/nodeText'
import type { TFunction } from 'i18next'
import type { GatesView, RegistryCard } from '../../api/flowSetupApi'
import type { WorkflowNodeType, WorkflowSchema, WorkflowSummary, WorkflowUsedBy } from '../../api/workflowsApi'
import type { PaletteBlock } from './model'


/** An engineering flow's palette sections, by kind. */
export const ENGINEERING_SECTIONS = ['startEnd', 'agents', 'gates', 'flows', 'platform'] as const
type EngineeringSection = (typeof ENGINEERING_SECTIONS)[number]

export interface PaletteItem {
  /** Unique in the palette. */
  readonly key: string
  readonly block: PaletteBlock
  /** Its name (the button's accessible name). */
  readonly label: string
  /** A short line beside it ("v4 · Sonnet 5.5", "r2"). */
  readonly meta: string
  /** Why it cannot be added here (shown as visible text); null: it can. */
  readonly disabledReason: string | null
}

export interface PaletteSection {
  readonly id: string
  /** Its heading (`palette.groups.<id>`, an agents workflow's `paletteGroups.<id>`). */
  readonly heading: string
  /** Its visible one-line hint (never a native title). */
  readonly hint: string
  readonly items: readonly PaletteItem[]
}

/** What the engineering palette is built from (each part absent where it was not read). */
export interface PaletteSources {
  readonly cards: readonly RegistryCard[] | undefined
  readonly gates: GatesView | undefined
  readonly flows: readonly WorkflowSummary[] | undefined
  /** This flow's id ('' for an unsaved one) and who calls it (a flow that does cannot be called from here). */
  readonly workflowId: string
  readonly usedBy: WorkflowUsedBy
}

const plain = (t: TFunction<'agents'>, type: WorkflowNodeType, params?: Readonly<Record<string, unknown>>): PaletteItem => ({
  key: `type:${type}`,
  block: { type, title: t(`nodeTypes.${type}.label`), ...(params === undefined ? {} : { params }) },
  label: t(`nodeTypes.${type}.label`),
  meta: '',
  disabledReason: null,
})

function startEndItems(t: TFunction<'agents'>): PaletteItem[] {
  const decision: PaletteItem = {
    key: 'decision',
    block: { type: 'end', title: t('canvas.decision.title'), params: { status: 'needs_human' } },
    label: t('canvas.decision.title'),
    meta: '',
    disabledReason: null,
  }
  return [plain(t, 'start'), plain(t, 'end'), plain(t, 'stop_at_pr'), decision]
}

/** A card's version line: a made card's version, else the skill the shared scope runs; and its model. */
function cardMeta(card: RegistryCard): string {
  const version = card.kind === 'card' ? card.version : card.skill.version ?? card.skill.template_version
  return [version === null ? '' : `v${version}`, card.model === '' ? '' : modelShortName(card.model)].filter(Boolean).join(' · ')
}

function agentItems(t: TFunction<'agents'>, cards: readonly RegistryCard[] | undefined): PaletteItem[] {
  const launchable = (cards ?? []).filter((card) => card.node !== null)
  if (launchable.length === 0) return [plain(t, 'agent')]
  return launchable.map((card) => {
    const title = card.kind === 'card' ? card.title || card.id : roleName(t, card.id)
    return {
      key: `card:${card.id}`,
      block: { type: 'agent', title, params: card.node?.data.params ?? { role: card.base_role, skill_version: 'latest' } },
      label: title,
      meta: card.kind === 'card' ? `${cardMeta(card)} · ${t('palette.madeFromSkill')}` : cardMeta(card),
      disabledReason: null,
    }
  })
}

/** A quality gate's packs when it detects them in the repository (the server's `packs: 'auto'`). */
const AUTO_PACKS = 'auto'

function gateItems(t: TFunction<'agents'>, gates: GatesView | undefined): PaletteItem[] {
  const auto = plain(t, 'quality_gate', { max_rounds: 3, packs: AUTO_PACKS })
  if (gates === undefined) return [auto]
  const detect: PaletteItem = { ...auto, key: `gate:${AUTO_PACKS}`, label: t('canvas.gate.autoDetect') }
  return [detect, ...gates.packs.map((pack) => ({
    key: `gate:${pack.id}`,
    block: { type: 'quality_gate' as const, title: t('palette.gateOf', { pack: pack.name || pack.id }), params: { max_rounds: 3, packs: [pack.id] } },
    label: pack.name || pack.id,
    meta: '',
    disabledReason: null,
  }))]
}

function flowItems(t: TFunction<'agents'>, sources: PaletteSources): PaletteItem[] {
  const callers = new Set(sources.usedBy.flows.map((flow) => flow.workflow_id))
  return (sources.flows ?? [])
    .filter((flow) => flow.kind === 'engineering' && flow.status === 'active' && flow.workflow_id !== sources.workflowId)
    .map((flow) => ({
      key: `flow:${flow.workflow_id}`,
      block: { type: 'call_flow' as const, title: flow.name, params: { flow: `${flow.workflow_id}@${flow.revision}` } },
      label: flow.name,
      meta: t('palette.revision', { n: flow.revision }),
      disabledReason: callers.has(flow.workflow_id) ? t('palette.cycle') : null,
    }))
}

const PLATFORM_TYPES: readonly WorkflowNodeType[] = ['map', 'reduce', 'board', 'memory', 'learning_loop', 'self_improvement']

function engineeringItems(t: TFunction<'agents'>, section: EngineeringSection, sources: PaletteSources): PaletteItem[] {
  switch (section) {
    case 'startEnd': return startEndItems(t)
    case 'agents': return agentItems(t, sources.cards)
    case 'gates': return gateItems(t, sources.gates)
    case 'flows': return flowItems(t, sources)
    case 'platform': return PLATFORM_TYPES.map((type) => plain(t, type, NODE_CATALOGUE[type].params))
  }
}

/** The palette's sections for a workflow of `schema` (an empty one is left out). */
export function paletteSections(t: TFunction<'agents'>, schema: WorkflowSchema, sources: PaletteSources): PaletteSection[] {
  if (schema !== WORKFLOW_SCHEMA_V2) {
    return paletteGroupsFor(schema).map((group) => ({
      id: group,
      heading: t(`paletteGroups.${group}`),
      hint: '',
      items: WORKFLOW_ALL_NODE_TYPES.filter((type) => NODE_CATALOGUE[type].group === group).map((type) => plain(t, type)),
    }))
  }
  return ENGINEERING_SECTIONS.map((section) => ({
    id: section,
    heading: t(`palette.groups.${section}`),
    hint: t(`palette.hints.${section}`),
    items: engineeringItems(t, section, sources),
  })).filter((section) => section.items.length > 0)
}

/** The sections with only the items whose name (or line) holds `query` (case and accents ignored). */
export function filterSections(sections: readonly PaletteSection[], query: string): PaletteSection[] {
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const wanted = fold(query.trim())
  if (wanted === '') return [...sections]
  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => fold(`${item.label} ${item.meta}`).includes(wanted)) }))
    .filter((section) => section.items.length > 0)
}

/** What is being dragged from the palette (its name, for the canvas's "Drop to add …" line): this window's only. */
const drag = { title: '' }
export const setDragTitle = (title: string): void => { drag.title = title }
export const dragTitle = (): string => drag.title
