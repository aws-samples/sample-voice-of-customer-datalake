/**
 * @fileoverview Parsers for the `result` of each assist job (./assistJobs).
 *
 * A job's `result` is exactly the body its route used to answer synchronously,
 * so each parser yields the type that route's API function always resolved —
 * read leniently (wrong-typed fields default, junk list elements are dropped)
 * rather than cast, per the repository's wire-shape rule.
 *
 * @module api/assistResults
 */
import { z } from 'zod'
import { parsedList, lenientText, optionalText } from './schemaList'
import { lenientList, nonBlankStringList } from './lenientFields'
import { asRecord } from './wireRecord'

const flag = z.boolean().catch(false)
const anyText = z.string().catch('')
/** Answers may legitimately be '' (an unanswered question), so blanks are kept. */
const stringList = lenientList((item): item is string => typeof item === 'string')

// ── settings: POST /settings/categories/generate ──────────────────────────

const generatedSubcategory = z.object({ id: lenientText, name: lenientText, description: optionalText })
const generatedCategory = z.object({
  id: lenientText, name: lenientText, description: optionalText,
  subcategories: parsedList(generatedSubcategory),
})
const generatedCategories = z.object({ success: flag, categories: parsedList(generatedCategory) })

export function parseGeneratedCategories(result: unknown) {
  return generatedCategories.parse(asRecord(result) ?? {})
}

// ── scrapers: POST /scrapers/analyze-url ──────────────────────────────────

const detectedSelectors = z.object({
  container_selector: lenientText,
  text_selector: lenientText,
  rating_selector: optionalText,
  rating_attribute: optionalText,
  author_selector: optionalText,
  date_selector: optionalText,
  title_selector: optionalText,
  confidence: lenientText,
  detected_reviews_count: z.number().catch(0),
  notes: optionalText,
  warnings: nonBlankStringList.optional(),
})
const selectorAnalysis = z.object({
  success: flag,
  selectors: detectedSelectors.optional().catch(undefined),
  message: optionalText,
  error: optionalText,
})

export function parseSelectorAnalysis(result: unknown) {
  return selectorAnalysis.parse(asRecord(result) ?? {})
}

// ── projects: the synchronous AI helpers ──────────────────────────────────

const prfaqAnswers = z.object({ answers: stringList })
export function parsePrfaqAnswers(result: unknown): { answers: string[] } {
  return prfaqAnswers.parse(asRecord(result) ?? {})
}

const researchSuggestion = z.object({ title: z.string(), question: z.string() })
const researchSuggestions = z.object({ suggestions: parsedList(researchSuggestion) })
export function parseResearchSuggestions(result: unknown): { suggestions: Array<{ title: string; question: string }> } {
  return researchSuggestions.parse(asRecord(result) ?? {})
}

const documentBrief = z.object({ title: anyText, feature_idea: anyText })
export function parseDocumentBrief(result: unknown): { title: string; feature_idea: string } {
  return documentBrief.parse(asRecord(result) ?? {})
}

/** `avatar_url` is null when the answer carries none (signing unavailable). */
export function parseRegeneratedAvatar(result: unknown): { avatar_url: string | null } {
  const url = asRecord(result)?.avatar_url
  return { avatar_url: typeof url === 'string' && url !== '' ? url : null }
}
