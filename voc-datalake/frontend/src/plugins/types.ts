/**
 * @fileoverview Plugin manifest types for frontend.
 * @module plugins/types
 * 
 * These types mirror the backend manifest schema but only include
 * UI-relevant fields. Runtime validation ensures type safety.
 */

import { z } from 'zod';

// ============================================
// Zod Schemas for Runtime Validation
// ============================================

export const ConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'password', 'textarea', 'select']),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  secret: z.boolean().optional(),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })).optional(),
});

export const WebhookInfoSchema = z.object({
  name: z.string(),
  events: z.array(z.string()),
  docUrl: z.string().optional(),
});

export const SetupSchema = z.object({
  title: z.string(),
  color: z.enum(['blue', 'orange', 'green', 'gray']).optional(),
  steps: z.array(z.string()),
});

export const PluginManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string().optional(),
  category: z.enum(['reviews', 'social', 'import', 'search', 'scraper']).optional(),
  config: z.array(ConfigFieldSchema),
  webhooks: z.array(WebhookInfoSchema).optional(),
  setup: SetupSchema.optional(),
  hasIngestor: z.boolean(),
  hasWebhook: z.boolean(),
  hasS3Trigger: z.boolean(),
  version: z.string().optional(),
  enabled: z.boolean(),
});

export const PluginManifestsSchema = z.array(PluginManifestSchema);

// ============================================
// TypeScript Types (inferred from Zod)
// ============================================

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type ConfigField = z.infer<typeof ConfigFieldSchema>;
export type WebhookInfo = z.infer<typeof WebhookInfoSchema>;
export type SetupInfo = z.infer<typeof SetupSchema>;

// ============================================
// Type Guards
// ============================================

export function isPluginManifest(value: unknown): value is PluginManifest {
  return PluginManifestSchema.safeParse(value).success;
}

export function isPluginManifestArray(value: unknown): value is PluginManifest[] {
  return PluginManifestsSchema.safeParse(value).success;
}

// ============================================
// Validation Functions
// ============================================

/**
 * Validate and parse plugin manifests at runtime.
 * Throws if validation fails.
 */
export function validateManifests(data: unknown): PluginManifest[] {
  return PluginManifestsSchema.parse(data);
}

/**
 * Safely validate manifests, returning null on failure.
 */
export function safeValidateManifests(data: unknown): PluginManifest[] | null {
  const result = PluginManifestsSchema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  console.error('Plugin manifest validation failed:', result.error);
  return null;
}
