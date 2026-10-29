/**
 * "Did you check that all personas generated images?" (owner, 5.35): one helper
 * that answers it for a project, for EVERY persona, through the API and the page.
 *
 * - API: `GET /projects/{id}` — each persona carries a non-empty `avatar_url`.
 * - Page: on `?tab=personas` each persona's list card shows an `<img>` (PersonaAvatar.tsx)
 *   that loaded: its image response answered 200 and, evaluated in the page,
 *   `naturalWidth > 0`. The initials fallback (no `<img>`: no URL, or the image
 *   failed and `onError` swapped it out) is a FAILURE.
 *
 * Returns one problem string per failure, each naming the persona; [] = all good.
 * A `data:` URL (the dev mock's regenerated avatar) has no network response, so
 * only its decode is judged.
 */
import type { Locator, Page, Response } from '@playwright/test'
import { apiCall, listOf, stringField } from './api'
import { site } from './fixtures'
import type { Role } from './env'

/** How long the Personas tab may take to list every persona card. */
const CARDS_TIMEOUT_MS = 30_000
/** How long one avatar may take to finish loading (load or error) in the page. */
const IMAGE_LOAD_TIMEOUT_MS = 15_000
const POLL_MS = 250

interface PersonaRef {
  readonly id: string
  readonly name: string
  readonly avatarUrl: string
}

const labelOf = (p: PersonaRef): string => `${p.name || '(no name)'} (${p.id || 'no id'})`

/** The personas of `GET /projects/{id}`, or the problem that the read failed. */
async function personasOf(role: Role, projectId: string): Promise<{ personas: PersonaRef[]; problem?: string }> {
  const res = await apiCall(role, 'GET', `/projects/${encodeURIComponent(projectId)}`)
  if (res.status !== 200) return { personas: [], problem: `GET /projects/${projectId} -> ${res.status}` }
  const personas = listOf(res.body, 'personas').map((p) => ({
    id: stringField(p, 'persona_id') ?? '',
    name: stringField(p, 'name') ?? '',
    avatarUrl: stringField(p, 'avatar_url') ?? '',
  }))
  return { personas }
}

/** The Personas-tab list card: a button named by the persona (PersonasTab's `aria-label`). */
const cardsNamed = (page: Page, name: string): Locator =>
  page.getByRole('button', { name, exact: true }).filter({ has: page.getByTestId('persona-list-name') })

/** Waits until the tab lists `count` persona cards; false on timeout. */
async function waitForCards(page: Page, count: number): Promise<boolean> {
  const deadline = Date.now() + CARDS_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await page.getByTestId('persona-list-name').count() >= count) return true
    await page.waitForTimeout(POLL_MS)
  }
  return false
}

/** In the page: waits for the image to finish (load or error), then reads its decode. */
async function imageState(img: Locator): Promise<{ naturalWidth: number; src: string } | null> {
  return img.evaluate(async (el, timeoutMs) => {
    if (!(el instanceof HTMLImageElement)) return { naturalWidth: 0, src: '' }
    if (!el.complete) {
      await new Promise<void>((resolve) => {
        el.addEventListener('load', () => resolve(), { once: true })
        el.addEventListener('error', () => resolve(), { once: true })
        setTimeout(resolve, timeoutMs)
      })
    }
    return { naturalWidth: el.naturalWidth, src: el.currentSrc || el.src }
  }, IMAGE_LOAD_TIMEOUT_MS).catch(() => null)
}

/** The image response status the page saw for `src`, else a direct fetch of it (a memory-cache hit fires no event). */
async function imageStatus(page: Page, seen: ReadonlyMap<string, number>, src: string): Promise<number | 'failed' | null> {
  if (src.startsWith('data:')) return null
  const recorded = seen.get(src)
  if (recorded !== undefined) return recorded
  const res = await page.context().request.get(src).catch(() => null)
  return res === null ? 'failed' : res.status()
}

/** The problems of one persona's card on the open Personas tab. */
async function cardProblems(page: Page, persona: PersonaRef, nth: number, seen: ReadonlyMap<string, number>): Promise<string[]> {
  const label = labelOf(persona)
  const card = cardsNamed(page, persona.name).nth(nth)
  if (await card.count() === 0) return [`${label}: no card on the Personas tab`]
  const img = card.getByTestId('persona-avatar')
  if (await img.count() === 0) return [`${label}: initials fallback on the Personas tab (no image)`]
  const state = await imageState(img.first())
  // The image failed after the first look: PersonaAvatar's onError swapped in the fallback.
  if (state === null || await img.count() === 0) return [`${label}: the image failed and the initials fallback replaced it`]
  const problems: string[] = []
  if (state.naturalWidth <= 0) problems.push(`${label}: the image did not decode (naturalWidth 0)`)
  const status = await imageStatus(page, seen, state.src)
  if (status !== null && status !== 200) problems.push(`${label}: image response ${status}`)
  return problems
}

/**
 * Every avatar problem of project `projectId`'s personas, read as `role`: the API's
 * `avatar_url`, then each card's image on the Personas tab (this navigates `page`).
 */
export async function personaAvatarProblems(page: Page, role: Role, projectId: string): Promise<string[]> {
  const { personas, problem } = await personasOf(role, projectId)
  if (problem !== undefined) return [problem]
  const problems = personas.filter((p) => p.avatarUrl === '').map((p) => `${labelOf(p)}: no avatar_url`)
  if (personas.length === 0) return problems

  const seen = new Map<string, number>()
  const onResponse = (response: Response): void => {
    if (response.request().resourceType() === 'image') seen.set(response.url(), response.status())
  }
  page.on('response', onResponse)
  try {
    await page.goto(site(`/projects/${encodeURIComponent(projectId)}?tab=personas`), { waitUntil: 'domcontentloaded' })
    if (!await waitForCards(page, personas.length)) problems.push(`the Personas tab did not list all ${personas.length} personas`)
    // Same-name personas: the k-th one in API order is the k-th card of that name.
    const occurrences = new Map<string, number>()
    for (const persona of personas) {
      const nth = occurrences.get(persona.name) ?? 0
      occurrences.set(persona.name, nth + 1)
      problems.push(...await cardProblems(page, persona, nth, seen))
    }
  } finally {
    page.off('response', onResponse)
  }
  return problems
}
