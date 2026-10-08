/**
 * @fileoverview Prototype pin feedback (todofeatures §6.2): the review routes under
 * `/projects/{id}/prototypes/{document_id}/pins` (project EDIT), normalized at the
 * boundary with lenient Zod schemas — a sparse or drifted pin degrades to defaults,
 * a pin without an id is dropped.
 * @module api/prototypePinsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'

const PIN_STATUSES = ['open', 'addressed', 'resolved'] as const

const pct = z.number().catch(0)
const EMPTY_BBOX = { x: 0, y: 0, w: 0, h: 0 }

const PinReplySchema = z.object({
  by: z.string().catch(''),
  name: z.string().catch(''),
  text: z.string().catch(''),
  at: z.string().catch(''),
})

const PinAnchorSchema = z.object({
  selector: z.string().catch(''),
  text_snippet: z.string().catch(''),
  route: z.string().catch(''),
  bbox: z.object({ x: pct, y: pct, w: pct, h: pct }).catch(() => ({ ...EMPTY_BBOX })),
})

const PinSchema = z.object({
  pin_id: z.string().min(1),
  status: z.enum(PIN_STATUSES).catch('open'),
  comment: z.string().catch(''),
  flagged: z.boolean().catch(false),
  created_at: z.string().catch(''),
  addressed_by: z.string().nullish().catch(null).transform((value) => value ?? ''),
  anchor: PinAnchorSchema.catch(() => ({ selector: '', text_snippet: '', route: '', bbox: { ...EMPTY_BBOX } })),
  console: z.array(z.object({ level: z.string().catch('error'), message: z.string().catch('') })).catch([]),
  replies: z.array(PinReplySchema).catch([]),
})

export type PrototypePin = z.infer<typeof PinSchema>

/** One pin, or null when it has no usable id. */
function normalizePin(raw: unknown): PrototypePin | null {
  const parsed = PinSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** A list response's pins; anything that is not a list normalizes to none. */
function normalizePins(raw: unknown): PrototypePin[] {
  const pins = z.object({ pins: z.array(z.unknown()) }).safeParse(raw)
  if (!pins.success) return []
  return pins.data.pins.flatMap((pin) => {
    const normalized = normalizePin(pin)
    return normalized ? [normalized] : []
  })
}

function pinMutationResult(raw: unknown): PrototypePin {
  const pin = normalizePin(z.object({ pin: z.unknown() }).safeParse(raw).data?.pin)
  if (!pin) throw new Error('The pin response was malformed')
  return pin
}

const pinsPath = (projectId: string, documentId: string) =>
  `/projects/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(documentId)}/pins`

const pinPath = (projectId: string, documentId: string, pinId: string) =>
  `${pinsPath(projectId, documentId)}/${encodeURIComponent(pinId)}`

export const prototypePinsApi = {
  list: async (projectId: string, documentId: string): Promise<PrototypePin[]> =>
    normalizePins(await fetchApi<unknown>(pinsPath(projectId, documentId))),

  reply: async (projectId: string, documentId: string, pinId: string, text: string): Promise<PrototypePin> =>
    pinMutationResult(await fetchApi<unknown>(`${pinPath(projectId, documentId, pinId)}/replies`, {
      method: 'POST', body: JSON.stringify({ text }),
    })),

  setStatus: async (projectId: string, documentId: string, pinId: string, action: 'resolve' | 'reopen'): Promise<PrototypePin> =>
    pinMutationResult(await fetchApi<unknown>(`${pinPath(projectId, documentId, pinId)}/${action}`, { method: 'POST' })),
}

export const prototypePinsQueryKey = (projectId: string, documentId: string) =>
  ['prototype-pins', projectId, documentId] as const
