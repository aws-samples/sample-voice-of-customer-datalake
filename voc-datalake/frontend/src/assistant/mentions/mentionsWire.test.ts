/**
 * Mentions on the wire: they leave the SPA only from a project page and only within the
 * contract, and Regenerate asks the same personas again from the saved persona round.
 */
import { describe, expect, it } from 'vitest'
import { buildForwardedProps } from '../agui/forwardedProps'
import { MENTION_TOOL_CALL_PREFIX } from '../contract'
import { mentionsOfLastTurn } from './mentionsOfTurn'
import type { Message } from '@ag-ui/core'
import type { Mentions, PageContext } from '../contract'

const PROJECT: PageContext = { kind: 'project', path: '/projects/proj_1', projectId: 'proj_1' }

function propsFor(page: PageContext, mentions: Mentions | undefined) {
  return buildForwardedProps({ page, language: 'en', useWebSearch: false, mentions }).mentions
}

describe('forwardedProps.mentions', () => {
  it('carries the mentions of a project page message', () => {
    expect(propsFor(PROJECT, { personas: 'all', documents: [{ document_id: 'd1', version: 2 }] }))
      .toStrictEqual({ personas: 'all', documents: [{ document_id: 'd1', version: 2 }] })
  })

  it('leaves them out on any other page', () => {
    expect(propsFor({ kind: 'dashboard', path: '/' }, { personas: 'all' })).toBeUndefined()
  })

  it('leaves out mentions the stream would refuse instead of failing the run', () => {
    expect(propsFor(PROJECT, { personas: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).toBeUndefined()
    expect(propsFor(PROJECT, {})).toBeUndefined()
  })
})

function roundCall(id: string, args: unknown) {
  return { id, type: 'function' as const, function: { name: 'consult_personas', arguments: JSON.stringify(args) } }
}

describe('mentionsOfLastTurn', () => {
  it('reads the personas and documents of the last persona round', () => {
    const messages: Message[] = [
      { id: 'u0', role: 'user', content: '@Pat earlier' },
      { id: 'a0', role: 'assistant', toolCalls: [roundCall(`${MENTION_TOOL_CALL_PREFIX}old`, { question: 'q', persona_ids: ['old'] })] },
      { id: 'u1', role: 'user', content: '@all review #PR/FAQ (v1)' },
      { id: 'a1', role: 'assistant', toolCalls: [
        roundCall(`${MENTION_TOOL_CALL_PREFIX}1`, { question: 'q', document_ids: ['d1'], persona_ids: ['p1'] }),
        roundCall(`${MENTION_TOOL_CALL_PREFIX}2`, { question: 'q', document_ids: ['d1'], persona_ids: ['p2'] }),
      ] },
      { id: 'a2', role: 'assistant', content: 'Both like it.' },
    ]
    expect(mentionsOfLastTurn(messages)).toStrictEqual({ personas: ['p1', 'p2'], documents: [{ document_id: 'd1' }] })
  })

  it('ignores consult_personas calls the model made itself', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'what would users think?' },
      { id: 'a1', role: 'assistant', toolCalls: [roundCall('tooluse_abc', { question: 'q', persona_ids: ['p1'] })] },
    ]
    expect(mentionsOfLastTurn(messages)).toBeUndefined()
  })
})
