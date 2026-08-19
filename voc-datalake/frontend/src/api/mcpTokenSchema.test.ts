import { describe, it, expect, vi } from 'vitest'
import {
  ApiTokenSchema, CreateApiTokenResponseSchema, DEFAULT_READ_REACH,
  MCP_SCOPES, OFFERED_READ_REACHES, READ_REACHES,
  isMcpScope, isReadReach, normalizeApiTokens,
} from './mcpTokenSchema'

const validRow = {
  token_id: 'tok_abc',
  name: 'Kiro laptop',
  scopes: ['feedback:read', 'projects:read'],
  projects: ['proj_1'],
  read_reach: 'project-set',
  created_at: '2026-08-01T00:00:00Z',
}

describe('normalizeApiTokens', () => {
  it('keeps a well-formed row intact', () => {
    expect(normalizeApiTokens([validRow])).toEqual([validRow])
  })

  it('returns an empty list for a payload that is not an array', () => {
    // The tab renders its empty state rather than blanking the route.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [null, undefined, {}, 'nope', 0]) {
      expect(normalizeApiTokens(bad)).toEqual([])
    }
    warn.mockRestore()
  })

  it('drops only the rows with no usable token_id', () => {
    // A row with no id cannot be keyed in React nor addressed by the revoke
    // endpoint, so it is unrenderable — but it must not take the other rows
    // down with it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tokens = normalizeApiTokens([
      validRow,
      { ...validRow, token_id: '' },
      { ...validRow, token_id: undefined },
      'not an object',
      { ...validRow, token_id: 'tok_other' },
    ])
    expect(tokens.map((t) => t.token_id)).toEqual(['tok_abc', 'tok_other'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('defaults a missing read_reach to what the backend enforces', () => {
    // Deliberately NOT a safer-looking default: showing a credential as
    // narrower than it is would be the more dangerous lie.
    const [token] = normalizeApiTokens([{ ...validRow, read_reach: undefined }])
    expect(token.read_reach).toBe(DEFAULT_READ_REACH)
    expect(DEFAULT_READ_REACH).toBe('workspace')
  })

  it('defaults an unrecognised read_reach rather than dropping the row', () => {
    const [token] = normalizeApiTokens([{ ...validRow, read_reach: 'write-set' }])
    expect(token.read_reach).toBe(DEFAULT_READ_REACH)
  })

  it('filters unknown scopes out of the set', () => {
    // A scope this UI cannot describe must not be rendered as if it were
    // meaningful; the row survives without it.
    const [token] = normalizeApiTokens([
      { ...validRow, scopes: ['feedback:read', 'projects:write', 42, null, 'read'] },
    ])
    expect(token.scopes).toEqual(['feedback:read'])
  })

  it('recovers from scopes and projects that are not arrays', () => {
    const [token] = normalizeApiTokens([
      { ...validRow, scopes: 'feedback:read', projects: { a: 1 } },
    ])
    expect(token.scopes).toEqual([])
    expect(token.projects).toEqual([])
  })

  it('normalizes empty and null timestamps to undefined', () => {
    // '' would render as "Invalid Date" in the row's expiry badge.
    const [token] = normalizeApiTokens([
      { ...validRow, last_used_at: '', expires_at: null },
    ])
    expect(token.last_used_at).toBeUndefined()
    expect(token.expires_at).toBeUndefined()
  })

  it('passes unknown backend fields through untouched', () => {
    const [token] = normalizeApiTokens([{ ...validRow, future_field: 'keep me' }])
    expect(token).toMatchObject({ future_field: 'keep me' })
  })
})

describe('ApiTokenSchema', () => {
  it('strips secret_hash and created_by even though the object is loose', () => {
    // Previously this asserted `not.toHaveProperty('scope')` — unrelated to its
    // own name, and vacuously true, while `secret_hash` DID pass through the
    // loose object. The schema now strips both, so the assertion and the name
    // describe the same guarantee.
    const parsed = ApiTokenSchema.parse({
      ...validRow, secret_hash: 'THE-STORED-HASH', created_by: 'a-cognito-sub',
    })
    expect(parsed).not.toHaveProperty('secret_hash')
    expect(parsed).not.toHaveProperty('created_by')
    expect(JSON.stringify(parsed)).not.toContain('THE-STORED-HASH')
    expect(JSON.stringify(parsed)).not.toContain('a-cognito-sub')
    // The rest of the row survives — this is a strip, not a rejection.
    expect(parsed.token_id).toBe(validRow.token_id)
  })

  it('still passes through harmless unknown fields', () => {
    // The strip must be targeted, not a switch to a strict object: forward
    // compatibility with new backend fields is why the schema is loose.
    const parsed = ApiTokenSchema.parse({ ...validRow, future_field: 'keep me' })
    expect(parsed).toMatchObject({ future_field: 'keep me' })
  })
})

describe('CreateApiTokenResponseSchema', () => {
  it('requires the raw credential', () => {
    // The mint response exists to deliver it once; a response without it is a
    // failure the caller must see, not a token row with an empty string.
    expect(() => CreateApiTokenResponseSchema.parse({ ...validRow, token: '' })).toThrow()
    expect(() => CreateApiTokenResponseSchema.parse({ ...validRow })).toThrow()
  })

  it('accepts a full mint response', () => {
    const parsed = CreateApiTokenResponseSchema.parse({
      ...validRow, token: 'voc_tok_abc_secret', expires_at: '2027-01-01T00:00:00Z',
    })
    expect(parsed.token).toBe('voc_tok_abc_secret')
    expect(parsed.expires_at).toBe('2027-01-01T00:00:00Z')
  })
})

describe('vocabulary', () => {
  it('offers every reach except the inert one', () => {
    // `none` is valid but produces a credential that can do nothing while
    // there are no write tools, so the form does not present it.
    expect(OFFERED_READ_REACHES).toEqual(['workspace', 'project-set'])
    expect(READ_REACHES).toContain('none')
    expect(OFFERED_READ_REACHES).not.toContain('none')
  })

  it('has no scope the retired model would have carried', () => {
    // `read` / `read-write` are gone; `read-write` in particular was mintable
    // and badged while no tool ever required it.
    expect(isMcpScope('read')).toBe(false)
    expect(isMcpScope('read-write')).toBe(false)
    expect(MCP_SCOPES.every((s) => s.endsWith(':read'))).toBe(true)
  })

  it('guards its type predicates', () => {
    expect(isReadReach('workspace')).toBe(true)
    expect(isReadReach('write-set')).toBe(false)
    expect(isMcpScope('feedback:read')).toBe(true)
    expect(isMcpScope('feedback:write')).toBe(false)
  })
})
