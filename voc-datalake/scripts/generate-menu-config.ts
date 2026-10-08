#!/usr/bin/env ts-node
/**
 * Generate frontend menu configuration from cdk.context.json.
 * 
 * This script reads menuStatus from cdk.context.json and generates
 * a menu-config.json file for the frontend.
 * 
 * Run: npx ts-node scripts/generate-menu-config.ts
 */

import * as path from 'path';
import { loadContextFlags, writeJsonFile } from './frontend-config-files';

const outputPath = path.join(__dirname, '../frontend/src/config/menu-config.json');

function main() {
  console.log('Generating menu configuration...');
  console.log(`Output path: ${outputPath}`);

  const menuStatus = loadContextFlags('menuStatus', 'all menu items will be enabled by default');
  console.log(`Menu status loaded: ${Object.keys(menuStatus).length} entries`);

  writeJsonFile(outputPath, menuStatus);

  console.log('✓ Generated menu configuration');
  const items = Object.entries(menuStatus).map(([k, v]) => `${k}:${v}`).join(', ');
  console.log(`  Items: ${items}`);
}

main();
