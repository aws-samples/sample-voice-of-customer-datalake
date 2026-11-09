/**
 * Push notices over AppSync Events (6.04.00 / 6.04.01, docs/realtime.md, frontend/src/realtime/).
 *
 * 1. `<site>/config.json` carries `realtime.httpDns` and `realtime.realtimeDns` (bare hosts).
 * 2. Over a Node WebSocket (lib/realtime.ts, the SPA's protocol): the role's own `/jobs|chat|runs/<sub>`
 *    subscribe succeeds; another sub's channel, `/jobs/*` and `/jobs/<sub>/x` are refused Unauthorized;
 *    a token-less connect is refused.
 * 3. Admin only: ONE assist job (`POST /scrapers/analyze-url` on https://example.com, nothing saved)
 *    ends with a `{type:'job', job_id, status}` notice on the open `/jobs/<sub>` subscription, and
 *    `GET /scrapers/jobs/{job_id}` agrees.
 * 4. Browser: a signed-in page opens a WebSocket to the realtime host and no console message reports a
 *    Content Security Policy violation (fails on 6.04.01, whose CSP blocks the socket; fixed in 6.04.02).
 *
 * Production-safe: subscriptions only read; the one write is an assist job that stores nothing.
 */
import { expect, type ConsoleMessage, type WebSocket as PwWebSocket } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, stringField } from '../lib/api'
import { isRecord } from '../lib/guards'
import { roleOf, settle, site } from '../lib/fixtures'
import { cognitoSubFor, idTokenFor } from '../lib/session'
import {
  RealtimeClient, errorTypesOf, eventOf, fetchRealtimeConfig, realtimeHostsOf, type RealtimeHosts,
} from '../lib/realtime'

const HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/i
const OTHER_SUB = 'ffffffff-1111-4222-8333-444455556666'
const JOB_NOTICE_TIMEOUT_MS = 120_000
const SOCKET_TIMEOUT_MS = 30_000
const CSP_VIOLATION = 'violates the following Content Security Policy'

let hosts: RealtimeHosts

test.beforeAll(async () => {
  hosts = realtimeHostsOf(await fetchRealtimeConfig())
})

test.describe('realtime push notices (AppSync Events)', () => {
  test('config.json carries the realtime hosts', async () => {
    const raw = await fetchRealtimeConfig()
    expect(isRecord(raw), 'config.json has a realtime block').toBe(true)
    const { httpDns, realtimeDns } = realtimeHostsOf(raw)
    expect(httpDns, 'httpDns is a bare host').toMatch(HOST)
    expect(realtimeDns, 'realtimeDns is a bare host').toMatch(HOST)
  })

  test('own channels subscribe; other channels and a token-less connect are refused', async ({}, testInfo) => {
    const role = roleOf(testInfo)
    const token = idTokenFor(role)
    const sub = cognitoSubFor(role)
    const { client, opened } = await RealtimeClient.open(hosts, token)
    try {
      expect(opened, 'the socket opens with a Cognito token').toBe(true)
      expect((await client.init()).type, 'connection_init').toBe('connection_ack')
      for (const ns of ['jobs', 'chat', 'runs']) {
        const msg = await client.subscribe(`own-${ns}`, `/${ns}/${sub}`, hosts, token)
        expect(msg.type, `/${ns}/<own sub>`).toBe('subscribe_success')
      }
      const refused: Array<[string, string]> = [
        ['other', `/jobs/${OTHER_SUB}`], ['wildcard', '/jobs/*'], ['deeper', `/jobs/${sub}/x`],
      ]
      for (const [id, channel] of refused) {
        const msg = await client.subscribe(id, channel, hosts, token)
        expect(msg.type, `${channel} is refused`).toBe('subscribe_error')
        expect(errorTypesOf(msg), `${channel} errorType`).toContain('Unauthorized')
      }
    } finally {
      client.close()
    }

    const anonymous = await RealtimeClient.open(hosts, null)
    try {
      const outcome = anonymous.opened ? (await anonymous.client.init()).type : 'refused'
      expect(outcome, 'a token-less connect gets no connection_ack').not.toBe('connection_ack')
    } finally {
      anonymous.client.close()
    }
  })

  test('an assist job end arrives as a push notice', async ({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'analyze-url is admin-only')
    test.setTimeout(JOB_NOTICE_TIMEOUT_MS + 60_000)
    const token = idTokenFor('admin')
    const sub = cognitoSubFor('admin')
    const { client, opened } = await RealtimeClient.open(hosts, token)
    try {
      expect(opened, 'socket opens').toBe(true)
      expect((await client.init()).type).toBe('connection_ack')
      expect((await client.subscribe('jobs', `/jobs/${sub}`, hosts, token)).type).toBe('subscribe_success')

      const started = await apiCall('admin', 'POST', '/scrapers/analyze-url', { url: 'https://example.com' })
      expect(started.status, `POST /scrapers/analyze-url ${JSON.stringify(started.body).slice(0, 200)}`).toBe(202)
      const jobId = stringField(isRecord(started.body) ? started.body : undefined, 'job_id')
      expect(jobId, 'job_id').toBeTruthy()

      const notice = await client.waitFor(
        (m) => m.type === 'data' && m.id === 'jobs' && eventOf(m)?.['job_id'] === jobId, JOB_NOTICE_TIMEOUT_MS)
      const event = eventOf(notice)
      expect(notice.type, `a notice for ${jobId} within ${JOB_NOTICE_TIMEOUT_MS / 1000} s`).toBe('data')
      expect(event?.['type']).toBe('job')
      const status = event?.['status']
      expect(['completed', 'failed'], `notice status ${String(status)}`).toContain(status)

      const poll = await apiCall('admin', 'GET', `/scrapers/jobs/${encodeURIComponent(jobId ?? '')}`)
      expect(poll.status, 'GET /scrapers/jobs/{id}').toBe(200)
      expect(stringField(isRecord(poll.body) ? poll.body : undefined, 'status'), 'poll agrees with the notice').toBe(status)
    } finally {
      client.close()
    }
  })

  test('a signed-in page opens the realtime socket without a CSP violation', async ({ page }) => {
    const sockets: string[] = []
    const cspViolations: string[] = []
    page.on('websocket', (ws: PwWebSocket) => { sockets.push(ws.url()) })
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.text().includes(CSP_VIOLATION)) cspViolations.push(msg.text().slice(0, 300))
    })
    await page.goto(site('/'), { waitUntil: 'domcontentloaded' })
    const opened = (): boolean => sockets.some((url) => new URL(url).host === hosts.realtimeDns)
    const deadline = Date.now() + SOCKET_TIMEOUT_MS
    while (!opened() && cspViolations.length === 0 && Date.now() < deadline) await page.waitForTimeout(500)
    await settle(page)
    // The CSP check comes first: a blocked socket never fires 'websocket', and the console text is the evidence.
    expect(cspViolations, 'no Content Security Policy violation').toEqual([])
    expect(opened(), `a WebSocket to ${hosts.realtimeDns} (seen: ${sockets.join(', ') || 'none'})`).toBe(true)
  })
})
