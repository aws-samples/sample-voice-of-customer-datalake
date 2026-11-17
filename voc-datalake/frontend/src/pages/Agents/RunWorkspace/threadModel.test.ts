/**
 * @fileoverview An agent's thread as the workspace keeps it: pages merged by ref (a later item replaces the earlier
 * in its place, a repeated conversation window kept once), in time order; how each item reads; the Slack-like groups;
 * the bound on a text.
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchApi } from '@test/fetchApiRoutes'
import fixture from '@test/engineeringRunWorkspace.json'
import { runWorkspaceApi } from '../../../api/engineeringRunWorkspaceApi'
import { MAX_ITEM_TEXT, boundedText, lookOf, mergeThread, startsGroup } from './threadModel'
import type { ThreadItem } from '../../../api/engineeringRunWorkspaceApi'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

/** A page of the shared fixture, read through the API module as the page reads it. */
async function page(answer: unknown): Promise<ThreadItem[]> {
  fetchApi.mockResolvedValueOnce(answer)
  return (await runWorkspaceApi.thread(fixture.run_id, fixture.agent, null)).items
}

const item = (ref: string, at: string, overrides: Partial<ThreadItem> = {}): ThreadItem => ({
  ref, at, kind: 'said', from: { kind: 'agent', id: 'fixer-3' }, text: ref, cut: false, update: 'agent_message_chunk', tool: null, ...overrides,
})

describe('mergeThread', () => {
  it('keeps each ref once across the fixture\'s pages: the repeated window and the call answered later', async () => {
    const merged = mergeThread(await page(fixture.thread.answer), await page(fixture.thread_next.answer))
    const refs = merged.map((entry) => entry.ref)
    expect(refs.filter((ref) => ref === 'c2')).toHaveLength(1)
    expect(refs.filter((ref) => ref === '2.1.2260')).toHaveLength(1)
    expect(refs).toHaveLength(new Set(refs).size)
  })

  it('orders the merged thread by time, a checkpoint read before its call placed after it', async () => {
    const merged = mergeThread(await page(fixture.thread.answer), await page(fixture.thread_next.answer))
    const times = merged.map((entry) => entry.at)
    expect(times).toStrictEqual([...times].sort((a, b) => a.localeCompare(b)))
    expect(merged.findIndex((entry) => entry.ref === '2.1.2260')).toBeLessThan(merged.findIndex((entry) => entry.ref === '2.1.2441'))
  })

  it('replaces an item by a later one with its ref, in the earlier one\'s place among equal times', () => {
    const call = item('t1', '2026-11-17T09:00:00Z', { kind: 'tool', text: '', tool: { name: 'run', ok: null, input: '', kind: 'execute', status: 'in_progress' } })
    const answered = { ...call, text: 'exit 0', tool: { name: 'run', ok: true, input: '', kind: 'execute', status: 'completed' } }
    const merged = mergeThread([call, item('s1', '2026-11-17T09:00:00Z')], [answered])
    expect(merged.map((entry) => [entry.ref, entry.text])).toStrictEqual([['t1', 'exit 0'], ['s1', 's1']])
  })
})

describe('how an item reads', () => {
  it('reads each ACP update as its look: words, thinking, a tool call, the harness folded, a message, steering, an event', async () => {
    const items = mergeThread(await page(fixture.thread.answer), await page(fixture.thread_next.answer))
    const looks = new Map(items.map((entry) => [entry.ref, lookOf(entry)]))
    expect(['2.1.1106.1', '2.1.1106', '2.1.1470', '2.1.411', 'c5', 'c4', '2.1.0'].map((ref) => looks.get(ref)))
      .toStrictEqual(['said', 'thought', 'tool', 'folded', 'message', 'steer', 'event'])
  })

  it('starts a group for another sender or after a pause, and not for the same sender soon after', () => {
    const first = item('a', '2026-11-17T09:00:00Z')
    expect([
      startsGroup(undefined, first),
      startsGroup(first, item('b', '2026-11-17T09:01:00Z')),
      startsGroup(first, item('c', '2026-11-17T09:01:00Z', { from: { kind: 'human', id: 'admin-sub' } })),
      startsGroup(first, item('d', '2026-11-17T09:30:00Z')),
    ]).toStrictEqual([true, false, true, true])
  })

  it('bounds a text, and says it was cut here or by the server', () => {
    expect(boundedText({ text: 'x'.repeat(MAX_ITEM_TEXT + 10), cut: false })).toStrictEqual({ text: 'x'.repeat(MAX_ITEM_TEXT), cut: true })
    expect(boundedText({ text: 'short', cut: true })).toStrictEqual({ text: 'short', cut: true })
  })
})
