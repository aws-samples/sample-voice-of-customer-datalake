/**
 * Pure helpers for turning a finished chat stream into committed ChatMessages.
 * Extracted from chatTabHooks.ts to keep that file under the max-lines limit.
 */
import type {
  ChatMessage, DocumentChangeInfo, ActivePersonaInfo,
} from './ChatBubbles'
import type { ToolStep } from '../../hooks/useStreamChat'

export interface CompletedTurn {
  persona: {
    persona_id: string;
    name: string;
    avatar_url?: string
  }
  content: string
  thinking?: string
}

export interface StreamSnapshot {
  text: string
  thinking: string
  error: string | null
  changes: DocumentChangeInfo[]
  toolSteps: ToolStep[]
  persona: ActivePersonaInfo | undefined
  turns: CompletedTurn[]
  curPersona: {
    persona_id: string;
    name: string;
    avatar_url?: string
  } | null
}

function buildRoundtableMessages(snapshot: StreamSnapshot): ChatMessage[] {
  const {
    text, turns, curPersona,
  } = snapshot
  const newMessages: ChatMessage[] = turns.map((turn) => ({
    role: 'assistant' as const,
    content: turn.content,
    activePersona: {
      name: turn.persona.name,
      avatar_url: turn.persona.avatar_url,
    },
  }))
  if (text !== '' && curPersona) {
    newMessages.push({
      role: 'assistant',
      content: text,
      activePersona: {
        name: curPersona.name,
        avatar_url: curPersona.avatar_url,
      },
    })
  }
  return newMessages
}

export function buildFinalizedMessages(snapshot: StreamSnapshot): ChatMessage[] {
  const {
    text, error, changes, toolSteps, persona, turns, curPersona,
  } = snapshot
  const isRoundtable = turns.length > 0 || curPersona !== null

  if (isRoundtable) return buildRoundtableMessages(snapshot)
  if (text !== '') {
    return [{
      role: 'assistant',
      content: text,
      documentChanges: changes.length > 0 ? changes : undefined,
      toolSteps: toolSteps.length > 0 ? toolSteps : undefined,
      activePersona: persona,
    }]
  }
  if (error != null && error !== '') return [{
    role: 'assistant',
    content: `Error: ${error}`,
  }]
  return []
}
