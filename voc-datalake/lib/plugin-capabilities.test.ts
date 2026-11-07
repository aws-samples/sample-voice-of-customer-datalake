/**
 * Plugin capabilities (TENETS.md tenet 5): what the platform does differently for a source is
 * declared in that plugin's manifest.json, never keyed on its id in platform code.
 *
 *   - `capabilities.updatesItems` → the processor's UPDATE_CAPABLE_SOURCES (lambda/shared/source_updates.py)
 *   - `infrastructure.ingestor.selfInvoke` → the ingestor's own-function invoke grant (ingestion-stack.ts)
 *   - `infrastructure.webhook.memory` → the webhook receiver's MemorySize (api-stack.ts)
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WEBHOOK_MEMORY_MB, ManifestSchema, loadPlugins, pluginIdsWithCapability, type PluginManifest,
} from './plugin-loader';
import { synthProcessingTemplate } from './test-support/processing-stack-fixture';
import { UPDATE_CAPABLE_SOURCES_ENV } from './stacks/processing-stack-consolidated';
import { byCodeUnit } from './utils/compare';

const PLUGINS = loadPlugins(path.join(__dirname, '../plugins'));
const BASE = { id: 'example_source', name: 'Example', icon: 'x', infrastructure: {} };

const manifest = (extra: Record<string, unknown>): PluginManifest => ManifestSchema.parse({ ...BASE, ...extra });

describe('manifest capabilities schema', () => {
  it('defaults every capability to off', () => {
    const parsed = manifest({
      capabilities: {},
      infrastructure: { ingestor: { enabled: true }, webhook: { enabled: true, path: '/webhooks/example_source' } },
    });
    expect(parsed.capabilities?.updatesItems).toBe(false);
    expect(parsed.infrastructure.ingestor?.selfInvoke).toBe(false);
    expect(parsed.infrastructure.ingestor?.jobNotices).toBe(false);
    expect(parsed.infrastructure.webhook?.memory).toBe(DEFAULT_WEBHOOK_MEMORY_MB);
  });

  it('refuses a misspelt capability instead of ignoring it', () => {
    expect(ManifestSchema.safeParse({ ...BASE, capabilities: { updateItems: true } }).success).toBe(false);
  });

  it.each([127, 1025, 300.5])('refuses webhook memory %s', (memory) => {
    const parsed = ManifestSchema.safeParse({
      ...BASE, infrastructure: { webhook: { enabled: true, path: '/webhooks/example_source', memory } },
    });
    expect(parsed.success).toBe(false);
  });

  it('lists the declaring plugins sorted, whatever their order on disk', () => {
    const plugins = [
      manifest({ id: 'zeta', capabilities: { updatesItems: true } }),
      manifest({ id: 'alpha', capabilities: { updatesItems: true } }),
      manifest({ id: 'mid' }),
      manifest({ id: 'off', capabilities: { updatesItems: false } }),
    ];
    expect(pluginIdsWithCapability(plugins, 'updatesItems')).toStrictEqual(['alpha', 'zeta']);
  });
});

describe('the committed manifests keep what each plugin did before 6.04.00', () => {
  it('only github_issues refreshes stored items in place', () => {
    expect(pluginIdsWithCapability(PLUGINS, 'updatesItems')).toStrictEqual(['github_issues']);
  });

  it('only the two app-review ingestors continue themselves', () => {
    expect(PLUGINS.filter((p) => p.infrastructure.ingestor?.selfInvoke).map((p) => p.id).sort(byCodeUnit))
      .toStrictEqual(['app_reviews_android', 'app_reviews_ios']);
  });

  it('only the s3_import ingestor sends job-end notices (its API-started reprocess runs, docs/realtime.md)', () => {
    expect(PLUGINS.filter((p) => p.infrastructure.ingestor?.jobNotices).map((p) => p.id)).toStrictEqual(['s3_import']);
  });

  it('the github_issues webhook keeps 512 MB, every other webhook the default', () => {
    const memory = Object.fromEntries(PLUGINS.filter((p) => p.infrastructure.webhook?.enabled)
      .map((p) => [p.id, p.infrastructure.webhook?.memory]));
    expect(memory).toStrictEqual({ github_issues: 512 });
  });
});

describe('the processor reads the update-capable sources from the manifests', () => {
  it(`renders ${UPDATE_CAPABLE_SOURCES_ENV} on the feedback processor`, () => {
    const functions = synthProcessingTemplate().findResources('AWS::Lambda::Function', {
      Properties: { Environment: { Variables: { POWERTOOLS_SERVICE_NAME: 'voc-processor' } } },
    });
    const variables = Object.values(functions).map((fn: unknown) => JSON.stringify(fn));
    expect(variables).toHaveLength(1);
    expect(variables[0]).toContain(`"${UPDATE_CAPABLE_SOURCES_ENV}":"[\\"github_issues\\"]"`);
  });
});
