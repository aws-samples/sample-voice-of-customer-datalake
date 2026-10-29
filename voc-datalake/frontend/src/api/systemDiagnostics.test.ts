/**
 * @fileoverview The diagnostics normalizers: a drifted or unreadable answer never
 * reads as "nothing wrong", and well-formed parts survive a partly drifted one.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeSystemEnvironment, normalizeSystemFailureQueues, normalizeSystemRequest,
} from './systemDiagnostics'
import { canShowRequest, normalizeSystemLogs } from './systemLogs'

describe('normalizeSystemRequest', () => {
  it('keeps the well-formed lines and defaults a missing level to INFO', () => {
    expect(normalizeSystemRequest({
      status: 'complete', truncated: false,
      lines: [{ timestamp: 't1', message: 'START' }, 'garbage', { timestamp: 't2', level: 'ERROR', message: 'boom' }],
    }).lines).toStrictEqual([
      { timestamp: 't1', level: 'INFO', message: 'START' },
      { timestamp: 't2', level: 'ERROR', message: 'boom' },
    ])
  })

  it.each([
    ['a non-object', 'nope'],
    ['running without a query id', { status: 'running', lines: [] }],
    ['an unknown status', { status: 'weird', lines: [] }],
  ])('reads %s as failed', (_name, raw) => {
    expect(normalizeSystemRequest(raw).status).toBe('failed')
  })
})

describe('normalizeSystemFailureQueues', () => {
  it('drops a nameless queue and reads an unreadable count as null, never as 0', () => {
    expect(normalizeSystemFailureQueues({ queues: [{ messages: 3 }, { name: 'voc-dlq', messages: 'x', sample: ['a'] }] }))
      .toStrictEqual({ queues: [{ name: 'voc-dlq', messages: null, sample: ['a'] }] })
  })

  it.each([['no list', {}], ['a non-object', null], ['a non-array list', { queues: 'none' }]])('throws for %s', (_name, raw) => {
    expect(() => normalizeSystemFailureQueues(raw)).toThrow('Unreadable failure queues answer')
  })
})

describe('normalizeSystemEnvironment', () => {
  it('keeps every field with its raw value and drops null / empty ones', () => {
    expect(normalizeSystemEnvironment({ region: 'eu-west-1', prefix: '', missing: null, retries: 3, flags: ['a', 2, {}] }))
      .toStrictEqual([
        { key: 'region', value: { kind: 'text', text: 'eu-west-1' }, raw: 'eu-west-1' },
        { key: 'retries', value: { kind: 'text', text: '3' }, raw: 3 },
        { key: 'flags', value: { kind: 'list', items: ['a', '2'] }, raw: ['a', 2, {}] },
      ])
  })

  it('flattens nested sections into one line per value (models per surface, alarms and their state)', () => {
    const [models, alerting] = normalizeSystemEnvironment({
      models: { effective: { chat: 'model-a', documents: 'model-b' }, overrides: {} },
      alerting: { configured: true, alarms: [{ name: 'processing-dlq', state: 'ALARM' }], in_alarm: 1 },
    })
    expect([models?.value, alerting?.value]).toStrictEqual([
      { kind: 'list', items: ['effective.chat: model-a', 'effective.documents: model-b'] },
      { kind: 'list', items: ['configured: true', 'alarms.1.name: processing-dlq', 'alarms.1.state: ALARM', 'in_alarm: 1'] },
    ])
  })

  it('throws for a non-object answer', () => {
    expect(() => normalizeSystemEnvironment([1, 2])).toThrow('Unreadable environment answer')
  })
})

describe('system log groups', () => {
  const group = (extra: object) => normalizeSystemLogs({
    status: 'complete', groups: [{ function: 'f', level: 'ERROR', message: 'm', request_id: 'r', ...extra }],
  }).groups[0]

  it('reads a group without a source as a Lambda one and accepts the HTTP level', () => {
    expect([group({})?.source, group({ source: 'api', level: 'HTTP' })?.level]).toStrictEqual(['lambda', 'HTTP'])
  })

  it.each([
    [{ source: 'lambda' }, true],
    [{ source: 'workflow' }, true],
    [{ source: 'api' }, false],
    [{ source: 'lambda', request_id: null }, false],
  ])('canShowRequest(%o) is %s', (extra, expected) => {
    const shown = group(extra)
    expect(shown !== undefined && canShowRequest(shown)).toBe(expected)
  })
})
