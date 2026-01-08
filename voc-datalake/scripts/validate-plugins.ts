#!/usr/bin/env ts-node
/**
 * Validate all plugin manifests.
 * 
 * This script loads and validates all plugins, checking:
 * - Manifest schema validity
 * - Folder name matches manifest ID
 * - Infrastructure limits
 * - Optionally: code integrity
 * 
 * Run: npx ts-node scripts/validate-plugins.ts [--verify-integrity]
 */

import * as path from 'path';
import { loadPlugins } from '../lib/plugin-loader';

const pluginsDir = path.join(__dirname, '../plugins');

function main() {
  const args = process.argv.slice(2);
  const verifyIntegrity = args.includes('--verify-integrity');

  console.log('Validating plugins...');
  console.log(`Plugins directory: ${pluginsDir}`);
  if (verifyIntegrity) {
    console.log('Integrity verification: ENABLED');
  }

  try {
    const plugins = loadPlugins(pluginsDir, { verifyIntegrity });

    console.log('\n✓ All plugins valid!\n');
    console.log('Summary:');
    console.log(`  Total plugins: ${plugins.length}`);
    console.log(`  With ingestor: ${plugins.filter(p => p.infrastructure.ingestor?.enabled).length}`);
    console.log(`  With webhook: ${plugins.filter(p => p.infrastructure.webhook?.enabled).length}`);
    console.log(`  With S3 trigger: ${plugins.filter(p => p.infrastructure.s3Trigger?.enabled).length}`);

    console.log('\nPlugins:');
    for (const plugin of plugins) {
      const features = [];
      if (plugin.infrastructure.ingestor?.enabled) features.push('ingestor');
      if (plugin.infrastructure.webhook?.enabled) features.push('webhook');
      if (plugin.infrastructure.s3Trigger?.enabled) features.push('s3');
      
      console.log(`  ${plugin.icon} ${plugin.name} (${plugin.id}) - ${features.join(', ') || 'no features'}`);
    }

  } catch (err) {
    console.error('\n✗ Validation failed!\n');
    console.error(err);
    process.exit(1);
  }
}

main();
