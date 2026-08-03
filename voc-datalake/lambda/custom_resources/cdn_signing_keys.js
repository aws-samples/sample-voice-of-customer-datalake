'use strict';
/**
 * Custom resource: mint the RSA keypair that signs CloudFront URLs for the
 * private `/avatars/*` and `/prototypes/*` cache behaviors (issue #229).
 *
 * WHY A CUSTOM RESOURCE AT ALL
 * CloudFront needs the PUBLIC key at CloudFormation time, and the PRIVATE key
 * must never appear in the template, in `cdk diff`, or in stack events. Two
 * non-options ruled that out:
 *   - generating the keypair at SYNTH time would make every synth produce a
 *     different template, which `core-stack.test.ts` asserts against on
 *     purpose ("synthesizes deterministically — no per-synth password churn").
 *   - a KMS asymmetric key cannot sign for CloudFront: `kms:Sign` offers only
 *     the SHA-256/384/512 RSA variants, and CloudFront requires RSA-SHA1.
 *
 * SO: this handler generates the keypair at DEPLOY time, writes the private
 * half straight to Secrets Manager (never through CloudFormation), and returns
 * only the public half. CDK feeds that into `cloudfront.PublicKey` +
 * `cloudfront.KeyGroup`, so CloudFormation still owns those two resources and
 * their create/update/delete ordering — this handler owns nothing but the key
 * material.
 *
 * Node, not Python: `crypto.generateKeyPairSync` is stdlib, so the handler
 * inlines with zero dependencies. The Python runtime has no RSA keygen without
 * `cryptography`, which would have meant bundling a layer into CoreStack.
 *
 * IDEMPOTENT BY CONSTRUCTION. Rotating the key would invalidate every URL
 * already handed to a browser, and CloudFormation calls this on every stack
 * update. So an existing keypair is REUSED and the same public key returned;
 * only an unpopulated secret triggers generation.
 */
const crypto = require('crypto');

/**
 * Stable across every update: a changing physical id makes CloudFormation
 * DELETE the previous resource, which here would orphan the CloudFront public
 * key while the distribution still referenced it.
 */
const PHYSICAL_RESOURCE_ID = 'voc-cdn-signing-keys';

/** CloudFront requires 2048-bit RSA for signing keys. */
const MODULUS_LENGTH = 2048;

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: MODULUS_LENGTH,
    // spki/pem gives the `-----BEGIN PUBLIC KEY-----` envelope CloudFront
    // wants; pkcs8 is read by both Python's `cryptography` and Node's
    // `crypto.createSign`, the two signers that consume this.
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Pull a previously minted keypair out of a raw secret string.
 *
 * Returns null when there is nothing usable, which covers the first deploy:
 * CDK seeds the secret with a random password so the resource can exist before
 * this handler runs, so "secret has a value" does NOT mean "key present".
 * Both halves must be there — a secret holding only the public key cannot
 * sign, and silently returning it would produce URLs that 403.
 */
function readKeyMaterial(secretString) {
  if (!secretString) return null;
  let parsed;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { publicKeyPem, privateKeyPem } = parsed;
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) return null;
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY')) return null;
  return { publicKeyPem, privateKeyPem };
}

function defaultSecretsClient() {
  // Required lazily so importing this module in a unit test never needs the
  // AWS SDK, and so the SDK bundled with the Node runtime is used at runtime.
  const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } =
    require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  return {
    async get(secretId) {
      try {
        const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
        return out.SecretString;
      } catch (error) {
        // A brand-new secret with no version yet is an expected state, not a
        // failure. Anything else is real and must not be swallowed, or we
        // would generate a SECOND keypair over a perfectly good one.
        if (error?.name === 'ResourceNotFoundException') return undefined;
        throw error;
      }
    },
    async put(secretId, secretString) {
      await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: secretString }));
    },
  };
}

/**
 * The actual logic, with its collaborators injected so tests need no AWS SDK.
 *
 * Kept SEPARATE from `exports.handler` because of a sharp edge in the Node 24
 * Lambda runtime: it infers the handler style from the function's ARITY, so a
 * three-parameter handler is taken for the legacy `(event, context, callback)`
 * signature — support for which Node 24 removed. An exported handler that took
 * `deps` as a third parameter therefore failed at runtime init with
 * "AWS Lambda has removed support for callback-based function handlers",
 * before any of this code ran.
 *
 * @param {object} event CloudFormation custom resource event.
 * @param {object} [deps] Injection seam for tests.
 */
async function onEvent(event, deps) {
  const requestType = event.RequestType;
  const secretId = event.ResourceProperties?.SecretId;

  // Nothing to undo: the secret and both CloudFront resources are
  // CloudFormation-owned and are removed by their own delete paths.
  if (requestType === 'Delete') {
    return { PhysicalResourceId: PHYSICAL_RESOURCE_ID };
  }

  if (!secretId) {
    throw new Error('SecretId resource property is required');
  }

  const secrets = deps?.secrets ?? defaultSecretsClient();

  const existing = readKeyMaterial(await secrets.get(secretId));
  if (existing) {
    return {
      PhysicalResourceId: PHYSICAL_RESOURCE_ID,
      Data: { PublicKeyPem: existing.publicKeyPem },
    };
  }

  const created = (deps?.generateKeyPair ?? generateKeyPair)();
  // Store BOTH halves. The public half is not a secret, but keeping it beside
  // the private one is what makes the reuse check above possible without
  // calling CloudFront to read the key back.
  await secrets.put(secretId, JSON.stringify(created));

  return {
    PhysicalResourceId: PHYSICAL_RESOURCE_ID,
    Data: { PublicKeyPem: created.publicKeyPem },
  };
}

/**
 * CloudFormation entry point. ONE parameter on purpose — see onEvent above for
 * why arity matters on the Node 24 runtime.
 */
exports.handler = async (event) => onEvent(event);

exports.onEvent = onEvent;
exports.generateKeyPair = generateKeyPair;
exports.readKeyMaterial = readKeyMaterial;
exports.PHYSICAL_RESOURCE_ID = PHYSICAL_RESOURCE_ID;
