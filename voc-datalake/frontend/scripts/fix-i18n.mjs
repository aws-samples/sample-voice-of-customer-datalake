#!/usr/bin/env node
/* eslint-disable security/detect-non-literal-fs-filename -- build script uses dynamic paths */
/**
 * Fix all missing/empty i18n translations using Amazon Bedrock (Claude Haiku).
 * Reads English source, finds gaps in target locales, translates in batches.
 *
 * Usage: node scripts/fix-i18n.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const LOCALES_DIR = resolve(__dirname, '..', 'public', 'locales')
const NAMESPACES = ['categories', 'chat', 'common', 'components', 'dashboard',
  'dataExplorer', 'feedback', 'feedbackDetail', 'feedbackForms', 'login',
  'prioritization', 'problemAnalysis', 'projectDetail', 'projects', 'scrapers', 'settings']
const LANGUAGES = ['es', 'fr', 'de', 'ko', 'pt', 'ja', 'zh']
const LANG_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German',
  ko: 'Korean', pt: 'Portuguese', ja: 'Japanese', zh: 'Simplified Chinese',
}
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
const REGION = 'us-east-1'
const BATCH_SIZE = 60

// Context descriptions for each namespace so the LLM understands
// where these strings appear in the UI
const NS_CONTEXT = {
  categories: 'Category breakdown page — shows feedback categories, sentiment filters, keyword clouds, and PDF export for a customer feedback analytics dashboard.',
  chat: 'AI Chat page — conversational interface where users ask questions about their customer feedback data. Includes suggested questions, chat history sidebar, and export options.',
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

function collectSourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue
    if (entry.endsWith('.test.tsx') || entry.endsWith('.test.ts')) continue
    const stat = statSync(full)
    if (stat.isDirectory()) files.push(...collectSourceFiles(full))
    else if (['.ts', '.tsx'].includes(extname(entry))) files.push(full)
  }
  return files
}

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

function flattenEntries(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v))
      out.push(...flattenEntries(v, full))
    else out.push([full, v])
  }
  return out
}

function getNested(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj)
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function setNested(obj, key, val) {
  const parts = key.split('.')
  if (parts.some(p => UNSAFE_KEYS.has(p))) return
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = val
}

// Resolve self-referencing plural values like "sidebar.messagesCount"
// to the actual English text
function resolveEnValue(enData, key, rawValue) {
  if (typeof rawValue === 'string' && rawValue.includes('.') && !rawValue.includes(' ')) {
    // Looks like a self-reference — try to resolve the base key
    const resolved = getNested(enData, rawValue)
    if (resolved && typeof resolved === 'string') return resolved
  }
  return rawValue
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
- Keep all {{variables}} exactly as-is (e.g. {{count}}, {{summary}}, {{name}}, {{error}}, {{percent}})
- Keep HTML tags (<code>, <strong>, <at>, <atAll>, <hash>, etc.) exactly as-is
- Keep URLs, email addresses, and technical identifiers as-is
- Keep product names as-is: "VoC Analytics", "Kiro", "Claude", "Amazon", "Bedrock", "Cognito", "MCP"
- Keep technical terms as-is: JSON, PDF, CSV, URL, API, S3, PRD, PR-FAQ, DynamoDB, CloudWatch, SSE, Markdown
- Keep file extensions and code references as-is: .json, mcp.json, Authorization
- For plural forms (_one, _many, _other): ensure {{count}} template variable is included in the translation
- Use natural, professional ${langName} appropriate for a B2B SaaS dashboard — avoid overly formal or literal translations
- For UI actions (buttons, labels), prefer concise wording that fits in compact UI elements
- Do NOT add markdown fences or any text outside the JSON

Input:
${JSON.stringify(input, null, 2)}`

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 16000,
    temperature: 0.1,
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
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- dev script intentionally invokes AWS CLI
    execFileSync('aws', args, { stdio: 'pipe', timeout: 120_000 })
    const resp = JSON.parse(readFileSync(tmpOut, 'utf-8'))
    const text = resp.content[0].text.trim()
    // Strip markdown fences if present
    const cleaned = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '')
    return JSON.parse(cleaned)
  } catch (err) {
    console.error(`  ⚠ Bedrock call failed for ${langName}:`, err.message)
    return null
  }
}

// ── Main ──

let totalFixed = 0

for (const lang of LANGUAGES) {
  console.log(`\n🌐 Processing ${lang.toUpperCase()} (${LANG_NAMES[lang]})`)

  for (const ns of NAMESPACES) {
    const enData = loadJSON('en', ns)
    const targetData = loadJSON(lang, ns)
    const enEntries = flattenEntries(enData)

    // Collect keys that are missing, empty, or untranslated (still in English) in target
    const toFix = []
    for (const [key, enValue] of enEntries) {
      const targetValue = getNested(targetData, key)
      const resolved = resolveEnValue(enData, key, enValue)
      if (typeof resolved !== 'string' || resolved.trim() === '') continue

      const isMissing = targetValue === undefined
      const isEmpty = typeof targetValue === 'string' && targetValue.trim() === ''
      const isUntranslated = typeof targetValue === 'string'
        && targetValue === resolved
        && targetValue.length > 3
        && !targetValue.startsWith('http')
        && !targetValue.startsWith('@')
        && !targetValue.startsWith('#')
        // eslint-disable-next-line sonarjs/slow-regex -- bounded input from JSON translation values, not user-controlled
        && targetValue.replace(/\{\{[^}]+\}\}/g, '').trim().length > 0

      if (isMissing || isEmpty || isUntranslated) {
        toFix.push([key, resolved])
      }
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
    for (let i = 0; i < toFix.length; i += BATCH_SIZE) {
      const batch = toFix.slice(i, i + BATCH_SIZE)
      console.log(`    Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} strings...`)

      const translations = translateBatch(batch, lang, ns)
      if (!translations) {
        console.log(`    ⚠ Falling back to English for this batch`)
        for (const [key, enVal] of batch) setNested(targetData, key, enVal)
        totalFixed += batch.length
        continue
      }

      for (const [key] of batch) {
        if (translations[key] && typeof translations[key] === 'string') {
          setNested(targetData, key, translations[key])
          totalFixed++
        } else {
          // Fallback to English
          setNested(targetData, key, toFix.find(([k]) => k === key)?.[1] ?? '')
          totalFixed++
        }
      }
    }

    saveJSON(lang, ns, targetData)
  }
}

console.log(`\n✅ Fixed ${totalFixed} translations across ${LANGUAGES.length} locales`)
/* eslint-enable security/detect-non-literal-fs-filename */