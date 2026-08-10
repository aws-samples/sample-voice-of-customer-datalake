/**
 * Tests for the one builder of a feedback form's public address.
 *
 * Worth its own file because a QR gives no feedback when it is wrong: the
 * modules look identical whatever they encode, so a malformed address is only
 * discovered by a room full of phones failing to open it.
 */
import { describe, it, expect } from 'vitest'
import { feedbackFormPublicUrl } from './feedbackFormUrls'

describe('a feedback form public URL', () => {
  it('addresses the form\'s hosted public page', () => {
    // Spelled out rather than assembled from the same pieces the builder uses:
    // this is the address printed on the card, copied into customers' embed
    // snippets and encoded into the QR, so the literal IS the contract.
    expect(feedbackFormPublicUrl('https://api.example.com', 'form_1'))
      .toBe('https://api.example.com/feedback-forms/form_1/iframe')
  })

  it('tolerates an endpoint configured with a trailing slash', () => {
    // The endpoint is user-entered configuration and `…/v1/` is a normal paste;
    // a doubled slash would encode an address the API may not route.
    expect(feedbackFormPublicUrl('https://api.example.com/v1/', 'form_1'))
      .toBe('https://api.example.com/v1/feedback-forms/form_1/iframe')
  })

  it('builds no address at all when no endpoint is configured', () => {
    // The failure this exists to prevent: '/feedback-forms/form_1/iframe' is a
    // perfectly good relative path and a perfectly scannable QR, and it resolves
    // to nothing on the phone that scans it.
    expect(feedbackFormPublicUrl('', 'form_1')).toBeNull()
  })

  it('builds no address from an endpoint that is not absolute', () => {
    // '/api' is the relative fallback `getBaseUrl` uses for fetches the app makes
    // itself. It is a working API base and a useless public address.
    expect(feedbackFormPublicUrl('/api', 'form_1')).toBeNull()
    expect(feedbackFormPublicUrl('api.example.com', 'form_1')).toBeNull()
  })

  it('builds no address from an endpoint that is not http', () => {
    // Parses as a valid URL, is not a valid API, and this string ends up in an
    // href and an iframe src on a customer's own page.
    expect(feedbackFormPublicUrl('javascript:alert(1)', 'form_1')).toBeNull()
    expect(feedbackFormPublicUrl('data:text/html,<p>x', 'form_1')).toBeNull()
  })

  it('percent-encodes the form id it is given', () => {
    // Server-minted today. It is also a path segment in a snippet customers paste
    // and in a QR nobody can proofread, so an id carrying a slash must not
    // silently address a different resource.
    expect(feedbackFormPublicUrl('https://api.example.com', 'form/../admin'))
      .toBe('https://api.example.com/feedback-forms/form%2F..%2Fadmin/iframe')
    expect(feedbackFormPublicUrl('https://api.example.com', 'a b?c=1'))
      .toBe('https://api.example.com/feedback-forms/a%20b%3Fc%3D1/iframe')
  })
})
