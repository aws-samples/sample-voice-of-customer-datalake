#!/usr/bin/env ts-node
/**
 * Generate frontend menu configuration from cdk.context.json.
 * 
 * This script reads menuStatus from cdk.context.json and generates
 * a menu-config.json file for the frontend.
 * 
 * Run: npx ts-node scripts/generate-menu-config.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const outputPath = path.join(__dirname, '../frontend/src/config/menu-config.json');
const cdkContextPath = path.join(__dirname, '../cdk.context.json');

// Schema for menuStatus in cdk.context.json
const MenuStatusSchema = z.record(z.string(), z.boolean());

function loadMenuStatus(): Record<string, boolean> {
  try {
    if (!fs.existsSync(cdkContextPath)) {
      console.warn('cdk.context.json not found, all menu items will be enabled by default');
      return {};
    }
    const context = JSON.parse(fs.readFileSync(cdkContextPath, 'utf-8'));
    const result = MenuStatusSchema.safeParse(context.menuStatus);
    if (!result.success) {
      console.warn('Invalid menuStatus in cdk.context.json, all menu items will be enabled by default');
      return {};
    }
    return result.data;
  } catch (err) {
    console.warn(`Failed to load cdk.context.json: ${err}`);
    return {};
  }
}

function main() {
  console.log('Generating menu configuration...');
  console.log(`Output path: ${outputPath}`);

  const menuStatus = loadMenuStatus();
  console.log(`Menu status loaded: ${Object.keys(menuStatus).length} entries`);

  // Ensure directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write menu config
  fs.writeFileSync(outputPath, JSON.stringify(menuStatus, null, 2));

  console.log('✓ Generated menu configuration');
  console.log(`  Items: ${Object.entries(menuStatus).map(([k, v]) => `${k}:${v}`).join(', ')}`);
}

main();
