/**
 * @fileoverview Runtime configuration loader.
 * 
 * Fetches configuration from /config.json at runtime, allowing the same
 * build artifact to work across multiple environments (dev, staging, prod).
 * 
 * The config.json is deployed by CDK with environment-specific values.
 * Falls back to VITE_* environment variables for local development.
 */

import { z } from 'zod'
import { getEnvString } from './lib/env'

// URL regex pattern for validation (replaces deprecated z.string().url())
const urlPattern = /^https?:\/\/.+/

const BoardConfigSchema = z.object({
  userPoolId: z.string().min(1),
  clientId: z.string().min(1),
  /**
   * How the pool emails its sign-in codes (lib/stacks/core-board-auth.ts): `email_otp` (SES, with
   * `-c emailFrom`) or `code` (Cognito's own email: sign-up confirmation / password-reset codes).
   * Absent (a config written before 5.45.00, always an SES deployment) = `email_otp`.
   */
  signIn: z.enum(['email_otp', 'code']).catch('email_otp').default('email_otp'),
})

type BoardSignInMode = 'email_otp' | 'code'

/** The board pool's ids plus the region every pool of the deployment lives in. */
export interface BoardPoolConfig {
  readonly userPoolId: string
  readonly clientId: string
  readonly region: string
  readonly signIn?: BoardSignInMode
}

// Schema for runtime configuration
const RuntimeConfigSchema = z.object({
  apiEndpoint: z.string().regex(urlPattern, 'Invalid URL format'),
  cognito: z.object({
    userPoolId: z.string().min(1),
    clientId: z.string().min(1),
    region: z.string().min(1),
    identityPoolId: z.string().min(1),
  }),
  // Optional capability flags: deployments without a given capability omit
  // the flag (or the whole block) and the UI hides the feature.
  features: z.object({
    webSearch: z.boolean().optional(),
    /** Participant email sending is configured (`-c emailFrom`); the UI explains it is off otherwise. */
    email: z.boolean().optional(),
    /** The app user pool allows passkey sign-in (5.58); older deployments omit it and the UI offers none. */
    passkey: z.boolean().optional(),
  }).optional(),
  /**
   * The feature-request board's own Cognito user pool (docs/feature-requests.md), present only when
   * the deployment created it. Lenient: a malformed block reads as "no board" rather than throwing
   * away the whole config (which would blank the app's own sign-in).
   */
  board: BoardConfigSchema.optional().catch(undefined),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

// Singleton state using a mutable container (const reference, mutable contents)
const configState: { config: RuntimeConfig | null; promise: Promise<RuntimeConfig> | null } = {
  config: null,
  promise: null,
}

/**
 * Fetches runtime configuration from /config.json.
 * Returns cached config if already loaded.
 * Falls back to environment variables if fetch fails.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  // Return cached config if available
  if (configState.config) {
    return configState.config
  }

  // Return existing promise if loading is in progress
  if (configState.promise) {
    return configState.promise
  }

  configState.promise = fetchConfig()
  configState.config = await configState.promise
  return configState.config
}

/**
 * Gets the runtime config synchronously.
 * Throws if config hasn't been loaded yet.
 */
export function getRuntimeConfig(): RuntimeConfig {
  if (!configState.config) {
    throw new Error('Runtime config not loaded. Call loadRuntimeConfig() first.')
  }
  return configState.config
}

/**
 * Checks if runtime config has been loaded.
 */
export function isConfigLoaded(): boolean {
  return configState.config !== null
}

/**
 * Whether this deployment has the AgentCore web search gateway, i.e. the
 * chat/research "search the web" options should be offered at all.
 * Safe to call before config load (returns false).
 */
export function isWebSearchAvailable(): boolean {
  return configState.config?.features?.webSearch === true
}

/**
 * Whether the app user pool takes passkeys (`features.passkey`, set by every deployment since 5.58).
 * Says nothing about the browser: services/passkey.ts `passkeySupported()` checks that.
 * Safe to call before config load (returns false).
 */
export function isPasskeyAvailable(): boolean {
  const config = configState.config
  return config?.features?.passkey === true && config.cognito.clientId !== ''
}

/**
 * The board user pool, or null when the deployment has none (or the config is
 * not loaded yet). The region is the app pool's: both pools live in the stack's region.
 */
export function getBoardPoolConfig(): BoardPoolConfig | null {
  const board = configState.config?.board
  if (!board) return null
  return { ...board, region: configState.config?.cognito.region ?? 'us-east-1' }
}

async function fetchConfig(): Promise<RuntimeConfig> {
  try {
    const response = await fetch('/config.json', {
      cache: 'no-store', // Always fetch fresh config
    })

    if (!response.ok) {
      console.warn(`Failed to fetch /config.json (${response.status}), using env vars`)
      return getEnvConfig()
    }

    const data: unknown = await response.json()
    const parsed = RuntimeConfigSchema.safeParse(data)

    if (!parsed.success) {
      console.warn('Invalid config.json format, using env vars:', parsed.error.message)
      return getEnvConfig()
    }

    return parsed.data
  } catch (error) {
    console.warn('Error fetching config.json, using env vars:', error)
    return getEnvConfig()
  }
}

/**
 * Fallback: Get config from VITE_* environment variables.
 * Used for local development or when config.json is unavailable.
 */
function getEnvConfig(): RuntimeConfig {
  // Constructed as a literal boolean (=== 'true'), so this object is
  // schema-conformant BY CONSTRUCTION — which is what lets the invalid-env
  // fallback below reuse it verbatim. Single construction site on purpose.
  const features = {
    // Local development: VITE_ENABLE_WEB_SEARCH=true surfaces the web search
    // toggles without a deployed config.json.
    webSearch: getEnvString('VITE_ENABLE_WEB_SEARCH') === 'true',
  }
  const envConfig = {
    apiEndpoint: getEnvString('VITE_API_ENDPOINT'),
    cognito: {
      userPoolId: getEnvString('VITE_COGNITO_USER_POOL_ID'),
      clientId: getEnvString('VITE_COGNITO_CLIENT_ID'),
      region: getEnvString('VITE_COGNITO_REGION', 'us-east-1'),
      identityPoolId: getEnvString('VITE_IDENTITY_POOL_ID'),
    },
    features,
  }

  // Validate env config
  const parsed = RuntimeConfigSchema.safeParse(envConfig)
  if (!parsed.success) {
    console.error('Invalid environment config:', parsed.error.message)
    // Partial env config is normal in local development (Cognito vars are
    // usually absent). Keep a valid VITE_API_ENDPOINT instead of discarding
    // it; otherwise point at the documented local mock port (`npm run mock`
    // serves http://localhost:3001, which the Vite /api proxy also targets).
    const fallbackEndpoint = urlPattern.test(envConfig.apiEndpoint)
      ? envConfig.apiEndpoint
      : 'http://localhost:3001'
    return {
      apiEndpoint: fallbackEndpoint,
      cognito: {
        userPoolId: '',
        clientId: '',
        region: 'us-east-1',
        identityPoolId: '',
      },
      // Keep the feature flags: mock-only dev (no Cognito vars) is exactly
      // when this branch runs, and it's also exactly when the
      // VITE_ENABLE_WEB_SEARCH escape hatch is needed. Safe to reuse: the
      // shared `features` object above is boolean-by-construction.
      features,
    }
  }

  return parsed.data
}
