/**
 * @fileoverview The builder's draft (formDraftContext.ts) and its saves: Save, Publish, Update live form and Turn off
 * (UX §3.6), the stale-save conflict (D7: a 409 `revision_conflict` offers Compare, Reload and Save mine), and the
 * server's refusals. A save of an answered form names what it removes (`removes`, model/removals.ts), as the server
 * requires (D9); its 409 `answers_locked` is a refusal, never the stale-save banner.
 *
 * A new form (a template, an AI draft) is created on its first Save, Off, and `onCreated` gives the page its id
 * (the address replaces `new`). Saving clears the AI's provenance (UX §12.3: "the AI draft is now your form").
 *
 * @module pages/FeedbackForms/builder/useFormDraft
 */
import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FormsApiError, feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { FormsFieldError } from '../../../api/feedbackFormsV2Api'
import { feedbackFormsKey } from '../../../api/feedbackFormQueryKeys'
import { HTTP_CONFLICT } from '../../../api/apiErrorStatus'
import type { FormV2, LoadedForm, StoredFormMeta } from '../model/formsV2'
import { removalsOf } from '../model/removals'
import type { FormRemovals } from '../model/removals'
import { blockingProblems, validateForm } from '../model/validateForm'
import type { AiState, ConflictInfo, FormDraft, SaveStatus } from './formDraftContext'
import type { NewFormHandoff } from './newFormHandoff'
import { sameJson } from '../../../lib/sameJson'

export interface FormDraftOptions {
  /** The stored form (null: a new one, from `handoff`). */
  readonly loaded: LoadedForm | null
  readonly handoff: NewFormHandoff | null
  /** A new form was created: the page replaces its address with the id. */
  readonly onCreated: (formId: string) => void
}

function initialAi(handoff: NewFormHandoff | null): AiState | null {
  if (handoff?.ai == null) return null
  const { form, ai } = handoff
  return {
    kind: 'draft', notes: ai.notes, warnings: ai.warnings, unconfirmed: ai.addresses, before: null, description: ai.description,
    marked: new Set([...form.questions.map((q) => q.id), ...form.endings.map((e) => e.id)]),
  }
}

const SAVE_FAILED = 'save failed'
/** The 409 code of a save that drops an answered question id or option code without naming it (model/removals.ts). */
const ANSWERS_LOCKED = 'answers_locked'

/** The words a failed save shows: the server's own reason, else a generic one (the page words it). */
function failureReason(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : SAVE_FAILED
}

type Persisted = { readonly loaded: LoadedForm; readonly created: boolean }

/**
 * A PUT's answer as the draft keeps it: the form API counts responses only on `GET /feedback-forms/{id}` (a save
 * answers no `response_count`), so the count the builder read stays, and a form once answered stays answered
 * (`has_responses`, which locks codes and ids: D9); so does whether this person may delete its test responses.
 */
function afterPut(saved: LoadedForm, before: StoredFormMeta): LoadedForm {
  return {
    ...saved,
    meta: {
      ...saved.meta, response_count: before.response_count, has_responses: saved.meta.has_responses || before.has_responses,
      can_delete_test_responses: before.can_delete_test_responses,
    },
  }
}

/**
 * What a save of `form` over `stored` (the version the server holds) must name in `removes`: what it drops, once the
 * form has a real response (`has_responses`, D9). The server refuses an unnamed drop (409 `answers_locked`); the
 * builder's removals are the person's own (its confirms say the answers stay in Results), so it names them.
 */
function removesFor(stored: FormV2 | null, meta: StoredFormMeta, form: FormV2): FormRemovals | null {
  return meta.has_responses && stored !== null ? removalsOf(stored, form) : null
}

/** Create (a new form, Off) or save over the stored revision; `enabled` set when publishing or turning off. */
async function persist(form: FormV2, stored: FormV2 | null, meta: StoredFormMeta | null, enabled: boolean | null): Promise<Persisted> {
  if (meta === null) {
    const created = await feedbackFormsV2Api.createForm(form)
    if (enabled !== true) return { loaded: created, created: true }
    const live = await feedbackFormsV2Api.saveForm(created.meta.form_id, { ...created.form, enabled: true }, created.meta.revision)
    return { loaded: live, created: true }
  }
  const next = enabled === null ? form : { ...form, enabled }
  const saved = await feedbackFormsV2Api.saveForm(meta.form_id, next, meta.revision, removesFor(stored, meta, next))
  return { loaded: afterPut(saved, meta), created: false }
}

/** A 409 that is a stale save (D7's banner), not the lock refusing an unnamed removal (`answers_locked`). */
const isStaleSave = (error: unknown): error is FormsApiError =>
  error instanceof FormsApiError && error.status === HTTP_CONFLICT && error.code !== ANSWERS_LOCKED

function savedMessage(enabled: boolean | null, created: boolean, wasAi: boolean): Extract<SaveStatus, { kind: 'saved' }>['message'] {
  if (enabled === true) return 'published'
  if (enabled === false) return 'turnedOff'
  if (wasAi) return 'aiSaved'
  return created ? 'firstSave' : 'saved'
}

/** What a draft opens with: the stored form (its baseline and meta), or the new form handed over. */
function openingOf(loaded: LoadedForm | null, handoff: NewFormHandoff | null): { form: FormV2; baseline: FormV2 | null; meta: StoredFormMeta | null } {
  if (loaded !== null) return { form: loaded.form, baseline: loaded.form, meta: loaded.meta }
  if (handoff === null) throw new Error('A form draft needs a stored form or a new one.')
  return { form: handoff.form, baseline: null, meta: null }
}

const sameForm = (a: FormV2, b: FormV2 | null): boolean => b !== null && sameJson(a, b)

export function useFormDraft({ loaded, handoff, onCreated }: FormDraftOptions): FormDraft {
  const queryClient = useQueryClient()
  const [opening] = useState(() => openingOf(loaded, handoff))
  const [form, setForm] = useState<FormV2>(opening.form)
  const [baseline, setBaseline] = useState<FormV2 | null>(opening.baseline)
  const [meta, setMeta] = useState<StoredFormMeta | null>(opening.meta)
  const [ai, setAi] = useState<AiState | null>(() => initialAi(handoff))
  const [fromTemplate, setFromTemplate] = useState<ReadonlySet<string>>(() => new Set())
  const [freshCodes, setFreshCodes] = useState<ReadonlySet<string>>(() => new Set())
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' })
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)
  const [serverErrors, setServerErrors] = useState<readonly FormsFieldError[]>([])

  const unconfirmed = ai?.unconfirmed
  const problems = useMemo(() => validateForm(form, { unconfirmedAddresses: unconfirmed }), [form, unconfirmed])
  const errors = useMemo(() => blockingProblems(problems), [problems])
  const dirty = !sameForm(form, baseline)

  const update = useCallback((change: (current: FormV2) => FormV2) => {
    setForm(change)
    setStatus((current) => (current.kind === 'saved' || current.kind === 'failed' ? { kind: 'idle' } : current))
  }, [])

  const settle = useCallback((next: LoadedForm, keepEdits: FormV2 | null) => {
    setBaseline(next.form)
    setMeta(next.meta)
    setForm(keepEdits ?? next.form)
    setConflict(null)
    setServerErrors([])
    void queryClient.invalidateQueries({ queryKey: feedbackFormsKey() })
  }, [queryClient])

  const refuse = useCallback((error: unknown) => {
    if (isStaleSave(error)) {
      setConflict({ updatedBy: error.current?.updatedBy ?? '', updatedAt: error.current?.updatedAt ?? '' })
      setStatus({ kind: 'idle' })
      return
    }
    // The form got its first real response while this draft was open: it is locked now (D9), so the codes and ids
    // lock here too, and the next Update live form lists what it removes before it names them.
    if (error instanceof FormsApiError && error.code === ANSWERS_LOCKED) {
      setMeta((current) => (current === null ? current : { ...current, has_responses: true }))
    }
    if (error instanceof FormsApiError) setServerErrors(error.errors)
    setStatus({ kind: 'failed', reason: failureReason(error) })
  }, [])

  const wasAiDraft = ai?.kind === 'draft'
  const run = useCallback(async (enabled: boolean | null): Promise<boolean> => {
    if (errors.length > 0 && enabled !== false) return false
    setStatus({ kind: 'saving' })
    try {
      const { loaded: next, created } = await persist(form, baseline, meta, enabled)
      settle(next, null)
      setStatus({ kind: 'saved', message: savedMessage(enabled, created, wasAiDraft) })
      setAi(null)
      setFreshCodes(new Set())
      if (created) onCreated(next.meta.form_id)
      return true
    } catch (error) {
      refuse(error)
      return false
    }
  }, [errors.length, form, baseline, meta, settle, wasAiDraft, onCreated, refuse])

  const turnOff = useCallback(async (): Promise<boolean> => {
    if (meta === null) return false
    setStatus({ kind: 'saving' })
    try {
      const next = afterPut(await feedbackFormsV2Api.setEnabled(meta.form_id, false, meta.revision), meta)
      settle(next, { ...form, enabled: false })
      setStatus({ kind: 'saved', message: 'turnedOff' })
      return true
    } catch (error) {
      refuse(error)
      return false
    }
  }, [meta, form, settle, refuse])

  const readLatest = useCallback(async (): Promise<LoadedForm> => {
    if (meta === null) throw new Error('A new form has no stored version.')
    return feedbackFormsV2Api.getForm(meta.form_id)
  }, [meta])

  const loadTheirs = useCallback(async () => {
    const latest = await readLatest()
    settle(latest, null)
    setStatus({ kind: 'idle' })
  }, [readLatest, settle])

  const saveMine = useCallback(async (): Promise<boolean> => {
    setStatus({ kind: 'saving' })
    try {
      const latest = await readLatest()
      // Named against theirs, the version the server now holds (D7's Compare listed what mine removes from it).
      const saved = await feedbackFormsV2Api.saveForm(latest.meta.form_id, form, latest.meta.revision,
        removesFor(latest.form, latest.meta, form))
      const next = afterPut(saved, latest.meta)
      settle(next, null)
      setStatus({ kind: 'saved', message: 'saved' })
      return true
    } catch (error) {
      refuse(error)
      return false
    }
  }, [readLatest, form, settle, refuse])

  const discard = useCallback(() => {
    setForm(baseline ?? opening.form)
    setStatus({ kind: 'idle' })
  }, [baseline, opening.form])

  const [templateId] = useState(handoff === null ? null : handoff.templateId)
  return {
    form, baseline, meta, isNew: meta === null, dirty, problems, errors, serverErrors,
    locked: meta?.has_responses === true,
    update, ai, setAi, templateId,
    fromTemplate, setFromTemplate, freshCodes, setFreshCodes, status, conflict,
    save: () => run(null),
    publish: () => run(true),
    turnOff,
    loadTheirs,
    saveMine,
    readTheirs: async () => (await readLatest()).form,
    discard,
  }
}
