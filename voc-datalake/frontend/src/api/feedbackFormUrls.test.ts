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
})
