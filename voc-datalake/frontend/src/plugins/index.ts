/**
 * @fileoverview Plugin manifest loader for frontend.
 * @module plugins
 * 
 * Loads and validates plugin manifests at runtime.
 * Manifests are generated at build time from backend plugin definitions.
 */

import { safeValidateManifests, type PluginManifest } from './types';

// Import raw manifests (generated at build time)
// This will be an empty array if manifests.json doesn't exist
import rawManifests from './manifests.json';

// Validate at runtime
const validatedManifests = safeValidateManifests(rawManifests);
const manifests: PluginManifest[] = validatedManifests ?? [];

if (manifests.length === 0 && Array.isArray(rawManifests) && rawManifests.length > 0) {
  console.error('Plugin manifests failed validation. Check manifest format.');
}

/**
 * Get all plugin manifests.
 */
export function getPluginManifests(): PluginManifest[] {
  return manifests;
}

/**
 * Get a plugin manifest by ID.
 */
export function getPluginById(id: string): PluginManifest | undefined {
  return manifests.find(m => m.id === id);
}

/**
 * Get plugins filtered by category.
 */
export function getPluginsByCategory(category: string): PluginManifest[] {
  return manifests.filter(m => m.category === category);
}

/**
 * Get plugins that have ingestors (polling).
 */
export function getPluginsWithIngestor(): PluginManifest[] {
  return manifests.filter(m => m.hasIngestor);
}

/**
 * Get plugins that have webhooks.
 */
export function getPluginsWithWebhook(): PluginManifest[] {
  return manifests.filter(m => m.hasWebhook);
}

/**
 * Get plugins that have S3 triggers.
 */
export function getPluginsWithS3Trigger(): PluginManifest[] {
  return manifests.filter(m => m.hasS3Trigger);
}

// Re-export types
export type { PluginManifest, ConfigField, WebhookInfo, SetupInfo } from './types';
