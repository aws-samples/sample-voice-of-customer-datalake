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
  isPluginManifest,
  isPluginManifestArray,
  validateManifests,
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
    if (result.success) {
      expect(result.data.secret).toBe(true);
      expect(result.data.required).toBe(true);
    }
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
    if (result.success) {
      expect(result.data.options).toHaveLength(2);
    }
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
    if (result.success) {
      expect(result.data.docUrl).toBe('https://docs.example.com/webhooks');
    }
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
      title: 'Trustpilot Setup',
      steps: [
        'Log in to your Trustpilot Business Portal',
        'Go to Integrations → API',
        'Copy your API Key',
      ],
    };

    const result = SetupSchema.safeParse(setup);

    expect(result.success).toBe(true);
  });

  it('accepts setup with color', () => {
    const setup = {
      title: 'Yelp Setup',
      color: 'orange',
      steps: ['Step 1', 'Step 2'],
    };

    const result = SetupSchema.safeParse(setup);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.color).toBe('orange');
    }
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
    id: 'trustpilot',
    name: 'Trustpilot',
    icon: '⭐',
    description: 'Service reviews via webhook and API polling',
    category: 'reviews',
    config: [
      { key: 'api_key', label: 'API Key', type: 'password' },
    ],
    hasIngestor: true,
    hasWebhook: true,
    hasS3Trigger: false,
    version: '1.0.0',
  };

  it('accepts valid plugin manifest', () => {
    const result = PluginManifestSchema.safeParse(validManifest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('trustpilot');
      expect(result.data.hasIngestor).toBe(true);
    }
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
    if (result.success) {
      expect(result.data.webhooks).toHaveLength(1);
    }
  });

  it('accepts manifest with setup info', () => {
    const manifest = {
      ...validManifest,
      setup: {
        title: 'Trustpilot Setup',
        color: 'blue',
        steps: ['Step 1', 'Step 2'],
      },
    };

    const result = PluginManifestSchema.safeParse(manifest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.setup?.title).toBe('Trustpilot Setup');
    }
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
        id: 'trustpilot',
        name: 'Trustpilot',
        icon: '⭐',
        config: [],
        hasIngestor: true,
        hasWebhook: true,
        hasS3Trigger: false,
      },
      {
        id: 'yelp',
        name: 'Yelp',
        icon: '🍽️',
        config: [],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: false,
      },
    ];

    const result = PluginManifestsSchema.safeParse(manifests);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
    }
  });

  it('accepts empty array', () => {
    const result = PluginManifestsSchema.safeParse([]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
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

describe('Type Guards', () => {
  describe('isPluginManifest', () => {
    it('returns true for valid manifest', () => {
      const manifest = {
        id: 'test',
        name: 'Test',
        icon: '🧪',
        config: [],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: false,
      };

      expect(isPluginManifest(manifest)).toBe(true);
    });

    it('returns false for invalid manifest', () => {
      const invalid = { id: 'test' };

      expect(isPluginManifest(invalid)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isPluginManifest(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isPluginManifest(undefined)).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(isPluginManifest('string')).toBe(false);
      expect(isPluginManifest(123)).toBe(false);
    });
  });

  describe('isPluginManifestArray', () => {
    it('returns true for valid manifest array', () => {
      const manifests = [
        {
          id: 'test1',
          name: 'Test 1',
          icon: '1️⃣',
          config: [],
          hasIngestor: true,
          hasWebhook: false,
          hasS3Trigger: false,
        },
        {
          id: 'test2',
          name: 'Test 2',
          icon: '2️⃣',
          config: [],
          hasIngestor: false,
          hasWebhook: true,
          hasS3Trigger: false,
        },
      ];

      expect(isPluginManifestArray(manifests)).toBe(true);
    });

    it('returns true for empty array', () => {
      expect(isPluginManifestArray([])).toBe(true);
    });

    it('returns false for array with invalid item', () => {
      const manifests = [
        {
          id: 'valid',
          name: 'Valid',
          icon: '✓',
          config: [],
          hasIngestor: true,
          hasWebhook: false,
          hasS3Trigger: false,
        },
        { invalid: true },
      ];

      expect(isPluginManifestArray(manifests)).toBe(false);
    });

    it('returns false for non-array', () => {
      expect(isPluginManifestArray({})).toBe(false);
      expect(isPluginManifestArray('string')).toBe(false);
    });
  });
});

describe('Validation Functions', () => {
  describe('validateManifests', () => {
    it('returns validated manifests for valid input', () => {
      const manifests = [
        {
          id: 'trustpilot',
          name: 'Trustpilot',
          icon: '⭐',
          config: [],
          hasIngestor: true,
          hasWebhook: true,
          hasS3Trigger: false,
        },
      ];

      const result = validateManifests(manifests);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('trustpilot');
    });

    it('throws for invalid input', () => {
      const invalid = [{ id: 'test' }];

      expect(() => validateManifests(invalid)).toThrow();
    });
  });

  describe('safeValidateManifests', () => {
    it('returns manifests for valid input', () => {
      const manifests = [
        {
          id: 'yelp',
          name: 'Yelp',
          icon: '🍽️',
          config: [],
          hasIngestor: true,
          hasWebhook: false,
          hasS3Trigger: false,
        },
      ];

      const result = safeValidateManifests(manifests);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
    });

    it('returns null for invalid input', () => {
      const invalid = [{ id: 'test' }];

      const result = safeValidateManifests(invalid);

      expect(result).toBeNull();
    });

    it('returns null for non-array input', () => {
      const result = safeValidateManifests({ id: 'test' });

      expect(result).toBeNull();
    });
  });
});

describe('Real-World Manifest Examples', () => {
  it('validates Trustpilot manifest structure', () => {
    const trustpilotManifest = {
      id: 'trustpilot',
      name: 'Trustpilot',
      icon: '⭐',
      description: 'Service reviews via webhook and API polling',
      category: 'reviews',
      config: [
        { key: 'api_key', label: 'API Key', type: 'password', required: true, secret: true },
        { key: 'api_secret', label: 'API Secret', type: 'password', required: true, secret: true },
        { key: 'business_unit_id', label: 'Business Unit ID', type: 'text', placeholder: 'e.g., 5a7b8c9d0e1f2a3b4c5d6e7f' },
      ],
      webhooks: [
        {
          name: 'Service Reviews',
          events: ['service-review-created', 'service-review-updated', 'service-review-deleted'],
          docUrl: 'https://support.trustpilot.com/hc/en-us/articles/360001108568-Webhooks',
        },
      ],
      setup: {
        title: 'Trustpilot Setup',
        color: 'blue',
        steps: [
          'Log in to your Trustpilot Business Portal',
          'Go to Integrations → API to get your API Key and Secret',
          'Copy your Business Unit ID from the URL',
        ],
      },
      hasIngestor: true,
      hasWebhook: true,
      hasS3Trigger: false,
      version: '1.0.0',
    };

    const result = PluginManifestSchema.safeParse(trustpilotManifest);

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
      version: '1.0.0',
    };

    const result = PluginManifestSchema.safeParse(s3ImportManifest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hasS3Trigger).toBe(true);
    }
  });
});
