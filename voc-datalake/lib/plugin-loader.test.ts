/**
 * Tests for plugin-loader.ts - Plugin discovery and validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

import type { PluginManifest } from './plugin-loader';
import { byCodeUnit } from './utils/compare';
import { itemAt, valueAt } from './test-support/guards';

// Mock fs module
vi.mock('fs');

const mockFs = vi.mocked(fs);

/**
 * `fs.readdirSync` narrowed to the one overload plugin-loader calls
 * (`withFileTypes: true`). Assigning the overloaded function to this signature
 * selects that overload without an assertion; `mockReturnValue` on the full
 * overload set would otherwise demand the LAST overload's Buffer-named Dirents.
 */
type ReaddirWithFileTypes = (path: fs.PathLike, options: { withFileTypes: true }) => fs.Dirent[];
const readdirWithFileTypes: ReaddirWithFileTypes = fs.readdirSync;
const mockReaddir = vi.mocked(readdirWithFileTypes);

// Helper to create mock Dirent objects
function createMockDirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    path: '',
    parentPath: '',
  };
}

// Helper to mock readdirSync return value
function mockDirents(...names: string[]) {
  return names.map(name => createMockDirent(name, true));
}

/**
 * Typed manifests for the helper-function tests, parsed through the real
 * schema (so defaults are filled exactly as loadPlugins fills them) instead of
 * asserting a partial literal into `PluginManifest[]`.
 */
async function manifestOf(raw: Record<string, unknown>): Promise<PluginManifest> {
  const { ManifestSchema } = await import('./plugin-loader');
  return ManifestSchema.parse({ name: 'Test', icon: 'Synthetic', infrastructure: {}, ...raw });
}

async function manifests(...raw: Record<string, unknown>[]): Promise<PluginManifest[]> {
  return Promise.all(raw.map(manifestOf));
}

const PLUGINS_DIR = '/test/plugins';

/** The smallest manifest the schema accepts: an enabled ingestor and nothing else. */
function minimalManifest(id: string, name: string, icon: string): Record<string, unknown> {
  return { id, name, icon, infrastructure: { ingestor: { enabled: true } } };
}

/** One plugin folder whose manifest.json is `manifest`; every path exists. */
function mockSinglePlugin(folder: string, manifest: Record<string, unknown>): void {
  mockFs.existsSync.mockReturnValue(true);
  mockReaddir.mockReturnValue(mockDirents(folder));
  mockFs.readFileSync.mockReturnValue(JSON.stringify(manifest));
}

/** A fresh import of the loader (the module is reset after each case), run on the mocked tree. */
async function loadTestPlugins(): Promise<ReturnType<typeof import('./plugin-loader').loadPlugins>> {
  const { loadPlugins } = await import('./plugin-loader');
  return loadPlugins(PLUGINS_DIR);
}

/** Every per-plugin and cross-plugin failure is collected, then reported as one aggregate error. */
const AGGREGATE_LOAD_ERROR = /^Failed to load \d+ plugin\(s\)$/;

/** The mocked tree must be refused by the loader. */
async function expectLoadRejected(): Promise<void> {
  const { loadPlugins } = await import('./plugin-loader');
  expect(() => loadPlugins(PLUGINS_DIR)).toThrow(AGGREGATE_LOAD_ERROR);
}

describe('Plugin Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('loadPlugins', () => {
    it('returns empty array when plugins directory does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const { loadPlugins } = await import('./plugin-loader');
      const result = loadPlugins('/nonexistent/plugins');

      expect(result).toStrictEqual([]);
    });

    it('loads valid plugin manifests from directory', async () => {
      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr.endsWith('plugins')) return true;
        if (pathStr.endsWith('manifest.json')) return true;
        return false;
      });

      mockReaddir.mockReturnValue(mockDirents('webscraper'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'webscraper',
        name: 'Web Scraper',
        icon: 'Web',
        description: 'Web scraping plugin',
        infrastructure: {
          ingestor: { enabled: true, schedule: 'rate(5 minutes)', timeout: 120, memory: 256 },
        },
        config: [],
      }));

      const result = await loadTestPlugins();

      expect(result).toHaveLength(1);
      expect(itemAt(result, 0).id).toBe('webscraper');
      expect(itemAt(result, 0).name).toBe('Web Scraper');
    });

    it('skips directories starting with underscore', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockReaddir.mockReturnValue(mockDirents('_shared', '_template', 'webscraper'));
      mockFs.readFileSync.mockReturnValue(JSON.stringify(minimalManifest('webscraper', 'Web Scraper', 'Web')));

      const result = await loadTestPlugins();

      // Should only load webscraper, not _shared or _template
      expect(result).toHaveLength(1);
      expect(itemAt(result, 0).id).toBe('webscraper');
    });

    it('skips directories without manifest.json', async () => {
      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr.endsWith('plugins')) return true;
        if (pathStr.includes('valid_plugin') && pathStr.endsWith('manifest.json')) return true;
        return false;
      });

      mockReaddir.mockReturnValue(mockDirents('valid_plugin', 'no_manifest'));
      mockFs.readFileSync.mockReturnValue(JSON.stringify(minimalManifest('valid_plugin', 'Valid Plugin', '✓')));

      const result = await loadTestPlugins();

      expect(result).toHaveLength(1);
      expect(itemAt(result, 0).id).toBe('valid_plugin');
    });

    it('throws error when folder name does not match manifest id', async () => {
      mockSinglePlugin('wrong_folder', {
        id: 'correct_id',  // Doesn't match folder name
        name: 'Plugin',
        icon: 'Package',
        infrastructure: { ingestor: { enabled: true } },
      });

      await expectLoadRejected();
    });

    it('throws error for invalid manifest schema', async () => {
      mockSinglePlugin('invalid', {
        // Missing required fields
        name: 'Invalid',
      });

      await expectLoadRejected();
    });
  });

  /**
   * A plugin id becomes a Secrets Manager key namespace (`<plugin_id>_<key>`), and
   * both readers of that secret match the namespace by plain string prefix — the
   * runtime one in `plugins/_shared/plugin_secrets.py`, which is the ENTIRE
   * isolation boundary between plugins because all ingestion Lambdas share one IAM
   * role, and the status one in `integrations_handler.get_credentials`.
   *
   * Neither can see the other ids, by design: since issue #251 a plugin Lambda
   * holds no list of its siblings' prefixes (keeping one is what let a plugin's
   * keys be reclassified as "shared" and leak into every other plugin). So synth
   * is the only vantage point from which a colliding pair can be refused, and this
   * is the guard that does it.
   */
  describe('plugin id namespace collisions', () => {
    /** Mock two manifests, returning each by the path being read. */
    function mockTwoPlugins(first: string, second: string) {
      mockFs.existsSync.mockReturnValue(true);
      mockReaddir.mockReturnValue(mockDirents(first, second));
      mockFs.readFileSync.mockImplementation((p) => JSON.stringify({
        id: String(p).includes(`/${second}/`) ? second : first,
        name: 'Plugin',
        icon: 'Package',
        infrastructure: { ingestor: { enabled: true } },
        secrets: { api_key: '' },
      }));
    }

    it('rejects an id that is a namespace prefix of another id', async () => {
      // The concrete hazard, not an abstract one: `app_reviews_ios` ships today,
      // and `app_reviews` is a plausible future id for a combined plugin. It would
      // silently receive every `app_reviews_ios_*` key under a mangled name
      // (`app_reviews_ios_app_id` arriving as `ios_app_id`).
      mockTwoPlugins('app_reviews', 'app_reviews_ios');

      await expectLoadRejected();
    });

    it('accepts ids that merely share a leading substring', async () => {
      // Non-vacuity, and the property the guard must not overreach on: the
      // boundary is the `_` separator, so `app_reviewsx` is NOT inside
      // `app_reviews`'s namespace and must still load. A guard written as a bare
      // `startsWith(id)` would reject this pair and block a legitimate plugin.
      mockTwoPlugins('app_reviews', 'app_reviewsx');

      const { loadPlugins } = await import('./plugin-loader');

      expect(loadPlugins('/test/plugins').map((p) => p.id).sort(byCodeUnit))
        .toStrictEqual(['app_reviews', 'app_reviewsx']);
    });

    it('names both ids in the error, so the fix is not a guessing game', async () => {
      mockTwoPlugins('app_reviews', 'app_reviews_ios');

      const { loadPlugins } = await import('./plugin-loader');
      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
        errors.push(args.map(String).join(' '));
      });

      expect(() => loadPlugins('/test/plugins')).toThrow(AGGREGATE_LOAD_ERROR);
      spy.mockRestore();

      const combined = errors.join('\n');
      expect(combined).toContain('app_reviews');
      expect(combined).toContain('app_reviews_ios');
    });
  });

  describe('Manifest Schema Validation', () => {
    it('rejects invalid plugin ID format', async () => {
      mockSinglePlugin('Invalid-Plugin', {
        id: 'Invalid-Plugin',  // Uppercase and hyphen not allowed
        name: 'Plugin',
        icon: 'Package',
        infrastructure: { ingestor: { enabled: true } },
      });

      await expectLoadRejected();
    });

    it('rejects schedule more frequent than 1 minute', async () => {
      mockSinglePlugin('fast_plugin', {
        id: 'fast_plugin',
        name: 'Fast Plugin',
        icon: 'Plugin',
        infrastructure: {
          ingestor: {
            enabled: true,
            schedule: 'rate(30 seconds)',  // Too frequent
          },
        },
      });

      await expectLoadRejected();
    });

    it('rejects timeout exceeding 900 seconds', async () => {
      mockSinglePlugin('slow_plugin', {
        id: 'slow_plugin',
        name: 'Slow Plugin',
        icon: 'Plugin',
        infrastructure: {
          ingestor: {
            enabled: true,
            timeout: 901,  // Exceeds 900 (Lambda hard max)
          },
        },
      });

      await expectLoadRejected();
    });

    it('accepts timeout of exactly 900 seconds (Lambda hard max)', async () => {
      mockSinglePlugin('max_timeout_plugin', {
        id: 'max_timeout_plugin',
        name: 'Max Timeout Plugin',
        icon: 'Plugin',
        infrastructure: {
          ingestor: {
            enabled: true,
            timeout: 900,  // inclusive boundary — Lambda hard max
          },
        },
      });

      const result = await loadTestPlugins();

      expect(result).toHaveLength(1);
      expect(itemAt(result, 0).infrastructure.ingestor?.timeout).toBe(900);
    });

    it('rejects memory exceeding 1024 MB', async () => {
      mockSinglePlugin('big_plugin', {
        id: 'big_plugin',
        name: 'Big Plugin',
        icon: 'Plugin',
        infrastructure: {
          ingestor: {
            enabled: true,
            memory: 2048,  // Exceeds 1024
          },
        },
      });

      await expectLoadRejected();
    });

    it('rejects webhook path with traversal', async () => {
      mockSinglePlugin('bad_plugin', {
        id: 'bad_plugin',
        name: 'Bad Plugin',
        icon: 'Plugin',
        infrastructure: {
          webhook: {
            enabled: true,
            path: '/webhooks/../../../etc/passwd',  // Path traversal
          },
        },
      });

      await expectLoadRejected();
    });

    it('accepts the synthetic category and the ingestor.bedrock capability flag', async () => {
      mockSinglePlugin('synthetic_reviews', {
        id: 'synthetic_reviews',
        name: 'Synthetic Data Review Generator',
        icon: 'Synthetic',
        category: 'synthetic',
        infrastructure: {
          ingestor: { enabled: true, timeout: 300, memory: 512, bedrock: true },
        },
        config: [],
      });

      const result = await loadTestPlugins();

      expect(result).toHaveLength(1);
      expect(itemAt(result, 0).category).toBe('synthetic');
      expect(itemAt(result, 0).infrastructure.ingestor?.bedrock).toBe(true);
    });

    it('defaults ingestor.bedrock to false so non-opted-in plugins never get a Bedrock role', async () => {
      mockSinglePlugin('webscraper', {
        id: 'webscraper',
        name: 'Web Scraper',
        icon: 'Web',
        infrastructure: { ingestor: { enabled: true } },
      });

      const result = await loadTestPlugins();

      // The dedicated Bedrock role in ingestion-stack keys off `bedrock === true`,
      // so the default MUST be false to keep the shared least-privilege role.
      expect(itemAt(result, 0).infrastructure.ingestor?.bedrock).toBe(false);
    });
  });

  describe('Helper Functions', () => {
    it('getPluginsWithIngestor filters correctly', async () => {
      const { getPluginsWithIngestor } = await import('./plugin-loader');

      const plugins = await manifests(
        { id: 'with_ingestor', infrastructure: { ingestor: { enabled: true } } },
        { id: 'without_ingestor', infrastructure: { ingestor: { enabled: false } } },
        { id: 'no_ingestor', infrastructure: {} },
      );

      const result = getPluginsWithIngestor(plugins);

      expect(result).toHaveLength(1);
      expect(itemAt(result, 0).id).toBe('with_ingestor');
    });

    it('getPluginsWithWebhook filters correctly', async () => {
      const { getPluginsWithWebhook } = await import('./plugin-loader');

      const plugins = await manifests(
        { id: 'with_webhook', infrastructure: { webhook: { enabled: true, path: '/webhooks/test' } } },
        { id: 'without_webhook', infrastructure: { webhook: { enabled: false, path: '/webhooks/test' } } },
      );

      const result = getPluginsWithWebhook(plugins);

      expect(result).toHaveLength(1);
      expect(itemAt(result, 0).id).toBe('with_webhook');
    });

    it('getPluginsWithS3Trigger filters correctly', async () => {
      const { getPluginsWithS3Trigger } = await import('./plugin-loader');

      const plugins = await manifests(
        { id: 's3_import', infrastructure: { s3Trigger: { enabled: true, suffixes: ['.csv'] } } },
        { id: 'no_s3', infrastructure: {} },
      );

      const result = getPluginsWithS3Trigger(plugins);

      expect(result).toHaveLength(1);
      expect(itemAt(result, 0).id).toBe('s3_import');
    });

    it('aggregateSecrets prefixes secrets with plugin ID', async () => {
      const { aggregateSecrets } = await import('./plugin-loader');

      const plugins = await manifests(
        { id: 'webscraper', secrets: { api_key: '', configs: '' } },
        { id: 'custom_source', secrets: { api_key: '' } },
      );

      const result = aggregateSecrets(plugins);

      expect(result).toHaveProperty('webscraper_api_key');
      expect(result).toHaveProperty('webscraper_configs');
      expect(result).toHaveProperty('custom_source_api_key');
    });

    it('aggregateSecretsByPlugin keys the same defaults by plugin instead of flattening', async () => {
      const { aggregateSecretsByPlugin, aggregateSecrets } = await import('./plugin-loader');

      const plugins = await manifests(
        { id: 'webscraper', secrets: { configs: '[]' } },
        { id: 'app_reviews_ios', secrets: { app_id: '', sort_by: 'most_recent' } },
      );

      expect(aggregateSecretsByPlugin(plugins)).toStrictEqual({
        webscraper: { configs: '[]' },
        app_reviews_ios: { app_id: '', sort_by: 'most_recent' },
      });

      // The two shapes must describe the same defaults. This is what lets the
      // integrations handler decide whether a stored value was seeded by the
      // deploy or entered by a human: if the nested form ever drifted from the
      // flat form that actually seeds the secret, every comparison it makes
      // would be against the wrong baseline.
      const flat = aggregateSecrets(plugins);
      const flattenedAgain = Object.fromEntries(
        Object.entries(aggregateSecretsByPlugin(plugins)).flatMap(([id, keys]) =>
          Object.entries(keys).map(([key, value]) => [`${id}_${key}`, value])
        )
      );
      expect(flattenedAgain).toStrictEqual(flat);
    });

    it('aggregateSecretsByPlugin lists a plugin that declares no secrets', async () => {
      const { aggregateSecretsByPlugin } = await import('./plugin-loader');

      // The key set doubles as "which sources exist", so a plugin with nothing
      // to configure must still appear — otherwise it silently vanishes from
      // GET /integrations/status.
      const plugins = await manifests({ id: 'no_config_plugin' });

      expect(aggregateSecretsByPlugin(plugins)).toStrictEqual({ no_config_plugin: {} });
    });

    it('aggregateSecretsByPlugin does not alias the manifest it read', async () => {
      const { aggregateSecretsByPlugin } = await import('./plugin-loader');

      const manifest = await manifestOf({ id: 'p', secrets: { a: '1' } });
      const result = aggregateSecretsByPlugin([manifest]);
      valueAt(result, 'p').a = 'mutated';

      expect(manifest.secrets).toStrictEqual({ a: '1' });
    });

    it('getEnabledPlugins filters by enabled sources', async () => {
      const { getEnabledPlugins } = await import('./plugin-loader');

      const plugins = await manifests(
        { id: 'webscraper' },
        { id: 'custom_source' },
        { id: 'another_plugin' },
      );

      const enabledSources = ['webscraper', 'another_plugin'];
      const result = getEnabledPlugins(plugins, enabledSources);

      expect(result).toHaveLength(2);
      expect(result.map(p => p.id)).toContain('webscraper');
      expect(result.map(p => p.id)).toContain('another_plugin');
      expect(result.map(p => p.id)).not.toContain('custom_source');
    });

    it('capitalize converts snake_case to PascalCase', async () => {
      const { capitalize } = await import('./plugin-loader');

      expect(capitalize('webscraper')).toBe('Webscraper');
      expect(capitalize('custom_source')).toBe('CustomSource');
      expect(capitalize('my_plugin')).toBe('MyPlugin');
    });
  });
});

describe('Config Field Schema', () => {
  it('accepts valid config field', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockReaddir.mockReturnValue(mockDirents('test_plugin'));

    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      id: 'test_plugin',
      name: 'Test Plugin',
      icon: 'Synthetic',
      infrastructure: { ingestor: { enabled: true } },
      config: [
        {
          key: 'api_key',
          label: 'API Key',
          type: 'password',
          required: true,
          secret: true,
        },
        {
          key: 'business_id',
          label: 'Business ID',
          type: 'text',
          placeholder: 'Enter ID',
          required: false,
        },
      ],
    }));

    const { loadPlugins } = await import('./plugin-loader');
    const result = loadPlugins('/test/plugins');

    const { config } = itemAt(result, 0);
    const firstField = itemAt(config, 0);

    expect(config).toHaveLength(2);
    expect(firstField.key).toBe('api_key');
    expect(firstField.secret).toBe(true);
  });

  it('accepts select type with options', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockReaddir.mockReturnValue(mockDirents('select_plugin'));

    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      id: 'select_plugin',
      name: 'Select Plugin',
      icon: 'Plugin',
      infrastructure: { ingestor: { enabled: true } },
      config: [
        {
          key: 'region',
          label: 'Region',
          type: 'select',
          options: [
            { value: 'us', label: 'United States' },
            { value: 'eu', label: 'Europe' },
          ],
        },
      ],
    }));

    const { loadPlugins } = await import('./plugin-loader');
    const result = loadPlugins('/test/plugins');

    const field = itemAt(itemAt(result, 0).config, 0);

    expect(field.type).toBe('select');
    expect(field.options).toHaveLength(2);
  });
});

describe('Webhook Info Schema', () => {
  it('accepts valid webhook configuration', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockReaddir.mockReturnValue(mockDirents('webhook_plugin'));

    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      id: 'webhook_plugin',
      name: 'Webhook Plugin',
      icon: 'Plugin',
      infrastructure: {
        webhook: {
          enabled: true,
          path: '/webhooks/test',
          methods: ['POST'],
          signatureHeader: 'X-Signature',
          signatureMethod: 'hmac_sha',
        },
      },
      webhooks: [
        {
          name: 'Review Events',
          events: ['review-created', 'review-updated'],
          docUrl: 'https://docs.example.com/webhooks',
        },
      ],
    }));

    const { loadPlugins } = await import('./plugin-loader');
    const result = loadPlugins('/test/plugins');

    const plugin = itemAt(result, 0);
    const webhooks = plugin.webhooks ?? [];

    expect(plugin.infrastructure.webhook?.enabled).toBe(true);
    expect(webhooks).toHaveLength(1);
    expect(itemAt(webhooks, 0).events).toContain('review-created');
  });
});
