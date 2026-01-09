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

/**
 * Legacy config object for backward compatibility.
 * 
 * @deprecated Use getConfig() instead for runtime-loaded config.
 * This getter provides backward compatibility but requires config to be loaded first.
 */
export const config = {
  get apiEndpoint(): string {
    try {
      return getRuntimeConfig().apiEndpoint
    } catch {
      return import.meta.env.VITE_API_ENDPOINT || ''
    }
  },
  get artifactBuilderEndpoint(): string {
    try {
      return getRuntimeConfig().artifactBuilderEndpoint
    } catch {
      return import.meta.env.VITE_ARTIFACT_BUILDER_ENDPOINT || ''
    }
  },
  get cognito() {
    try {
      return getRuntimeConfig().cognito
    } catch {
      return {
        userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
        clientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
        region: import.meta.env.VITE_COGNITO_REGION || 'us-east-1',
      }
    }
  },
}
