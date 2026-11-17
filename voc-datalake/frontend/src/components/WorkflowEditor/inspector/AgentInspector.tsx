/**
 * @fileoverview The Agent inspector (and the Team's, a board) (7.52.00 C2; docs/ux part 5 §5.4): Setup, Assertions and
 * Arrows; in a run Agents, Setup and Assertions.
 * - **In this flow:** the step's own fields (its role, skill version or pin, model override, share of each run's
 *   budget, instructions; a team's posters and claimers), with the agents' shares in all ("85 of 100 %") and a model
 *   that overrides the card's said so. Edited while building, text otherwise.
 * - **From the card:** the card behind it (its made card, else its role's), always read only (FromCard.tsx); in a run,
 *   at the card and version that ran (the overview's `card`, `card_version`).
 *
 * @module components/WorkflowEditor/inspector/AgentInspector
 */
import { useTranslation } from 'react-i18next'
import { parseCardRef } from '../../../api/flowSetupApi'
import { cardIdOf, modelShortName, roleName, stepModel } from '../nodes/nodeText'
import { useFlowLookups } from '../nodes/nodeData'
import { FromCard } from './FromCard'
import { Arrows, InThisFlow, RunSlot, StepAssertions } from './inspectorParts'
import { setParams } from './stepEdits'
import { agentTabs } from './inspectorTabs'
import type { AgentTab } from './inspectorTabs'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { WorkflowDefinition } from '../../../api/workflowsApi'
import type { KindViewProps } from './inspectorParts'

/** Every agent's and call's share of each run's budget, in percent (what is left is the run's own). */
function sharesInAll(definition: WorkflowDefinition): number {
  const shares = definition.nodes.filter((node) => node.type === 'agent' || node.type === 'call_flow')
    .map((node) => node.data.params?.budget_share)
  return Math.round(shares.reduce((sum: number, share) => sum + (typeof share === 'number' ? share : 0), 0) * 100)
}

function agentRows(t: TFunction<'agents'>, params: Readonly<Record<string, unknown>>): ReadonlyArray<readonly [string, ReactNode] | null> {
  const card = parseCardRef(params.card)
  const version = typeof params.skill_version === 'string' ? params.skill_version : 'latest'
  const model = typeof params.model === 'string' ? params.model : null
  const share = typeof params.budget_share === 'number' ? params.budget_share : null
  return [
    [t('editor.engineering.role'), roleName(t, params.role)],
    card === null ? null : [t('inspector.agent.card'), `${card.card} v${card.version}`],
    [t('editor.engineering.skillVersion'), version === 'latest' ? t('inspector.agent.latest') : t('canvas.chips.pinned', { version })],
    [t('editor.engineering.model'), model === null ? t('inspector.agent.cardModel') : modelShortName(model)],
    share === null ? null : [t('inspector.agent.share'), t('canvas.chips.share', { percent: Math.round(share * 100) })],
  ]
}

function teamRows(t: TFunction<'agents'>, params: Readonly<Record<string, unknown>>): ReadonlyArray<readonly [string, ReactNode] | null> {
  const names = (key: string) => {
    const roles: unknown = params[key]
    return Array.isArray(roles) ? roles.map((role: unknown) => roleName(t, role)).join(', ') : ''
  }
  return [[t('editor.engineering.posters'), names('posters')], [t('editor.engineering.claimers'), names('claimers')]]
}

/** Building: the agents' shares in all, and a model that overrides the card's (with the way back to it). */
function AgentExtras({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const { cards } = useFlowLookups()
  const { node, definition, onChange } = props
  const params = node.data.params ?? {}
  const cardId = cardIdOf(params)
  const card = cardId === undefined ? undefined : cards.get(cardId)
  const own = typeof params.model === 'string' && params.model !== ''
  const cardModel = card === undefined || card.model === '' ? undefined : card.model
  return (
    <div className="space-y-1 text-[12px] text-muted">
      <p>{t('inspector.agent.sharesInAll', { used: sharesInAll(definition) })}</p>
      {own && cardModel !== undefined && (
        <p className="flex flex-wrap items-center gap-2">
          {t('inspector.agent.overrides', { model: modelShortName(cardModel) })}
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => onChange(setParams(definition, node.id, (current) => ({ ...current, model: undefined })))}>
            {t('inspector.agent.useCards')}
          </button>
        </p>
      )}
      {!own && cardModel !== undefined && <p>{t('inspector.agent.cardsModel', { model: modelShortName(stepModel(params, card) ?? cardModel) })}</p>}
    </div>
  )
}

/** The card behind the step: in a run, the one that ran; else its made card at its version, or its role's. */
function StepCard({ props }: Readonly<{ props: KindViewProps }>) {
  const { node, run, connection } = props
  const params = node.data.params ?? {}
  const ran = run?.cardOf?.(node.id) ?? null
  if (ran !== null) return <FromCard cardId={ran.card} version={ran.version} connection={connection} />
  const card = parseCardRef(params.card)
  return <FromCard cardId={card?.card ?? cardIdOf(params)} version={card?.version ?? null} connection={connection} />
}

/** Setup: "In this flow" (a team's posters and claimers; an agent's own fields and extras), then the card. */
function AgentSetup({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const params = props.node.data.params ?? {}
  if (props.node.type === 'board') return <InThisFlow props={props} rows={teamRows(t, params)} />
  return (
    <>
      <InThisFlow props={props} rows={agentRows(t, params)} extras={<AgentExtras props={props} />} />
      <StepCard props={props} />
    </>
  )
}

export function AgentInspector({ props, tab: asked }: Readonly<{ props: KindViewProps; tab: string }>) {
  const { t } = useTranslation('agents')
  const tab: AgentTab = agentTabs(props.mode).find((id) => id === asked) ?? 'setup'
  switch (tab) {
    case 'agents':
      return <RunSlot content={props.run?.agentsOf?.(props.node.id)} empty={t('inspector.empty.notRun')} />
    case 'assertions':
      return <StepAssertions props={props} place={props.node.type} />
    case 'arrows':
      return <Arrows props={props} />
    case 'setup':
      return <AgentSetup props={props} />
  }
}
