/**
 * i18next-parser configuration for automatic string extraction.
 *
 * Usage: npx i18next-parser
 *
 * Scans src/ for t() calls and updates public/locales/{lang}/{ns}.json files.
 * New keys are added with empty values for non-English locales.
 */
export default {
  locales: ['en', 'es', 'fr', 'de', 'ko', 'pt', 'ja', 'zh'],
  output: 'public/locales/$LOCALE/$NAMESPACE.json',
  input: ['src/**/*.{ts,tsx}'],
  defaultNamespace: 'common',
  namespaceSeparator: ':',
  keySeparator: '.',
  createOldCatalogs: false,
  failOnUpdate: false,
  failOnWarnings: false,
  verbose: true,
  sort: true,
  // Keep existing translations, only add new keys
  keepRemoved: false,
  defaultValue: (locale, _namespace, key) => {
    // English gets the key as default, other locales get empty string
    return locale === 'en' ? key : ''
  },
}
