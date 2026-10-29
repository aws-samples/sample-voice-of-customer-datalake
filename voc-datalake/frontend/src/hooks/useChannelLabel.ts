/**
 * @fileoverview A review's channel as a person reads it.
 *
 * A feedback-form submission is stored under channel `form_<form id>`, which the
 * plain label rule humanised to "Form c8ee14b3" (5.34.00). Such a channel reads as
 * the form's NAME, from the feedback-form list (the shared `feedbackFormsKey()`
 * query, so a page of form reviews asks once, and only when it shows one). While
 * that loads, or for a form since deleted, the humanised id stays.
 *
 * @module hooks/useChannelLabel
 */
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '../api/client'
import { feedbackFormsKey } from '../api/feedbackFormQueryKeys'
import { channelLabel } from '../utils/displayLabels'

const FORM_CHANNEL_PREFIX = 'form_'
const FORM_LIST_STALE_MS = 5 * 60 * 1000

const FormNamesSchema = z.object({
  forms: z.array(z.object({ form_id: z.string(), name: z.string() }).nullable().catch(null)).catch([]),
}).catch({ forms: [] })

/** form id → its trimmed, non-empty name. */
function formNames(raw: unknown): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const form of FormNamesSchema.parse(raw).forms) {
    if (form === null) continue
    const name = form.name.trim()
    if (name !== '') names.set(form.form_id, name)
  }
  return names
}

/** The form id of a `form_<id>` channel, else null. */
function formIdOfChannel(channel: string | undefined): string | null {
  const trimmed = channel?.trim() ?? ''
  return trimmed.startsWith(FORM_CHANNEL_PREFIX) && trimmed.length > FORM_CHANNEL_PREFIX.length
    ? trimmed.slice(FORM_CHANNEL_PREFIX.length)
    : null
}

/** `channelLabel`, with a feedback-form channel named after its form. */
export function useChannelLabel(channel: string | undefined, sourceId: string): string | undefined {
  const formId = formIdOfChannel(channel)
  const { data: names } = useQuery({
    queryKey: feedbackFormsKey(),
    queryFn: () => api.getFeedbackForms(),
    select: formNames,
    enabled: formId !== null,
    staleTime: FORM_LIST_STALE_MS,
  })
  const formName = formId === null ? undefined : names?.get(formId)
  return formName ?? channelLabel(channel, sourceId)
}
