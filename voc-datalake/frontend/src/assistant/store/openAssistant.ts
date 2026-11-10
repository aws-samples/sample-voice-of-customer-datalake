/**
 * Open the assistant on a NEW conversation with a prompt prefilled (a brief card's act
 * button). Nothing is sent: the user reads the prompt and presses send, because a card
 * can lead to a write (plan mode). The card's evidence travels inside the prompt, so the
 * assistant can look the reviews up with its read tools.
 */
import { isChatRoute } from '../page/chatRoute'
import { newThread } from '../runtime/runtime'
import { useAssistantUiStore } from './assistantStore'

interface AssistantDraftContext {
  /** Reviews the card is based on (at most the first 10 are named). */
  feedbackIds?: readonly string[]
}

export interface OpenAssistantRequest {
  prompt: string
  context?: AssistantDraftContext
}

const MAX_EVIDENCE_IDS = 10

/** The composer text: the prompt, then the card's evidence ids on their own line. */
export function composeDraft({ prompt, context }: OpenAssistantRequest): string {
  const ids = (context?.feedbackIds ?? []).slice(0, MAX_EVIDENCE_IDS)
  return ids.length === 0 ? prompt : `${prompt}\n\n[feedback: ${ids.join(', ')}]`
}

export function openAssistant(request: OpenAssistantRequest, pathname: string = window.location.pathname): void {
  newThread()
  const ui = useAssistantUiStore.getState()
  // Strictly increasing, so two identical prompts in a row are still both adopted.
  const id = Math.max(Date.now(), (ui.pendingDraft?.id ?? 0) + 1)
  ui.setPendingDraft({ id, text: composeDraft(request) })
  // On /chat the page itself is the assistant; elsewhere the floating panel opens.
  if (!isChatRoute(pathname)) ui.setOpen(true)
}
