#!/usr/bin/env node
/**
 * Translate the i18n delta using Amazon Bedrock (Claude Haiku 5.5): write the new strings in English
 * (public/locales/en), then run this; it finds the keys missing or empty in each target locale and
 * translates only those, in batches. Each batch carries the page description and the JSX lines where
 * every key is used, so the model sees the UI context of a string, not just the string.
 *
 * Usage: node scripts/fix-i18n.mjs [--lang <code>]... [--ns <namespace>]... [--keys <a.b,c.d>] [--recheck-english]
 *   --lang / --ns       only these locales / catalogues (repeatable or comma-separated; default: all)
 *   --keys              only these dotted keys (plus their plural forms and list items)
 *   --recheck-english   also retranslate values still identical to English (the old default; many strings)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { resolve, join, isAbsolute, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { collectSourceFiles, stripPlaceholders } from './i18n-locales.mjs'
import { setNested, UNSAFE_SEGMENTS } from './set-nested.mjs'
import {
  flattenEntries, getNested, isStringList, keySelected, listItemOf, missingPluralForms, parseAnswer, parseOptions,
  resolveEnValue,
} from './fix-i18n-helpers.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const LOCALES_DIR = resolve(__dirname, '..', 'public', 'locales')
// Must match the shipped catalogues in public/locales/<lang>/ — `src/i18n/options.test.ts`
// compares this list, i18n-check.mjs's copy, src/i18n/options.ts and src/test/setup.ts
// against the files on disk. `feedback` was listed here with no catalogue in any
// locale, so every run tried to load a namespace that does not exist.
const NAMESPACES = ['agents', 'assistant', 'assistantTools', 'briefing', 'categories', 'common', 'components', 'dashboard',
  'dataExplorer', 'decisions', 'emailInbox', 'featureRequests', 'feedbackDetail', 'feedbackForms', 'login', 'memory',
  'participants', 'prioritization', 'problemAnalysis', 'projectDetail', 'projects', 'radar', 'scrapers', 'settings']
const ALL_LANGUAGES = ['es', 'fr', 'de', 'ko', 'pt', 'ja', 'zh', 'pl']
const LANG_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German',
  ko: 'Korean', pt: 'Portuguese', ja: 'Japanese', zh: 'Simplified Chinese', pl: 'Polish',
}
// The address the existing catalogue uses, so a new string matches it (a review caught "Du" in 5.65.00).
const LANG_STYLE = {
  de: 'Address the reader formally with "Sie" (Sie / Ihr / Ihnen), never "du", as the rest of the German UI does',
}
// Haiku 5.5 through the global cross-region profile (the app's own allowlist id). It rejects
// `temperature` (like Sonnet 5.x and every Opus), so the request body sets none.
const MODEL_ID = 'global.anthropic.claude-haiku-5-5'
const REGION = 'us-east-1'
const BATCH_SIZE = 60
const OPTIONS = parseOptions(process.argv.slice(2), { languages: ALL_LANGUAGES, namespaces: NAMESPACES })
const LANGUAGES = OPTIONS.languages

/** Drop, in place, the `[key, …]` entries `--keys` did not select. */
function keepSelected(entries) {
  entries.splice(0, entries.length, ...entries.filter(([key]) => keySelected(key, OPTIONS.keys)))
}

/**
 * Absolute path of the AWS CLI. `AWS_CLI` (absolute) wins; otherwise the first
 * `aws` found in an ABSOLUTE `PATH` entry. Relative entries (`.`, `bin`) are
 * skipped — they would let a file in the working directory stand in for the CLI
 * that receives the caller's credentials.
 */
function awsCli() {
  const override = process.env.AWS_CLI
  if (override) {
    if (!isAbsolute(override)) throw new Error('AWS_CLI must be an absolute path')
    return override
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, 'aws')
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error('AWS CLI not found on an absolute PATH entry (set AWS_CLI)')
}

// Context descriptions for each namespace so the LLM understands
// where these strings appear in the UI
const NS_CONTEXT = {
  categories: 'Category breakdown page — shows feedback categories, sentiment filters, keyword clouds, and PDF export for a customer feedback analytics dashboard.',
  assistant: 'Unified AI assistant — floating bubble / expanded panel / full screen on every page and the /chat page. Page-aware chat about customer feedback and projects; write actions need explicit approval. Includes suggested prompts, past conversations and export.',
  assistantTools: 'AI assistant approval cards — each proposed write (create/update/delete documents, personas, projects, product context, feedback forms, research and generation jobs, scraper runs, brand settings) is shown with a preview/diff and Approve / Decline buttons, plus its executed / failed / declined / expired outcome.',
  common: 'Shared UI strings — navigation menu, sidebar, breadcrumbs, time range selectors, sentiment labels, pagination, and global filter controls used across all pages.',
  components: 'Reusable UI components — data source wizard (multi-step form), feedback cards, social feed, S3 file import, user administration panel, user profile/password management, document/persona export menus.',
  dashboard: 'Main dashboard — overview page with metric cards (total feedback, sentiment, urgent issues), charts (volume trend, source breakdown, sentiment distribution), and a live social feed.',
  dataExplorer: 'Data Explorer page — browse raw S3 data files and processed DynamoDB feedback records. Includes file editing, JSON preview, and category statistics.',
  feedback: 'Feedback list page — filterable, searchable, paginated list of all customer feedback items with sentiment and source filters.',
  feedbackDetail: 'Feedback detail page — single feedback item view showing classification, persona, problem analysis, root cause, suggested customer responses, similar feedback, and translation info.',
  feedbackForms: 'Feedback Forms page — create and manage embeddable Typeform-style feedback collection forms with rating types, themes, category routing, and embed code generation.',
  login: 'Login page — Cognito authentication with username/password, forgot password flow, verification code, and new password setup.',
  prioritization: 'Prioritization page — score and rank PR/FAQ documents across projects using Impact, Time to Market, Strategic Fit, and Confidence dimensions.',
  problemAnalysis: 'Problem Analysis page — hierarchical tree view of problems grouped by category/subcategory with similarity clustering, urgency flags, and resolve/unresolve actions.',
  projectDetail: 'Project Detail page — single research project view with tabs for Overview (generate personas/PRDs/PR-FAQs), Personas (view/edit/import user personas with AI avatars), Documents (PRDs, PR-FAQs, research), AI Chat (project-scoped), and MCP Access (API tokens). Includes Working Backwards wizard with Amazon\'s 5 Customer Questions.',
  projects: 'Projects list page — shows all research projects with persona/document counts, create/delete project modals.',
  scrapers: 'Data Sources page — configure web scrapers (CSS selectors, pagination, auto-detect), manual import (paste reviews with AI parsing), JSON upload, and app review plugin configuration.',
  settings: 'Settings page — tabs for General (API endpoint, brand config, language), Categories (AI-generated feedback categories), Data Sources (integrations), Users (Cognito admin), and Logs (scraper runs, processing errors).',
}

const SRC_DIR = resolve(__dirname, '..', 'src')

// ── Source code context extraction ──
// Scans frontend source files to find where each i18n key is used,
// extracting surrounding JSX/TSX lines so the LLM can see the UI context
// (e.g. button label vs tooltip vs paragraph).

/** Extract i18n key usages from a single source file. */
function extractFileKeyUsages(file) {
  const content = readFileSync(file, 'utf-8')
  if (!content.includes('useTranslation') && !content.includes("t('") && !content.includes('t("')) return []

  const lines = content.split('\n')
  let fileNs = 'common'
  const nsMatch = content.match(/useTranslation\(\s*['"](\w+)['"]\s*\)/)
  if (nsMatch) fileNs = nsMatch[1]

  const results = []
  for (let i = 0; i < lines.length; i++) {
    const tMatches = lines[i].matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)
    for (const m of tMatches) {
      const rawKey = m[1]
      const [ns, key] = rawKey.includes(':') ? rawKey.split(':', 2) : [fileNs, rawKey]
      const start = Math.max(0, i - 1)
      const end = Math.min(lines.length - 1, i + 1)
      const snippet = lines.slice(start, end + 1).map(l => l.trim()).join('\n')
      results.push([`${ns}:${key}`, snippet])
    }
  }
  return results
}

/** Build a map of i18n key → source code snippet showing where it's used. */
function buildKeyUsageMap() {
  const sourceFiles = collectSourceFiles(SRC_DIR)
  const usageMap = new Map()
  for (const file of sourceFiles) {
    for (const [fullKey, snippet] of extractFileKeyUsages(file)) {
      if (!usageMap.has(fullKey)) usageMap.set(fullKey, snippet)
    }
  }
  return usageMap
}

let _keyUsageMap = null
function getKeyUsageMap() {
  if (!_keyUsageMap) {
    console.log('📖 Scanning source code for key usage context...')
    _keyUsageMap = buildKeyUsageMap()
    console.log(`   Found usage context for ${_keyUsageMap.size} keys`)
  }
  return _keyUsageMap
}

/**
 * Build a compact UI context string for a batch of keys.
 * Shows where each key appears in the source code (JSX context).
 */
function buildSourceContext(keys, namespace) {
  const usageMap = getKeyUsageMap()
  const snippets = []
  for (const key of keys) {
    const fullKey = `${namespace}:${key}`
    const snippet = usageMap.get(fullKey)
    if (snippet) snippets.push(`"${key}" is used in:\n${snippet}`)
  }
  if (snippets.length === 0) return ''
  // Cap at ~30 snippets to avoid blowing up the prompt
  const capped = snippets.slice(0, 30)
  const result = capped.join('\n\n')
  if (snippets.length > 30) {
    return result + `\n\n... and ${snippets.length - 30} more keys with similar UI patterns.`
  }
  return result
}

// ── helpers ──

function loadJSON(lang, ns) {
  const p = join(LOCALES_DIR, lang, `${ns}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : {}
}

function saveJSON(lang, ns, data) {
  const dir = join(LOCALES_DIR, lang)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${ns}.json`), JSON.stringify(data, null, 2) + '\n')
}

// ── Bedrock translation via AWS CLI ──

function translateBatch(kvPairs, targetLang, namespace) {
  const langName = LANG_NAMES[targetLang]
  const input = Object.fromEntries(kvPairs)
  const nsContext = NS_CONTEXT[namespace] || ''
  const sourceContext = buildSourceContext(kvPairs.map(([k]) => k), namespace)

  const prompt = `You are translating UI strings for a SaaS customer feedback analytics platform called "VoC Analytics" (Voice of the Customer). The application helps businesses collect, analyze, and act on customer feedback from multiple sources.

CONTEXT: These strings belong to the "${namespace}" namespace.
${nsContext ? `PAGE/COMPONENT: ${nsContext}` : ''}
${sourceContext ? `\nSOURCE CODE CONTEXT (shows how each key is used in the React UI):\n${sourceContext}\n` : ''}

Translate the following JSON values from English to ${langName}.

RULES:
- Return ONLY a valid JSON object with the exact same keys
- Keep all {{variables}} exactly as-is (e.g. {{count, number}}, {{summary}}, {{name}}, {{error}}, {{percent}})
- Keep HTML tags (<code>, <strong>, <at>, <atAll>, <hash>, etc.) exactly as-is
- Keep URLs, email addresses, and technical identifiers as-is
- Keep product names as-is: "VoC Analytics", "Kiro", "Claude", "Amazon", "Bedrock", "Cognito", "MCP"
- Keep technical terms as-is: JSON, PDF, CSV, URL, API, S3, PRD, PR-FAQ, DynamoDB, CloudWatch, SSE, Markdown
- Keep file extensions and code references as-is: .json, mcp.json, Authorization
- For plural forms (keys ending _zero, _one, _two, _few, _many, _other): write the ${langName} grammatical form for that CLDR plural category and keep {{count}} in it. A key may arrive whose English text is the _other form (e.g. a ${langName} _few or _many form English does not have): still give the correct ${langName} form for that category
- Use natural, professional ${langName} appropriate for a B2B SaaS dashboard — avoid overly formal or literal translations${LANG_STYLE[targetLang] ? `\n- ${LANG_STYLE[targetLang]}` : ''}
- For UI actions (buttons, labels), prefer concise wording that fits in compact UI elements
- Do NOT add markdown fences or any text outside the JSON

Input:
${JSON.stringify(input, null, 2)}`

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  }

  const tmpDir = resolve(__dirname, '..', '.i18n-tmp')
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  const tmpIn = join(tmpDir, 'bedrock-i18n-in.json')
  const tmpOut = join(tmpDir, 'bedrock-i18n-out.json')
  writeFileSync(tmpIn, JSON.stringify(body))

  try {
    const args = [
      'bedrock-runtime', 'invoke-model',
      '--model-id', MODEL_ID,
      '--region', REGION,
      '--content-type', 'application/json',
      '--accept', 'application/json',
      '--body', 'fileb://' + tmpIn,
      tmpOut,
    ]
    execFileSync(awsCli(), args, { stdio: 'pipe', timeout: 120_000 })
    const resp = JSON.parse(readFileSync(tmpOut, 'utf-8'))
    return parseAnswer(resp)
  } catch (err) {
    console.error(`  ⚠ Bedrock call failed for ${langName}:`, err.message)
    return null
  }
}

// ── Main ──

let totalFixed = 0
let totalSkipped = 0
let totalUnwritable = 0

for (const lang of LANGUAGES) {
  console.log(`\n🌐 Processing ${lang.toUpperCase()} (${LANG_NAMES[lang]})`)

  for (const ns of OPTIONS.namespaces) {
    const enData = loadJSON('en', ns)
    const targetData = loadJSON(lang, ns)
    const enEntries = flattenEntries(enData)

    // Collect keys that are missing, empty, or untranslated (still in English) in target
    const toFix = []
    // String-list values (e.g. suggested responses) are sent item by item as `<key>.<i>` and
    // reassembled into a list after the batches; the whole list is redone when any item is missing.
    const listKeys = []
    for (const [key, enValue] of enEntries) {
      if (isStringList(enValue)) {
        if (!isStringList(getNested(targetData, key)) || getNested(targetData, key).length !== enValue.length) {
          listKeys.push([key, enValue.length])
          enValue.forEach((item, i) => toFix.push([`${key}.${i}`, item]))
        }
        continue
      }
      const targetValue = getNested(targetData, key)
      const resolved = resolveEnValue(enData, enValue)
      if (typeof resolved !== 'string' || resolved.trim() === '') continue

      const isMissing = targetValue === undefined
      const isEmpty = typeof targetValue === 'string' && targetValue.trim() === ''
      // Still identical to English: retranslated only on request (`--recheck-english`), so an
      // ordinary run sends just the missing or empty keys, not hundreds of strings again.
      const isUntranslated = OPTIONS.recheckEnglish
        && typeof targetValue === 'string'
        && targetValue === resolved
        && targetValue.length > 3
        && !targetValue.startsWith('http')
        && !targetValue.startsWith('@')
        && !targetValue.startsWith('#')
        && stripPlaceholders(targetValue).trim().length > 0

      if (isMissing || isEmpty || isUntranslated) {
        toFix.push([key, resolved])
      }
    }

    // Plural forms the target language has and English does not (Polish `_few` / `_many`,
    // French `_many`): i18next asks for them by the language's CLDR categories, and a missing
    // one falls back to English. Queue each with the English `_other` text as its source.
    for (const pair of missingPluralForms(enData, enEntries, targetData, lang)) {
      if (!toFix.some(([k]) => k === pair[0])) toFix.push(pair)
    }

    // Also fix empty _many/_one/_other plural forms in target that don't exist in English.
    // These are added by i18next-parser for languages with those plural rules.
    // Use the _other form (or base form) as source text.
    const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']
    const targetEntries = flattenEntries(targetData)
    const directCopy = [] // keys where we can copy from an existing translated form
    for (const [key, val] of targetEntries) {
      if (typeof val === 'string' && val.trim() === '') {
        // Already queued for Bedrock?
        if (toFix.some(([k]) => k === key)) continue
        // Find a source: try _other in target first (already translated)
        for (const suffix of PLURAL_SUFFIXES) {
          if (key.endsWith(suffix)) {
            const base = key.slice(0, -suffix.length)
            const otherVal = getNested(targetData, `${base}_other`)
            if (otherVal && typeof otherVal === 'string' && otherVal.trim() !== '') {
              directCopy.push([key, otherVal])
              break
            }
            // Fallback: queue for Bedrock with English base
            const enBase = getNested(enData, base)
            if (enBase && typeof enBase === 'string' && enBase.trim() !== '') {
              toFix.push([key, enBase])
              break
            }
          }
        }
      }
    }

    // Only the selected keys (`--keys`), and only the delta unless `--recheck-english`.
    keepSelected(toFix)
    keepSelected(directCopy)
    keepSelected(listKeys)

    // Apply direct copies immediately (no Bedrock needed)
    for (const [key, val] of directCopy) {
      setNested(targetData, key, val)
      totalFixed++
    }
    if (directCopy.length > 0) {
      console.log(`  📂 ${ns}.json — ${directCopy.length} plural forms copied from _other`)
    }

    if (toFix.length === 0 && directCopy.length === 0) continue

    if (toFix.length === 0) {
      // Only direct copies, already applied — just save
      saveJSON(lang, ns, targetData)
      continue
    }
    console.log(`  📂 ${ns}.json — ${toFix.length} strings to translate`)

    // Translate in batches
    const listItems = new Map()
    // setNested refuses any key with a `__proto__` / `constructor` / `prototype` segment
    // (prototype-pollution guard, set-nested.mjs). Real catalogue keys such as
    // `documents.prototype.build` can therefore not be written here: report them instead of
    // paying to translate strings that would be dropped.
    const unwritable = toFix.filter(([key]) => key.split('.').some((part) => UNSAFE_SEGMENTS.has(part)))
    if (unwritable.length > 0) {
      console.log(`    ⚠ ${unwritable.length} keys under a guarded segment need adding by hand: ${unwritable.map(([k]) => k).join(', ')}`)
      totalUnwritable += unwritable.length
      toFix.splice(0, toFix.length, ...toFix.filter((pair) => !unwritable.includes(pair)))
    }
    for (let i = 0; i < toFix.length; i += BATCH_SIZE) {
      const batch = toFix.slice(i, i + BATCH_SIZE)
      console.log(`    Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} strings...`)

      const translations = translateBatch(batch, lang, ns)
      // A failed batch or key is LEFT missing, not filled with English: the app already falls
      // back to English for a missing key, and a re-run then finds the gap again (an English
      // copy of a short string like "Off" would look translated and never be retried).
      if (!translations) {
        console.log(`    ⚠ Batch left untranslated (re-run to retry)`)
        totalSkipped += batch.length
        continue
      }

      for (const [key] of batch) {
        if (translations[key] && typeof translations[key] === 'string') {
          if (listItemOf(key, listKeys)) listItems.set(key, translations[key])
          else setNested(targetData, key, translations[key])
          totalFixed++
        } else {
          totalSkipped++
        }
      }
    }

    // Reassemble each string list; a list with any untranslated item is left as it was.
    for (const [key, length] of listKeys) {
      const items = Array.from({ length }, (_, i) => listItems.get(`${key}.${i}`))
      if (items.every((item) => typeof item === 'string')) setNested(targetData, key, items)
    }

    saveJSON(lang, ns, targetData)
  }
}

console.log(`\n✅ Fixed ${totalFixed} translations across ${LANGUAGES.length} locales`)
if (totalUnwritable > 0) console.log(`⚠ ${totalUnwritable} keys under a guarded segment were not written (listed above)`)
if (totalSkipped > 0) {
  console.log(`⚠ ${totalSkipped} strings left untranslated — re-run to retry`)
  process.exitCode = 1
}
