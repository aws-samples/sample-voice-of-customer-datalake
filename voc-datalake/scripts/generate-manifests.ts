#!/usr/bin/env ts-node
/**
 * Generate frontend manifests from plugin manifests.
 * 
 * This script scans the plugins/ directory, extracts UI-relevant fields,
 * and generates a manifests.json file for the frontend.
 * 
 * It also reads pluginStatus from cdk.context.json to set the enabled flag.
 * 
 * Run: npx ts-node scripts/generate-manifests.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { loadPlugins } from '../lib/plugin-loader';

const pluginsDir = path.join(__dirname, '../plugins');
const outputPath = path.join(__dirname, '../frontend/src/plugins/manifests.json');
const cdkContextPath = path.join(__dirname, '../cdk.context.json');

// Schema for pluginStatus in cdk.context.json
const PluginStatusSchema = z.record(z.string(), z.boolean());

function loadPluginStatus(): Record<string, boolean> {
  try {
    if (!fs.existsSync(cdkContextPath)) {
      console.warn('cdk.context.json not found, all plugins will be disabled by default');
      return {};
    }
    const context = JSON.parse(fs.readFileSync(cdkContextPath, 'utf-8'));
    const result = PluginStatusSchema.safeParse(context.pluginStatus);
    if (!result.success) {
      console.warn('Invalid pluginStatus in cdk.context.json, all plugins will be disabled by default');
      return {};
    }
    return result.data;
  } catch (err) {
    console.warn(`Failed to load cdk.context.json: ${err}`);
    return {};
  }
}

interface FrontendManifest {
  id: string;
  name: string;
  icon: string;
  description?: string;
  category?: string;
  config: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    placeholder?: string;
    secret?: boolean;
    options?: Array<{ value: string; label: string }>;
  }>;
  webhooks?: Array<{
    name: string;
    events: string[];
    docUrl?: string;
  }>;
  setup?: {
    title: string;
    color?: string;
    steps: string[];
  };
  hasIngestor: boolean;
  hasWebhook: boolean;
  hasS3Trigger: boolean;
  version?: string;
  enabled: boolean;
}

function main() {
  console.log('Generating frontend manifests...');
  console.log(`Plugins directory: ${pluginsDir}`);
  console.log(`Output path: ${outputPath}`);

  // Load plugin status from cdk.context.json
  const pluginStatus = loadPluginStatus();
  console.log(`Plugin status loaded: ${Object.keys(pluginStatus).length} entries`);

  // Load and validate plugins
  const plugins = loadPlugins(pluginsDir);

  // Extract only UI-relevant fields and add enabled status
  const frontendManifests: FrontendManifest[] = plugins.map(plugin => ({
    id: plugin.id,
    name: plugin.name,
    icon: plugin.icon,
    description: plugin.description,
    category: plugin.category,
    config: plugin.config,
    webhooks: plugin.webhooks,
    setup: plugin.setup,
    hasIngestor: !!plugin.infrastructure.ingestor?.enabled,
    hasWebhook: !!plugin.infrastructure.webhook?.enabled,
    hasS3Trigger: !!plugin.infrastructure.s3Trigger?.enabled,
    version: plugin.version,
    enabled: pluginStatus[plugin.id] ?? false,
  }));

  // Ensure directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write manifests
  fs.writeFileSync(outputPath, JSON.stringify(frontendManifests, null, 2));

  console.log(`✓ Generated ${frontendManifests.length} plugin manifests`);
  console.log(`  Plugins: ${frontendManifests.map(m => m.id).join(', ')}`);
}

main();
