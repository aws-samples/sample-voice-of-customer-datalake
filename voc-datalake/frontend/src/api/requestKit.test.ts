import { describe, expect, it } from 'vitest'
import { del, patch, post, put } from './requestKit'

describe('request options', () => {
  it('serialise a given body and send none when there is none', () => {
    expect([post({ a: 1 }), put(['x']), patch({}), post(), put(), del()]).toStrictEqual([
      { method: 'POST', body: '{"a":1}' },
      { method: 'PUT', body: '["x"]' },
      { method: 'PATCH', body: '{}' },
      { method: 'POST' },
      { method: 'PUT' },
      { method: 'DELETE' },
    ])
  })

  it('serialise a falsy body (null, 0, empty string) rather than dropping it', () => {
    expect([post(null), put(0), post('')]).toStrictEqual([
      { method: 'POST', body: 'null' },
      { method: 'PUT', body: '0' },
      { method: 'POST', body: '""' },
    ])
  })
})
