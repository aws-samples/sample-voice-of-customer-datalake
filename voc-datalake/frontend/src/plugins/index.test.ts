/**
 * Tests for plugins/index.ts - Plugin manifest loader.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the manifests.json import
vi.mock('./manifests.json', () => ({
  default: [
    {
      id: 'webscraper',
      name: 'Web Scraper',
      icon: '🕷️',
      description: 'Configurable scraper for extracting feedback from websites',
      category: 'import',
      config: [
        { key: 'configs', label: 'Scraper Configurations (JSON)', type: 'textarea', required: false, secret: false },
      ],
      hasIngestor: true,
      hasWebhook: false,
      hasS3Trigger: false,
      version: '1.0.0',
      enabled: true,
    },
    {
      id: 'manual_import',
      name: 'Manual Import',
      icon: '📝',
      description: 'Manually import feedback data',
      category: 'import',
      config: [],
      hasIngestor: true,
      hasWebhook: false,
      hasS3Trigger: false,
      version: '1.0.0',
      enabled: true,
    },
    {
      id: 's3_import',
      name: 'S3 Bulk Import',
      icon: '📦',
      description: 'Import feedback from S3 bucket',
      category: 'import',
      config: [],
      hasIngestor: true,
      hasWebhook: false,
      hasS3Trigger: true,
      version: '1.0.0',
      enabled: true,
    },
  ],
}));

describe('Plugin Manifest Loader', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('getPluginManifests', () => {
    it('returns all loaded plugin manifests', async () => {
      const { getPluginManifests } = await import('./index');

      const manifests = getPluginManifests();

      expect(manifests).toHaveLength(3);
      expect(manifests.map(m => m.id)).toContain('webscraper');
      expect(manifests.map(m => m.id)).toContain('manual_import');
      expect(manifests.map(m => m.id)).toContain('s3_import');
    });

    it('returns manifests with correct structure', async () => {
      const { getPluginManifests } = await import('./index');

      const manifests = getPluginManifests();
      const webscraper = manifests.find(m => m.id === 'webscraper');

      expect(webscraper).toBeDefined();
      expect(webscraper?.name).toBe('Web Scraper');
      expect(webscraper?.icon).toBe('🕷️');
      expect(webscraper?.hasIngestor).toBe(true);
    });
  });
});

describe('Plugin Manifest Validation', () => {
  it('validates manifests at load time', async () => {
    const { getPluginManifests } = await import('./index');

    const manifests = getPluginManifests();

    expect(manifests.length).toBeGreaterThan(0);
    for (const manifest of manifests) {
      expect(manifest.id).toBeDefined();
      expect(manifest.name).toBeDefined();
      expect(manifest.icon).toBeDefined();
    }
  });

  it('has correct boolean flags on all manifests', async () => {
    const { getPluginManifests } = await import('./index');

    const manifests = getPluginManifests();

    for (const manifest of manifests) {
      expect(typeof manifest.hasIngestor).toBe('boolean');
      expect(typeof manifest.hasWebhook).toBe('boolean');
      expect(typeof manifest.hasS3Trigger).toBe('boolean');
    }
  });
});

describe('Type Exports', () => {
  it('exports PluginManifest type with core properties', async () => {
    const { getPluginManifests } = await import('./index');
    const manifests = getPluginManifests();

    const manifest = manifests[0];
    expect(manifest).toHaveProperty('id');
    expect(manifest).toHaveProperty('name');
    expect(manifest).toHaveProperty('icon');
    expect(manifest).toHaveProperty('config');
  });

  it('exports PluginManifest type with feature flags', async () => {
    const { getPluginManifests } = await import('./index');
    const manifests = getPluginManifests();

    const manifest = manifests[0];
    expect(manifest).toHaveProperty('hasIngestor');
    expect(manifest).toHaveProperty('hasWebhook');
    expect(manifest).toHaveProperty('hasS3Trigger');
    expect(manifest).toHaveProperty('enabled');
  });

  it('exports ConfigField type through manifest config', async () => {
    const { getPluginManifests } = await import('./index');
    const manifests = getPluginManifests();
    const manifest = manifests.find(m => m.id === 'webscraper');

    expect(manifest?.config).toBeDefined();
    expect(Array.isArray(manifest?.config)).toBe(true);

    const configField = manifest!.config[0];
    expect(configField).toHaveProperty('key');
    expect(configField).toHaveProperty('label');
  });
});

describe('getEnabledPlugins', () => {
  it('returns only enabled plugins', async () => {
    const { getEnabledPlugins } = await import('./index');

    const plugins = getEnabledPlugins();

    // All mock plugins are enabled
    expect(plugins).toHaveLength(3);
    plugins.forEach(p => {
      expect(p.enabled).toBe(true);
    });
  });
});
