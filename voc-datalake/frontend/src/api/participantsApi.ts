/**
 * @fileoverview Participants API client (docs/participants.md): participant lists, people,
 * project links, asks for feedback (emails) and the engagement settings, all on
 * `voc-engagement-api`; plus the PUBLIC `POST /unsubscribe` the emailed link opens.
 *
 * @module api/participantsApi
 */
import { del, post, put } from './requestKit'
import { fetchApi } from './client'
import { getBaseUrl } from './baseUrl'
import { normalize } from './participantsSchema'
import type {
  AddMembersResult, Ask, AskDetail, EngagementSettings, FormOption, ListDetail, ListKind, ParticipantList, Person,
  PersonDetail, ProjectLinkResult, ProjectParticipants, SettingsView,
} from './participantsSchema'

/** A new person, as the add forms and the composer send one. */
export interface NewPersonInput {
  readonly email: string
  readonly name?: string
  readonly company?: string
  readonly title?: string
  readonly tags?: readonly string[]
}

export interface ListInput {
  readonly name: string
  readonly description?: string
  readonly kind: ListKind
}

export interface PersonEdit {
  readonly name?: string
  readonly company?: string
  readonly title?: string
  readonly notes?: string
  readonly tags?: readonly string[]
}

export interface AddMembersInput {
  readonly person_ids?: readonly string[]
  readonly people?: readonly NewPersonInput[]
  /** Who added new people: the AI assistant's card says 'assistant'; omitted = 'manual' (the API's default). */
  readonly origin?: 'manual' | 'assistant'
}

export interface ProjectLinkInput {
  readonly list_ids?: readonly string[]
  readonly person_ids?: readonly string[]
  readonly people?: readonly NewPersonInput[]
}

type AskLinkInput = { readonly kind: 'form'; readonly form_id: string } | { readonly kind: 'url'; readonly url: string }

export interface AskInput {
  readonly project_id?: string
  readonly list_ids: readonly string[]
  readonly person_ids: readonly string[]
  readonly subject: string
  readonly message: string
  readonly link: AskLinkInput
}

export type SettingsInput = Omit<EngagementSettings, 'updated_at' | 'updated_by'>

/** Route bounds, mirrored so the forms refuse before the server does. */
export const MAX_SUBJECT_CHARS = 160
export const MAX_MESSAGE_CHARS = 4000
export const MAX_RECIPIENTS = 500
export const MAX_COMPANY_DOMAINS = 20
export const MAX_SENDER_NAME_CHARS = 80

export const participantsKeys = {
  all: () => ['participants'] as const,
  settings: () => ['participants', 'settings'] as const,
  lists: () => ['participants', 'lists'] as const,
  list: (listId: string) => ['participants', 'list', listId] as const,
  people: (q: string, listId: string) => ['participants', 'people', q, listId] as const,
  person: (personId: string) => ['participants', 'person', personId] as const,
  project: (projectId: string) => ['participants', 'project', projectId] as const,
  asks: (projectId: string) => ['participants', 'asks', projectId] as const,
  ask: (askId: string) => ['participants', 'ask', askId] as const,
  forms: () => ['participants', 'forms'] as const,
}

const id = encodeURIComponent

function peopleQuery(q: string, listId: string): string {
  const params = new URLSearchParams()
  if (q.trim() !== '') params.set('q', q.trim())
  if (listId !== '') params.set('list_id', listId)
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

export const participantsApi = {
  getSettings: async (): Promise<SettingsView> => normalize.settings(await fetchApi<unknown>('/participants/settings')),
  /** A partial save: only the named fields change (the Boards section saves the company domains alone). */
  saveSettings: async (settings: Partial<SettingsInput>): Promise<EngagementSettings> =>
    normalize.savedSettings(await fetchApi<unknown>('/participants/settings', put(settings))),

  getLists: async (): Promise<ParticipantList[]> => normalize.lists(await fetchApi<unknown>('/participants/lists')),
  createList: async (input: ListInput): Promise<ParticipantList> =>
    normalize.list(await fetchApi<unknown>('/participants/lists', post(input))),
  getList: async (listId: string): Promise<ListDetail> =>
    normalize.listDetail(await fetchApi<unknown>(`/participants/lists/${id(listId)}`)),
  updateList: async (listId: string, input: Partial<ListInput>): Promise<ParticipantList> =>
    normalize.list(await fetchApi<unknown>(`/participants/lists/${id(listId)}`, put(input))),
  deleteList: (listId: string) => fetchApi<unknown>(`/participants/lists/${id(listId)}`, del()),
  addMembers: async (listId: string, input: AddMembersInput): Promise<AddMembersResult> =>
    normalize.addMembers(await fetchApi<unknown>(`/participants/lists/${id(listId)}/members`, post(input))),
  removeMember: (listId: string, personId: string) =>
    fetchApi<unknown>(`/participants/lists/${id(listId)}/members/${id(personId)}`, del()),

  getPeople: async (q = '', listId = ''): Promise<Person[]> =>
    normalize.people(await fetchApi<unknown>(`/participants/people${peopleQuery(q, listId)}`)),
  getPerson: async (personId: string): Promise<PersonDetail> =>
    normalize.personDetail(await fetchApi<unknown>(`/participants/people/${id(personId)}`)),
  updatePerson: async (personId: string, edit: PersonEdit): Promise<Person> =>
    normalize.person(await fetchApi<unknown>(`/participants/people/${id(personId)}`, put(edit))),
  /** Admin: erases the person (memberships, project links, tokens); past recipient rows keep only the id. */
  deletePerson: (personId: string) => fetchApi<unknown>(`/participants/people/${id(personId)}`, del()),

  getProject: async (projectId: string): Promise<ProjectParticipants> =>
    normalize.project(await fetchApi<unknown>(`/participants/projects/${id(projectId)}`)),
  linkToProject: async (projectId: string, input: ProjectLinkInput): Promise<ProjectLinkResult> =>
    normalize.projectLink(await fetchApi<unknown>(`/participants/projects/${id(projectId)}`, post(input))),
  unlinkList: (projectId: string, listId: string) =>
    fetchApi<unknown>(`/participants/projects/${id(projectId)}/lists/${id(listId)}`, del()),
  unlinkPerson: (projectId: string, personId: string) =>
    fetchApi<unknown>(`/participants/projects/${id(projectId)}/people/${id(personId)}`, del()),

  createAsk: async (input: AskInput): Promise<Ask> =>
    normalize.ask(await fetchApi<unknown>('/participants/asks', post(input))),
  getAsks: async (projectId = ''): Promise<Ask[]> => normalize.asks(projectId === ''
    ? await fetchApi<unknown>('/participants/asks')
    : await fetchApi<unknown>(`/participants/asks?project_id=${id(projectId)}`)),
  getAsk: async (askId: string): Promise<AskDetail> =>
    normalize.askDetail(await fetchApi<unknown>(`/participants/asks/${id(askId)}`)),

  /** The feedback forms an ask can link to (the composer's picker). */
  getForms: async (): Promise<FormOption[]> => normalize.forms(await fetchApi<unknown>('/feedback-forms')),
}

/**
 * PUBLIC. Unsubscribe the person an emailed token names. Plain `fetch`, no session header:
 * the page is opened from an email, signed in or not. The route always answers 200 (no
 * existence leak), so only a transport failure or a 5xx reads as "not done".
 */
export async function unsubscribe(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${getBaseUrl()}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    return response.ok
  } catch {
    return false
  }
}
