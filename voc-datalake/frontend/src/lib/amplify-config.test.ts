/**
 * configureAmplify: the user pool only (no identity pool), once per page load, and nothing
 * without a pool (the dev mock and unconfigured builds).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const configure = vi.hoisted(() => vi.fn())
vi.mock('aws-amplify', () => ({ Amplify: { configure } }))

const cognito = vi.hoisted(() => ({ userPoolId: '', clientId: '', region: 'eu-west-1' }))
const realtime = vi.hoisted((): { value: { httpDns: string; realtimeDns: string } | null } => ({ value: null }))
vi.mock('../runtimeConfig', () => ({ getRuntimeConfig: () => ({ cognito }), getRealtimeEndpoints: () => realtime.value }))

/** A fresh module: its once-per-page flag starts unset. */
async function freshConfigure(): Promise<() => void> {
  vi.resetModules()
  return (await import('./amplify-config')).configureAmplify
}

beforeEach(() => {
  configure.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(vi.fn())
  Object.assign(cognito, { userPoolId: 'us-east-1_pool', clientId: 'client' })
  realtime.value = null
})

describe('configureAmplify', () => {
  it('configures the user pool and client, without the identity pool', async () => {
    (await freshConfigure())()

    expect(configure).toHaveBeenCalledWith(
      { Auth: { Cognito: { userPoolId: 'us-east-1_pool', userPoolClientId: 'client', loginWith: { email: true } } } },
      { ssr: false },
    )
  })

  it('adds the Event API (user pool auth) on a deployment that has one (docs/realtime.md)', async () => {
    realtime.value = { httpDns: 'a.appsync-api.eu-west-1.amazonaws.com', realtimeDns: 'a.appsync-realtime-api.eu-west-1.amazonaws.com' }
    ;(await freshConfigure())()

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      API: { Events: { endpoint: 'https://a.appsync-api.eu-west-1.amazonaws.com/event', region: 'eu-west-1', defaultAuthMode: 'userPool' } },
    }), { ssr: false })
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
