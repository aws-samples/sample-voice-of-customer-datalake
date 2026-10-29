/**
 * Participants (docs/participants.md): `/participants?tab=lists|people|asks` and a
 * project's Participants tab (`/projects/{id}?tab=participants`).
 *
 * Admin, serial:
 * 1. Lists: "New list" → `${RUN_PREFIX}list`, Edit renames it, Delete → "Delete this
 *    list?" → Delete; the card is gone and `GET /participants/lists/{id}` is a 404.
 * 2. People: on a helper e2e list, "Add one person" adds `e2e-<run id>-person@example.com`;
 *    the People search finds them, the person modal opens and closes with Escape, then
 *    "Delete person" → "Delete this person for good?" erases them (search: "No one
 *    matches.", `GET /participants/people/{id}` 404). Skipped when the deployment refuses
 *    @example.com addresses (no company domain, external people off).
 * 3. Project tab on a public `ensureE2eProject` project: link the e2e list, the linked
 *    list and the reach sentence show (reach 1 with its e2e member), unlink it.
 * 4. Ask composer: Send on an empty draft lists every problem and sends nothing; email
 *    off (the deployment's own `email_enabled`, then forced off by answering
 *    `GET /participants/settings` in the page) disables Send with the explanation.
 *    `POST /participants/asks` is answered in the page in this test, so even a slip
 *    cannot send (asserted: 0 hits).
 * 5. MOCK ONLY: one ask to the fixture list "Example Air employees" (@example.com
 *    people) appears under Asks. NEVER in production: an ask emails real people.
 *
 * e2e-user (production only; the mock has no login): no list Delete and no "Delete
 * person" control, and forced admin-only DELETEs are 403.
 *
 * Lists and people are not ledger kinds: every one made here is deleted in this file
 * (`afterAll` too) and proven gone with a GET.
 *
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:5481 E2E_API=http://127.0.0.1:3481 \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/participants.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { assertStep, escapeRegExp, isApi, roleOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { injectFailure } from '../lib/inject'
import {
  addPersonToList, createList, deleteListAs, e2eEmail, erasePersonAs, listIdNamed, personIdByEmail,
  listStatus, personStatus, readEngagementSettings,
} from '../lib/participants'
import { ensureE2eProject } from '../lib/projects'

const NAME = {
  list: `${RUN_PREFIX}list`,
  renamed: `${RUN_PREFIX}list-renamed`,
  peopleList: `${RUN_PREFIX}people-list`,
  projectList: `${RUN_PREFIX}project-list`,
  person: `${RUN_PREFIX}person`,
  reachPerson: `${RUN_PREFIX}reach-person`,
  project: `${RUN_PREFIX}participants`,
  ask: `${RUN_PREFIX}ask`,
}
const EMAIL = { person: e2eEmail('person'), reachPerson: e2eEmail('reach-person') }
/** The mock's fixture list of @example.com people (mock-participants-data.js). */
const MOCK_LIST = 'Example Air employees'
/** An id no person or list has; the admin check comes before the lookup (participants_routes.py). */
const NOBODY = { person: 'per_e2e0000000000nobody', list: 'lst_e2e0000000000nobody' }
const EMAIL_OFF = /Email sending is not configured for this deployment, so asks cannot be sent/
const DRAFT_ISSUES = ['Choose at least one list or person.', 'Write a subject.', 'Write a message.', 'Choose a feedback form.']

/** Every list and person this file made, for `afterAll` (ids as soon as they are known). */
const made = { lists: new Set<string>(), people: new Set<string>() }

const listCard = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Lists' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) })

async function openParticipants(page: Page, tab: 'lists' | 'people' | 'asks'): Promise<void> {
  await page.goto(site(`/participants?tab=${tab}`), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Participants', level: 1 })).toBeVisible()
  await expect(page.getByRole('tab', { name: new RegExp(`^${tab}$`, 'i') })).toHaveAttribute('aria-selected', 'true')
}

/** Saves the open list form and returns the saved list id. */
async function saveListForm(page: Page, dialogName: string, name: string, method: 'POST' | 'PUT'): Promise<string> {
  const dialog = dialogNamed(page, dialogName)
  await dialog.getByLabel('Name').fill(name)
  const saved = page.waitForResponse((r) => isApi(r, method, /\/participants\/lists(\/[^/]+)?$/))
  await dialog.getByRole('button', { name: 'Save' }).click()
  const response = await saved
  expect(response.status(), `${method} list`).toBeLessThan(300)
  await expect(dialog).toHaveCount(0)
  const body: unknown = await response.json()
  const id = stringField(isRecord(body) && isRecord(body['list']) ? body['list'] : undefined, 'list_id')
  if (id === undefined) throw new Error('the list save answered no list_id')
  return id
}

test.describe('participants (admin)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'admin writes; e2e-user has its own describe')
  })

  test.afterAll(async ({}, testInfo) => {
    if (roleOf(testInfo) !== 'admin') return
    for (const id of made.people) expect(await erasePersonAs(id), `person ${id} gone`).toBe(404)
    for (const id of made.lists) expect(await deleteListAs(id), `list ${id} gone`).toBe(404)
  })

  test('a list is created, renamed and deleted, and the API no longer has it', async ({ page }) => {
    let listId = ''
    await assertStep(page, 'admin', 'participants-list-create', async () => {
      await openParticipants(page, 'lists')
      await settle(page, 300)
      await page.getByRole('button', { name: 'New list' }).first().click()
      listId = await saveListForm(page, 'New list', NAME.list, 'POST')
      made.lists.add(listId)
      await expect(listCard(page, NAME.list)).toBeVisible()
    })
    await assertStep(page, 'admin', 'participants-list-rename', async () => {
      await page.getByRole('button', { name: `Edit ${NAME.list}`, exact: true }).click()
      await expect(dialogNamed(page, 'Edit list').getByLabel('Name')).toHaveValue(NAME.list)
      expect(await saveListForm(page, 'Edit list', NAME.renamed, 'PUT')).toBe(listId)
      await expect(listCard(page, NAME.renamed)).toBeVisible()
      await expect(listCard(page, NAME.list)).toHaveCount(0)
    })
    await assertStep(page, 'admin', 'participants-list-delete', async () => {
      await page.getByRole('button', { name: `Delete ${NAME.renamed}`, exact: true }).click()
      const confirm = dialogNamed(page, 'Delete this list?')
      await expect(confirm.getByText(NAME.renamed)).toBeVisible()
      const deleted = page.waitForResponse((r) => isApi(r, 'DELETE', /\/participants\/lists\/[^/]+$/))
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
      expect((await deleted).status()).toBeLessThan(300)
      await expect(listCard(page, NAME.renamed)).toHaveCount(0)
    })
    expect(await listStatus(listId), 'deleted list').toBe(404)
    expect(await listIdNamed(NAME.renamed), 'not in GET /participants/lists').toBeUndefined()
    made.lists.delete(listId)
  })

  test('a person is added, found, opened and closed, then erased for good', async ({ page }) => {
    const settings = await readEngagementSettings()
    test.skip(!settings.exampleAllowed, 'the deployment refuses @example.com people (no company domain, external off)')
    const listId = await createList(NAME.peopleList)
    made.lists.add(listId)

    await assertStep(page, 'admin', 'participants-person-add', async () => {
      await openParticipants(page, 'lists')
      await listCard(page, NAME.peopleList).getByRole('button', { name: 'Open' }).click()
      const modal = dialogNamed(page, NAME.peopleList)
      const form = modal.getByRole('region', { name: 'Add one person' })
      await form.getByLabel('Email').fill(EMAIL.person)
      await form.getByLabel('Name').fill(NAME.person)
      const added = page.waitForResponse((r) => isApi(r, 'POST', /\/participants\/lists\/[^/]+\/members$/))
      await form.getByRole('button', { name: 'Add to list' }).click()
      expect((await added).status()).toBe(200)
      await expect(form.getByRole('status')).toContainText('Added: 1')
      await expect(modal.getByRole('list', { name: 'Members' }).getByText(NAME.person)).toBeVisible()
      const personId = await personIdByEmail(EMAIL.person)
      if (personId !== undefined) made.people.add(personId)
      expect(personId, 'the person exists').toBeDefined()
      await page.keyboard.press('Escape')
      await expect(modal).toHaveCount(0)
    })

    await assertStep(page, 'admin', 'participants-person-search-modal', async () => {
      await openParticipants(page, 'people')
      await page.getByRole('searchbox', { name: 'Search people' }).fill(EMAIL.person)
      const row = page.getByRole('button', { name: EMAIL.person, exact: true })
      await expect(row).toBeVisible()
      await expect(page.getByRole('row').filter({ hasText: EMAIL.person })).toContainText(NAME.peopleList)
      await row.click()
      const modal = dialogNamed(page, NAME.person)
      await expect(modal.getByText(EMAIL.person)).toBeVisible()
      await expect(modal.getByRole('region', { name: 'Lists' })).toContainText(NAME.peopleList)
      await page.keyboard.press('Escape')
      await expect(modal).toHaveCount(0)
    })

    const search = page.getByRole('searchbox', { name: 'Search people' })
    await assertStep(page, 'admin', 'participants-person-erase', async (recorder) => {
      await page.getByRole('button', { name: EMAIL.person, exact: true }).click()
      const modal = dialogNamed(page, NAME.person)
      await modal.getByRole('button', { name: 'Delete person' }).click()
      const confirm = dialogNamed(page, 'Delete this person for good?')
      await expect(confirm.getByText(/This cannot be undone/)).toBeVisible()
      const erased = page.waitForResponse((r) => isApi(r, 'DELETE', /\/participants\/people\/[^/]+$/))
      await confirm.getByRole('button', { name: 'Delete for good' }).click()
      expect((await erased).status()).toBeLessThan(300)
      await expect(modal).toHaveCount(0)
      await expect(page.getByRole('button', { name: EMAIL.person, exact: true })).toHaveCount(0)
      recorder.note(`search after the erase: "${await search.inputValue()}"`)
      await search.fill(EMAIL.person)
      await expect(page.getByText('No one matches.')).toBeVisible()
    })
    for (const id of made.people) {
      expect(await personStatus(id), 'erased person').toBe(404)
      made.people.delete(id)
    }
    expect(await personIdByEmail(EMAIL.person), 'not in the people search').toBeUndefined()
  })

  test('a project links a list, shows its reach, and unlinks it', async ({ page }) => {
    const settings = await readEngagementSettings()
    const projectId = await ensureE2eProject(NAME.project, 'public')
    const listId = await createList(NAME.projectList)
    made.lists.add(listId)
    if (settings.exampleAllowed) made.people.add(await addPersonToList(listId, EMAIL.reachPerson, NAME.reachPerson))
    const reach = settings.exampleAllowed ? 1 : 0
    const linkedLists = page.getByRole('region', { name: 'Linked lists' })

    await assertStep(page, 'admin', 'participants-project-link', async () => {
      await page.goto(site(`/projects/${encodeURIComponent(projectId)}?tab=participants`), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'Participants', level: 2 })).toBeVisible()
      const add = page.getByRole('region', { name: 'Add participants' })
      await add.getByLabel('Add a list').selectOption({ label: NAME.projectList })
      const linked = page.waitForResponse((r) => isApi(r, 'POST', /\/participants\/projects\/[^/]+$/))
      await add.getByRole('button', { name: 'Link list' }).click()
      expect((await linked).status()).toBe(200)
      await expect(linkedLists.getByText(NAME.projectList, { exact: true })).toBeVisible()
      await expect(linkedLists.getByRole('listitem').filter({ hasText: NAME.projectList })).toContainText(`${reach} member`)
      await expect(page.getByText(new RegExp(`^Reaches ${reach} active (person|people)\\.$`))).toBeVisible()
    })

    await assertStep(page, 'admin', 'participants-project-unlink', async () => {
      const unlinked = page.waitForResponse((r) => isApi(r, 'DELETE', /\/participants\/projects\/[^/]+\/lists\/[^/]+$/))
      await page.getByRole('button', { name: `Remove the list ${NAME.projectList} from this project`, exact: true }).click()
      expect((await unlinked).status()).toBeLessThan(300)
      await expect(linkedLists.getByText(NAME.projectList, { exact: true })).toHaveCount(0)
    })
    const after = await apiCall('admin', 'GET', `/participants/projects/${encodeURIComponent(projectId)}`)
    expect(after.status).toBe(200)
    expect(listOf(after.body, 'lists').some((list) => list['list_id'] === listId), 'unlinked in the API').toBe(false)
  })

  test('the ask composer refuses an empty draft and explains a disabled Send when email is off', async ({ page }) => {
    const settings = await readEngagementSettings()
    // Belt and braces: nothing this test does may send an ask.
    const sendGuard = await injectFailure(page, { method: 'POST', path: /\/participants\/asks$/, failure: { status: 418 } })
    const composer = dialogNamed(page, 'Ask for feedback')
    const send = composer.getByRole('button', { name: 'Send', exact: true })

    await assertStep(page, 'admin', 'participants-ask-validation', async (recorder) => {
      recorder.note(`deployment email_enabled: ${settings.emailEnabled}`)
      await openParticipants(page, 'lists')
      await page.getByRole('button', { name: 'New ask' }).click()
      await expect(composer.getByRole('status')).toHaveText(/0 people/)
      if (settings.emailEnabled) {
        await expect(send).toBeEnabled()
        await send.click()
        const issues = composer.getByRole('alert')
        for (const issue of DRAFT_ISSUES) await expect(issues.getByText(issue, { exact: true })).toBeVisible()
      } else {
        await expect(composer.getByText(EMAIL_OFF)).toBeVisible()
        await expect(send).toBeDisabled()
      }
      await page.keyboard.press('Escape')
      await expect(composer).toHaveCount(0)
    })

    const real = await apiCall('admin', 'GET', '/participants/settings')
    const off = isRecord(real.body) ? { ...real.body, email_enabled: false } : { email_enabled: false }
    const forced = await injectFailure(page, { method: 'GET', path: /\/participants\/settings$/, failure: { status: 200, body: off } })
    await assertStep(page, 'admin', 'participants-ask-email-off', async () => {
      await openParticipants(page, 'lists')
      await page.getByRole('button', { name: 'New ask' }).click()
      await expect(composer.getByRole('alert').filter({ hasText: EMAIL_OFF })).toBeVisible()
      await expect(send).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(composer).toHaveCount(0)
    })
    expect(forced.hits(), 'the forced settings answer was used').toBeGreaterThan(0)
    expect(sendGuard.hits(), 'no ask was sent').toBe(0)
  })

  test('mock only: an ask to an @example.com fixture list appears under Asks', async ({ page }) => {
    test.skip(!MOCK, 'an ask emails real people: never against a deployment')
    const composer = dialogNamed(page, 'Ask for feedback')
    await assertStep(page, 'admin', 'participants-ask-send-mock', async () => {
      await openParticipants(page, 'lists')
      await page.getByRole('button', { name: 'New ask' }).click()
      await composer.getByRole('checkbox', { name: new RegExp(`^${escapeRegExp(MOCK_LIST)}`) }).check()
      await expect(composer.getByRole('status')).toHaveText(/^2 people/)
      await composer.getByLabel('Subject').fill(NAME.ask)
      await composer.getByLabel('Message').fill('e2e: an ask to the mock fixture list.')
      await composer.getByRole('radio', { name: 'A web page (https)' }).check()
      await composer.getByPlaceholder('https://').fill('https://example.com/e2e')
      const sent = page.waitForResponse((r) => isApi(r, 'POST', /\/participants\/asks$/))
      await composer.getByRole('button', { name: 'Send', exact: true }).click()
      expect((await sent).status()).toBe(202)
      await expect(composer.getByText('Your ask is on its way to 2 people.')).toBeVisible()
      await composer.getByRole('button', { name: 'Done' }).click()
      await expect(composer).toHaveCount(0)
      await page.getByRole('tab', { name: 'Asks' }).click()
      const row = page.getByRole('list', { name: 'Asks' }).getByRole('listitem').filter({ hasText: NAME.ask })
      await expect(row.first()).toContainText('2 sent')
    })
  })
})

test.describe('participants (e2e-user)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(MOCK, 'e2e-user needs a real login')
    test.skip(roleOf(testInfo) !== 'user', 'the refusals run as e2e-user')
  })

  test('e2e-user sees no delete or erase control', async ({ page }) => {
    await assertStep(page, 'user', 'participants-user-controls', async (recorder) => {
      await openParticipants(page, 'lists')
      await settle(page, 300)
      await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0)
      await openParticipants(page, 'people')
      await settle(page, 300)
      const first = page.getByRole('table').getByRole('button').first()
      if (await first.count() === 0) {
        recorder.note('no people on the deployment: the person modal is not opened')
        return
      }
      await first.click()
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Delete person' })).toHaveCount(0)
      await page.keyboard.press('Escape')
    })
  })

  test('forced admin-only deletes are refused with 403', async () => {
    expect((await apiCall('user', 'DELETE', `/participants/people/${NOBODY.person}`)).status, 'erase a person').toBe(403)
    expect((await apiCall('user', 'DELETE', `/participants/lists/${NOBODY.list}`)).status, 'delete a list').toBe(403)
  })
})
