/**
 * The point of these tests is CROSS-LANGUAGE AGREEMENT.
 *
 * Avatar URLs are signed by two implementations — this one and
 * `lambda/shared/cloudfront_signing.py` — and CloudFront verifies the signature
 * against the exact policy bytes. A difference as small as one space, or a
 * different key order, yields a signature CloudFront rejects, and the failure
 * would surface only as a 403 in a browser after deploying.
 *
 * The guarantee is assembled from three parts rather than by pinning a signed
 * URL against a committed key, because that would mean checking a real
 * `-----BEGIN PRIVATE KEY-----` into a public repository:
 *
 *   1. the canned policy bytes match botocore exactly — the fixture is kept
 *      honest by `lambda/shared/test/test_cloudfront_signing_fixture.py`, which
 *      recomputes it from `CloudFrontSigner.build_policy` and fails on drift;
 *   2. the signature this module produces verifies against the matching public
 *      key under RSA-SHA1 / PKCS#1 v1.5 — the exact check CloudFront performs;
 *   3. the query parameters are named, ordered and encoded as CloudFront wants.
 *
 * RSA PKCS#1 v1.5 is deterministic, so 1 + 2 together imply both
 * implementations emit identical signatures for identical keys.
 */
import { describe, it, expect } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import fixture from './__fixtures__/cloudfront-signing.botocore.json';
import {
  buildCannedPolicy,
  buildSignedUrl,
  signUrlWithKey,
} from './cloudfront-signing.js';

/** Matches what the cdn_signing_keys custom resource generates at deploy time. */
function testKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/** Undo CloudFront's base64 variant. */
function decodeSignature(signature: string): Buffer {
  return Buffer.from(
    signature.replaceAll('-', '+').replaceAll('_', '=').replaceAll('~', '/'),
    'base64',
  );
}

describe('canned policy serialization', () => {
  it('matches botocore byte-for-byte', () => {
    expect(buildCannedPolicy(fixture.url, fixture.expiresEpochSeconds)).toBe(
      fixture.expectedCannedPolicy,
    );
  });

  it('matches botocore for a url that already has a query string', () => {
    expect(buildCannedPolicy(fixture.urlWithQuery, fixture.expiresEpochSeconds)).toBe(
      fixture.expectedCannedPolicyForUrlWithQuery,
    );
  });
});

describe('signUrlWithKey', () => {
  it('produces a signature CloudFront would accept, i.e. RSA-SHA1 over the policy', () => {
    const { publicKey, privateKey } = testKeyPair();

    const signed = signUrlWithKey(
      fixture.url,
      privateKey,
      fixture.keyPairId,
      fixture.expiresEpochSeconds,
    );

    const signature = new URL(signed).searchParams.get('Signature') ?? '';
    const verified = createVerify('RSA-SHA1')
      .update(fixture.expectedCannedPolicy)
      .verify(publicKey, decodeSignature(signature));

    // Verifying against the BOTOCORE policy string, not our own — so this fails
    // if the two implementations ever sign different bytes.
    expect(verified).toBe(true);
  });

  it('is deterministic for the same key, url and expiry', () => {
    // PKCS#1 v1.5 has no random salt. This is what lets parts 1 and 2 above add
    // up to byte-identical output across the two languages.
    const { privateKey } = testKeyPair();
    const once = signUrlWithKey(fixture.url, privateKey, 'KID', 123);
    const twice = signUrlWithKey(fixture.url, privateKey, 'KID', 123);

    expect(once).toBe(twice);
  });
});

describe('buildSignedUrl', () => {
  it('starts a query string, orders Expires, Signature, Key-Pair-Id and maps + / = onto - ~ _', () => {
    // 0xfb 0xff is '+/8=' in standard base64: every character CloudFront remaps.
    const out = buildSignedUrl('https://d1.cloudfront.net/a.jpeg', 42, Buffer.from([0xfb, 0xff]), 'KID');
    expect(out).toBe('https://d1.cloudfront.net/a.jpeg?Expires=42&Signature=-~8_&Key-Pair-Id=KID');
  });

  it('appends to an existing query string instead of starting a second one', () => {
    const out = buildSignedUrl('https://d1.cloudfront.net/a.jpeg?v=2', 42, Buffer.from('sig'), 'KID');
    expect(out).toBe('https://d1.cloudfront.net/a.jpeg?v=2&Expires=42&Signature=c2ln&Key-Pair-Id=KID');
  });
});
