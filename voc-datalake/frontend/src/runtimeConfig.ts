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
import { ConfigError } from './lib/errors'

// URL regex pattern for validation (replaces deprecated z.string().url())
const urlPattern = /^https?:\/\/.+/

// Schema for runtime configuration
const RuntimeConfigSchema = z.object({
  apiEndpoint: z.string().regex(urlPattern, 'Invalid URL format'),
  cognito: z.object({
    userPoolId: z.string().min(1),
    clientId: z.string().min(1),
    region: z.string().min(1),
    identityPoolId: z.string().min(1),
  }),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

// Singleton state using a mutable container (const reference, mutable contents)
const configState: {
  config: RuntimeConfig | null;
  promise: Promise<RuntimeConfig> | null
} = {
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
    return await configState.promise
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
    throw new ConfigError('Runtime config not loaded. Call loadRuntimeConfig() first.')
  }
  return configState.config
}

/**
 * Checks if runtime config has been loaded.
 */
export function isConfigLoaded(): boolean {
  return configState.config !== null
}

async function fetchConfig(): Promise<RuntimeConfig> {
  try {
    const response = await fetch('/config.json', {
      /** Always fetch fresh config */
      cache: 'no-store',
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

    console.log('Loaded runtime config from /config.json')
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
  const envConfig = {
    apiEndpoint: getEnvString('VITE_API_ENDPOINT'),
    cognito: {
      userPoolId: getEnvString('VITE_COGNITO_USER_POOL_ID'),
      clientId: getEnvString('VITE_COGNITO_CLIENT_ID'),
      region: getEnvString('VITE_COGNITO_REGION', 'us-east-1'),
      identityPoolId: getEnvString('VITE_IDENTITY_POOL_ID'),
    },
  }

  // Validate env config
  const parsed = RuntimeConfigSchema.safeParse(envConfig)
  if (!parsed.success) {
    console.error('Invalid environment config:', parsed.error.message)
    // Return a minimal config to prevent crashes
    return {
      apiEndpoint: 'http://localhost:3000',
      cognito: {
        userPoolId: '',
        clientId: '',
        region: 'us-east-1',
        identityPoolId: '',
      },
    }
  }

  return parsed.data
}
