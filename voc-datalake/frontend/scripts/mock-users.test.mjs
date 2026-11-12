#!/usr/bin/env node

/**
 * The dev mock's user list and role change against users_handler: GET /users reports each user's
 * `platform_admin`, and a demotion also revokes platform-admins while a promotion keeps the other groups.
 *
 * Run: node --test scripts/mock-users.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mockCaller, useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()
const call = mockCaller(mock)

async function listed(username) {
  const [, body] = await call('GET', '/users')
  return body.users.find((user) => user.username === username)
}

describe('mock users', () => {
  it('reports platform_admin from the platform-admins group', async () => {
    assert.deepEqual([(await listed('admin-demo')).platform_admin, (await listed('viewer-demo')).platform_admin], [true, false])
  })

  it('keeps platform-admins on a promotion and revokes it on a demotion', async () => {
    assert.equal((await call('PUT', '/users/admin-demo/group', { group: 'admins' }))[0], 200)
    assert.deepEqual((await listed('admin-demo')).groups, ['platform-admins', 'admins'])
    assert.equal((await call('PUT', '/users/admin-demo/group', { group: 'users' }))[0], 200)
    const demoted = await listed('admin-demo')
    assert.deepEqual([demoted.groups, demoted.platform_admin], [['users'], false])
  })
})
