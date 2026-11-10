/**
 * @fileoverview The web scraper's manifest identity, shared by the plugin
 * specs that build a manifest around it (the loader's mocked
 * `manifests.json` and the schema's real-world example).
 */
export const WEBSCRAPER_MANIFEST_CORE = {
  id: 'webscraper',
  name: 'Web Scraper',
  icon: 'Web',
  description: 'Configurable scraper for extracting feedback from websites',
  category: 'import',
  config: [
    { key: 'configs', label: 'Scraper Configurations (JSON)', type: 'textarea', required: false, secret: false },
  ],
} as const
