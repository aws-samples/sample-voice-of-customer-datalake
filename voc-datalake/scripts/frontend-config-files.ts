/**
 * Shared by the two generators that turn cdk.context.json flags into frontend
 * JSON files (generate-manifests.ts, generate-menu-config.ts): reading a
 * `Record<string, boolean>` flag map out of the context, and writing the result
 * where Vite picks it up.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const cdkContextPath = path.join(__dirname, '../cdk.context.json');

const FlagMapSchema = z.record(z.string(), z.boolean());

/**
 * The `key` map from cdk.context.json, or `{}` with a warning ending in
 * `fallbackNote` when the file is missing, unreadable, or the key is not a
 * boolean map.
 */
export function loadContextFlags(key: string, fallbackNote: string): Record<string, boolean> {
  try {
    if (!fs.existsSync(cdkContextPath)) {
      console.warn(`cdk.context.json not found, ${fallbackNote}`);
      return {};
    }
    const context = JSON.parse(fs.readFileSync(cdkContextPath, 'utf-8'));
    const result = FlagMapSchema.safeParse(context[key]);
    if (!result.success) {
      console.warn(`Invalid ${key} in cdk.context.json, ${fallbackNote}`);
      return {};
    }
    return result.data;
  } catch (err) {
    console.warn(`Failed to load cdk.context.json: ${err}`);
    return {};
  }
}

/** Write `value` as pretty-printed JSON, creating the parent directory first. */
export function writeJsonFile(outputPath: string, value: unknown): void {
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(value, null, 2));
}
