/**
 * @fileoverview What a voice session's modal shows, folded from the relay's messages (`@stream/voice/protocol`):
 * the captions of both sides by turn (a caption's text is the whole turn so far, so it replaces, never appends), which
 * persona turn was cut off by the person (barge-in), the reviews cited, the seconds and cost so far, the month's
 * minutes left, the current notice and, at the end, why it ended. Pure: the modal's hook owns the socket and audio.
 *
 * @module pages/ProjectDetail/voice/voiceSessionState
 */
import type { RelayMessage, VoiceEndReason } from '@stream/voice/protocol'

type VoicePhase = 'connecting' | 'live' | 'ending' | 'ended'
type VoiceNotice = 'time_almost_up' | 'budget_almost_up' | 'wrapping_up'

export interface VoiceCaption {
  readonly role: 'user' | 'assistant'
  readonly turn: number
  readonly text: string
  /** `final`: what was said; otherwise the model's text before it is spoken, which may still change. */
  readonly final: boolean
  /** The person spoke over this persona turn. */
  readonly interrupted: boolean
  readonly feedbackIds: readonly string[]
}

export interface VoiceState {
  readonly phase: VoicePhase
  readonly captions: readonly VoiceCaption[]
  readonly seconds: number
  readonly cents: number
  /** The deployment's minutes left this month, as the relay last said. */
  readonly minutesLeft: number | null
  readonly sessionSeconds: number
  readonly notice: VoiceNotice | null
  readonly cited: readonly string[]
  readonly endReason: VoiceEndReason | null
}

export function initialVoiceState(sessionSeconds: number, minutesLeft: number): VoiceState {
  return {
    phase: 'connecting', captions: [], seconds: 0, cents: 0, minutesLeft, sessionSeconds, notice: null, cited: [],
    endReason: null,
  }
}

type CaptionMessage = Extract<RelayMessage, { type: 'caption' }>

function withCaption(captions: readonly VoiceCaption[], message: CaptionMessage): VoiceCaption[] {
  const final = message.stage === 'final'
  const index = captions.findIndex((caption) => caption.role === message.role && caption.turn === message.turn)
  if (index === -1) {
    return [...captions, { role: message.role, turn: message.turn, text: message.text, final, interrupted: false, feedbackIds: [] }]
  }
  return captions.map((caption, at) => {
    // A late speculative caption never overwrites what was already said.
    if (at !== index || (caption.final && !final)) return caption
    return { ...caption, text: message.text, final }
  })
}

/** The latest persona turn is the one the person spoke over. */
function interruptLast(captions: readonly VoiceCaption[]): VoiceCaption[] {
  const last = captions.reduce((found, caption, at) => (caption.role === 'assistant' ? at : found), -1)
  return captions.map((caption, at) => (at === last ? { ...caption, interrupted: true } : caption))
}

function withCitation(state: VoiceState, turn: number, ids: readonly string[]): VoiceState {
  const captions = state.captions.map((caption) => (caption.role === 'assistant' && caption.turn === turn
    ? { ...caption, feedbackIds: [...new Set([...caption.feedbackIds, ...ids])] }
    : caption))
  return { ...state, captions, cited: [...new Set([...state.cited, ...ids])] }
}

function onReady(state: VoiceState, message: Extract<RelayMessage, { type: 'ready' }>): VoiceState {
  const phase = state.phase === 'connecting' ? 'live' : state.phase
  return { ...state, phase, sessionSeconds: message.session_seconds, minutesLeft: message.minutes_left }
}

/** The session is over on the browser's side: the socket closed, the person ended it, or it could not start. */
export function endVoice(state: VoiceState, reason: VoiceEndReason): VoiceState {
  return { ...state, phase: 'ended', endReason: state.endReason ?? reason }
}

/** The state after one message from the relay. */
export function reduceVoice(state: VoiceState, message: RelayMessage): VoiceState {
  switch (message.type) {
    case 'ready':
      return onReady(state, message)
    case 'caption':
      return { ...state, captions: withCaption(state.captions, message) }
    case 'interrupted':
      return { ...state, captions: interruptLast(state.captions) }
    case 'citation':
      return withCitation(state, message.turn, message.feedback_ids)
    case 'usage':
      return { ...state, seconds: message.seconds, cents: message.cents }
    case 'budget':
      return { ...state, minutesLeft: message.minutes_left }
    case 'notice':
      return { ...state, notice: message.code }
    case 'ended':
      return endVoice(state, message.reason)
    case 'turn_end':
      return state
  }
}
