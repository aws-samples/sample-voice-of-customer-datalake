/**
 * @fileoverview Source configuration data for Settings page.
 * @module pages/Settings/sourceConfig
 */

export interface SourceField {
  key: string
  label: string
  type: string
  placeholder?: string
  multiline?: boolean
}

export interface SourceWebhook {
  name: string
  events: string
  docUrl?: string
}

export interface SetupInstructions {
  title: string
  color: string
  steps: string[]
}

export interface SourceInfo {
  name: string
  icon: string
  description?: string
  fields: SourceField[]
  webhooks?: SourceWebhook[]
  setupInstructions?: SetupInstructions
}

export const sourceInfo: Record<string, SourceInfo> = {
  trustpilot: {
    name: 'Trustpilot',
    icon: '⭐',
    description: 'Service reviews via webhook and API polling',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
      { key: 'api_secret', label: 'API Secret', type: 'password' },
      { key: 'business_unit_id', label: 'Business Unit ID', type: 'text', placeholder: 'e.g., 5a7b8c9d0e1f2a3b4c5d6e7f' },
    ],
    webhooks: [
      { name: 'Service Reviews', events: 'service-review-created, service-review-updated, service-review-deleted', docUrl: 'https://support.trustpilot.com/hc/en-us/articles/360001108568-Webhooks' }
    ],
    setupInstructions: {
      title: 'Trustpilot Setup',
      color: 'blue',
      steps: [
        'Log in to your Trustpilot Business Portal',
        'Go to Integrations → API to get your API Key and Secret',
        'Copy your Business Unit ID from the URL',
        'Go to Integrations → Webhooks and add the webhook URL',
        'Select events: service-review-created, updated, deleted',
      ]
    }
  },
  yelp: {
    name: 'Yelp Fusion API',
    icon: '🍽️',
    description: 'Business reviews via official Yelp API',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
      { key: 'business_ids', label: 'Business IDs', type: 'text', placeholder: 'lufthansa-frankfurt-am-main-3, lufthansa-los-angeles-2', multiline: true },
    ],
    setupInstructions: {
      title: 'Yelp Setup',
      color: 'orange',
      steps: [
        'Go to Yelp Fusion Developer Portal',
        'Create a new app or use an existing one',
        'Copy your API Key from the app settings',
        'Find business IDs from Yelp URLs (slug after /biz/)',
      ]
    }
  },
  google_reviews: {
    name: 'Google Reviews',
    icon: '🔍',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
      { key: 'location_ids', label: 'Location IDs (comma-separated)', type: 'text' },
    ],
  },
  twitter: {
    name: 'Twitter / X',
    icon: '𝕏',
    fields: [
      { key: 'bearer_token', label: 'Bearer Token', type: 'password' },
    ],
  },
  instagram: {
    name: 'Instagram',
    icon: '📸',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password' },
    ],
  },
  facebook: {
    name: 'Facebook',
    icon: '👤',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password' },
      { key: 'page_id', label: 'Page ID', type: 'text' },
    ],
  },
  reddit: {
    name: 'Reddit',
    icon: '🤖',
    fields: [
      { key: 'client_id', label: 'Client ID', type: 'text' },
      { key: 'client_secret', label: 'Client Secret', type: 'password' },
    ],
  },
  linkedin: {
    name: 'LinkedIn',
    icon: '💼',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password' },
    ],
  },
  tiktok: {
    name: 'TikTok',
    icon: '🎵',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password' },
    ],
  },
  youtube: {
    name: 'YouTube',
    icon: '▶️',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
      { key: 'channel_id', label: 'Channel ID', type: 'text' },
    ],
  },
  tavily: {
    name: 'Tavily Web Search',
    icon: '🌐',
    description: 'AI-powered web search for brand mentions',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
    ],
    setupInstructions: {
      title: 'Tavily Setup',
      color: 'blue',
      steps: [
        'Sign up at tavily.com',
        'Get your API key from the dashboard',
        'Configure brand handles and URLs above',
      ]
    }
  },
  appstore_apple: {
    name: 'Apple App Store',
    icon: '🍎',
    fields: [
      { key: 'app_id', label: 'App ID', type: 'text', placeholder: 'e.g., 123456789' },
      { key: 'country_codes', label: 'Country Codes (comma-separated)', type: 'text', placeholder: 'us, gb, de' },
    ],
  },
  appstore_google: {
    name: 'Google Play Store',
    icon: '🤖',
    fields: [
      { key: 'package_name', label: 'Package Name', type: 'text', placeholder: 'com.example.app' },
      { key: 'service_account', label: 'Service Account JSON', type: 'password', multiline: true },
    ],
  },
  appstore_huawei: {
    name: 'Huawei AppGallery',
    icon: '📱',
    fields: [
      { key: 'client_id', label: 'Client ID', type: 'text' },
      { key: 'client_secret', label: 'Client Secret', type: 'password' },
      { key: 'app_id', label: 'App ID', type: 'text' },
    ],
  },
  s3_import: {
    name: 'S3 Bulk Import',
    icon: '📦',
    description: 'Import feedback from S3 bucket (CSV, JSON, JSONL)',
    fields: [
      { key: 'bucket_name', label: 'S3 Bucket Name', type: 'text', placeholder: 'my-feedback-bucket' },
      { key: 'import_prefix', label: 'Import Prefix', type: 'text', placeholder: 'imports/' },
      { key: 'processed_prefix', label: 'Processed Prefix', type: 'text', placeholder: 'processed/' },
    ],
    setupInstructions: {
      title: 'S3 Import Setup',
      color: 'blue',
      steps: [
        'Create an S3 bucket for feedback imports',
        'Grant the VoC Lambda role read/write access',
        'Upload CSV/JSON/JSONL files to the import prefix',
        'Files are moved to processed prefix after import',
        'CSV columns: id, text, rating, created_at, source, url',
      ]
    }
  },
}
