#!/usr/bin/env node

/**
 * The dev mock's workspaces against workspaces_handler: no workspace by default, two after the
 * `/__mock/workspaces` switch (admin of acme, editor of juniper), and `/me/workspaces/current` honouring
 * X-Workspace-Id: 400 without it, one 404 for any id that is not the caller's.
 *
 * Run: node --test scripts/mock-workspaces.test.mjs
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mockCaller, useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()
const call = mockCaller(mock)

/** `[status, json]` of `GET /me/workspaces/current`, naming `id` in X-Workspace-Id when given. */
async function current(id) {
  const headers = id === undefined ? {} : { 'X-Workspace-Id': id }
  const response = await fetch(`${mock.base}/me/workspaces/current`, { headers })
  return [response.status, await response.json()]
}

describe('mock workspaces', () => {
  it('lists no workspace by default, as a deployment before workspaces', async () => {
    assert.deepEqual(await call('GET', '/me/workspaces'), [200, { workspaces: [] }])
  })

  describe('with the switch on', () => {
    before(async () => { assert.equal((await call('PUT', '/__mock/workspaces', { enabled: true }))[0], 200) })
    after(async () => { await call('PUT', '/__mock/workspaces', { enabled: false }) })

    it('lists acme (admin) and juniper (editor) by name, with server-shaped ids', async () => {
      const [status, body] = await call('GET', '/me/workspaces')
      assert.equal(status, 200)
      assert.deepEqual(body.workspaces.map(({ name, slug, role }) => [name, slug, role]),
        [['Acme Outfitters', 'acme', 'admin'], ['Juniper Trail Co.', 'juniper', 'editor']])
      assert.ok(body.workspaces.every(({ id }) => /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)))
    })

    it('answers the workspace X-Workspace-Id names, 400 without it and one 404 for another id', async () => {
      const [, { workspaces }] = await call('GET', '/me/workspaces')
      const juniper = workspaces.find(({ slug }) => slug === 'juniper')
      assert.deepEqual(await current(juniper.id), [200, { workspace: { ...juniper, platform_admin: false } }])
      assert.equal((await current())[0], 400)
      assert.deepEqual(await current('ws_01JCZZZZ0000000000000000Z9'), [404, { success: false, error: 'Workspace not found' }])
    })
  })

  it('refuses a switch that is not a boolean', async () => {
    assert.equal((await call('PUT', '/__mock/workspaces', { enabled: 'yes' }))[0], 400)
  })
})
