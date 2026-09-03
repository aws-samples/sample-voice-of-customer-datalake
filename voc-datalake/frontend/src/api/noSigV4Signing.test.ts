/**
 * No request this app makes is signed with Identity Pool credentials.
 *
 * `core-stack.ts` removed the authenticated role's `lambda:InvokeFunction` /
 * `InvokeFunctionUrl` grant (#254). That is safe only if nothing in the client
 * SigV4-signs a Lambda Function URL with the credentials that role provides —
 * otherwise the removal is a runtime 403 in the browser, which no typecheck or
 * CDK assertion would catch, and the failure would surface as "chat is broken"
 * rather than as anything pointing at an IAM change.
 *
 * The claim is therefore pinned here rather than argued in a review reply.
 * `amplify-config.ts` still says the credential exchange exists "for AWS IAM
 * request signing" and logs "Amplify configured for IAM signing", so the code
 * reads as if something signs; these cases are what say otherwise, and what would
 * fail if a future change made it true again.
 *
 * Every authenticated request goes through `getAuthHeaders`, which attaches the
 * Cognito ID token as a bearer `Authorization` header to a trusted origin — a
 * User Pool authorizer on API Gateway, not IAM auth. `streamClient` is included
 * deliberately: it is the surface the removed grant would have affected, and its
 * headers come from that same function.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// Literal paths relative to the frontend package root, which is where vitest runs
// — matching `streamLimits.lockstep.test.ts` next door. The security lint rule
// forbids a computed `readFileSync` argument, and `import.meta.url` is not a
// `file:` URL under this config.
const STREAM_CLIENT = readFileSync('src/api/streamClient.ts', 'utf8')
const AUTH_SERVICE = readFileSync('src/services/auth.ts', 'utf8')
const PACKAGE_MANIFEST = readFileSync('package.json', 'utf8')

describe('the client never signs a request with Identity Pool credentials', () => {
  it('reaches the chat stream with a bearer token, not a signed request', () => {
    // The surface the removed grant would have broken. `getAuthHeaders` is the
    // whole auth story for it, and that function attaches `Authorization: <idToken>`.
    expect(STREAM_CLIENT).toContain('getAuthHeaders')
    for (const signer of ['SignatureV4', 'signRequest', 'aws4', 'fetchAuthSession']) {
      expect(STREAM_CLIENT, `streamClient must not reference ${signer}`)
        .not.toContain(signer)
    }
  })

  it('declares no SigV4 signing dependency at all', () => {
    // A signer would have to come from somewhere. `@aws-sdk/signature-v4`,
    // `@aws-crypto/sha256-js` and `aws4fetch` are the usual ways this is reached;
    // none is a dependency, so a future signing path cannot be added without also
    // touching package.json — a far more visible edit than an import.
    const manifest: unknown = JSON.parse(PACKAGE_MANIFEST)
    const declared = Object.keys({
      ...(manifest as { dependencies?: Record<string, string> }).dependencies,
      ...(manifest as { devDependencies?: Record<string, string> }).devDependencies,
    })

    // The control: the read found a real manifest, so an empty list cannot pass this.
    expect(declared).toContain('aws-amplify')
    for (const signer of [
      '@aws-sdk/signature-v4', '@aws-crypto/sha256-js', 'aws4fetch', 'aws4',
    ]) {
      expect(declared, `no signing dependency: ${signer}`).not.toContain(signer)
    }
  })

  it('uses the Amplify credential exchange for nothing', () => {
    // `authService.syncAmplifySession` is the only thing that fetches Identity Pool
    // credentials, and it has no callers — the exchange is vestigial. Asserted so
    // that wiring it back up has to come with a decision about the removed grant,
    // rather than quietly depending on a permission that no longer exists.
    expect(AUTH_SERVICE, 'the exchange still exists, so this case is not vacuous')
      .toContain('fetchAuthSession')
    // Its ONLY appearances are the import and the one call inside
    // `syncAmplifySession` itself.
    expect(AUTH_SERVICE.match(/fetchAuthSession/g)).toHaveLength(2)
  })
})
