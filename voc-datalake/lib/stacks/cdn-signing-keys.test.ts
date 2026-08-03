/**
 * Tests for the CloudFront signing-key custom resource handler
 * (lambda/custom_resources/cdn_signing_keys.js), which core-stack.ts inlines.
 *
 * The behavior worth guarding is IDEMPOTENCE. CloudFormation invokes this on
 * every stack update, and rotating the keypair would invalidate every signed
 * URL already handed to a browser — including ones sitting in an open tab. So
 * "reuse what exists" is the contract, and "generate" is only for a secret that
 * has no key yet.
 */
import { describe, it, expect, vi } from 'vitest';
// Plain CommonJS JavaScript, typed by a hand-written .d.ts sitting beside it.
// It cannot be TypeScript: core-stack.ts inlines it via Code.fromInline, and
// inline Lambda code is never bundled or transpiled.
import {
  handler,
  generateKeyPair,
  readKeyMaterial,
  PHYSICAL_RESOURCE_ID,
} from '../../lambda/custom_resources/cdn_signing_keys.js';

const SECRET_ID = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:cdn-signing';

function fakeSecrets(initial?: string) {
  const store: { value?: string } = { value: initial };
  return {
    store,
    get: vi.fn(async () => store.value),
    put: vi.fn(async (_id: string, secretString: string) => {
      store.value = secretString;
    }),
  };
}

function createEvent(requestType: string) {
  return { RequestType: requestType, ResourceProperties: { SecretId: SECRET_ID } };
}

describe('generateKeyPair', () => {
  it('produces a PEM keypair CloudFront and both signers can read', () => {
    const { publicKeyPem, privateKeyPem } = generateKeyPair();

    // CloudFront requires the SPKI envelope; PKCS#8 is what Python's
    // `cryptography` and Node's `createSign` both accept.
    expect(publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('produces a distinct key each call', () => {
    expect(generateKeyPair().privateKeyPem).not.toBe(generateKeyPair().privateKeyPem);
  });
});

describe('readKeyMaterial', () => {
  it('returns null for the random password CDK seeds the secret with', () => {
    // The Secret resource must exist before the handler can write to it, so CDK
    // seeds it. "Has a value" therefore does not mean "has a key".
    expect(readKeyMaterial('9RandomlyGeneratedPassword!')).toBeNull();
  });

  it('returns null for absent or empty input', () => {
    expect(readKeyMaterial(undefined)).toBeNull();
    expect(readKeyMaterial('')).toBeNull();
  });

  it('returns null for valid JSON that is not a key pair', () => {
    expect(readKeyMaterial(JSON.stringify({ password: 'x' }))).toBeNull();
    expect(readKeyMaterial(JSON.stringify(['not', 'an', 'object']))).toBeNull();
  });

  it('returns null when only the public half is present', () => {
    // A public-key-only secret cannot sign; accepting it would produce URLs
    // that 403 with no obvious cause.
    const { publicKeyPem } = generateKeyPair();
    expect(readKeyMaterial(JSON.stringify({ publicKeyPem }))).toBeNull();
  });

  it('returns null when the public half is not a PEM public key', () => {
    const { privateKeyPem } = generateKeyPair();
    expect(readKeyMaterial(JSON.stringify({ publicKeyPem: 'nope', privateKeyPem }))).toBeNull();
  });

  it('round-trips a complete key pair', () => {
    const created = generateKeyPair();
    expect(readKeyMaterial(JSON.stringify(created))).toEqual(created);
  });
});

describe('handler', () => {
  it('generates and stores a keypair on first create', async () => {
    const secrets = fakeSecrets();

    const result = await handler(createEvent('Create'), {}, { secrets });

    expect(secrets.put).toHaveBeenCalledOnce();
    const stored = JSON.parse(secrets.store.value ?? '{}');
    expect(stored.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    // Only the PUBLIC half crosses back through CloudFormation.
    expect(result.Data?.PublicKeyPem).toBe(stored.publicKeyPem);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });

  it('reuses the existing keypair on update instead of rotating it', async () => {
    const existing = generateKeyPair();
    const secrets = fakeSecrets(JSON.stringify(existing));

    const result = await handler(createEvent('Update'), {}, { secrets });

    expect(secrets.put).not.toHaveBeenCalled();
    expect(result.Data?.PublicKeyPem).toBe(existing.publicKeyPem);
  });

  it('returns a stable public key across repeated updates', async () => {
    // A changing PublicKeyPem would replace the CloudFront PublicKey resource
    // on every deploy and break URLs already in flight.
    const secrets = fakeSecrets();
    const first = await handler(createEvent('Create'), {}, { secrets });
    const second = await handler(createEvent('Update'), {}, { secrets });
    const third = await handler(createEvent('Update'), {}, { secrets });

    expect(second.Data?.PublicKeyPem).toBe(first.Data?.PublicKeyPem);
    expect(third.Data?.PublicKeyPem).toBe(first.Data?.PublicKeyPem);
  });

  it('regenerates when the secret exists but holds no key', async () => {
    const secrets = fakeSecrets('seeded-random-password');

    const result = await handler(createEvent('Update'), {}, { secrets });

    expect(secrets.put).toHaveBeenCalledOnce();
    expect(result.Data?.PublicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });

  it('keeps one physical id for every request type', async () => {
    // Any change here makes CloudFormation issue a Delete for the old id.
    const secrets = fakeSecrets(JSON.stringify(generateKeyPair()));

    for (const requestType of ['Create', 'Update', 'Delete']) {
      const result = await handler(createEvent(requestType), {}, { secrets });
      expect(result.PhysicalResourceId).toBe(PHYSICAL_RESOURCE_ID);
    }
  });

  it('does not touch the secret on delete', async () => {
    // The secret and both CloudFront resources are CloudFormation-owned.
    const secrets = fakeSecrets(JSON.stringify(generateKeyPair()));

    await handler(createEvent('Delete'), {}, { secrets });

    expect(secrets.get).not.toHaveBeenCalled();
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it('fails loudly when SecretId is missing', async () => {
    const secrets = fakeSecrets();

    await expect(
      handler({ RequestType: 'Create', ResourceProperties: {} }, {}, { secrets }),
    ).rejects.toThrow(/SecretId/);
  });

  it('propagates an unexpected secret read failure instead of overwriting the key', async () => {
    // Swallowing this would mean generating a SECOND keypair on top of a
    // perfectly good one, silently invalidating every URL in circulation.
    const secrets = {
      get: vi.fn(async () => { throw new Error('AccessDeniedException'); }),
      put: vi.fn(async () => undefined),
    };

    await expect(handler(createEvent('Update'), {}, { secrets })).rejects.toThrow(/AccessDenied/);
    expect(secrets.put).not.toHaveBeenCalled();
  });
});
