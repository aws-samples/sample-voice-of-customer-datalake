/**
 * `signCloudFrontUrl` end to end, with Secrets Manager doubled.
 *
 * The mutation run found that no spec ever reached the secret: the fail-closed
 * cases stopped at the env check, and each asserted only `undefined` — which every
 * failure path returns. So the secret read, its validation, the per-container
 * cache, the expiry arithmetic, the TTL override and every warning an operator
 * greps for were unpinned (51 mutants never executed, 16 survived). These cases
 * pin the signed URL exactly, the SecretId read, and each warning verbatim, since
 * the warning is the only thing telling an operator why avatars vanished.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const hooks = vi.hoisted(() => ({
  send: vi.fn(),
  commands: new Array<unknown>(),
  failSign: { on: false },
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = hooks.send;
  },
  GetSecretValueCommand: class {
    constructor(input: unknown) {
      hooks.commands.push(input);
    }
  },
}));

// A signer that throws something that is not an Error (a value from another realm),
// the one way to reach the `'unknown'` branch of the signing-failure warning.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const { runInNewContext } = await import('node:vm');
  return {
    ...actual,
    createSign: (algorithm: string) => (hooks.failSign.on
      ? { update: () => ({ sign: () => runInNewContext('throw 0') }) }
      : actual.createSign(algorithm)),
  };
});

const KEY_PAIR_ID = 'K2JCJMDEHXQW5F';
const ARN = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:cdn-signing';
const URL_TO_SIGN = 'https://d1.cloudfront.net/avatars/p1/a.png';
/** Date.now() is pinned 0.9 s past this second, so the floor is observable. */
const NOW_SECONDS = 1_700_000_000;
const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const CONFIG_WARNING = 'cloudfront-signing: CDN_SIGNING_SECRET_ARN/CDN_SIGNING_KEY_PAIR_ID not set; '
  + 'refusing to emit an unsigned URL for a private CDN path';
const NO_KEY_WARNING = 'cloudfront-signing: signing secret holds no usable privateKeyPem; avatars will be omitted';

function secretHolding(value: unknown): { SecretString: string } {
  return { SecretString: JSON.stringify(value) };
}

/** The module re-imported after resetModules, so every case starts with an empty PEM cache. */
async function freshModule() {
  return import('./cloudfront-signing.js');
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  hooks.send.mockReset();
  hooks.commands.length = 0;
  hooks.failSign.on = false;
  vi.stubEnv('CDN_SIGNING_SECRET_ARN', ARN);
  vi.stubEnv('CDN_SIGNING_KEY_PAIR_ID', KEY_PAIR_ID);
  vi.stubEnv('CDN_SIGNED_URL_TTL_SECONDS', undefined);
  vi.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000 + 900);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a usable secret signs the URL', () => {
  it('reads the configured secret and signs for an hour from the current second', async () => {
    hooks.send.mockResolvedValue(secretHolding({ privateKeyPem: PEM, publicKeyPem: 'pub' }));
    const { signCloudFrontUrl, signUrlWithKey } = await freshModule();

    await expect(signCloudFrontUrl(URL_TO_SIGN)).resolves.toBe(
      signUrlWithKey(URL_TO_SIGN, PEM, KEY_PAIR_ID, NOW_SECONDS + 3600),
    );
    expect(hooks.commands).toStrictEqual([{ SecretId: ARN }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the secret once per container', async () => {
    hooks.send.mockResolvedValue(secretHolding({ privateKeyPem: PEM }));
    const { signCloudFrontUrl, signUrlWithKey } = await freshModule();

    const first = await signCloudFrontUrl(URL_TO_SIGN);
    const second = await signCloudFrontUrl(URL_TO_SIGN);

    expect([first, second]).toStrictEqual([
      signUrlWithKey(URL_TO_SIGN, PEM, KEY_PAIR_ID, NOW_SECONDS + 3600),
      signUrlWithKey(URL_TO_SIGN, PEM, KEY_PAIR_ID, NOW_SECONDS + 3600),
    ]);
    expect(hooks.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['600', 600],
    ['1', 1],
    ['0', 3600],
    ['-5', 3600],
    ['abc', 3600],
  ])('CDN_SIGNED_URL_TTL_SECONDS=%s signs for %i s', async (raw, ttl) => {
    vi.stubEnv('CDN_SIGNED_URL_TTL_SECONDS', raw);
    hooks.send.mockResolvedValue(secretHolding({ privateKeyPem: PEM }));
    const { signCloudFrontUrl, signUrlWithKey } = await freshModule();

    await expect(signCloudFrontUrl(URL_TO_SIGN)).resolves.toBe(
      signUrlWithKey(URL_TO_SIGN, PEM, KEY_PAIR_ID, NOW_SECONDS + ttl),
    );
  });
});

describe('every refusal returns undefined and names its cause once', () => {
  it.each([
    ['no SecretString', {}, 'cloudfront-signing: signing secret has no SecretString; avatars will be omitted'],
    ['a JSON null', { SecretString: 'null' }, NO_KEY_WARNING],
    ['a key that is not a string', secretHolding({ privateKeyPem: 123 }), NO_KEY_WARNING],
    ['a string that is not a private key', secretHolding({ privateKeyPem: 'random-seed-password' }), NO_KEY_WARNING],
    ['only the public half', secretHolding({ publicKeyPem: 'pub' }), NO_KEY_WARNING],
  ])('a secret with %s', async (_label, secret, warning) => {
    hooks.send.mockResolvedValue(secret);
    const { signCloudFrontUrl } = await freshModule();

    await expect(signCloudFrontUrl(URL_TO_SIGN)).resolves.toBeUndefined();
    expect(warn.mock.calls).toStrictEqual([[warning]]);
  });

  it.each([
    ['an Error, by its name', Object.assign(new Error('denied'), { name: 'AccessDeniedException' }), 'AccessDeniedException'],
    ['anything else, as unknown', 'boom', 'unknown'],
  ])('a failed secret read reports %s', async (_label, failure, shown) => {
    hooks.send.mockRejectedValue(failure);
    const { signCloudFrontUrl } = await freshModule();

    await expect(signCloudFrontUrl(URL_TO_SIGN)).resolves.toBeUndefined();
    expect(warn.mock.calls).toStrictEqual([[
      `cloudfront-signing: could not read the signing secret (${shown}); avatars will be omitted`,
    ]]);
  });

  it('a malformed key fails the signature, named by the error', async () => {
    // Passes the loader's 'PRIVATE KEY' check but is no PEM block, so createSign throws.
    hooks.send.mockResolvedValue(secretHolding({ privateKeyPem: 'PRIVATE KEY without PEM armour' }));
    const { signCloudFrontUrl } = await freshModule();

    await expect(signCloudFrontUrl(URL_TO_SIGN)).resolves.toBeUndefined();
    expect(warn.mock.calls).toStrictEqual([['cloudfront-signing: signing failed (Error); avatar will be omitted']]);
  });

  it('a signer throwing a non-Error is reported as unknown', async () => {
    hooks.failSign.on = true;
    hooks.send.mockResolvedValue(secretHolding({ privateKeyPem: PEM }));
    const { signCloudFrontUrl } = await freshModule();

    await expect(signCloudFrontUrl(URL_TO_SIGN)).resolves.toBeUndefined();
    expect(warn.mock.calls).toStrictEqual([['cloudfront-signing: signing failed (unknown); avatar will be omitted']]);
  });

  // Never a bare URL: /avatars/* requires a signature, and emitting the unsigned
  // form would be handing out an unauthenticated link.
  it.each([
    ['neither variable', undefined, undefined],
    ['only the key pair id', undefined, KEY_PAIR_ID],
    ['only the secret', ARN, undefined],
  ])('signing configured with %s', async (_label, arn, keyPairId) => {
    vi.stubEnv('CDN_SIGNING_SECRET_ARN', arn);
    vi.stubEnv('CDN_SIGNING_KEY_PAIR_ID', keyPairId);
    const { signCloudFrontUrl } = await freshModule();

    await expect(signCloudFrontUrl(URL_TO_SIGN)).resolves.toBeUndefined();
    expect({ warnings: warn.mock.calls, reads: hooks.commands }).toStrictEqual({ warnings: [[CONFIG_WARNING]], reads: [] });
  });

  it('an empty URL, silently and without reading the secret', async () => {
    const { signCloudFrontUrl } = await freshModule();

    await expect(signCloudFrontUrl('')).resolves.toBeUndefined();
    expect({ warnings: warn.mock.calls, reads: hooks.commands }).toStrictEqual({ warnings: [], reads: [] });
  });
});
