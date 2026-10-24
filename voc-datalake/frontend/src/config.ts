/**
 * @fileoverview Application configuration.
 * 
 * Provides access to runtime configuration loaded from /config.json.
 * For synchronous access, use getRuntimeConfig() after loadRuntimeConfig() (both in
 * ./runtimeConfig) completes.
 * 
 * The config is loaded asynchronously at app startup (see main.tsx).
 */

import { getRuntimeConfig, type RuntimeConfig } from './runtimeConfig'

/**
 * Gets the current runtime configuration.
 * 
 * @throws Error if config hasn't been loaded yet
 * @returns The runtime configuration object
 */
export function getConfig(): RuntimeConfig {
  return getRuntimeConfig()
}
