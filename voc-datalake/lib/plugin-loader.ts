/**
 * Plugin Loader - Discovers and validates plugin manifests.
 * 
 * This module scans the plugins/ directory, validates manifests using Zod,
 * and provides helper functions for CDK stacks to create plugin resources.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { z } from 'zod';

// ============================================
// Zod Schema for Manifest Validation
// ============================================

// Strict ID pattern - only lowercase alphanumeric and underscores
const PluginIdSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, 'ID must start with letter, contain only lowercase alphanumeric and underscores');

// Safe path pattern - no traversal
const SafePathSchema = z.string()
  .max(128)
  .regex(/^\/[a-z0-9\-_\/]*$/, 'Path must start with / and contain only safe characters')
  .refine(p => !p.includes('..'), 'Path traversal not allowed')
  .refine(p => !p.includes('//'), 'Double slashes not allowed');

// Safe string - no control characters or dangerous patterns
const SafeStringSchema = z.string()
  .max(256)
  .refine(s => !/[\x00-\x1f\x7f]/.test(s), 'Control characters not allowed')
  .refine(s => !/<script|javascript:|data:/i.test(s), 'Potentially dangerous content');

// Icon - only emoji or safe SVG path
const IconSchema = z.string()
  .max(64);

// Schedule expression - only safe EventBridge patterns
const ScheduleSchema = z.string()
  .regex(
    /^rate\(\d+\s+(minute|minutes|hour|hours|day|days)\)$|^cron\([0-9,\-\*\/\s]+\)$/,
    'Invalid schedule expression'
  );

// Config key - safe identifier
const ConfigKeySchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Config key must be safe identifier');

const ConfigFieldSchema = z.object({
  key: ConfigKeySchema,
  label: SafeStringSchema,
  type: z.enum(['text', 'password', 'textarea', 'select']),
  required: z.boolean().optional().default(false),
  placeholder: SafeStringSchema.optional(),
  secret: z.boolean().optional().default(false),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })).optional(),
});

const WebhookInfoSchema = z.object({
  name: SafeStringSchema,
  events: z.array(SafeStringSchema).max(10),
  docUrl: z.string().url().max(256).optional(),
});

const SetupSchema = z.object({
  title: SafeStringSchema,
  color: z.enum(['blue', 'orange', 'green', 'gray']).optional().default('blue'),
  steps: z.array(SafeStringSchema).max(15),
});

const IngestorInfraSchema = z.object({
  enabled: z.boolean(),
  schedule: ScheduleSchema.optional(),
  timeout: z.number().int().min(1).max(300).default(120),
  memory: z.number().int().min(128).max(1024).default(256),
});

const WebhookInfraSchema = z.object({
  enabled: z.boolean(),
  path: SafePathSchema,
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE'])).max(4).default(['POST']),
  signatureHeader: z.string().max(64).regex(/^[A-Za-z0-9\-]+$/).optional(),
  signatureMethod: z.string().max(32).regex(/^[a-z_]+$/).optional(),
});

const S3TriggerSchema = z.object({
  enabled: z.boolean(),
  suffixes: z.array(z.string().regex(/^\.[a-z0-9]+$/).max(10)).max(5),
});

const InfrastructureSchema = z.object({
  ingestor: IngestorInfraSchema.optional(),
  webhook: WebhookInfraSchema.optional(),
  s3Trigger: S3TriggerSchema.optional(),
});

const IntegritySchema = z.object({
  ingestor: z.string().regex(/^sha256-[a-f0-9]+$/).optional(),
  webhook: z.string().regex(/^sha256-[a-f0-9]+$/).optional(),
});

const SecretsSchema = z.record(ConfigKeySchema, z.string());

const ManifestSchema = z.object({
  id: PluginIdSchema,
  name: SafeStringSchema,
  icon: IconSchema,
  description: SafeStringSchema.optional(),
  category: z.enum(['reviews', 'social', 'import', 'search', 'scraper']).optional(),
  infrastructure: InfrastructureSchema,
  config: z.array(ConfigFieldSchema).max(20).default([]),
  webhooks: z.array(WebhookInfoSchema).max(5).optional(),
  setup: SetupSchema.optional(),
  secrets: SecretsSchema.optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must be semver').optional(),
  minPlatformVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  integrity: IntegritySchema.optional(),
});

// ============================================
// TypeScript Types
// ============================================

export type PluginManifest = z.infer<typeof ManifestSchema>;
export type ConfigField = z.infer<typeof ConfigFieldSchema>;
export type WebhookInfo = z.infer<typeof WebhookInfoSchema>;
export type SetupInfo = z.infer<typeof SetupSchema>;
export type IngestorInfra = z.infer<typeof IngestorInfraSchema>;
export type WebhookInfra = z.infer<typeof WebhookInfraSchema>;
export type Infrastructure = z.infer<typeof InfrastructureSchema>;

// ============================================
// Plugin Discovery
// ============================================

export interface LoadPluginsOptions {
  verifyIntegrity?: boolean;
}

export function loadPlugins(pluginsDir: string, options: LoadPluginsOptions = {}): PluginManifest[] {
  const plugins: PluginManifest[] = [];
  const errors: string[] = [];

  if (!fs.existsSync(pluginsDir)) {
    console.warn(`Plugins directory not found: ${pluginsDir}`);
    return plugins;
  }

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip non-directories and special folders
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;

    const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      console.warn(`No manifest.json found in plugins/${entry.name}, skipping`);
      continue;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const parsed = ManifestSchema.parse(raw);

      // Validate folder name matches manifest ID
      if (parsed.id !== entry.name) {
        errors.push(`Plugin folder '${entry.name}' does not match manifest id '${parsed.id}'`);
        continue;
      }

      // Validate infrastructure limits
      validateManifestLimits(parsed);

      // Optionally verify code integrity
      if (options.verifyIntegrity) {
        verifyPluginIntegrity(parsed, pluginsDir);
      }

      plugins.push(parsed);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const zodErrors = err.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        errors.push(`Invalid manifest in plugins/${entry.name}: ${zodErrors.join(', ')}`);
      } else {
        errors.push(`Failed to load plugins/${entry.name}: ${err}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Plugin loading errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    throw new Error(`Failed to load ${errors.length} plugin(s)`);
  }

  console.log(`Loaded ${plugins.length} plugins: ${plugins.map(p => p.id).join(', ')}`);
  return plugins;
}

function validateManifestLimits(manifest: PluginManifest): void {
  const infra = manifest.infrastructure;

  if (infra.ingestor) {
    if (infra.ingestor.timeout > 300) {
      throw new Error(`Plugin ${manifest.id}: timeout cannot exceed 300 seconds`);
    }
    if (infra.ingestor.memory > 1024) {
      throw new Error(`Plugin ${manifest.id}: memory cannot exceed 1024 MB`);
    }
    if (infra.ingestor.schedule) {
      const schedule = infra.ingestor.schedule;
      if (schedule.includes('rate(') && schedule.includes('second')) {
        throw new Error(`Plugin ${manifest.id}: schedule cannot be more frequent than 1 minute`);
      }
    }
  }
}

// ============================================
// Code Integrity Verification
// ============================================

function computeDirectoryHash(dirPath: string): string {
  const files: string[] = [];

  function collectFiles(dir: string) {
    if (!fs.existsSync(dir)) return;
    
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('__')) {
        collectFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        files.push(fullPath);
      }
    }
  }

  collectFiles(dirPath);
  files.sort();

  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const content = fs.readFileSync(file);
    hash.update(content);
  }

  return 'sha256-' + hash.digest('hex');
}

function verifyPluginIntegrity(plugin: PluginManifest, pluginsDir: string): void {
  const pluginDir = path.join(pluginsDir, plugin.id);

  // Verify ingestor code
  if (plugin.infrastructure.ingestor?.enabled) {
    const ingestorDir = path.join(pluginDir, 'ingestor');
    if (fs.existsSync(ingestorDir)) {
      const actualHash = computeDirectoryHash(ingestorDir);
      const expectedHash = plugin.integrity?.ingestor;

      if (expectedHash && actualHash !== expectedHash) {
        throw new Error(
          `Plugin ${plugin.id}: ingestor code integrity check failed.\n` +
          `Expected: ${expectedHash}\n` +
          `Actual: ${actualHash}`
        );
      }
    }
  }

  // Verify webhook code
  if (plugin.infrastructure.webhook?.enabled) {
    const webhookDir = path.join(pluginDir, 'webhook');
    if (fs.existsSync(webhookDir)) {
      const actualHash = computeDirectoryHash(webhookDir);
      const expectedHash = plugin.integrity?.webhook;

      if (expectedHash && actualHash !== expectedHash) {
        throw new Error(
          `Plugin ${plugin.id}: webhook code integrity check failed.\n` +
          `Expected: ${expectedHash}\n` +
          `Actual: ${actualHash}`
        );
      }
    }
  }
}

// ============================================
// Helper Functions
// ============================================

export function getEnabledPlugins(
  plugins: PluginManifest[],
  enabledSources: string[]
): PluginManifest[] {
  return plugins.filter(p => enabledSources.includes(p.id));
}

export function aggregateSecrets(plugins: PluginManifest[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const plugin of plugins) {
    if (plugin.secrets) {
      // Prefix secrets with plugin ID for isolation
      for (const [key, value] of Object.entries(plugin.secrets)) {
        secrets[`${plugin.id}_${key}`] = value;
      }
    }
  }
  return secrets;
}

export function getPluginsWithIngestor(plugins: PluginManifest[]): PluginManifest[] {
  return plugins.filter(p => p.infrastructure.ingestor?.enabled);
}

export function getPluginsWithWebhook(plugins: PluginManifest[]): PluginManifest[] {
  return plugins.filter(p => p.infrastructure.webhook?.enabled);
}

export function getPluginsWithS3Trigger(plugins: PluginManifest[]): PluginManifest[] {
  return plugins.filter(p => p.infrastructure.s3Trigger?.enabled);
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// ============================================
// Integrity Hash Generation (for scripts)
// ============================================

export function generateIntegrityHashes(pluginId: string, pluginsDir: string): void {
  const pluginDir = path.join(pluginsDir, pluginId);
  const manifestPath = path.join(pluginDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  manifest.integrity = manifest.integrity || {};

  const ingestorDir = path.join(pluginDir, 'ingestor');
  if (fs.existsSync(ingestorDir)) {
    manifest.integrity.ingestor = computeDirectoryHash(ingestorDir);
  }

  const webhookDir = path.join(pluginDir, 'webhook');
  if (fs.existsSync(webhookDir)) {
    manifest.integrity.webhook = computeDirectoryHash(webhookDir);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Updated integrity hashes for ${pluginId}`);
}
