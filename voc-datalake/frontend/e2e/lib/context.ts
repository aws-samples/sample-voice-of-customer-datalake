/**
 * What every browser context of the suite gets, however it was created (the
 * `context` fixture of `lib/test.ts` or a spec's own `browser.newContext`):
 *
 * - **Persisted UI state reset per spec.** The SPA persists UI state in
 *   localStorage (the assistant panel's open/mode/active thread, the manual
 *   import draft) and the saved sessions in `.auth/` carry it from spec to spec:
 *   s3 writes its context back to refresh tokens, so a panel left open by one
 *   step opened in every later context, and `getByRole('dialog').last()` matched
 *   the panel instead of the wizard (QA 2.14.00, s3-07/08/10/11). The keys are
 *   stripped from both saved sessions once at the start of every spec file, and
 *   whenever a spec writes a session back.
 * - **Every assistant conversation in the ledger.** Conversations used to be
 *   recorded from successful saves only, so one whose only save was refused (409,
 *   the stream Lambda already writing it) was never cleaned up. The stream Lambda
 *   persists the request's `threadId` itself, so the id is recorded from every
 *   `POST /chat/stream` request body, for the context's role.
 */
import fs from 'node:fs'
import type { BrowserContext, Request } from '@playwright/test'
import { isRecord } from './guards'
import { apiUrl, BUILTIN_WORKFLOW_ID, RUN_PREFIX, storageStatePath, type Role } from './env'
import { recordCreated, type EntityKind } from './ledger'

/**
 * localStorage keys holding UI state, not the session (never `voc-auth` / `voc-config`).
 * `voc-assistant-bubble` is the launcher's dragged position: a spec that moves
 * it must not leave it over another spec's buttons.
 */
export const PERSISTED_UI_KEYS: readonly string[] = ['voc-assistant-ui', 'voc-manual-import', 'voc-assistant-bubble']

/** `state` (a Playwright storage state) without the persisted UI keys; anything unrecognised is returned as is. */
export function withoutPersistedUi(state: unknown): unknown {
  if (!isRecord(state) || !Array.isArray(state['origins'])) return state
  const origins = state['origins'].map((origin: unknown) => {
    if (!isRecord(origin) || !Array.isArray(origin['localStorage'])) return origin
    const kept = origin['localStorage'].filter((item: unknown) =>
      !(isRecord(item) && typeof item['name'] === 'string' && PERSISTED_UI_KEYS.includes(item['name'])))
    return { ...origin, localStorage: kept }
  })
  return { ...state, origins }
}

/** Strip the persisted UI keys from one role's saved session (a missing file is left missing). */
export function resetPersistedUi(role: Role): void {
  const file = storageStatePath(role)
  if (!fs.existsSync(file)) return
  const state: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify(withoutPersistedUi(state), null, 2), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/** Write a context's session back to its role's file (token refresh), without its UI state. */
export async function saveSession(context: BrowserContext, role: Role): Promise<void> {
  const file = storageStatePath(role)
  await context.storageState({ path: file })
  fs.chmodSync(file, 0o600)
  resetPersistedUi(role)
}

const resetFiles = new Set<string>()

/** Reset both roles' persisted UI once per spec file (workers run their files one after another). */
export function resetPersistedUiOnce(specFile: string): void {
  if (resetFiles.has(specFile)) return
  resetFiles.add(specFile)
  resetPersistedUi('admin')
  resetPersistedUi('user')
}

/** The `threadId` of a `POST /chat/stream` request to the suite's API, else null. */
export function streamThreadId(request: Pick<Request, 'method' | 'url' | 'postData'>): string | null {
  if (request.method() !== 'POST') return null
  const url = new URL(request.url())
  if (url.origin !== new URL(apiUrl()).origin || !/\/chat\/stream$/.test(url.pathname)) return null
  try {
    const body: unknown = JSON.parse(request.postData() ?? '')
    const id = isRecord(body) ? body['threadId'] : undefined
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

/** Record every conversation a run in `context` starts, as `role`'s (cleanup deletes it as that user). */
export function trackStreamConversations(context: BrowserContext, role: Role): void {
  context.on('request', (request) => {
    const id = streamThreadId(request)
    if (id !== null) recordCreated('conversation', id, `assistant stream ${id}`, role)
  })
}

/** One entity a browser POST created (from its 2xx response), ready for the ledger. */
export interface BrowserCreated {
  readonly kind: EntityKind
  readonly id: string
  readonly name: string
}

/**
 * The create routes whose 2xx answer names a new entity cleanup can delete or
 * retire: `[path, kind, envelope key, id field]`. Only true creates: `POST
 * /scrapers` also saves an EXISTING config, so it is not here.
 */
const CREATE_ROUTES: ReadonlyArray<readonly [RegExp, EntityKind, string, string]> = [
  [/\/projects$/, 'project', 'project', 'project_id'],
  [/\/feedback-forms$/, 'feedback-form', 'form', 'form_id'],
  [/\/agents$/, 'agent', 'agent', 'agent_id'],
  [/\/workflows(?:\/import|\/[^/]+\/duplicate)?$/, 'workflow', 'workflow', 'workflow_id'],
]

/** The create route `pathname` is, if any. */
function createRouteOf(pathname: string): readonly [RegExp, EntityKind, string, string] | undefined {
  return CREATE_ROUTES.find(([pattern]) => pattern.test(pathname))
}

/** A ledger label: the entity's own name when it is this run's e2e name, else one under the run prefix. */
function labelFor(kind: EntityKind, name: string): string {
  return name.startsWith(RUN_PREFIX) ? name : `${RUN_PREFIX}${kind}-via-browser ${name}`.trimEnd()
}

function stringIn(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/**
 * What a browser POST to the suite's API created, from its response: the entity
 * (and, for `POST /agents`, the workflow copy it made). Empty for anything else.
 * This is how the assistant's approved writes reach the ledger: an approval runs
 * the client tool in the SPA, which sends the same REST create a click does, and
 * the model may name the entity anything.
 */
export function browserCreated(method: string, url: string, status: number, body: unknown): BrowserCreated[] {
  if (method !== 'POST' || status < 200 || status >= 300 || !isRecord(body)) return []
  const parsed = new URL(url)
  if (parsed.origin !== new URL(apiUrl()).origin) return []
  const route = createRouteOf(parsed.pathname)
  if (route === undefined) return []
  const [, kind, key, idField] = route
  const entity = isRecord(body[key]) ? body[key] : {}
  const id = stringIn(entity, idField)
  if (id === '') return []
  const name = stringIn(entity, 'name')
  const out: BrowserCreated[] = [{ kind, id, name: labelFor(kind, name) }]
  const workflowId = kind === 'agent' ? stringIn(entity, 'workflow_id') : ''
  // The agent's own template copy; the built-in is never recorded (it cannot be archived).
  if (workflowId !== '' && workflowId !== BUILTIN_WORKFLOW_ID) out.push({ kind: 'workflow', id: workflowId, name: labelFor('workflow', `${name} workflow`) })
  return out
}

/**
 * Record every entity a browser POST in `context` creates, as `role`'s, so
 * cleanup deletes it however it was created: the spec's own click, or the
 * assistant's approved write with a name the model chose. A spec that records
 * the same id itself is not repeated (`recordCreated` keeps the first entry).
 */
export function trackBrowserCreates(context: BrowserContext, role: Role): void {
  context.on('response', (response) => {
    const request = response.request()
    if (request.method() !== 'POST' || createRouteOf(new URL(response.url()).pathname) === undefined) return
    response.json().then((body: unknown) => {
      for (const entity of browserCreated(request.method(), response.url(), response.status(), body)) {
        recordCreated(entity.kind, entity.id, entity.name, role)
      }
    }, () => undefined)
  })
}
