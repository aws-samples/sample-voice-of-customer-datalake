/**
 * The `connector-version` every raw object records (lambda/shared/raw_versions.py): a plugin's
 * manifest version (env `PLUGIN_VERSION`) or, for an API-side writer, the platform release
 * (env `APP_VERSION`).
 *
 * The platform release (the repo-root package.json `version`, kept equal to the other two by
 * scripts/check-version.mjs), read at synth. API-side raw writers record it as the
 * `connector-version` of every raw object they write (lambda/shared/raw_versions.py, env
 * `APP_VERSION`). Same source as the SPA's Settings → System → version (frontend/vite.config.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const RootPackageSchema = z.object({ version: z.string().min(1) });

/** The repo-root package.json (lib/utils → lib → voc-datalake → the repo root). */
const ROOT_PACKAGE_JSON = join(__dirname, '..', '..', '..', 'package.json');

export function appVersion(packageJsonPath: string = ROOT_PACKAGE_JSON): string {
  return RootPackageSchema.parse(JSON.parse(readFileSync(packageJsonPath, 'utf-8'))).version;
}

/** The version a plugin Lambda records (`PLUGIN_VERSION`): its manifest `version`, `unversioned` when it has none. */
export function pluginVersion(plugin: { readonly version?: string }): string {
  return plugin.version ?? 'unversioned';
}
