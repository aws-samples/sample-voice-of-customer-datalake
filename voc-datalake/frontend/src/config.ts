/**
 * @fileoverview Application configuration.
 * 
 * Provides access to runtime configuration loaded from /config.json.
 * For synchronous access, use getRuntimeConfig() after loadRuntimeConfig() completes.
 * 
 * The config is loaded asynchronously at app startup (see main.tsx).
 */

import { getRuntimeConfig, type RuntimeConfig } from './runtimeConfig'

// Re-export for convenience
export type { RuntimeConfig }
export { loadRuntimeConfig, isConfigLoaded } from './runtimeConfig'

/**
 * Gets the current runtime configuration.
 * 
 * @throws Error if config hasn't been loaded yet
 * @returns The runtime configuration object
 */
export function getConfig(): RuntimeConfig {
  return getRuntimeConfig()
}

interface CognitoConfig {
  userPoolId: string
  clientId: string
  region: string
}

interface LegacyConfig {
  readonly apiEndpoint: string
  readonly artifactBuilderEndpoint: string
  readonly cognito: CognitoConfig
}

function getEnvString(key: string, defaultValue = ''): string {
  const value: unknown = import.meta.env[key]
  return typeof value === 'string' ? value : defaultValue
}

/**
 * Legacy config object for backward compatibility.
 * 
 * @deprecated Use getConfig() instead for runtime-loaded config.
 * This getter provides backward compatibility but requires config to be loaded first.
 */
export const config: LegacyConfig = {
  get apiEndpoint(): string {
    try {
      const cfg = getRuntimeConfig()
      return cfg.apiEndpoint
    } catch {
      return getEnvString('VITE_API_ENDPOINT')
    }
  },
  get artifactBuilderEndpoint(): string {
    try {
      const cfg = getRuntimeConfig()
      return cfg.artifactBuilderEndpoint
    } catch {
      return getEnvString('VITE_ARTIFACT_BUILDER_ENDPOINT')
    }
  },
  get cognito(): CognitoConfig {
    try {
      const cfg = getRuntimeConfig()
      return cfg.cognito
    } catch {
      return {
        userPoolId: getEnvString('VITE_COGNITO_USER_POOL_ID'),
        clientId: getEnvString('VITE_COGNITO_CLIENT_ID'),
        region: getEnvString('VITE_COGNITO_REGION', 'us-east-1'),
      }
    }
  },
}
