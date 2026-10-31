/**
 * Passkey registration and sign-in against a scripted Cognito and a stubbed WebAuthn browser API
 * (jsdom has none): the calls made, what the browser is given, and how each failure is named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PasskeyError, createPasskeyClient, passkeySupported } from './passkey'
import { refusal, scriptedCognito, targetsOf } from '@test/scriptedCognito'
import type { Script } from '@test/scriptedCognito'

const CREDENTIAL_JSON = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} }

/** A stand-in for the browser's PublicKeyCredential: the static JSON parsers echo their input. */
class FakePublicKeyCredential {
  static readonly parseCreationOptionsFromJSON = vi.fn((options: unknown) => ({ parsed: 'creation', options }))
  static readonly parseRequestOptionsFromJSON = vi.fn((options: unknown) => ({ parsed: 'request', options }))
  toJSON() { return CREDENTIAL_JSON }
}

const CREATION_OPTIONS = {
  challenge: 'Y2hhbGxlbmdl',
  rp: { id: 'app.example.com', name: 'VoC' },
  user: { id: 'dXNlcg', name: 'dana', displayName: 'Dana' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
}
const REQUEST_OPTIONS = { challenge: 'c2lnbg', rpId: 'app.example.com' }
const TOKENS = { AuthenticationResult: { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh' } }
const WEB_AUTHN_CHALLENGE = {
  status: 200,
  body: {
    ChallengeName: 'WEB_AUTHN',
    Session: 'auth-session',
    ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(REQUEST_OPTIONS), USERNAME: 'dana-uuid' },
  },
}

function setup(script: Script, browser: { create?: () => Promise<unknown>; get?: () => Promise<unknown> } = {}) {
  const cognito = scriptedCognito(script)
  const credentials = {
    create: vi.fn(browser.create ?? (() => Promise.resolve(new FakePublicKeyCredential()))),
    get: vi.fn(browser.get ?? (() => Promise.resolve(new FakePublicKeyCredential()))),
  }
  const client = createPasskeyClient({ region: 'us-east-1', clientId: 'webclient', fetchImpl: cognito.fetchImpl, credentials })
  return { client, credentials, ...cognito }
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error: unknown) {
    return error instanceof PasskeyError ? error.code : 'not-a-passkey-error'
  }
  return 'resolved'
}

beforeEach(() => {
  vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A navigator with a credentials container (jsdom's has none). */
const stubCredentialsContainer = () => vi.stubGlobal('navigator', { credentials: { create: vi.fn(), get: vi.fn() } })

describe('passkeySupported', () => {
  it('is true when the browser has a credentials container and the WebAuthn JSON helpers', () => {
    stubCredentialsContainer()
    expect(passkeySupported()).toBe(true)
  })

  it('is false without a credentials container (jsdom), without PublicKeyCredential, or with an older one', () => {
    expect(passkeySupported()).toBe(false)
    stubCredentialsContainer()
    vi.stubGlobal('PublicKeyCredential', undefined)
    expect(passkeySupported()).toBe(false)
    vi.stubGlobal('PublicKeyCredential', class {})
    expect(passkeySupported()).toBe(false)
  })
})

describe('register', () => {
  it('starts with the access token, hands the options to the browser, and completes with its credential', async () => {
    const { client, calls, credentials } = setup({
      StartWebAuthnRegistration: { status: 200, body: { CredentialCreationOptions: CREATION_OPTIONS } },
      CompleteWebAuthnRegistration: { status: 200, body: {} },
    })
    await client.register('access-token')
    expect(targetsOf(calls)).toStrictEqual(['StartWebAuthnRegistration', 'CompleteWebAuthnRegistration'])
    expect(credentials.create).toHaveBeenCalledExactlyOnceWith({ publicKey: { parsed: 'creation', options: CREATION_OPTIONS } })
    expect(calls.map((call) => call.payload)).toStrictEqual([
      { AccessToken: 'access-token' },
      { AccessToken: 'access-token', Credential: CREDENTIAL_JSON },
    ])
  })

  it('names a closed or timed-out browser prompt as cancelled, and registers nothing', async () => {
    const { client, calls } = setup(
      { StartWebAuthnRegistration: { status: 200, body: { CredentialCreationOptions: CREATION_OPTIONS } } },
      { create: () => Promise.reject(new DOMException('closed', 'NotAllowedError')) },
    )
    await expect(failureOf(client.register('access-token'))).resolves.toBe('cancelled')
    expect(targetsOf(calls)).toStrictEqual(['StartWebAuthnRegistration'])
  })

  it.each([
    ['a Cognito refusal', { StartWebAuthnRegistration: refusal('WebAuthnNotEnabledException') }],
    ['options of the wrong shape', { StartWebAuthnRegistration: { status: 200, body: { CredentialCreationOptions: { challenge: '' } } } }],
  ])('reports %s as unknown', async (_label, script: Script) => {
    await expect(failureOf(setup(script).client.register('access-token'))).resolves.toBe('unknown')
  })

  it('refuses before any call in a browser without passkeys', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined)
    const { client, calls } = setup({})
    await expect(failureOf(client.register('access-token'))).resolves.toBe('unsupported')
    expect(calls).toStrictEqual([])
  })
})

describe('signIn', () => {
  it('prefers WEB_AUTHN, signs the challenge, and answers with the username Cognito named', async () => {
    const { client, calls, credentials } = setup({ InitiateAuth: WEB_AUTHN_CHALLENGE, RespondToAuthChallenge: { status: 200, body: TOKENS } })
    await expect(client.signIn('dana@example.com')).resolves.toStrictEqual(TOKENS.AuthenticationResult)
    expect(credentials.get).toHaveBeenCalledExactlyOnceWith({ publicKey: { parsed: 'request', options: REQUEST_OPTIONS } })
    expect(calls.map((call) => call.payload)).toStrictEqual([
      { AuthFlow: 'USER_AUTH', ClientId: 'webclient', AuthParameters: { USERNAME: 'dana@example.com', PREFERRED_CHALLENGE: 'WEB_AUTHN' } },
      {
        ChallengeName: 'WEB_AUTHN',
        ClientId: 'webclient',
        Session: 'auth-session',
        ChallengeResponses: { USERNAME: 'dana-uuid', CREDENTIAL: JSON.stringify(CREDENTIAL_JSON) },
      },
    ])
  })

  it.each([
    ['another challenge (the account has no passkey)', { InitiateAuth: { status: 200, body: { ChallengeName: 'SELECT_CHALLENGE', Session: 's', AvailableChallenges: ['PASSWORD'] } } }],
    ['an unknown user (preventUserExistenceErrors answers NotAuthorized)', { InitiateAuth: refusal('NotAuthorizedException') }],
  ])('reports %s as no_passkey', async (_label, script: Script) => {
    await expect(failureOf(setup(script).client.signIn('dana@example.com'))).resolves.toBe('no_passkey')
  })

  it('reports a refused answer to the challenge as unknown, never as a sign-in', async () => {
    const { client } = setup({ InitiateAuth: WEB_AUTHN_CHALLENGE, RespondToAuthChallenge: refusal('NotAuthorizedException') })
    await expect(failureOf(client.signIn('dana@example.com'))).resolves.toBe('unknown')
  })

  it('reports request options that are not JSON as unknown, before asking the browser', async () => {
    const broken = { status: 200, body: { ...WEB_AUTHN_CHALLENGE.body, ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: 'not json' } } }
    const { client, credentials } = setup({ InitiateAuth: broken })
    await expect(failureOf(client.signIn('dana@example.com'))).resolves.toBe('unknown')
    expect(credentials.get).not.toHaveBeenCalled()
  })
})

describe('hasPasskey', () => {
  it.each([
    [[{ CredentialId: 'c1' }], true],
    [[], false],
  ])('answers from ListWebAuthnCredentials (%j -> %s)', async (credentialsList, expected) => {
    const { client, calls } = setup({ ListWebAuthnCredentials: { status: 200, body: { Credentials: credentialsList } } })
    await expect(client.hasPasskey('access-token')).resolves.toBe(expected)
    expect(calls[0]?.payload).toStrictEqual({ AccessToken: 'access-token', MaxResults: 1 })
  })
})
