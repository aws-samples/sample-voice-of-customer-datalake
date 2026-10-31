/**
 * A scripted Cognito user-pool endpoint for services that call it with plain `fetch`
 * (services/cognitoIdp.ts: the board sign-in and the app's passkeys).
 */
import { vi } from 'vitest'
import { parsedJson } from './jsonText'

export interface Answer { readonly status: number; readonly body: unknown }
export type Script = Partial<Record<string, Answer | Answer[]>>

/** An unsigned JWT the library can decode; `exp` an hour after `nowMs`. */
export function fakeJwt(claims: Record<string, unknown>, nowMs: number): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_')
  return `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(nowMs / 1000) + 3600, iat: Math.floor(nowMs / 1000), ...claims })}.sig`
}

export function refusal(type: string, message = ''): Answer {
  return { status: 400, body: { __type: type, message } }
}

function payloadOf(init: RequestInit | undefined): Record<string, unknown> {
  const payload: unknown = parsedJson(init?.body)
  return typeof payload === 'object' && payload !== null ? Object.fromEntries(Object.entries(payload)) : {}
}

/** The scripted answer for one call; an unscripted target answers 500. */
function nextAnswer(entry: Answer | Answer[] | undefined): Answer {
  const answer = Array.isArray(entry) ? entry.shift() : entry
  return answer ?? { status: 500, body: {} }
}

/** A Cognito double answering each target from `script` (an array answers one per call). */
export function scriptedCognito(script: Script) {
  const calls: Array<{ target: string; payload: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const target = (new Headers(init?.headers).get('X-Amz-Target') ?? '').replace('AWSCognitoIdentityProviderService.', '')
    calls.push({ target, payload: payloadOf(init) })
    const answer = nextAnswer(script[target])
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }))
  })
  return { calls, fetchImpl }
}

export const targetsOf = (calls: ReadonlyArray<{ target: string }>) => calls.map((call) => call.target)
