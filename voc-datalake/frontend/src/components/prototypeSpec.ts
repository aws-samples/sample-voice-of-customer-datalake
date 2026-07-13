/**
 * Prototype spec parsing + detection helpers.
 *
 * Extracted from PrototypeRenderer.tsx so the component file only exports
 * components (react-refresh), and so the JSON parsing is validated with Zod
 * instead of type assertions.
 *
 * Spec shape (mirrors lambda/jobs/document_generator/handler.py):
 *   { title?, banner?, screens: [
 *       { id, label?, heading?, subheading?, blocks?: [
 *           { type: 'text' | 'callout' | 'stats' | 'list' | 'form' | 'buttons', ... }
 *       ] }
 *   ] }
 */
import { z } from 'zod'

const prototypeItemSchema = z.object({
  label: z.string().optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  badge: z.string().optional(),
  value: z.string().optional(),
  goto: z.string().optional(),
  tone: z.string().optional(),
})

const prototypeBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  tone: z.string().optional(),
  title: z.string().optional(),
  items: z.array(prototypeItemSchema).optional(),
  fields: z.array(z.object({
    label: z.string(),
    placeholder: z.string().optional(),
    type: z.string().optional(),
  })).optional(),
  submit: z.object({ label: z.string(), goto: z.string().optional() }).optional(),
})

const prototypeScreenSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  heading: z.string().optional(),
  subheading: z.string().optional(),
  blocks: z.array(prototypeBlockSchema).optional(),
})

export const prototypeSpecSchema = z.object({
  title: z.string().optional(),
  banner: z.string().optional(),
  screens: z.array(prototypeScreenSchema),
})

export type PrototypeBlock = z.infer<typeof prototypeBlockSchema>
export type PrototypeScreen = z.infer<typeof prototypeScreenSchema>
export type PrototypeSpec = z.infer<typeof prototypeSpecSchema>

/**
 * Heuristic: does this content look like a self-contained HTML document (the
 * newer Opus-built prototype format) rather than a legacy JSON spec? Used as a
 * fallback when `prototype_format` isn't present on the document.
 */
export function looksLikeHtmlDocument(content: string | null | undefined): boolean {
  if (!content) return false
  const head = content.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

/**
 * Parse a prototype document's `content` (which is a JSON string) into a
 * validated spec object, or return null if it can't be parsed/validated.
 * Caller decides how to display malformed/legacy prototypes.
 */
export function parsePrototypeSpec(content: string | null | undefined): PrototypeSpec | null {
  if (!content) return null
  try {
    const result = prototypeSpecSchema.safeParse(JSON.parse(content))
    return result.success ? result.data : null
  } catch {
    // not JSON
    return null
  }
}
