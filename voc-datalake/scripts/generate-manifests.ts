#!/usr/bin/env ts-node
/**
 * Generate frontend manifests from plugin manifests.
 * 
 * This script scans the plugins/ directory, extracts UI-relevant fields,
 * and generates a manifests.json file for the frontend.
 * 
 * Run: npx ts-node scripts/generate-manifests.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadPlugins } from '../lib/plugin-loader';

const pluginsDir = path.join(__dirname, '../plugins');
const outputPath = path.join(__dirname, '../frontend/src/plugins/manifests.json');

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
}

function main() {
  console.log('Generating frontend manifests...');
  console.log(`Plugins directory: ${pluginsDir}`);
  console.log(`Output path: ${outputPath}`);

  // Load and validate plugins
  const plugins = loadPlugins(pluginsDir);

  // Extract only UI-relevant fields
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
