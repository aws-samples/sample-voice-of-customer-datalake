/**
 * MCP OAuth wire shapes (api/oauthSchema.ts): a redirect the browser will follow must be http(s),
 * and a damaged grant row never reads wider or more alive than the backend treats it.
 */
import { describe, it, expect } from 'vitest'
import { ConsentApprovalSchema, ConsentDescriptionSchema, GrantListResponseSchema } from './oauthSchema'

describe('oauthSchema', () => {
  it.each(['javascript:alert(1)', 'data:text/html,x', 'not a url', '//evil.example.com'])(
    'refuses %s as a redirect to follow',
    (url) => {
      expect(ConsentApprovalSchema.safeParse({ redirect_to: url }).success).toBe(false)
    },
  )

  it('accepts the hosted sign-in and a loopback redirect', () => {
    expect(ConsentApprovalSchema.parse({ redirect_to: 'https://voc.auth.us-east-1.amazoncognito.com/oauth2/authorize?a=1' }).redirect_to)
      .toContain('amazoncognito.com')
    expect(ConsentDescriptionSchema.parse({
      refused: false, client_kind: 'kiro', client_name: 'Kiro', can_write: true, can_run_agents: false, loopback: true,
      deny_redirect: 'http://127.0.0.1:53111/oauth/callback?error=access_denied',
    }).refused).toBe(false)
  })

  it('drops a row without an id and reads an unknown scope as read, an unknown status as expired', () => {
    const { grants } = GrantListResponseSchema.parse({ grants: [{ client_name: 'x' }, { grant_id: 'oag_1', scope: 'admin', status: '??' }] })
    expect(grants).toHaveLength(1)
    expect([grants[0]?.scope, grants[0]?.status, grants[0]?.signed_in]).toStrictEqual(['read', 'expired', false])
  })
})
