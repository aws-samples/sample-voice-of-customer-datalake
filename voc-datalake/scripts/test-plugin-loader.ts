#!/usr/bin/env ts-node
/**
 * Plugin Loader Tests - Run with: npx ts-node scripts/test-plugin-loader.ts
 * 
 * Tests the plugin loader functionality without requiring a test framework.
 */

import * as path from 'path';
import {
  loadPlugins,
  getPluginsWithIngestor,
  getPluginsWithWebhook,
  getPluginsWithS3Trigger,
  getEnabledPlugins,
  aggregateSecrets,
  capitalize,
} from '../lib/plugin-loader';

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
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertArrayLength<T>(arr: T[], length: number, message?: string): void {
  if (arr.length !== length) {
    throw new Error(message || `Expected array length ${length}, got ${arr.length}`);
  }
}

function assertContains<T>(arr: T[], item: T, message?: string): void {
  if (!arr.includes(item)) {
    throw new Error(message || `Expected array to contain ${item}`);
  }
}

function assertHasProperty(obj: object, prop: string, message?: string): void {
  if (!(prop in obj)) {
    throw new Error(message || `Expected object to have property ${prop}`);
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

// Test: loadPlugins
console.log('loadPlugins:');

test('loads all plugin manifests from directory', () => {
  assertArrayLength(plugins, 16, 'Should load 16 plugins');
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

test('trustpilot plugin has correct structure', () => {
  const trustpilot = plugins.find(p => p.id === 'trustpilot');
  if (!trustpilot) throw new Error('Trustpilot plugin not found');
  assertEqual(trustpilot.name, 'Trustpilot');
  assertEqual(trustpilot.infrastructure.ingestor?.enabled, true);
  assertEqual(trustpilot.infrastructure.webhook?.enabled, true);
});

// Test: getPluginsWithIngestor
console.log('\ngetPluginsWithIngestor:');

test('returns plugins with ingestors enabled', () => {
  const ingestorPlugins = getPluginsWithIngestor(plugins);
  // All plugins should have ingestors
  assertArrayLength(ingestorPlugins, 16);
  for (const p of ingestorPlugins) {
    assertEqual(p.infrastructure.ingestor?.enabled, true);
  }
});

// Test: getPluginsWithWebhook
console.log('\ngetPluginsWithWebhook:');

test('returns only plugins with webhooks enabled', () => {
  const webhookPlugins = getPluginsWithWebhook(plugins);
  // Only trustpilot has webhook
  assertArrayLength(webhookPlugins, 1);
  assertEqual(webhookPlugins[0].id, 'trustpilot');
});

// Test: getPluginsWithS3Trigger
console.log('\ngetPluginsWithS3Trigger:');

test('returns only plugins with S3 triggers enabled', () => {
  const s3Plugins = getPluginsWithS3Trigger(plugins);
  // Only s3_import has S3 trigger
  assertArrayLength(s3Plugins, 1);
  assertEqual(s3Plugins[0].id, 's3_import');
});

// Test: getEnabledPlugins
console.log('\ngetEnabledPlugins:');

test('filters plugins by enabled sources list', () => {
  const enabledSources = ['trustpilot', 'yelp', 'twitter'];
  const enabled = getEnabledPlugins(plugins, enabledSources);
  assertArrayLength(enabled, 3);
  assertContains(enabled.map(p => p.id), 'trustpilot');
  assertContains(enabled.map(p => p.id), 'yelp');
  assertContains(enabled.map(p => p.id), 'twitter');
});

test('returns empty array when no sources enabled', () => {
  const enabled = getEnabledPlugins(plugins, []);
  assertArrayLength(enabled, 0);
});

// Test: aggregateSecrets
console.log('\naggregateSecrets:');

test('prefixes secrets with plugin ID', () => {
  const testPlugins = [
    { id: 'test1', secrets: { api_key: '', api_secret: '' } },
    { id: 'test2', secrets: { token: '' } },
  ] as any[];
  
  const secrets = aggregateSecrets(testPlugins);
  assertHasProperty(secrets, 'test1_api_key');
  assertHasProperty(secrets, 'test1_api_secret');
  assertHasProperty(secrets, 'test2_token');
});

test('handles plugins without secrets', () => {
  const testPlugins = [
    { id: 'no_secrets' },
  ] as any[];
  
  const secrets = aggregateSecrets(testPlugins);
  assertEqual(Object.keys(secrets).length, 0);
});

// Test: capitalize
console.log('\ncapitalize:');

test('capitalizes first letter', () => {
  assertEqual(capitalize('trustpilot'), 'Trustpilot');
});

test('converts snake_case to PascalCase', () => {
  assertEqual(capitalize('google_reviews'), 'GoogleReviews');
  assertEqual(capitalize('appstore_apple'), 'AppstoreApple');
});

// Test: Manifest validation
console.log('\nManifest Validation:');

test('all plugins have valid categories', () => {
  const validCategories = ['reviews', 'social', 'appstore', 'import', 'search'];
  for (const plugin of plugins) {
    if (plugin.category && !validCategories.includes(plugin.category)) {
      throw new Error(`Invalid category '${plugin.category}' for plugin ${plugin.id}`);
    }
  }
});

test('all plugins have valid config fields', () => {
  const validTypes = ['text', 'password', 'textarea', 'select'];
  for (const plugin of plugins) {
    for (const field of plugin.config || []) {
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
