/**
 * @fileoverview Plugin manifest loader for frontend.
 * @module plugins
 *
 * Loads and validates plugin manifests at runtime.
 * Manifests are generated at build time from backend plugin definitions.
 */

import rawManifests from './manifests.json'
import {
  safeValidateManifests, type PluginManifest,
} from './types'

// Import raw manifests (generated at build time)
// This will be an empty array if manifests.json doesn't exist

// Validate at runtime
const validatedManifests = safeValidateManifests(rawManifests)
const manifests: PluginManifest[] = validatedManifests ?? []

if (manifests.length === 0 && Array.isArray(rawManifests) && rawManifests.length > 0) {
  console.error('Plugin manifests failed validation. Check manifest format.')
}

/**
 * Get all plugin manifests.
 */
export function getPluginManifests(): PluginManifest[] {
  return manifests
}

/**
 * Get only enabled plugin manifests.
 */
export function getEnabledPlugins(): PluginManifest[] {
  return manifests.filter((m) => m.enabled)
}

/**
 * Get synthetic data generator plugins (category 'synthetic'). On-demand
 * generators configured via GeneratorConfigModal rather than the multi-app
 * plugin config. Shared by TemplateSelector and the Data Sources page.
 */
export function getSyntheticPlugins(): PluginManifest[] {
  return manifests.filter((m) => m.category === 'synthetic')
}

// Types are available directly from './types'
