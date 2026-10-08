#!/usr/bin/env ts-node
/**
 * Plugin Loader Tests - Run with: npx ts-node scripts/test-plugin-loader.ts
 * 
 * Tests the plugin loader functionality without requiring a test framework.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  loadPlugins,
  getPluginsWithIngestor,
  getPluginsWithWebhook,
  getPluginsWithS3Trigger,
  getEnabledPlugins,
  aggregateSecrets,
  capitalize,
  ManifestSchema,
  type PluginManifest,
} from '../lib/plugin-loader';
import { isRecord } from '../lib/test-support/guards';

/** A schema-valid manifest from a partial literal — defaults filled by the schema, no assertion. */
function manifest(fields: Record<string, unknown>): PluginManifest {
  return ManifestSchema.parse({ name: 'Test', icon: 'Synthetic', infrastructure: {}, ...fields });
}

// Simple test utilities
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error instanceof Error ? error.message : error}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${expected}, got ${actual}`);
  }
}

function assertArrayLength<T>(arr: T[], length: number, message?: string): void {
  if (arr.length !== length) {
    throw new Error(message ?? `Expected array length ${length}, got ${arr.length}`);
  }
}

function assertContains<T>(arr: T[], item: T, message?: string): void {
  if (!arr.includes(item)) {
    throw new Error(message ?? `Expected array to contain ${item}`);
  }
}

function assertHasProperty(obj: object, prop: string, message?: string): void {
  if (!(prop in obj)) {
    throw new Error(message ?? `Expected object to have property ${prop}`);
  }
}

// Run tests
console.log('\n🧪 Plugin Loader Tests\n');

const pluginsDir = path.join(__dirname, '..', 'plugins');

console.log('Loading plugins...');
let plugins: ReturnType<typeof loadPlugins>;

try {
  plugins = loadPlugins(pluginsDir);
  console.log(`Loaded ${plugins.length} plugins\n`);
} catch (error) {
  console.error('Failed to load plugins:', error);
  process.exit(1);
}

/**
 * What the plugins/ tree declares, read straight from the manifest JSON rather
 * than through the loader, so the expectations below are an independent oracle
 * that follows plugins being added instead of hard-coding today's count.
 * Underscore folders (_shared, _template) are not plugins.
 */
function declaredManifests(): unknown[] {
  return fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .map(entry => path.join(pluginsDir, entry.name, 'manifest.json'))
    .filter(file => fs.existsSync(file))
    .map((file): unknown => JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Count of declared manifests whose `infrastructure[key].enabled` is true. */
function declaredWith(key: 'ingestor' | 'webhook' | 's3Trigger'): number {
  return declaredManifests().filter(m => {
    const infra = isRecord(m) ? m.infrastructure : undefined;
    const block = isRecord(infra) ? infra[key] : undefined;
    return isRecord(block) && block.enabled === true;
  }).length;
}

// Test: loadPlugins
console.log('loadPlugins:');

test('loads all plugin manifests from directory', () => {
  const declared = declaredManifests().length;
  assertArrayLength(plugins, declared, `Should load every declared plugin (${declared})`);
});

test('each plugin has required fields', () => {
  for (const plugin of plugins) {
    assertHasProperty(plugin, 'id');
    assertHasProperty(plugin, 'name');
    assertHasProperty(plugin, 'icon');
    assertHasProperty(plugin, 'infrastructure');
  }
});

test('plugin IDs are lowercase with underscores', () => {
  for (const plugin of plugins) {
    if (!/^[a-z][a-z0-9_]*$/.test(plugin.id)) {
      throw new Error(`Invalid plugin ID: ${plugin.id}`);
    }
  }
});

test('webscraper plugin has correct structure', () => {
  const webscraper = plugins.find(p => p.id === 'webscraper');
  if (!webscraper) throw new Error('Webscraper plugin not found');
  assertEqual(webscraper.name, 'Web Scraper');
  assertEqual(webscraper.infrastructure.ingestor?.enabled, true);
});

// Test: getPluginsWithIngestor
console.log('\ngetPluginsWithIngestor:');

test('returns plugins with ingestors enabled', () => {
  const ingestorPlugins = getPluginsWithIngestor(plugins);
  assertArrayLength(ingestorPlugins, declaredWith('ingestor'));
  for (const p of ingestorPlugins) {
    assertEqual(p.infrastructure.ingestor?.enabled, true);
  }
});

// Test: getPluginsWithWebhook
console.log('\ngetPluginsWithWebhook:');

test('returns only plugins with webhooks enabled', () => {
  const webhookPlugins = getPluginsWithWebhook(plugins);
  assertArrayLength(webhookPlugins, declaredWith('webhook'));
});

// Test: getPluginsWithS3Trigger
console.log('\ngetPluginsWithS3Trigger:');

test('returns only plugins with S3 triggers enabled', () => {
  const s3Plugins = getPluginsWithS3Trigger(plugins);
  assertArrayLength(s3Plugins, declaredWith('s3Trigger'));
});

// Test: getEnabledPlugins
console.log('\ngetEnabledPlugins:');

test('filters plugins by enabled sources list', () => {
  const enabledSources = ['webscraper'];
  const enabled = getEnabledPlugins(plugins, enabledSources);
  assertArrayLength(enabled, 1);
  assertContains(enabled.map(p => p.id), 'webscraper');
});

test('returns empty array when no sources enabled', () => {
  const enabled = getEnabledPlugins(plugins, []);
  assertArrayLength(enabled, 0);
});

// Test: aggregateSecrets
console.log('\naggregateSecrets:');

test('prefixes secrets with plugin ID', () => {
  const testPlugins = [
    manifest({ id: 'test1', secrets: { api_key: '', api_secret: '' } }),
    manifest({ id: 'test2', secrets: { token: '' } }),
  ];
  
  const secrets = aggregateSecrets(testPlugins);
  assertHasProperty(secrets, 'test1_api_key');
  assertHasProperty(secrets, 'test1_api_secret');
  assertHasProperty(secrets, 'test2_token');
});

test('handles plugins without secrets', () => {
  const testPlugins = [
    manifest({ id: 'no_secrets' }),
  ];
  
  const secrets = aggregateSecrets(testPlugins);
  assertEqual(Object.keys(secrets).length, 0);
});

// Test: capitalize
console.log('\ncapitalize:');

test('capitalizes first letter', () => {
  assertEqual(capitalize('webscraper'), 'Webscraper');
});

test('converts snake_case to PascalCase', () => {
  assertEqual(capitalize('custom_source'), 'CustomSource');
  assertEqual(capitalize('my_plugin'), 'MyPlugin');
});

// Test: Manifest validation
console.log('\nManifest Validation:');

test('all plugins have valid categories', () => {
  // The schema's own enum, so this list cannot drift from what loadPlugins accepts.
  const validCategories: string[] = ManifestSchema.shape.category.unwrap().options;
  for (const plugin of plugins) {
    if (plugin.category && !validCategories.includes(plugin.category)) {
      throw new Error(`Invalid category '${plugin.category}' for plugin ${plugin.id}`);
    }
  }
});

test('all plugins have valid config fields', () => {
  const validTypes = ['text', 'password', 'textarea', 'select'];
  for (const plugin of plugins) {
    for (const field of plugin.config) {
      if (!validTypes.includes(field.type)) {
        throw new Error(`Invalid config type '${field.type}' in plugin ${plugin.id}`);
      }
    }
  }
});

test('webhook paths start with /', () => {
  for (const plugin of plugins) {
    if (plugin.infrastructure.webhook?.enabled) {
      const webhookPath = plugin.infrastructure.webhook.path;
      if (!webhookPath.startsWith('/')) {
        throw new Error(`Webhook path must start with / in plugin ${plugin.id}`);
      }
    }
  }
});

test('schedule expressions are valid', () => {
  const schedulePattern = /^rate\(\d+\s+(minute|minutes|hour|hours|day|days)\)$|^cron\([0-9,\-\*\/\s]+\)$/;
  for (const plugin of plugins) {
    const schedule = plugin.infrastructure.ingestor?.schedule;
    if (schedule && !schedulePattern.test(schedule)) {
      throw new Error(`Invalid schedule '${schedule}' in plugin ${plugin.id}`);
    }
  }
});

// Summary
console.log('\n' + '='.repeat(50));
console.log(`\n✅ Passed: ${passed}`);
if (failed > 0) {
  console.log(`❌ Failed: ${failed}`);
  process.exit(1);
} else {
  console.log('\n🎉 All tests passed!\n');
}
