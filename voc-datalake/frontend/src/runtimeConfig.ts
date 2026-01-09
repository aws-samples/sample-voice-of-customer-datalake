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

// Schema for runtime configuration
const RuntimeConfigSchema = z.object({
  apiEndpoint: z.string().url(),
  // artifactBuilderEndpoint is optional - empty string or valid URL
  artifactBuilderEndpoint: z.union([
    z.literal(''),
    z.string().url(),
  ]).default(''),
  cognito: z.object({
    userPoolId: z.string().min(1),
    clientId: z.string().min(1),
    region: z.string().min(1),
  }),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

// Singleton state
let runtimeConfig: RuntimeConfig | null = null
let configPromise: Promise<RuntimeConfig> | null = null

/**
 * Fetches runtime configuration from /config.json.
 * Returns cached config if already loaded.
 * Falls back to environment variables if fetch fails.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  // Return cached config if available
  if (runtimeConfig) {
    return runtimeConfig
  }

  // Return existing promise if loading is in progress
  if (configPromise) {
    return configPromise
  }

  configPromise = fetchConfig()
  runtimeConfig = await configPromise
  return runtimeConfig
}

/**
 * Gets the runtime config synchronously.
 * Throws if config hasn't been loaded yet.
 */
export function getRuntimeConfig(): RuntimeConfig {
  if (!runtimeConfig) {
    throw new Error('Runtime config not loaded. Call loadRuntimeConfig() first.')
  }
  return runtimeConfig
}

/**
 * Checks if runtime config has been loaded.
 */
export function isConfigLoaded(): boolean {
  return runtimeConfig !== null
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
    apiEndpoint: import.meta.env.VITE_API_ENDPOINT || '',
    artifactBuilderEndpoint: import.meta.env.VITE_ARTIFACT_BUILDER_ENDPOINT || '',
    cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
      clientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
      region: import.meta.env.VITE_COGNITO_REGION || 'us-east-1',
    },
  }

  // Validate env config
  const parsed = RuntimeConfigSchema.safeParse(envConfig)
  if (!parsed.success) {
    console.error('Invalid environment config:', parsed.error.message)
    // Return a minimal config to prevent crashes
    return {
      apiEndpoint: 'http://localhost:3000',
      artifactBuilderEndpoint: '',
      cognito: {
        userPoolId: '',
        clientId: '',
        region: 'us-east-1',
      },
    }
  }

  return parsed.data
}
