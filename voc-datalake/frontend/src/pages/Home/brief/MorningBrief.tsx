/**
 * @fileoverview The brief's body on Home: metric tiles, the cards, "Things to do".
 * Cards the reader dismissed stay hidden for the day; the others are marked `seen`
 * once they are on screen. An act button opens the assistant prefilled (never sent)
 * and marks the card `acted`. While Home shows live agent-decision cards, the
 * brief's own "agent runs waiting" row is left out of "Things to do" (no duplicate).
 * @module pages/Home/brief/MorningBrief
 */
import { useEffect } from 'react'
import { openAssistant } from '../../../assistant/store/openAssistant'
import MetricTiles from './MetricTiles'
import { BriefCardList, ThingsToDo } from './BriefSections'
import { isTodo, unseenIds, visibleCards } from './briefCards'
import type { BriefCard } from '../../../api/briefingApi'
import type { BriefResult } from './useBrief'

function useMarkSeen({ brief, setCardStates }: BriefResult): void {
  const unseen = brief.status === 'ready' ? unseenIds(brief.cards, brief.card_state) : []
  const unseenKey = unseen.join(',')
  useEffect(() => {
    if (unseenKey !== '') setCardStates(Object.fromEntries(unseenKey.split(',').map((id) => [id, 'seen'])))
  }, [unseenKey, setCardStates])
}

/** The brief's "Things to do" row the live agent-decision cards replace. */
const AGENT_RUNS_TODO = 'todo_agent_runs'

export default function MorningBrief({ result, liveAgentDecisions = false }: Readonly<{
  result: BriefResult
  /** Live agent-decision cards are on screen (AgentDecisionCards). */
  liveAgentDecisions?: boolean
}>) {
  useMarkSeen(result)
  const { brief, setCardStates } = result
  const shown = visibleCards(brief.cards, brief.card_state)
  const act = (card: BriefCard, prompt: string) => {
    openAssistant({ prompt, context: { feedbackIds: card.feedback_ids } })
    setCardStates({ [card.id]: 'acted' })
  }
  const dismiss = (card: BriefCard) => { setCardStates({ [card.id]: 'dismissed' }) }
  return (
    <>
      <MetricTiles />
      <BriefCardList cards={shown.filter((card) => !isTodo(card))} onAct={act} onDismiss={dismiss} />
      <ThingsToDo cards={shown.filter((card) => isTodo(card) && !(liveAgentDecisions && card.kind === AGENT_RUNS_TODO))}
        onDismiss={dismiss} />
    </>
  )
}
