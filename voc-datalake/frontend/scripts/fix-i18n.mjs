#!/usr/bin/env node
/**
 * Fix all missing/empty i18n translations using Amazon Bedrock (Claude Haiku).
 * Reads English source, finds gaps in target locales, translates in batches.
 *
 * Usage: node scripts/fix-i18n.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const LOCALES_DIR = resolve(__dirname, '..', 'public', 'locales')
const NAMESPACES = ['categories', 'chat', 'common', 'components', 'dashboard',
  'dataExplorer', 'feedback', 'feedbackDetail', 'feedbackForms', 'login',
  'prioritization', 'problemAnalysis', 'projects', 'scrapers', 'settings']
const LANGUAGES = ['es', 'fr', 'de', 'ko', 'pt', 'ja', 'zh']
const LANG_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German',
  ko: 'Korean', pt: 'Portuguese', ja: 'Japanese', zh: 'Simplified Chinese',
}
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
const REGION = 'us-east-1'
const BATCH_SIZE = 60

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

function setNested(obj, key, val) {
  const parts = key.split('.')
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

function translateBatch(kvPairs, targetLang) {
  const langName = LANG_NAMES[targetLang]
  const input = Object.fromEntries(kvPairs)

  const prompt = `Translate the following JSON values from English to ${langName}.
RULES:
- Return ONLY a valid JSON object with the exact same keys
- Keep all {{variables}} exactly as-is (e.g. {{count}}, {{summary}}, {{name}}, {{error}})
- Keep HTML tags, URLs, and technical terms (JSON, PDF, CSV, URL, API, S3, etc.) as-is
- Be concise and natural in ${langName}
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

    // Collect keys that are missing or empty in target
    const toFix = []
    for (const [key, enValue] of enEntries) {
      const targetValue = getNested(targetData, key)
      const resolved = resolveEnValue(enData, key, enValue)
      if (targetValue === undefined || (typeof targetValue === 'string' && targetValue.trim() === '')) {
        if (typeof resolved === 'string' && resolved.trim() !== '') {
          toFix.push([key, resolved])
        }
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

      const translations = translateBatch(batch, lang)
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
