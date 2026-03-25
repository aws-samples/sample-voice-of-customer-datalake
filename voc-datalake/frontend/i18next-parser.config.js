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
  // Keep existing translations — many keys are referenced dynamically
  // (e.g. t(item.labelKey)) and can't be statically detected by the parser.
  keepRemoved: true,
  defaultValue: (locale, _namespace, key) => {
    // English gets the key as default, other locales get empty string
    return locale === 'en' ? key : ''
  },
}
