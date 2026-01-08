#!/usr/bin/env ts-node
/**
 * Generate integrity hashes for plugin code.
 * 
 * This script computes SHA256 hashes of plugin code and updates
 * the manifest.json files with integrity hashes.
 * 
 * Run: npx ts-node scripts/generate-integrity.ts [plugin-id]
 * 
 * If no plugin-id is provided, generates hashes for all plugins.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateIntegrityHashes } from '../lib/plugin-loader';

const pluginsDir = path.join(__dirname, '../plugins');

function main() {
  const args = process.argv.slice(2);
  const targetPlugin = args[0];

  if (!fs.existsSync(pluginsDir)) {
    console.error(`Plugins directory not found: ${pluginsDir}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  let processed = 0;

  for (const entry of entries) {
    // Skip non-directories and special folders
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;

    // If target plugin specified, only process that one
    if (targetPlugin && entry.name !== targetPlugin) continue;

    const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.warn(`No manifest.json found in plugins/${entry.name}, skipping`);
      continue;
    }

    try {
      generateIntegrityHashes(entry.name, pluginsDir);
      processed++;
    } catch (err) {
      console.error(`Failed to generate integrity for ${entry.name}: ${err}`);
    }
  }

  if (processed === 0) {
    if (targetPlugin) {
      console.error(`Plugin not found: ${targetPlugin}`);
      process.exit(1);
    } else {
      console.warn('No plugins found to process');
    }
  } else {
    console.log(`✓ Generated integrity hashes for ${processed} plugin(s)`);
  }
}

main();
