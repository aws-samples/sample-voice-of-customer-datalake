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
 *   6. Untranslated   — target values identical to English (informational only)
 *
 * Usage:  node scripts/i18n-check.mjs
 *
 * Exit codes:
 *   0 – no missing, extra, empty or missing-in-source keys (checks 4 and 6 never fail)
 *   1 – problems detected
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flattenEntries, loadLocale, localeNamespaces, safePath, stripPlaceholders } from './i18n-locales.mjs'
import { extractKeyUsages, isValidPluralVariant, pluralBase, resolveKeyUsages } from './i18n-keys.mjs'


const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SRC_DIR = resolve(__dirname, '..', 'src')

const SOURCE_LANG = 'en'
const LANGUAGES = ['es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko']
const NAMESPACES = localeNamespaces(SOURCE_LANG)
const DEFAULT_NS = 'common'

// ── helpers ──────────────────────────────────────────────────────────

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
 * Every translation key the source files use, as `{ namespaces, key }` usages:
 * the `t(...)` calls (scope-resolved through their `useTranslation` hook — see
 * `i18n-keys.mjs`) plus the keys held in data tables.
 */
function extractKeysFromSource(files) {
  const usages = []
  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    usages.push(...extractKeyUsages(file, content, { defaultNs: DEFAULT_NS, namespaces: NAMESPACES }))
    for (const dataKey of extractDataHeldKeys(content, file)) {
      const [ns, key] = dataKey.split(':', 2)
      usages.push({ namespaces: [ns], key })
    }
  }
  return usages
}

/**
 * Collect namespace-qualified keys held in DATA rather than passed straight to
 * t(), e.g. the nav/phase tables:
 *
 *   { to: '/x', labelKey: 'common:nav.categories' }
 *
 * These reach t() indirectly (`t(item.labelKey)`), so the t() regex cannot see
 * them and a deleted key stays invisible to this gate. That is how
 * `common:nav.feedback` survived long after the key was removed — the landing
 * page rendered the literal text "nav.feedback" in every locale while the gate
 * reported all translations in sync.
 *
 * The namespace must be one we actually ship. Without that constraint any
 * property whose name ends in "Key" holding a colon-separated string would be
 * collected — `cacheKey: 'user:123'`, `sortKey: 'a:b'` — and then reported as a
 * missing translation key, failing the gate on code that is perfectly fine.
 *
 * @param content source text of one file
 * @param file path to that file, used only to locate a suspected typo in the
 *   warning message
 * @returns "ns:key" strings
 */
function extractDataHeldKeys(content, file) {
  const found = []
  const dataKeyRegex = /\b\w*[Kk]ey:\s*['"](\w+):([\w.]+)['"]/g
  let match
  while ((match = dataKeyRegex.exec(content)) !== null) {
    const [, ns, key] = match
    if (NAMESPACES.includes(ns)) {
      found.push(`${ns}:${key}`)
    } else if (/^[a-z]+$/i.test(ns) && key.includes('.')) {
      // Don't drop a near-miss silently: a mistyped namespace
      // (`commmon:nav.categories`) is exactly the class of bug this extractor
      // exists to catch, and skipping it quietly would recreate the blind spot.
      //
      // Warned rather than failed, because the namespace list is the only thing
      // separating a real key from an unrelated `foo:bar` string. The guard is
      // deliberately narrow — an alphabetic namespace AND a dotted key path — so
      // `cacheKey: 'user:123'` and `sortKey: 'a:b'` stay silent while anything
      // actually shaped like a translation key gets surfaced.
      console.warn(
        `⚠️  ${file}: '${ns}:${key}' is shaped like a translation key but '${ns}' is not a known namespace — typo?`,
      )
    }
  }
  return found
}

// ── Check 1 & 2: Missing / Extra keys per locale ────────────────────

let totalMissing = 0
let totalExtra = 0
let totalEmpty = 0
let totalUntranslated = 0
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
        report.push({ lang, ns, missing: [...sourceKeys], extra: [], empty: [], untranslated: [], fileExists: false })
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
        report.push({ lang, ns, missing: [], extra: [], empty, untranslated: [], fileExists: true })
        totalEmpty += empty.length
      }
      continue
    }

    const missing = [...sourceKeys].filter((k) => !targetKeys.has(k))
    const extra = [...targetKeys].filter((k) => !sourceKeys.has(k) && !isValidPluralVariant(k, sourceKeys))

    // Check for untranslated values — target value identical to English source
    const sourceMap = new Map(sourceEntries)
    const untranslated = targetEntries
      .filter(([k, v]) => {
        if (typeof v !== 'string' || v.trim() === '') return false
        const sourceVal = sourceMap.get(k)
        if (typeof sourceVal !== 'string') return false
        // Skip short values (1-3 chars) that are likely the same across languages
        // (e.g. "PDF", "URL", "OK", abbreviations, numbers like "24h")
        if (v.length <= 3) return false
        // Skip values that are URLs, placeholders, or technical strings
        if (v.startsWith('http') || v.startsWith('@') || v.startsWith('#')) return false
        // Skip values containing only template variables like "{{count}}"
        if (stripPlaceholders(v).trim().length === 0) return false
        return v === sourceVal
      })
      .map(([k]) => k)

    if (missing.length > 0 || extra.length > 0 || empty.length > 0 || untranslated.length > 0) {
      report.push({ lang, ns, missing, extra, empty, untranslated, fileExists: true })
      totalMissing += missing.length
      totalExtra += extra.length
      totalEmpty += empty.length
      totalUntranslated += untranslated.length
    }
  }
}

// ── Check 3: Source code t() calls vs English keys ───────────────────

const sourceFiles = collectSourceFiles(SRC_DIR)
const { used: usedKeys, missing: missingInEnglish } = resolveKeyUsages(extractKeysFromSource(sourceFiles), allEnglishKeys)

const unusedInEnglish = []   // keys in English files but never referenced in code

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
  // Untranslated values are printed but do not fail the audit: a value equal
  // to English is often correct (cognates and product terms — "Persona",
  // "PR/FAQ", "Scrapers", "Source ID"), so it is a prompt for a reviewer, not a
  // defect. Missing, extra and empty keys are defects.
  hasProblems = totalMissing + totalExtra + totalEmpty > 0
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
    const langUntranslated = entries.reduce((sum, e) => sum + (e.untranslated?.length || 0), 0)

    console.log(`\n┌─ ${lang.toUpperCase()} ─ missing: ${langMissing}, extra: ${langExtra}, empty: ${langEmpty}, untranslated: ${langUntranslated}`)

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
      if (entry.untranslated?.length > 0) {
        console.log(`│  📂 ${entry.ns}.json — ${entry.untranslated.length} untranslated (same as English):`)
        for (const key of entry.untranslated.slice(0, 10)) console.log(`│     🔤 ${key}`)
        if (entry.untranslated.length > 10) console.log(`│     ... and ${entry.untranslated.length - 10} more`)
      }
    }
    console.log('└' + '─'.repeat(59))
  }

  console.log(`\nTotal missing: ${totalMissing}  |  Total extra: ${totalExtra}  |  Total empty: ${totalEmpty}  |  Total untranslated: ${totalUntranslated}`)
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


process.exit(hasProblems ? 1 : 0)