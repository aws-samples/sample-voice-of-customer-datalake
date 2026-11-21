import { describe, expect, it } from 'vitest'
import type { RelayMessage } from '@stream/voice/protocol'
import { endVoice, initialVoiceState, reduceVoice } from './voiceSessionState'

const fold = (messages: readonly RelayMessage[]) => messages.reduce(reduceVoice, initialVoiceState(900, 300))

describe('reduceVoice', () => {
  it('goes live on ready and keeps one caption per side and turn, a final never overwritten by a late speculative', () => {
    const state = fold([
      { type: 'ready', voice_id: 'tiffany', session_seconds: 420, minutes_left: 120 },
      { type: 'caption', role: 'assistant', stage: 'speculative', text: 'Hi', turn: 1 },
      { type: 'caption', role: 'assistant', stage: 'final', text: 'Hi there', turn: 1 },
      { type: 'caption', role: 'assistant', stage: 'speculative', text: 'Hi th', turn: 1 },
      { type: 'caption', role: 'user', stage: 'final', text: 'Hello', turn: 2 },
      { type: 'turn_end', role: 'user', turn: 2 },
    ])
    expect([state.phase, state.sessionSeconds, state.minutesLeft]).toStrictEqual(['live', 420, 120])
    expect(state.captions.map(({ role, text, final }) => [role, text, final])).toStrictEqual([
      ['assistant', 'Hi there', true], ['user', 'Hello', true]])
  })

  it('marks the last persona turn interrupted and files each citation on its turn, once', () => {
    const state = fold([
      { type: 'caption', role: 'assistant', stage: 'speculative', text: 'First', turn: 1 },
      { type: 'caption', role: 'user', stage: 'final', text: 'Wait', turn: 2 },
      { type: 'caption', role: 'assistant', stage: 'speculative', text: 'Second', turn: 3 },
      { type: 'interrupted' },
      { type: 'citation', turn: 3, feedback_ids: ['fb1', 'fb2'] },
      { type: 'citation', turn: 3, feedback_ids: ['fb2'] },
    ])
    expect(state.captions.map((caption) => caption.interrupted)).toStrictEqual([false, false, true])
    expect([state.captions[2]?.feedbackIds, state.cited]).toStrictEqual([['fb1', 'fb2'], ['fb1', 'fb2']])
  })

  it('follows usage, the budget and notices, and ends with the first reason only', () => {
    const state = fold([
      { type: 'usage', seconds: 61, cents: 1.8 },
      { type: 'budget', minutes_left: 9.5 },
      { type: 'notice', code: 'time_almost_up' },
      { type: 'ended', reason: 'session_limit' },
    ])
    expect([state.seconds, state.cents, state.minutesLeft, state.notice]).toStrictEqual([61, 1.8, 9.5, 'time_almost_up'])
    expect([state.phase, endVoice(state, 'disconnected').endReason]).toStrictEqual(['ended', 'session_limit'])
  })

  it('stays ended when a late ready arrives', () => {
    const ended = endVoice(initialVoiceState(900, 10), 'refused')
    expect(reduceVoice(ended, { type: 'ready', voice_id: 'matthew', session_seconds: 900, minutes_left: 10 }).phase).toBe('ended')
  })
})
