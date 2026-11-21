/**
 * @fileoverview The fine-grained token connection's rules (7.60.00): a token's shape (a fine-grained token, never a
 * classic, OAuth or App token), the repository as typed or as its github.com address, GitHub's new-token page prefilled
 * with what its link takes, the 14-day warning, and the server's refusal codes.
 */
import { describe, expect, it } from 'vitest'
import { FAKE_TOKEN } from '@test/tokenConnectionFixtures'
import {
  MAX_TOKEN_DAYS, NEW_TOKEN_PAGE, TOKEN_REFUSAL_CODES, TOKEN_WARNING_DAYS, knownRefusal, newTokenUrl, repositoryOf, fineGrainedTokenIssue,
  tokenState,
} from './tokenConnectionRules'

describe('a pasted token', () => {
  it.each([
    ['', 'tokenEmpty'], ['   ', 'tokenEmpty'], [`ghp_${'a'.repeat(36)}`, 'classic'], [`gho_${'a'.repeat(36)}`, 'classic'],
    [`ghu_${'a'.repeat(36)}`, 'classic'], [`ghs_${'a'.repeat(36)}`, 'classic'], [`ghr_${'a'.repeat(36)}`, 'classic'],
    ['github_pat_short', 'shape'], [`glpat-${'a'.repeat(20)}`, 'shape'], [`github_pat_${'a'.repeat(20)}!`, 'shape'],
  ])('%j is refused as %s', (token, issue) => {
    expect(fineGrainedTokenIssue(token)).toBe(issue)
  })

  it('passes as a fine-grained token, surrounding spaces trimmed', () => {
    expect([fineGrainedTokenIssue(FAKE_TOKEN), fineGrainedTokenIssue(` ${FAKE_TOKEN}\n`)]).toStrictEqual([undefined, undefined])
  })
})

describe('the repository', () => {
  it.each([
    ['partner-org/sdk', 'partner-org/sdk'], [' partner-org/sdk ', 'partner-org/sdk'],
    ['https://github.com/partner-org/sdk', 'partner-org/sdk'], ['https://github.com/partner-org/sdk.git', 'partner-org/sdk'],
    ['https://github.com/partner-org/sdk/', 'partner-org/sdk'], ['partner-org', null], ['a/b/c', null],
    ['https://gitlab.com/partner-org/sdk', null], ['', null],
  ])('%j is %j', (typed, repository) => {
    expect(repositoryOf(typed)).toBe(repository)
  })
})

describe('GitHub\'s new-token page', () => {
  it('is prefilled with the owner, 90 days and the two write permissions, the name cut at 40 characters', () => {
    const url = new URL(newTokenUrl(`partner-org/${'x'.repeat(50)}`))
    expect(`${url.origin}${url.pathname}`).toBe(NEW_TOKEN_PAGE)
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      name: `VoC agents ${'x'.repeat(29)}`, description: `VoC engineering agents: branches and pull requests on partner-org/${'x'.repeat(50)} only`,
      target_name: 'partner-org', expires_in: String(MAX_TOKEN_DAYS), contents: 'write', pull_requests: 'write',
    })
    expect(url.searchParams.get('name')).toHaveLength(40)
  })
})

describe('a token\'s expiry', () => {
  it.each([
    [null, 'none'], [-3, 'expired'], [0, 'expired'], [1, 'soon'], [TOKEN_WARNING_DAYS, 'soon'],
    [TOKEN_WARNING_DAYS + 1, 'ok'], [90, 'ok'],
  ])('%j days left is %s', (days, state) => {
    expect(tokenState(days)).toBe(state)
  })
})

describe('the server\'s refusals', () => {
  it('are each known, and anything else is not', () => {
    expect(TOKEN_REFUSAL_CODES.map(knownRefusal)).toStrictEqual([...TOKEN_REFUSAL_CODES])
    expect([knownRefusal(null), knownRefusal('token_owner_go')]).toStrictEqual([null, null])
  })
})
