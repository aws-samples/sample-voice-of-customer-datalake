/**
 * Tests for plugins/types.ts - Frontend plugin manifest types and validation.
 */
import { describe, it, expect } from 'vitest';
import {
  PluginManifestSchema,
  PluginManifestsSchema,
  ConfigFieldSchema,
  WebhookInfoSchema,
  SetupSchema,
  safeValidateManifests,
} from './types';

describe('ConfigFieldSchema', () => {
  it('accepts valid text config field', () => {
    const field = {
      key: 'api_key',
      label: 'API Key',
      type: 'text',
    };

    const result = ConfigFieldSchema.safeParse(field);

    expect(result.success).toBe(true);
  });

  it('accepts valid password config field with all options', () => {
    const field = {
      key: 'api_secret',
      label: 'API Secret',
      type: 'password',
      required: true,
      placeholder: 'Enter your secret',
      secret: true,
    };

    const result = ConfigFieldSchema.safeParse(field);

    expect(result.success).toBe(true);
    expect(result.data?.secret).toBe(true);
    expect(result.data?.required).toBe(true);
  });

  it('accepts select type with options', () => {
    const field = {
      key: 'region',
      label: 'Region',
      type: 'select',
      options: [
        { value: 'us', label: 'United States' },
        { value: 'eu', label: 'Europe' },
      ],
    };

    const result = ConfigFieldSchema.safeParse(field);

    expect(result.success).toBe(true);
    expect(result.data?.options).toHaveLength(2);
  });

  it('rejects invalid type', () => {
    const field = {
      key: 'test',
      label: 'Test',
      type: 'invalid_type',
    };

    const result = ConfigFieldSchema.safeParse(field);

    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const field = {
      key: 'test',
      // Missing label and type
    };

    const result = ConfigFieldSchema.safeParse(field);

    expect(result.success).toBe(false);
  });
});

describe('WebhookInfoSchema', () => {
  it('accepts valid webhook info', () => {
    const webhook = {
      name: 'Review Events',
      events: ['review-created', 'review-updated', 'review-deleted'],
    };

    const result = WebhookInfoSchema.safeParse(webhook);

    expect(result.success).toBe(true);
  });

  it('accepts webhook info with docUrl', () => {
    const webhook = {
      name: 'Service Reviews',
      events: ['service-review-created'],
      docUrl: 'https://docs.example.com/webhooks',
    };

    const result = WebhookInfoSchema.safeParse(webhook);

    expect(result.success).toBe(true);
    expect(result.data?.docUrl).toBe('https://docs.example.com/webhooks');
  });

  it('rejects missing name', () => {
    const webhook = {
      events: ['event-1'],
    };

    const result = WebhookInfoSchema.safeParse(webhook);

    expect(result.success).toBe(false);
  });

  it('rejects missing events', () => {
    const webhook = {
      name: 'Test Webhook',
    };

    const result = WebhookInfoSchema.safeParse(webhook);

    expect(result.success).toBe(false);
  });
});


describe('SetupSchema', () => {
  it('accepts valid setup info', () => {
    const setup = {
      title: 'Web Scraper Setup',
      steps: [
        'Configure scrapers via the Scrapers page',
        'Each scraper can use CSS selectors',
        'Test scrapers before enabling them',
      ],
    };

    const result = SetupSchema.safeParse(setup);

    expect(result.success).toBe(true);
  });

  it('accepts setup with color', () => {
    const setup = {
      title: 'Plugin Setup',
      color: 'gray',
      steps: ['Step 1', 'Step 2'],
    };

    const result = SetupSchema.safeParse(setup);

    expect(result.success).toBe(true);
    expect(result.data?.color).toBe('gray');
  });

  it('rejects invalid color', () => {
    const setup = {
      title: 'Test',
      color: 'purple',  // Not in enum
      steps: ['Step 1'],
    };

    const result = SetupSchema.safeParse(setup);

    expect(result.success).toBe(false);
  });
});

describe('PluginManifestSchema', () => {
  const validManifest = {
    id: 'webscraper',
    name: 'Web Scraper',
    icon: '🕷️',
    description: 'Configurable scraper for extracting feedback from websites',
    category: 'import',
    config: [
      { key: 'configs', label: 'Scraper Configurations', type: 'textarea' },
    ],
    hasIngestor: true,
    hasWebhook: false,
    hasS3Trigger: false,
    enabled: true,
    version: '1.0.0',
  };

  it('accepts valid plugin manifest', () => {
    const result = PluginManifestSchema.safeParse(validManifest);

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('webscraper');
    expect(result.data?.hasIngestor).toBe(true);
  });


  it('accepts manifest with webhooks array', () => {
    const manifest = {
      ...validManifest,
      webhooks: [
        { name: 'Reviews', events: ['review-created'] },
      ],
    };

    const result = PluginManifestSchema.safeParse(manifest);

    expect(result.success).toBe(true);
    expect(result.data?.webhooks).toHaveLength(1);
  });

  it('accepts manifest with setup info', () => {
    const manifest = {
      ...validManifest,
      setup: {
        title: 'Web Scraper Setup',
        color: 'gray',
        steps: ['Step 1', 'Step 2'],
      },
    };

    const result = PluginManifestSchema.safeParse(manifest);

    expect(result.success).toBe(true);
    expect(result.data?.setup?.title).toBe('Web Scraper Setup');
  });

  it('rejects manifest without required fields', () => {
    const manifest = {
      id: 'test',
      name: 'Test',
      // Missing icon, config, hasIngestor, hasWebhook, hasS3Trigger
    };

    const result = PluginManifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
  });

  it('rejects invalid category', () => {
    const manifest = {
      ...validManifest,
      category: 'invalid_category',
    };

    const result = PluginManifestSchema.safeParse(manifest);

    expect(result.success).toBe(false);
  });
});

describe('PluginManifestsSchema', () => {
  it('accepts array of valid manifests', () => {
    const manifests = [
      {
        id: 'webscraper',
        name: 'Web Scraper',
        icon: '🕷️',
        config: [],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: false,
        enabled: true,
      },
      {
        id: 'manual_import',
        name: 'Manual Import',
        icon: '📝',
        config: [],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: false,
        enabled: true,
      },
    ];

    const result = PluginManifestsSchema.safeParse(manifests);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });


  it('accepts empty array', () => {
    const result = PluginManifestsSchema.safeParse([]);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('rejects array with invalid manifest', () => {
    const manifests = [
      {
        id: 'valid',
        name: 'Valid',
        icon: '✓',
        config: [],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: false,
        enabled: true,
      },
      {
        id: 'invalid',
        // Missing required fields
      },
    ];

    const result = PluginManifestsSchema.safeParse(manifests);

    expect(result.success).toBe(false);
  });
});

describe('Validation Functions', () => {
  const validManifest = {
    id: 'webscraper',
    name: 'Web Scraper',
    icon: '🕷️',
    config: [],
    hasIngestor: true,
    hasWebhook: false,
    hasS3Trigger: false,
    enabled: true,
  };

  describe('safeValidateManifests', () => {
    it('returns validated manifests for valid input', () => {
      const manifests = [validManifest];

      const result = safeValidateManifests(manifests);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].id).toBe('webscraper');
    });

    it('returns null for invalid input', () => {
      const invalid = [{ id: 'test' }];

      const result = safeValidateManifests(invalid);

      expect(result).toBeNull();
    });

    it('returns null for non-array input', () => {
      expect(safeValidateManifests({})).toBeNull();
      expect(safeValidateManifests('string')).toBeNull();
    });

    it('returns empty array for empty input', () => {
      const result = safeValidateManifests([]);

      expect(result).toStrictEqual([]);
    });
  });
});

describe('Real-World Manifest Examples', () => {
  it('validates Web Scraper manifest structure', () => {
    const webscraperManifest = {
      id: 'webscraper',
      name: 'Web Scraper',
      icon: '🕷️',
      description: 'Configurable scraper for extracting feedback from websites',
      category: 'import',
      config: [
        { key: 'configs', label: 'Scraper Configurations (JSON)', type: 'textarea', required: false, secret: false },
      ],
      setup: {
        title: 'Web Scraper Setup',
        color: 'gray',
        steps: [
          'Configure scrapers via the Scrapers page in the dashboard',
          'Each scraper can use CSS selectors or JSON-LD extraction',
          'Test scrapers before enabling them',
        ],
      },
      hasIngestor: true,
      hasWebhook: false,
      hasS3Trigger: false,
      enabled: true,
      version: '1.0.0',
    };

    const result = PluginManifestSchema.safeParse(webscraperManifest);

    expect(result.success).toBe(true);
  });

  it('validates S3 Import manifest structure', () => {
    const s3ImportManifest = {
      id: 's3_import',
      name: 'S3 Bulk Import',
      icon: '📦',
      description: 'Import feedback from S3 bucket (CSV, JSON, JSONL)',
      category: 'import',
      config: [
        { key: 'bucket_name', label: 'S3 Bucket Name', type: 'text', placeholder: 'my-feedback-bucket' },
        { key: 'import_prefix', label: 'Import Prefix', type: 'text', placeholder: 'imports/' },
      ],
      setup: {
        title: 'S3 Import Setup',
        color: 'blue',
        steps: [
          'Create an S3 bucket for feedback imports',
          'Grant the VoC Lambda role read/write access',
          'Upload CSV/JSON/JSONL files to the import prefix',
        ],
      },
      hasIngestor: true,
      hasWebhook: false,
      hasS3Trigger: true,
      enabled: true,
      version: '1.0.0',
    };

    const result = PluginManifestSchema.safeParse(s3ImportManifest);

    expect(result.success).toBe(true);
    expect(result.data?.hasS3Trigger).toBe(true);
  });
});
