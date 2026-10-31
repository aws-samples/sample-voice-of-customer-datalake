/**
 * configureAmplify: the user pool only (no identity pool), once per page load, and nothing
 * without a pool (the dev mock and unconfigured builds).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const configure = vi.hoisted(() => vi.fn())
vi.mock('aws-amplify', () => ({ Amplify: { configure } }))

const cognito = vi.hoisted(() => ({ userPoolId: '', clientId: '', identityPoolId: 'us-east-1:pool' }))
vi.mock('../runtimeConfig', () => ({ getRuntimeConfig: () => ({ cognito }) }))

/** A fresh module: its once-per-page flag starts unset. */
async function freshConfigure(): Promise<() => void> {
  vi.resetModules()
  return (await import('./amplify-config')).configureAmplify
}

beforeEach(() => {
  configure.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(vi.fn())
  Object.assign(cognito, { userPoolId: 'us-east-1_pool', clientId: 'client' })
})

describe('configureAmplify', () => {
  it('configures the user pool and client, without the identity pool', async () => {
    (await freshConfigure())()

    expect(configure).toHaveBeenCalledWith(
      { Auth: { Cognito: { userPoolId: 'us-east-1_pool', userPoolClientId: 'client', loginWith: { email: true } } } },
      { ssr: false },
    )
  })

  it('configures once per page load', async () => {
    const configureAmplify = await freshConfigure()

    configureAmplify()
    configureAmplify()

    expect(configure).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no user pool', { userPoolId: '' }],
    ['no client id', { clientId: '' }],
  ])('does nothing with %s, and configures once the config arrives', async (_label, missing) => {
    const configureAmplify = await freshConfigure()
    Object.assign(cognito, missing)

    configureAmplify()
    expect(configure).not.toHaveBeenCalled()

    Object.assign(cognito, { userPoolId: 'us-east-1_pool', clientId: 'client' })
    configureAmplify()
    expect(configure).toHaveBeenCalledTimes(1)
  })
})
