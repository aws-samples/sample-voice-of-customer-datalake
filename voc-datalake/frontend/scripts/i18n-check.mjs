#!/usr/bin/env node

/**
 * @fileoverview Comprehensive i18n translation audit.
 *
 * Checks performed:
 *   1. Missing keys   — keys in English but absent in a target locale
 *   2. Extra keys     — keys in a target locale but absent in English (ignoring valid plural variants)
 *   3. Empty values   — keys whose value is an empty string or whitespace-only
 *   4. Unused keys    — keys in English that are never referenced by source code t() calls
 *   5. Missing in source — t() calls in source code that reference keys not found in English files
 *
 * Usage:  node scripts/i18n-check.mjs
 *
 * Exit codes:
 *   0 – everything is clean
 *   1 – problems detected
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

/* eslint-disable security/detect-non-literal-fs-filename -- Build script with controlled paths from known base directories */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const LOCALES_DIR = resolve(__dirname, '..', 'public', 'locales')
const SRC_DIR = resolve(__dirname, '..', 'src')

/**
 * Validate that a resolved path stays within an allowed base directory.
 * Prevents path-traversal attacks when building paths from dynamic segments.
 */
function safePath(base, ...segments) {
  const resolved = normalize(resolve(base, ...segments))
  if (!resolved.startsWith(normalize(base) + '/') && resolved !== normalize(base)) {
    throw new Error(`Path traversal detected: ${resolved} is outside ${base}`)
  }
  return resolved
}

const SOURCE_LANG = 'en'
const LANGUAGES = ['es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko']
const NAMESPACES = ['categories', 'chat', 'common', 'components', 'dashboard', 'dataExplorer', 'feedback', 'feedbackDetail', 'feedbackForms', 'login', 'prioritization', 'problemAnalysis', 'projectDetail', 'projects', 'scrapers', 'settings']
const DEFAULT_NS = 'common'

// ── helpers ──────────────────────────────────────────────────────────

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

function pluralBase(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length)
  }
  return null
}

/** Flatten nested object into { 'dot.path': value } entries. */
function flattenEntries(obj, prefix = '') {
  const entries = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenEntries(value, fullKey))
    } else {
      entries.push([fullKey, value])
    }
  }
  return entries
}

function loadLocale(lang, ns) {
  const filePath = safePath(LOCALES_DIR, lang, `${ns}.json`)
  if (!existsSync(filePath)) return null
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

function isValidPluralVariant(key, sourceKeys) {
  const base = pluralBase(key)
  if (!base) return false
  return PLURAL_SUFFIXES.some((s) => sourceKeys.has(`${base}${s}`))
}

/** Recursively collect all .tsx / .ts files under a directory. */
function collectSourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(safePath(dir, '.'))) {
    const full = safePath(dir, entry)
    if (entry === 'node_modules' || entry === 'dist' || entry === 'test' || entry.endsWith('.test.tsx') || entry.endsWith('.test.ts')) continue
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      files.push(full)
    }
  }
  return files
}

/**
 * Extract t('key') / t("key") calls from source code.
 * Handles:
 *   t('key')                        → namespace = default
 *   t('key', { ns: 'settings' })   → namespace = settings
 *   t('ns:key')                     → namespace = ns
 *   useTranslation('ns') … t('key') → namespace = ns
 */
function extractKeysFromSource(files) {
  const usedKeys = new Set()  // Set of "ns:key"

  for (const file of files) {
    const content = readFileSync(file, 'utf-8')

    // Detect useTranslation('namespace') to know the file-level namespace
    let fileNs = DEFAULT_NS
    const nsMatch = content.match(/useTranslation\(\s*['"](\w+)['"]\s*\)/)
    if (nsMatch) fileNs = nsMatch[1]

    // Match t('...') and t("...")
    // Handles: t('key'), t('key', ...), t(`key`)
    // Extract t('key') and t('key', { ns: 'foo' }) calls
    // eslint-disable-next-line security/detect-unsafe-regex -- Bounded by line-level input; no user-controlled data
    const tCallRegex = /\bt\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{[^}]*?ns:\s*['"](\w+)['"])?/g
    let match
    while ((match = tCallRegex.exec(content)) !== null) {
      const rawKey = match[1]
      const explicitNs = match[2]

      // Handle ns:key syntax
      if (rawKey.includes(':')) {
        const [ns, key] = rawKey.split(':', 2)
        usedKeys.add(`${ns}:${key}`)
      } else {
        const ns = explicitNs || fileNs
        usedKeys.add(`${ns}:${rawKey}`)
      }
    }
  }

  return usedKeys
}

// ── Check 1 & 2: Missing / Extra keys per locale ────────────────────

let totalMissing = 0
let totalExtra = 0
let totalEmpty = 0
const report = []

// Build a map of all English keys per namespace (for check 4/5)
const allEnglishKeys = new Map() // ns → Set<key>

for (const ns of NAMESPACES) {
  const sourceData = loadLocale(SOURCE_LANG, ns)
  if (!sourceData) {
    console.warn(`⚠  Source file missing: ${SOURCE_LANG}/${ns}.json — skipping namespace`)
    continue
  }
  const sourceEntries = flattenEntries(sourceData)
  const sourceKeys = new Set(sourceEntries.map(([k]) => k))
  allEnglishKeys.set(ns, sourceKeys)

  for (const lang of [SOURCE_LANG, ...LANGUAGES]) {
    const targetData = loadLocale(lang, ns)

    if (!targetData) {
      if (lang !== SOURCE_LANG) {
        report.push({ lang, ns, missing: [...sourceKeys], extra: [], empty: [], fileExists: false })
        totalMissing += sourceKeys.size
      }
      continue
    }

    const targetEntries = flattenEntries(targetData)
    const targetKeys = new Set(targetEntries.map(([k]) => k))

    // Empty values
    const empty = targetEntries
      .filter(([, v]) => typeof v === 'string' && v.trim() === '')
      .map(([k]) => k)

    if (lang === SOURCE_LANG) {
      // For English, only report empty values
      if (empty.length > 0) {
        report.push({ lang, ns, missing: [], extra: [], empty, fileExists: true })
        totalEmpty += empty.length
      }
      continue
    }

    const missing = [...sourceKeys].filter((k) => !targetKeys.has(k))
    const extra = [...targetKeys].filter((k) => !sourceKeys.has(k) && !isValidPluralVariant(k, sourceKeys))

    if (missing.length > 0 || extra.length > 0 || empty.length > 0) {
      report.push({ lang, ns, missing, extra, empty, fileExists: true })
      totalMissing += missing.length
      totalExtra += extra.length
      totalEmpty += empty.length
    }
  }
}

// ── Check 3: Source code t() calls vs English keys ───────────────────

const sourceFiles = collectSourceFiles(SRC_DIR)
const usedKeys = extractKeysFromSource(sourceFiles)

const missingInEnglish = []  // keys used in code but not in English files
const unusedInEnglish = []   // keys in English files but never referenced in code

// Collect all English keys as "ns:key" for comparison
const allEnglishFlat = new Set()
for (const [ns, keys] of allEnglishKeys) {
  for (const key of keys) {
    allEnglishFlat.add(`${ns}:${key}`)
    // Also add without plural suffix for matching t('base', { count })
    const base = pluralBase(key)
    if (base) allEnglishFlat.add(`${ns}:${base}`)
  }
}

for (const usedKey of usedKeys) {
  if (!allEnglishFlat.has(usedKey)) {
    // Check if it's a dynamic key pattern (contains {{ or variable)
    const keyPart = usedKey.split(':')[1]
    if (keyPart && !keyPart.includes('$') && !keyPart.includes('{')) {
      missingInEnglish.push(usedKey)
    }
  }
}

// Check for unused English keys (skip plural variants of used bases)
for (const [ns, keys] of allEnglishKeys) {
  for (const key of keys) {
    const fullKey = `${ns}:${key}`
    const base = pluralBase(key)
    const baseKey = base ? `${ns}:${base}` : null

    const isUsed = usedKeys.has(fullKey) || (baseKey && usedKeys.has(baseKey))
    if (!isUsed) {
      unusedInEnglish.push(fullKey)
    }
  }
}

// ── output ───────────────────────────────────────────────────────────

let hasProblems = false

if (report.length > 0) {
  hasProblems = true
  console.log('\n🌐  i18n Translation Coverage Report')
  console.log('═'.repeat(60))

  const byLang = {}
  for (const entry of report) {
    if (!byLang[entry.lang]) byLang[entry.lang] = []
    byLang[entry.lang].push(entry)
  }

  for (const [lang, entries] of Object.entries(byLang)) {
    const langMissing = entries.reduce((sum, e) => sum + e.missing.length, 0)
    const langExtra = entries.reduce((sum, e) => sum + e.extra.length, 0)
    const langEmpty = entries.reduce((sum, e) => sum + e.empty.length, 0)

    console.log(`\n┌─ ${lang.toUpperCase()} ─ missing: ${langMissing}, extra: ${langExtra}, empty: ${langEmpty}`)

    for (const entry of entries) {
      if (!entry.fileExists) {
        console.log(`│  ⛔ ${entry.ns}.json — FILE MISSING (${entry.missing.length} keys needed)`)
        continue
      }
      if (entry.missing.length > 0) {
        console.log(`│  📂 ${entry.ns}.json — ${entry.missing.length} missing key(s):`)
        for (const key of entry.missing) console.log(`│     ❌ ${key}`)
      }
      if (entry.extra.length > 0) {
        console.log(`│  📂 ${entry.ns}.json — ${entry.extra.length} extra key(s):`)
        for (const key of entry.extra) console.log(`│     ➕ ${key}`)
      }
      if (entry.empty.length > 0) {
        console.log(`│  📂 ${entry.ns}.json — ${entry.empty.length} empty value(s):`)
        for (const key of entry.empty) console.log(`│     🔲 ${key}`)
      }
    }
    console.log('└' + '─'.repeat(59))
  }

  console.log(`\nTotal missing: ${totalMissing}  |  Total extra: ${totalExtra}  |  Total empty: ${totalEmpty}`)
}

if (missingInEnglish.length > 0) {
  hasProblems = true
  console.log('\n⚠️  Keys used in source code but MISSING from English translation files:')
  console.log('─'.repeat(60))
  for (const key of missingInEnglish.sort()) {
    console.log(`  ❌ ${key}`)
  }
}

if (unusedInEnglish.length > 0) {
  // This is informational, not a failure
  console.log(`\nℹ️  ${unusedInEnglish.length} English key(s) not directly referenced in source code (may be dynamic):`)
  console.log('─'.repeat(60))
  for (const key of unusedInEnglish.sort()) {
    console.log(`  ⚪ ${key}`)
  }
}

if (!hasProblems && unusedInEnglish.length === 0) {
  console.log('\n✅  All translations are in sync with English source. No empty values. All keys used.\n')
} else if (!hasProblems) {
  console.log('\n✅  All translations are in sync. No empty values.\n')
}

// ── Check 4: Components without useTranslation ──────────────────────

const pagesDir = join(SRC_DIR, 'pages')
const componentsDir = join(SRC_DIR, 'components')

function findUntranslatedComponents(baseDir) {
  const results = []
  for (const entry of readdirSync(baseDir)) {
    const dirPath = join(baseDir, entry)
    if (!statSync(dirPath).isDirectory()) continue
    const tsxFiles = readdirSync(dirPath).filter(
      (f) => (f.endsWith('.tsx') || f.endsWith('.ts')) && !f.endsWith('.test.tsx') && !f.endsWith('.test.ts')
    )
    if (tsxFiles.length === 0) continue

    const hasI18n = tsxFiles.some((f) => {
      const content = readFileSync(join(dirPath, f), 'utf-8')
      return content.includes('useTranslation')
    })

    if (!hasI18n) {
      // Check if any file has user-visible hardcoded strings (rough heuristic)
      let hardcodedCount = 0
      for (const f of tsxFiles) {
        const content = readFileSync(join(dirPath, f), 'utf-8')
        // Count JSX text patterns: >{Some Text}<  or  "Label text"  in JSX attributes
        const jsxTextMatches = content.match(/>\s*[A-Z][a-zA-Z ]{2,}</) || [] // NOSONAR
        hardcodedCount += jsxTextMatches.length
      }
      if (hardcodedCount > 0) {
        results.push({ name: entry, files: tsxFiles.length, hardcodedEstimate: hardcodedCount })
      }
    }
  }
  return results
}

const untranslatedPages = findUntranslatedComponents(pagesDir)
const untranslatedComponents = findUntranslatedComponents(componentsDir)

if (untranslatedPages.length > 0 || untranslatedComponents.length > 0) {
  console.log('\n🔤  Components/pages with hardcoded English (no useTranslation):')
  console.log('─'.repeat(60))
  if (untranslatedPages.length > 0) {
    console.log('  Pages:')
    for (const p of untranslatedPages) {
      console.log(`    📄 ${p.name}/ — ${p.files} file(s), ~${p.hardcodedEstimate} hardcoded string(s)`)
    }
  }
  if (untranslatedComponents.length > 0) {
    console.log('  Components:')
    for (const c of untranslatedComponents) {
      console.log(`    📄 ${c.name}/ — ${c.files} file(s), ~${c.hardcodedEstimate} hardcoded string(s)`)
    }
  }
}

/* eslint-enable security/detect-non-literal-fs-filename */

process.exit(hasProblems ? 1 : 0)