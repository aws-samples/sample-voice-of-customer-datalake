/**
 * @fileoverview The Agent node (and the Team, a board): a rounded card, 220 × 88, with a round `aim` avatar holding
 * the role's glyph (who acts: a model, owner decision N-D1), the title, the role's name (and a made card's id), and
 * its chips: the model's short name (the card's when the step sets none), the version or its pin, the share; "Update
 * available" when the template is newer. In a run the chips are what ran: the model, the skill's label, the cost and
 * how many agents. A team shows its claimers as overlapping avatars instead of the role line. An agents workflow's
 * step is the same card with its type's icon and its role's name.
 *
 * @module components/WorkflowEditor/nodes/AgentNode
 */
import { useTranslation } from 'react-i18next'
import { NodeChips, NodeFrame, NodeIssue, NodeLines, NodeTile } from './NodeParts'
import { isQuiet, useStateWords } from './nodeState'
import { roleGlyphName } from './nodeGlyphs'
import { GlyphIcon } from './GlyphIcon'
import { agentChips, agentLine, cardIdOf, modelShortName, teamLine } from './nodeText'
import { useFlowLookups } from './nodeData'
import type { TFunction } from 'i18next'
import type { NodeProps } from '@xyflow/react'
import type { StepState } from '../runState'
import type { StepFlowNode, StepNodeData } from './nodeData'
import type { NodeChip } from './nodeText'

/** The claimers of a team as overlapping 20 px avatars (each ringed in the card's colour). */
function ClaimerAvatars({ claimers }: Readonly<{ claimers: readonly unknown[] }>) {
  return (
    <span className="mt-1 flex -space-x-1.5" aria-hidden="true">
      {claimers.slice(0, 5).map((role) => (
        <span key={String(role)} className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-aim-subtle text-aim ring-2 ring-card">
          <GlyphIcon name={roleGlyphName(role)} size={11} />
        </span>
      ))}
    </span>
  )
}

/** What ran on a step, as chips: its model, its skill's label, what it cost, and "2 agents" when several did. */
function ranChips(t: TFunction<'agents'>, ran: NonNullable<StepState['ran']>): NodeChip[] {
  const chips: NodeChip[] = []
  if (ran.model !== undefined) chips.push({ text: modelShortName(ran.model), tone: 'muted' })
  if (ran.skill !== undefined) chips.push({ text: ran.skill, tone: 'muted' })
  if (ran.costUsd !== undefined) chips.push({ text: t('canvas.chips.cost', { amount: ran.costUsd.toFixed(2) }), tone: 'muted' })
  if (ran.agents > 1) chips.push({ text: t('canvas.chips.agents', { count: ran.agents }), tone: 'muted' })
  return chips
}

/** The second line: a team's claimers and posters, an engineering agent's role (and card), a step's role or type. */
function lineOf(t: TFunction<'agents'>, data: StepNodeData): string {
  const { step } = data
  const params = step.data.params ?? {}
  if (data.kind === 'team') return teamLine(t, params)
  if (step.type === 'agent') return agentLine(t, params)
  return step.data.role === undefined ? t(`nodeTypes.${step.type}.label`) : t(`roles.${step.data.role}`)
}

export function AgentNode({ id, data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation('agents')
  const { cards } = useFlowLookups()
  const { step, kind, run } = data
  const params = step.data.params ?? {}
  const cardId = cardIdOf(params)
  const card = cardId === undefined ? undefined : cards.get(cardId)
  const planned = step.type === 'agent' ? agentChips(t, params, card) : []
  const chips = run?.ran === undefined ? planned : ranChips(t, run.ran)
  const team = kind === 'team'
  const line = lineOf(t, data)
  const state = useStateWords(data)
  return (
    <NodeFrame id={id} data={data} selected={selected} shape="voc-node-agent"
      description={[t(`canvas.kinds.${kind}`), line, ...chips.map((chip) => chip.text), state].filter((part) => part !== '').join(', ')}>
      <span className="flex items-start gap-2 px-3 py-2">
        <NodeTile step={step} kind={kind} round />
        <span className="min-w-0 flex-1">
          <NodeLines title={step.data.title} line={team ? undefined : line} quiet={isQuiet(data)} />
          {team && <ClaimerAvatars claimers={Array.isArray(params.claimers) ? params.claimers : []} />}
          <NodeChips chips={chips} />
          <NodeIssue issues={data.issues} />
        </span>
      </span>
    </NodeFrame>
  )
}
