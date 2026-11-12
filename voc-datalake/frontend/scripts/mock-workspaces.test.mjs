#!/usr/bin/env node

/**
 * The dev mock's workspaces against workspaces_handler: no workspace by default, two after the
 * `/__mock/workspaces` switch (admin of acme, editor of juniper), `/me/workspaces/current` honouring
 * X-Workspace-Id (400 without it, one 404 for any id that is not the caller's), the members routes with their
 * refusals (403 for a non-admin, 409 for the last admin or a person already a member, a leave), the platform list
 * and create (409 for a taken slug), and the platform-admin grant and revoke (users routes in mock-server.js).
 *
 * Run: node --test scripts/mock-workspaces.test.mjs
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import { mockCaller, useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()
const call = mockCaller(mock)
const CALLER = 'sub-admin-demo'

/** `[status, json]` of `method path` with X-Workspace-Id `id` (none when undefined). */
async function inWorkspace(id, method, path, body) {
  const headers = { 'Content-Type': 'application/json', ...(id === undefined ? {} : { 'X-Workspace-Id': id }) }
  const response = await fetch(`${mock.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return [response.status, await response.json()]
}

const current = (id) => inWorkspace(id, 'GET', '/me/workspaces/current')
const members = (id) => inWorkspace(id, 'GET', '/me/workspaces/current/members')
const member = (sub) => `/me/workspaces/current/members/${sub}`

/** The mock's workspaces by slug, as `GET /me/workspaces` lists them. */
async function mine() {
  const [, { workspaces }] = await call('GET', '/me/workspaces')
  return Object.fromEntries(workspaces.map((workspace) => [workspace.slug, workspace]))
}

describe('mock workspaces', () => {
  it('lists no workspace by default, as a deployment before workspaces', async () => {
    assert.deepEqual(await call('GET', '/me/workspaces'), [200, { workspaces: [] }])
    assert.deepEqual(await call('GET', '/platform/workspaces'), [200, { workspaces: [], next_cursor: null }])
  })

  it('creates no workspace while the switch is off', async () => {
    const [status, body] = await call('POST', '/platform/workspaces', { name: 'Acme Outfitters', slug: 'acme' })
    assert.equal(status, 400)
    assert.match(body.error, /__mock\/workspaces/)
  })

  describe('with the switch on', () => {
    // Each switch starts afresh, so every test sees the two fixtures as they are.
    beforeEach(async () => { assert.equal((await call('PUT', '/__mock/workspaces', { enabled: true }))[0], 200) })
    after(async () => { await call('PUT', '/__mock/workspaces', { enabled: false }) })

    it('lists acme (admin) and juniper (editor) by name, with server-shaped ids', async () => {
      const [status, body] = await call('GET', '/me/workspaces')
      assert.equal(status, 200)
      assert.deepEqual(body.workspaces.map(({ name, slug, role }) => [name, slug, role]),
        [['Acme Outfitters', 'acme', 'admin'], ['Juniper Trail Co.', 'juniper', 'editor']])
      assert.ok(body.workspaces.every(({ id }) => /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)))
    })

    it('answers the workspace X-Workspace-Id names, 400 without it and one 404 for another id', async () => {
      const { juniper } = await mine()
      assert.deepEqual(await current(juniper.id), [200, { workspace: { ...juniper, platform_admin: false } }])
      assert.equal((await current())[0], 400)
      assert.deepEqual(await current('ws_01JCZZZZ0000000000000000Z9'), [404, { success: false, error: 'Workspace not found' }])
    })

    it('lists a workspace\'s members by sub, the creator\'s email filled in like Cognito\'s', async () => {
      const { acme } = await mine()
      const [status, body] = await members(acme.id)
      assert.equal(status, 200)
      assert.deepEqual(body.members.map(({ sub, role, email }) => [sub, role, email]),
        [[CALLER, 'admin', 'admin@example.com'], ['sub-viewer-demo', 'viewer', 'viewer@example.com']])
      assert.equal(body.next_cursor, null)
    })

    it('adds an existing account at once, then refuses it again (409); a new email gets an account', async () => {
      const { acme } = await mine()
      const [status, body] = await inWorkspace(acme.id, 'POST', '/me/workspaces/current/members', { email: 'editor@example.com', role: 'editor' })
      assert.deepEqual([status, body.member.sub, body.member.account], [201, 'sub-editor-demo', 'existing'])
      const again = await inWorkspace(acme.id, 'POST', '/me/workspaces/current/members', { email: 'editor@example.com', role: 'viewer' })
      assert.deepEqual(again, [409, { success: false, error: 'That person is already a member of this workspace' }])
      const created = await inWorkspace(acme.id, 'POST', '/me/workspaces/current/members', { email: 'new.person@example.com', role: 'viewer' })
      assert.deepEqual([created[0], created[1].member.account], [201, 'created'])
    })

    it('changes a role, and refuses demoting or removing the last admin (409)', async () => {
      const { acme } = await mine()
      assert.deepEqual(await inWorkspace(acme.id, 'PUT', member('sub-viewer-demo'), { role: 'editor' }), [200, { member: { sub: 'sub-viewer-demo', role: 'editor' } }])
      const lastAdmin = { success: false, error: 'A workspace needs an admin: make another member an admin first' }
      assert.deepEqual(await inWorkspace(acme.id, 'PUT', member(CALLER), { role: 'viewer' }), [409, lastAdmin])
      assert.deepEqual(await inWorkspace(acme.id, 'DELETE', member(CALLER)), [409, lastAdmin])
    })

    it('lets an editor read and leave, but not manage (403)', async () => {
      const { juniper } = await mine()
      assert.equal((await members(juniper.id))[0], 200)
      assert.deepEqual(await inWorkspace(juniper.id, 'PUT', member('sub-editor-demo'), { role: 'viewer' }),
        [403, { success: false, error: 'Workspace admin access required' }])
      assert.deepEqual(await inWorkspace(juniper.id, 'DELETE', member(CALLER)), [200, { removed: CALLER }])
      assert.deepEqual(Object.keys(await mine()), ['acme'])
    })

    it('answers 404 for a member who is not one', async () => {
      const { acme } = await mine()
      assert.deepEqual(await inWorkspace(acme.id, 'DELETE', member('sub-nobody')), [404, { success: false, error: 'Member not found' }])
    })

    it('lists every workspace for a platform admin and creates one, the caller its admin; a taken slug is 409', async () => {
      const [created, body] = await call('POST', '/platform/workspaces', { name: 'Acme Outfitters Field Team', slug: 'acme-field' })
      assert.deepEqual([created, body.workspace.slug, body.workspace.role, body.workspace.secret_status], [201, 'acme-field', 'admin', 'ready'])
      const [, list] = await call('GET', '/platform/workspaces')
      assert.deepEqual(list.workspaces.map(({ slug, secret_status }) => [slug, secret_status]),
        [['acme', 'ready'], ['acme-field', 'ready'], ['juniper', 'pending']])
      assert.deepEqual((await mine())['acme-field']?.role, 'admin')
      assert.deepEqual(await call('POST', '/platform/workspaces', { name: 'Again', slug: 'acme-field' }), [409, { success: false, error: 'That slug is taken: choose another' }])
    })

    it('lets a platform admin who is not a member enter as admin', async () => {
      const { juniper } = await mine()
      await inWorkspace(juniper.id, 'DELETE', member(CALLER))
      const [status, body] = await current(juniper.id)
      assert.deepEqual([status, body.workspace.role, body.workspace.platform_admin], [200, 'admin', true])
    })
  })

  it('refuses a switch that is not a boolean, or a member that is not a slug', async () => {
    assert.equal((await call('PUT', '/__mock/workspaces', { enabled: 'yes' }))[0], 400)
    assert.equal((await call('PUT', '/__mock/workspaces', { enabled: true, member: 7 }))[0], 400)
    assert.equal((await call('PUT', '/__mock/workspaces', { enabled: true, member: 'nowhere' }))[0], 400)
    assert.deepEqual(await call('PUT', '/__mock/workspaces', { enabled: false, member: 'acme' }),
      [400, { success: false, error: 'member needs enabled: true' }])
  })

  describe('member: acme (the cross-workspace check)', () => {
    let juniperId = ''
    before(async () => {
      await call('PUT', '/__mock/workspaces', { enabled: true })
      juniperId = (await mine()).juniper.id
      assert.deepEqual(await call('PUT', '/__mock/workspaces', { enabled: true, member: 'acme' }), [200, { enabled: true }])
    })
    after(async () => { await call('PUT', '/__mock/workspaces', { enabled: false }) })

    it('lists acme only and refuses the platform routes', async () => {
      assert.deepEqual(Object.keys(await mine()), ['acme'])
      assert.equal((await call('GET', '/platform/workspaces'))[0], 403)
    })

    it("answers juniper's id with the one 404, as an id that names no workspace", async () => {
      const refused = [404, { success: false, error: 'Workspace not found' }]
      for (const id of [juniperId, 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
        assert.deepEqual(await current(id), refused)
        assert.deepEqual(await members(id), refused)
        assert.deepEqual(await inWorkspace(id, 'PUT', member('sub-editor-demo'), { role: 'viewer' }), refused)
        assert.deepEqual(await inWorkspace(id, 'DELETE', member('sub-editor-demo')), refused)
      }
    })

    it('restores the default when switched off', async () => {
      await call('PUT', '/__mock/workspaces', { enabled: false })
      assert.equal((await call('GET', '/platform/workspaces'))[0], 200)
    })
  })
})

describe('mock platform-admin grant and revoke', () => {
  before(async () => {
    // A second administrator to grant it to (deleted again below).
    await call('POST', '/users', { username: 'second-admin', email: 'second.admin@example.com', group: 'admins' })
  })
  after(async () => { await call('DELETE', '/users/second-admin') })

  it('grants an administrator, refuses a plain user (400), and refuses revoking the last one (409)', async () => {
    assert.equal((await call('PUT', '/users/viewer-demo/platform-admin', { platform_admin: true }))[0], 400)
    assert.deepEqual((await call('PUT', '/users/second-admin/platform-admin', { platform_admin: true }))[1].message, 'Platform admin granted')
    assert.deepEqual((await call('PUT', '/users/second-admin/platform-admin', { platform_admin: false }))[1].message, 'Platform admin revoked')
    assert.deepEqual(await call('PUT', '/users/admin-demo/platform-admin', { platform_admin: false }),
      [409, { success: false, error: 'This is the last enabled platform admin: make another administrator a platform admin first.' }])
  })
})
