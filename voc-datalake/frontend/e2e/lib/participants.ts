/**
 * Participants fixtures through the API (docs/participants.md, `voc-engagement-api`):
 * e2e lists and people a spec needs on the page, and the reads that prove them gone.
 *
 * Lists and people are not ledger kinds (lib/ledger.ts `ENTITY_KINDS`), so the spec
 * that makes one deletes it itself (`deleteListAs` / `erasePersonAs`) and proves it with
 * a GET (404). Every create is `${RUN_PREFIX}…`; a person's address is
 * `e2e-<run id>-<what>@example.com` (a reserved domain, never a real mailbox).
 */
import { apiCall, listOf, stringField } from './api'
import { RUN_ID } from './env'
import { isRecord } from './guards'

/** The address the suite gives the person called `what` in this run (example.com: no mailbox behind it). */
export const e2eEmail = (what: string): string => `e2e-${RUN_ID}-${what}@example.com`

/** What `GET /participants/settings` says, reduced to what the specs branch on. */
export interface EngagementSettings {
  readonly emailEnabled: boolean
  /** Can an @example.com address become a person (a company domain, or external people allowed)? */
  readonly exampleAllowed: boolean
}

export async function readEngagementSettings(): Promise<EngagementSettings> {
  const answer = await apiCall('admin', 'GET', '/participants/settings')
  if (answer.status !== 200 || !isRecord(answer.body)) throw new Error(`GET /participants/settings -> ${answer.status}`)
  const settings = isRecord(answer.body['settings']) ? answer.body['settings'] : {}
  const domains = Array.isArray(settings['company_domains']) ? settings['company_domains'] : []
  return {
    emailEnabled: answer.body['email_enabled'] === true,
    // Exact element equality over the domain LIST (not a substring test on a URL or address).
    exampleAllowed: settings['allow_external_people'] === true || domains.some((domain) => domain === 'example.com'),
  }
}

/** The lists `GET /participants/lists` answers. */
export async function readLists(): Promise<Array<Record<string, unknown>>> {
  return listOf((await apiCall('admin', 'GET', '/participants/lists')).body, 'lists')
}

/** The id of the list called exactly `name`, if it exists. */
export async function listIdNamed(name: string): Promise<string | undefined> {
  return stringField((await readLists()).find((list) => list['name'] === name), 'list_id')
}

/** Creates a custom list as the admin; throws unless the API made it. */
export async function createList(name: string): Promise<string> {
  const created = await apiCall('admin', 'POST', '/participants/lists', { name, kind: 'custom', description: 'Created by the e2e suite.' })
  const list = isRecord(created.body) && isRecord(created.body['list']) ? created.body['list'] : undefined
  const id = stringField(list, 'list_id')
  if (created.status >= 300 || id === undefined) throw new Error(`POST /participants/lists -> ${created.status}`)
  return id
}

/** Adds one new person to a list; their person id (throws when the address was refused). */
export async function addPersonToList(listId: string, email: string, name: string): Promise<string> {
  const added = await apiCall('admin', 'POST', `/participants/lists/${encodeURIComponent(listId)}/members`, { people: [{ email, name }] })
  if (added.status >= 300 || listOf(added.body, 'rejected').length > 0) throw new Error(`POST …/members -> ${added.status}, address refused`)
  const id = await personIdByEmail(email)
  if (id === undefined) throw new Error(`added ${email}, but the people search does not find it`)
  return id
}

/** The person id the people search answers for exactly this address. */
export async function personIdByEmail(email: string): Promise<string | undefined> {
  const people = listOf((await apiCall('admin', 'GET', `/participants/people?q=${encodeURIComponent(email)}`)).body, 'people')
  return stringField(people.find((person) => person['email'] === email), 'person_id')
}

/** `GET /participants/lists/{id}` status (404 = gone). */
export async function listStatus(listId: string): Promise<number> {
  return (await apiCall('admin', 'GET', `/participants/lists/${encodeURIComponent(listId)}`)).status
}

/** `GET /participants/people/{id}` status (404 = gone). */
export async function personStatus(personId: string): Promise<number> {
  return (await apiCall('admin', 'GET', `/participants/people/${encodeURIComponent(personId)}`)).status
}

/** Admin cleanup: deletes the list when it still exists; returns the GET status after (404 expected). */
export async function deleteListAs(listId: string): Promise<number> {
  if (await listStatus(listId) === 200) await apiCall('admin', 'DELETE', `/participants/lists/${encodeURIComponent(listId)}`)
  return listStatus(listId)
}

/** Admin cleanup: erases the person when they still exist; returns the GET status after (404 expected). */
export async function erasePersonAs(personId: string): Promise<number> {
  if (await personStatus(personId) === 200) await apiCall('admin', 'DELETE', `/participants/people/${encodeURIComponent(personId)}`)
  return personStatus(personId)
}
