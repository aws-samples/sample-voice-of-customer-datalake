/**
 * Tests for plugin-loader.ts - Plugin discovery and validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// Mock fs module
vi.mock('fs');

const mockFs = vi.mocked(fs);

// Helper to create mock Dirent objects
function createMockDirent(name: string, isDir: boolean) {
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
  return names.map(name => createMockDirent(name, true)) as unknown as ReturnType<typeof fs.readdirSync>;
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

      expect(result).toEqual([]);
    });

    it('loads valid plugin manifests from directory', async () => {
      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr.endsWith('plugins')) return true;
        if (pathStr.endsWith('manifest.json')) return true;
        return false;
      });

      mockFs.readdirSync.mockReturnValue(mockDirents('trustpilot'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'trustpilot',
        name: 'Trustpilot',
        icon: '⭐',
        description: 'Service reviews',
        infrastructure: {
          ingestor: { enabled: true, schedule: 'rate(5 minutes)', timeout: 120, memory: 256 },
        },
        config: [],
      }));

      const { loadPlugins } = await import('./plugin-loader');
      const result = loadPlugins('/test/plugins');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('trustpilot');
      expect(result[0].name).toBe('Trustpilot');
    });

    it('skips directories starting with underscore', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(mockDirents('_shared', '_template', 'trustpilot'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'trustpilot',
        name: 'Trustpilot',
        icon: '⭐',
        infrastructure: { ingestor: { enabled: true } },
      }));

      const { loadPlugins } = await import('./plugin-loader');
      const result = loadPlugins('/test/plugins');

      // Should only load trustpilot, not _shared or _template
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('trustpilot');
    });

    it('skips directories without manifest.json', async () => {
      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr.endsWith('plugins')) return true;
        if (pathStr.includes('valid_plugin') && pathStr.endsWith('manifest.json')) return true;
        return false;
      });

      mockFs.readdirSync.mockReturnValue(mockDirents('valid_plugin', 'no_manifest'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'valid_plugin',
        name: 'Valid Plugin',
        icon: '✓',
        infrastructure: { ingestor: { enabled: true } },
      }));

      const { loadPlugins } = await import('./plugin-loader');
      const result = loadPlugins('/test/plugins');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('valid_plugin');
    });

    it('throws error when folder name does not match manifest id', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(mockDirents('wrong_folder'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'correct_id',  // Doesn't match folder name
        name: 'Plugin',
        icon: '📦',
        infrastructure: { ingestor: { enabled: true } },
      }));

      const { loadPlugins } = await import('./plugin-loader');

      expect(() => loadPlugins('/test/plugins')).toThrow();
    });

    it('throws error for invalid manifest schema', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(mockDirents('invalid'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        // Missing required fields
        name: 'Invalid',
      }));

      const { loadPlugins } = await import('./plugin-loader');

      expect(() => loadPlugins('/test/plugins')).toThrow();
    });
  });

  describe('Manifest Schema Validation', () => {
    it('rejects invalid plugin ID format', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(mockDirents('Invalid-Plugin'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'Invalid-Plugin',  // Uppercase and hyphen not allowed
        name: 'Plugin',
        icon: '📦',
        infrastructure: { ingestor: { enabled: true } },
      }));

      const { loadPlugins } = await import('./plugin-loader');

      expect(() => loadPlugins('/test/plugins')).toThrow();
    });

    it('rejects schedule more frequent than 1 minute', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(mockDirents('fast_plugin'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'fast_plugin',
        name: 'Fast Plugin',
        icon: '⚡',
        infrastructure: {
          ingestor: {
            enabled: true,
            schedule: 'rate(30 seconds)',  // Too frequent
          },
        },
      }));

      const { loadPlugins } = await import('./plugin-loader');

      expect(() => loadPlugins('/test/plugins')).toThrow();
    });

    it('rejects timeout exceeding 300 seconds', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(mockDirents('slow_plugin'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'slow_plugin',
        name: 'Slow Plugin',
        icon: '🐢',
        infrastructure: {
          ingestor: {
            enabled: true,
            timeout: 600,  // Exceeds 300
          },
        },
      }));

      const { loadPlugins } = await import('./plugin-loader');

      expect(() => loadPlugins('/test/plugins')).toThrow();
    });

    it('rejects memory exceeding 1024 MB', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(mockDirents('big_plugin'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'big_plugin',
        name: 'Big Plugin',
        icon: '🐘',
        infrastructure: {
          ingestor: {
            enabled: true,
            memory: 2048,  // Exceeds 1024
          },
        },
      }));

      const { loadPlugins } = await import('./plugin-loader');

      expect(() => loadPlugins('/test/plugins')).toThrow();
    });

    it('rejects webhook path with traversal', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(mockDirents('bad_plugin'));

      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'bad_plugin',
        name: 'Bad Plugin',
        icon: '💀',
        infrastructure: {
          webhook: {
            enabled: true,
            path: '/webhooks/../../../etc/passwd',  // Path traversal
          },
        },
      }));

      const { loadPlugins } = await import('./plugin-loader');

      expect(() => loadPlugins('/test/plugins')).toThrow();
    });
  });

  describe('Helper Functions', () => {
    it('getPluginsWithIngestor filters correctly', async () => {
      const { getPluginsWithIngestor } = await import('./plugin-loader');

      const plugins = [
        { id: 'with_ingestor', infrastructure: { ingestor: { enabled: true } } },
        { id: 'without_ingestor', infrastructure: { ingestor: { enabled: false } } },
        { id: 'no_ingestor', infrastructure: {} },
      ] as Parameters<typeof getPluginsWithIngestor>[0];

      const result = getPluginsWithIngestor(plugins);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('with_ingestor');
    });

    it('getPluginsWithWebhook filters correctly', async () => {
      const { getPluginsWithWebhook } = await import('./plugin-loader');

      const plugins = [
        { id: 'with_webhook', infrastructure: { webhook: { enabled: true, path: '/webhooks/test' } } },
        { id: 'without_webhook', infrastructure: { webhook: { enabled: false, path: '/webhooks/test' } } },
      ] as Parameters<typeof getPluginsWithWebhook>[0];

      const result = getPluginsWithWebhook(plugins);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('with_webhook');
    });

    it('getPluginsWithS3Trigger filters correctly', async () => {
      const { getPluginsWithS3Trigger } = await import('./plugin-loader');

      const plugins = [
        { id: 's3_import', infrastructure: { s3Trigger: { enabled: true, suffixes: ['.csv'] } } },
        { id: 'no_s3', infrastructure: {} },
      ] as Parameters<typeof getPluginsWithS3Trigger>[0];

      const result = getPluginsWithS3Trigger(plugins);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s3_import');
    });

    it('aggregateSecrets prefixes secrets with plugin ID', async () => {
      const { aggregateSecrets } = await import('./plugin-loader');

      const plugins = [
        { id: 'trustpilot', secrets: { api_key: '', api_secret: '' } },
        { id: 'yelp', secrets: { api_key: '' } },
      ] as unknown as Parameters<typeof aggregateSecrets>[0];

      const result = aggregateSecrets(plugins);

      expect(result).toHaveProperty('trustpilot_api_key');
      expect(result).toHaveProperty('trustpilot_api_secret');
      expect(result).toHaveProperty('yelp_api_key');
    });

    it('getEnabledPlugins filters by enabled sources', async () => {
      const { getEnabledPlugins } = await import('./plugin-loader');

      const plugins = [
        { id: 'trustpilot' },
        { id: 'yelp' },
        { id: 'twitter' },
      ] as Parameters<typeof getEnabledPlugins>[0];

      const enabledSources = ['trustpilot', 'twitter'];
      const result = getEnabledPlugins(plugins, enabledSources);

      expect(result).toHaveLength(2);
      expect(result.map(p => p.id)).toContain('trustpilot');
      expect(result.map(p => p.id)).toContain('twitter');
      expect(result.map(p => p.id)).not.toContain('yelp');
    });

    it('capitalize converts snake_case to PascalCase', async () => {
      const { capitalize } = await import('./plugin-loader');

      expect(capitalize('trustpilot')).toBe('Trustpilot');
      expect(capitalize('google_reviews')).toBe('GoogleReviews');
      expect(capitalize('appstore_apple')).toBe('AppstoreApple');
    });
  });
});

describe('Config Field Schema', () => {
  it('accepts valid config field', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(mockDirents('test_plugin'));

    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      id: 'test_plugin',
      name: 'Test Plugin',
      icon: '🧪',
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

    expect(result[0].config).toHaveLength(2);
    expect(result[0].config[0].key).toBe('api_key');
    expect(result[0].config[0].secret).toBe(true);
  });

  it('accepts select type with options', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(mockDirents('select_plugin'));

    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      id: 'select_plugin',
      name: 'Select Plugin',
      icon: '📋',
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

    expect(result[0].config[0].type).toBe('select');
    expect(result[0].config[0].options).toHaveLength(2);
  });
});

describe('Webhook Info Schema', () => {
  it('accepts valid webhook configuration', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(mockDirents('webhook_plugin'));

    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      id: 'webhook_plugin',
      name: 'Webhook Plugin',
      icon: '🔔',
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

    expect(result[0].infrastructure.webhook?.enabled).toBe(true);
    expect(result[0].webhooks).toHaveLength(1);
    expect(result[0].webhooks?.[0].events).toContain('review-created');
  });
});
