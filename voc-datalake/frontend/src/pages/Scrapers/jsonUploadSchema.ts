/**
 * Zod schema and template data for JSON feedback upload.
 */
import { z } from 'zod'

// ============================================
// Zod Schema — matches pipeline minimum fields
// ============================================

export const JsonFeedbackItemSchema = z.object({
  text: z.string().min(1, 'text is required').max(50_000),
  id: z.string().min(1, 'id is required for deduplication').max(256),
  source: z.string().min(1, 'source is required').max(64).optional(),
  source_channel: z.string().max(64).optional(),
  timestamp: z.string().min(1).optional(),
  created_at: z.string().min(1).optional(),
  user_id: z.string().max(256).optional(),
  author: z.string().max(256).optional(),
  rating: z.number().min(1).max(5).optional(),
  title: z.string().max(500).optional(),
  url: z.string().max(2048).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (item) => Boolean(item.timestamp ?? item.created_at),
  {
    message: 'timestamp (or created_at) is required — provide the original date of the feedback in ISO 8601 format',
    path: ['timestamp'],
  },
).refine(
  (item) => Boolean(item.source ?? item.source_channel),
  {
    message: 'source (or source_channel) is required — identifies where the feedback came from (e.g. "trustpilot", "zendesk")',
    path: ['source'],
  },
)

export const JsonFeedbackArraySchema = z.array(JsonFeedbackItemSchema).min(1, 'File must contain at least one item').max(500, 'Maximum 500 items per upload')

export type JsonFeedbackItem = z.infer<typeof JsonFeedbackItemSchema>

// ============================================
// Template
// ============================================

export const TEMPLATE_DATA = {
  _instructions: {
    _note: 'This section is documentation only. Remove it before uploading, or leave it — it will be ignored.',
    _llm_instruction: 'If you are an LLM generating data for this template: produce a JSON array (or an object with an "items" array) following the field definitions below. Every item MUST have: text, id, source, and timestamp. Ensure each "id" is unique within its source to prevent duplicates. Output valid JSON only, no markdown fences.',
    format: 'JSON array of feedback objects. Each object represents one piece of customer feedback.',
    fields: {
      'text (REQUIRED)': 'The feedback content. This is mandatory.',
      'id (REQUIRED)': 'A unique identifier for this feedback item.',
      'source (REQUIRED)': 'The channel or origin of the feedback.',
      'timestamp (REQUIRED)': 'ISO 8601 datetime of when the feedback was originally created.',
      'rating (optional)': 'Numeric rating from 1 to 5.',
      'title (optional)': 'A short title or subject line.',
      'user_id (optional)': 'Author name or user identifier.',
      'url (optional)': 'Direct link to the original feedback.',
      'metadata (optional)': 'Flat key-value object for extra context.',
    },
    deduplication: 'The system deduplicates using: sha256(source_platform + ":" + id).',
    text_formatting: 'Keep the original text as-is. Do not summarize or paraphrase.',
    limits: 'Max 500 items per file. Max 50,000 characters per text field. Max 5MB file size.',
  },
  items: [
    {
      id: 'review-2026-0420-001',
      text: 'The delivery was late by 3 days and the package was damaged.',
      timestamp: '2026-03-20T14:30:00Z',
      source: 'trustpilot',
      rating: 2,
      title: 'Disappointing delivery',
      user_id: 'customer_123',
    },
    {
      id: 'review-2026-0421-002',
      text: 'Great product quality, exactly what I expected!',
      timestamp: '2026-03-21T09:15:00Z',
      source: 'trustpilot',
      rating: 5,
      user_id: 'happy_buyer',
    },
    {
      id: 'ticket-4821',
      text: 'Customer support was helpful but slow to respond.',
      timestamp: '2026-03-19T16:00:00Z',
      source: 'zendesk',
      user_id: 'user_456',
      metadata: {
        priority: 'medium',
        channel: 'email',
      },
    },
  ],
}

// ============================================
// Helpers
// ============================================

function isObjectWithItems(raw: unknown): raw is { items: unknown } {
  return typeof raw === 'object' && raw !== null && 'items' in raw
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function extractJsonArray(raw: unknown): unknown[] | null {
  if (isUnknownArray(raw)) return raw
  if (isObjectWithItems(raw) && isUnknownArray(raw.items)) return raw.items
  return null
}

function formatValidationErrors(issues: ReadonlyArray<{
  path: ReadonlyArray<PropertyKey>;
  message: string
}>): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? `Item ${String(issue.path[0])}` : 'Root'
    const field = issue.path.length > 1 ? `.${issue.path.slice(1).map(String).join('.')}` : ''
    return `${path}${field}: ${issue.message}`
  }).slice(0, 10)
}

type ParseResult =
  | {
    ok: true;
    data: JsonFeedbackItem[]
  }
  | {
    ok: false;
    errors: string[]
  }

export function parseJsonFeedback(content: string): ParseResult {
  const raw: unknown = JSON.parse(content)
  const arr = extractJsonArray(raw)
  if (!arr) {
    return {
      ok: false,
      errors: ['File must contain a JSON array or an object with an "items" array'],
    }
  }
  const result = JsonFeedbackArraySchema.safeParse(arr)
  if (!result.success) {
    return {
      ok: false,
      errors: formatValidationErrors(result.error.issues),
    }
  }
  return {
    ok: true,
    data: result.data,
  }
}

export function downloadTemplate() {
  const blob = new Blob([JSON.stringify(TEMPLATE_DATA, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'feedback-template.json'
  a.click()
  URL.revokeObjectURL(url)
}

export function validateFileBasics(file: File): string | null {
  if (!file.name.endsWith('.json')) return 'File must be a .json file'
  if (file.size > 5 * 1024 * 1024) return 'File must be smaller than 5MB'
  return null
}
