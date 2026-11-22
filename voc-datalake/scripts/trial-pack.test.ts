/**
 * scripts/trial-pack.mjs (7.71.00, docs/multi-workspace.md "Trial workspaces"), run as the operator runs it, in a child
 * process: the people CSV, the requests a trial and its pack send (the trial first, then each create in the new
 * workspace, the forms Off, the sample categories), the new workspace named on every pack request, and nothing more
 * sent once the trial itself is refused. A local HTTP server stands in for the API.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const SCRIPT = path.resolve(__dirname, 'trial-pack.mjs');
const run = promisify(execFile);
const PACK = z.object({ categories: z.array(z.unknown()) })
  .parse(JSON.parse(readFileSync(path.resolve(__dirname, '..', 'schemas', 'trial-pack.json'), 'utf8')));
const RequestsSchema = z.array(z.object({ method: z.string(), path: z.string(), inWorkspace: z.boolean(), body: z.unknown() }));
const WS = 'ws_01JCTRIL0000000000000000T1';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'trial-pack-'));
  writeFileSync(path.join(dir, 'people.csv'), 'email,role,playbook\nana@example.com, admin, qa\n\nbo@example.com,viewer\n');
  writeFileSync(path.join(dir, 'form.json'), JSON.stringify({ name: 'Workshop feedback', template: { id: 'workshop', version: 1 }, enabled: true }));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const args = (...extra: string[]) => [SCRIPT, '--name', 'Example Trial', '--slug', 'example-trial', '--people',
  path.join(dir, 'people.csv'), '--form', path.join(dir, 'form.json'), '--categories', ...extra];

describe('trial-pack --dry-run', () => {
  it('creates the trial first, then the members, the forms Off and the sample categories in it', async () => {
    const requests = RequestsSchema.parse(JSON.parse((await run('node', args('--dry-run', '--days', '14'))).stdout));
    expect(requests.map((r) => `${r.method} ${r.path} ${String(r.inWorkspace)}`)).toStrictEqual([
      'POST /platform/workspaces false', 'POST /me/workspaces/current/members true',
      'POST /me/workspaces/current/members true', 'POST /feedback-forms true', 'PUT /settings/categories true']);
    expect(requests[0]?.body).toStrictEqual({ name: 'Example Trial', slug: 'example-trial',
      trial: { days: 14, pack: { forms: ['workshop'], categories: true, playbooks: true } } });
    expect(requests.map((r) => r.body)).toStrictEqual(expect.arrayContaining([
      { email: 'ana@example.com', role: 'admin', playbook: 'qa' }, { email: 'bo@example.com', role: 'viewer' },
      { name: 'Workshop feedback', template: { id: 'workshop', version: 1 }, enabled: false }, { categories: PACK.categories }]));
  });

  it('names a template once in the pack when two forms come from it (review round 1)', async () => {
    writeFileSync(path.join(dir, 'again.json'), JSON.stringify({ name: 'Day 2 feedback', template: { id: 'workshop', version: 1 } }));
    const requests = RequestsSchema.parse(JSON.parse((await run('node', [...args('--dry-run'), '--form',
      path.join(dir, 'again.json')])).stdout));
    expect(requests[0]?.body).toMatchObject({ trial: { pack: { forms: ['workshop'] } } });
    expect(requests.filter((r) => r.path === '/feedback-forms')).toHaveLength(2);
  });

  it('refuses a length the API does not take, and a person who is no email', async () => {
    await expect(run('node', [...args('--dry-run'), '--days', '45'])).rejects.toThrow(/--days must be 14, 30 or 60/);
    writeFileSync(path.join(dir, 'people.csv'), 'ana,admin\n');
    await expect(run('node', args('--dry-run'))).rejects.toThrow(/is not an email/);
  });
});

describe('trial-pack against an API', () => {
  async function serve(answer: (route: string) => [number, unknown]) {
    const seen: { route: string; workspace: string | undefined; token: string | undefined }[] = [];
    const server = createServer((request, response) => {
      const route = `${request.method ?? ''} ${request.url ?? ''}`;
      seen.push({ route, workspace: request.headers['x-workspace-id']?.toString(), token: request.headers.authorization });
      const [status, body] = answer(route);
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : 0;
    const api = `http://127.0.0.1:${port}/prod`;
    return { api, seen, close: () => new Promise<void>((done) => { server.close(() => { done(); }); }) };
  }

  it('names the new workspace on every pack request and says each outcome', async () => {
    const api = await serve((route) => (route === 'POST /prod/platform/workspaces'
      ? [201, { workspace: { id: WS, slug: 'example-trial' } }] : [200, { success: true }]));
    const { stdout } = await run('node', args('--api', api.api, '--token', 'id-token'));
    await api.close();
    expect(api.seen.map((s) => s.workspace)).toStrictEqual([undefined, WS, WS, WS, WS]);
    expect(api.seen.every((s) => s.token === 'id-token')).toBe(true);
    expect(stdout).toContain('/workspace/example-trial/scrapers/import');
  });

  it('sends nothing more when the trial itself is refused', async () => {
    const api = await serve(() => [409, { error: 'That slug is taken: choose another' }]);
    const result = await run('node', args('--api', api.api, '--token', 'id-token')).catch((error: unknown) => error);
    await api.close();
    expect(api.seen.map((s) => s.route)).toStrictEqual(['POST /prod/platform/workspaces']);
    expect(String(z.object({ stdout: z.string() }).parse(result).stdout)).toContain('409 That slug is taken');
  });
});
