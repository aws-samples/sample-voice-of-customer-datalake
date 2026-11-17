// A repository's knowledge pack, its tenets and the pull request of the approved docs (7.52.00;
// lambda/shared/agents_engineering_knowledge_routes.py), in their wire shape, for `npm run dev`. Fictional packs and
// tenets of the sample connection `storefront` (mock-engineering-runs.js):
//   GET  /agents/engineering/knowledge/<conn>                          {connection, packages, rendering}
//   GET  /agents/engineering/knowledge/<conn>/<pkg>/versions/<v>        {connection, version, documents, flagged}
//   POST …/approve {}                                                   the version approved (409: moved, read it again)
//   GET  /agents/engineering/tenets/<conn>                              {connection, head, versions} (newest first)
//   GET  /agents/engineering/tenets/<conn>/versions/<v>                 {connection, version, log}
//   POST …/versions/<v>/accept|reject {expected_accepted, reason?}      409 when the accepted version moved (gap P)
//   GET  /agents/engineering/docs/<conn>/preview?kind=knowledge|tenets  the files with their text (gap O), the patch
//   POST /agents/engineering/docs/<conn>/publish {kind, digest}         202 {pr, kind, version, digest, draft}, or 409
//        human_driven (MOCK_HUMAN_DRIVEN=1), already_published, digest_mismatch, not_approved
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403 on every route, as the server answers.
// Wired into mock-server.js by handleDomainModules, before the engineering runs' routes.
import { createHash } from 'node:crypto';

const isAdmin = () => process.env.MOCK_AGENTS_NON_ADMIN !== '1';
const CONNECTION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[1-9]\d{0,5}$/;
const KINDS = ['architecture', 'convention', 'review-guide', 'test-strategy', 'ci', 'glossary', 'how-we-work'];
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const sha = (text) => createHash('sha256').update(text).digest('hex');
const READ_AGAIN = 'the version or the approved one changed meanwhile: read it again';

const documentsOf = (pkg, version) => Object.fromEntries(KINDS.map((kind) => [kind,
  `# ${kind}\n\nWhat the agents should know of \`${pkg}\` (version ${version}).\n\n## Where things live\n\n- \`src/\`: the code\n- \`tests/\`: the tests\n\n## Notes\n\nCited from \`README.md:${version}\`.\n`]));

const packVersion = (pkg, version, status, extra = {}) => ({
  package: pkg, version, status, author: 'understander-1', author_kind: 'agent', reason: '', built_from: 'a'.repeat(40),
  base_version: version > 1 ? version - 1 : 0, created_at: daysAgo(10 - version), approved_by: status === 'approved' ? 'admin-demo' : null,
  approved_at: status === 'approved' ? daysAgo(8) : null, rendering_digest: null, ...extra,
});

/** Each connection's packages: their versions (oldest first) and the approved one. */
const PACKS = {
  storefront: [
    { package: '.', segment: '=2E', approved: 1, versions: [packVersion('.', 1, 'approved'), packVersion('.', 2, 'draft')] },
    { package: 'packages/web', segment: 'packages=2Fweb', approved: null, versions: [packVersion('packages/web', 1, 'draft')] },
  ],
};
const RENDERING = { storefront: { kind: 'knowledge', version: 1, approved_by: 'admin-demo', approved_at: daysAgo(8) } };

const tenet = (id, title, statement) => ({ id, title, statement, rationale: 'The users depend on it.', citations: ['README.md:12'] });
const TENETS = {
  storefront: {
    accepted: 1,
    versions: [
      { version: 1, status: 'accepted', record: { summary: 'What the storefront values.', tenets: [
        tenet('api-compat', 'Keep the public API compatible', 'A change never breaks a published endpoint.'),
        tenet('old-style', 'Use tabs', 'Indent with tabs.')] }, base_version: 0, created_at: daysAgo(9), decided_by: 'admin-demo',
        decided_at: daysAgo(8), reason: null, run_id: 'RUN-T1' },
      { version: 2, status: 'draft', record: { summary: 'What the storefront values, read again.', tenets: [
        tenet('api-compat', 'Keep the public API compatible', 'A change never breaks a published endpoint, nor its error codes.'),
        tenet('tests', 'Every fix comes with a test', 'A bug fix lands with a test that fails without it.')] }, base_version: 1,
        created_at: daysAgo(1), decided_by: null, decided_at: null, reason: null, run_id: 'RUN-T2' },
    ],
    log: { 1: [{ event: 'drafted', by: 'understander-1', at: daysAgo(9), reason: null }, { event: 'accepted', by: 'admin-demo', at: daysAgo(8), reason: null }],
      2: [{ event: 'drafted', by: 'understander-1', at: daysAgo(1), reason: null }] },
  },
};
const PUBLISHED = new Set();

function tenetsView(version, accepted) {
  return { ...version, current: version.version === accepted, ids: version.record.tenets.map((t) => t.id), author: 'understander-1',
    author_kind: 'agent', rendering_digest: null };
}

/** A version as the listing answers it: its summary, without its record (knowledge_routes `_summary`). */
function withoutRecord(view) {
  return Object.fromEntries(Object.entries(view).filter(([name]) => name !== 'record'));
}

function tenetsHead(connection) {
  const store = TENETS[connection];
  const accepted = store?.versions.find((v) => v.version === store.accepted);
  return { versions: store?.versions.length ?? 0, accepted_version: store?.accepted || null,
    accepted_ids: accepted ? accepted.record.tenets.map((t) => t.id).sort() : [], accepted_digest: accepted ? sha(JSON.stringify(accepted.record)) : null,
    accepted_by: accepted?.decided_by ?? null, accepted_at: accepted?.decided_at ?? null };
}

/** The files a kind's approved docs render to, with their text (gap O). */
function filesOf(connection, kind) {
  if (kind === 'tenets') {
    const store = TENETS[connection];
    const accepted = store?.versions.find((v) => v.version === store.accepted);
    if (!accepted) return null;
    const sections = accepted.record.tenets.map((t) => `## ${t.title}\n\n${t.statement}\n`).join('\n');
    const text = `# Tenets\n\n${accepted.record.summary}\n\n${sections}`;
    return { version: accepted.version, files: [{ path: 'TENETS.md', text }] };
  }
  const packs = (PACKS[connection] ?? []).filter((pkg) => pkg.approved !== null);
  if (packs.length === 0) return null;
  const index = packs.map((pkg) => `- ${pkg.package}`).join('\n');
  const files = [{ path: 'docs/agents/index.md', text: `# What the agents know\n\n${index}\n` },
    ...packs.map((pkg) => ({ path: `docs/agents/${pkg.package === '.' ? 'repository' : pkg.package}.md`,
      text: Object.values(documentsOf(pkg.package, pkg.approved)).join('\n') }))];
  return { version: RENDERING[connection]?.version ?? 1, files };
}

function digestOf(files) {
  return sha(JSON.stringify(files.map((file) => [file.path, sha(file.text)]).sort()));
}

function preview(connection, kind) {
  if (kind !== 'knowledge' && kind !== 'tenets') return [400, { error: 'kind is knowledge or tenets' }];
  const rendered = filesOf(connection, kind);
  if (!rendered) return [404, { error: `no ${kind} docs are approved for the connection yet` }];
  const digest = digestOf(rendered.files);
  const added = (text) => text.split('\n').map((l) => `+${l}`).join('\n');
  const patch = rendered.files.map((file) => `--- /dev/null\n+++ b/${file.path}\n${added(file.text)}`).join('\n');
  return [200, {
    connection, kind, version: rendered.version, branch: `voc-agent/docs/${kind}-v${rendered.version}`,
    files: rendered.files.map((file) => ({ path: file.path, sha256: sha(file.text), bytes: Buffer.byteLength(file.text), text: file.text })),
    digest, approved_digest: digest, matches: true, approved_by: 'admin-demo', approved_at: daysAgo(8), patch, patch_truncated: false,
    texts_truncated: false,
  }];
}

function publish(connection, body) {
  const kind = body.kind;
  if ((kind !== 'knowledge' && kind !== 'tenets') || typeof body.digest !== 'string') {
    return [400, { error: "the body is {kind: knowledge | tenets, digest: <the preview's digest>, pr?: ready | draft}" }];
  }
  if (process.env.MOCK_HUMAN_DRIVEN === '1') {
    return [409, { error: 'You work Human-driven: the platform pushes nothing for you. Apply the patch of the preview yourself, or change your way of working.', code: 'human_driven' }];
  }
  const rendered = filesOf(connection, kind);
  if (!rendered) return [409, { error: 'nothing of the kind is approved', code: 'not_approved' }];
  if (body.digest !== digestOf(rendered.files)) return [409, { error: 'the docs changed since the preview', code: 'digest_mismatch' }];
  const key = `${connection}/${kind}/${rendered.version}`;
  const pr = { url: `https://github.com/example-org/${connection}/pull/41`, number: 41, branch: `voc-agent/docs/${kind}-v${rendered.version}` };
  if (PUBLISHED.has(key)) return [409, { error: 'This version of the docs has its pull request already.', code: 'already_published', pr }];
  PUBLISHED.add(key);
  return [202, { pr, kind, version: rendered.version, digest: body.digest, draft: false }];
}

function knowledge(connection) {
  const packages = (PACKS[connection] ?? []).map((pkg) => ({ package: pkg.package, segment: pkg.segment,
    approved_version: pkg.approved, versions: pkg.versions }));
  return [200, { connection, packages, rendering: RENDERING[connection] ? { ...RENDERING[connection], digest: 'b'.repeat(64), packages: {}, source: null } : null }];
}

function packOf(connection, segment) {
  return (PACKS[connection] ?? []).find((pkg) => pkg.segment === segment || pkg.segment === decodeURIComponent(segment));
}

function approve(connection, segment, raw) {
  const pkg = packOf(connection, segment);
  const version = pkg?.versions.find((v) => v.version === Number(raw));
  if (!version) return [404, { error: 'no such version' }];
  if (version.status === 'approved') return [200, { connection, version, rendering_digest: null, rendering: RENDERING[connection] ?? null }];
  if (version.version < (pkg.approved ?? 0)) return [409, { error: READ_AGAIN }];
  Object.assign(version, { status: 'approved', approved_by: 'admin-demo', approved_at: new Date().toISOString() });
  pkg.approved = version.version;
  RENDERING[connection] = { kind: 'knowledge', version: (RENDERING[connection]?.version ?? 0) + 1, approved_by: 'admin-demo', approved_at: version.approved_at };
  return [200, { connection, version, rendering_digest: 'c'.repeat(64), rendering: RENDERING[connection] }];
}

function decide(connection, raw, decision, body) {
  const store = TENETS[connection];
  const version = store?.versions.find((v) => v.version === Number(raw));
  if (!version) return [404, { error: 'no such version' }];
  if (typeof body.expected_accepted !== 'number') return [400, { error: 'expected_accepted is the accepted version the screen showed (0 for none)' }];
  if (body.expected_accepted !== (store.accepted ?? 0)) {
    return [409, { error: `the accepted version was ${body.expected_accepted} and is ${store.accepted ?? 0} now: read it again` }];
  }
  const at = new Date().toISOString();
  Object.assign(version, { status: decision === 'accept' ? 'accepted' : 'rejected', decided_by: 'admin-demo', decided_at: at,
    reason: typeof body.reason === 'string' && body.reason !== '' ? body.reason : null });
  if (decision === 'accept' && version.version > (store.accepted ?? 0)) store.accepted = version.version;
  store.log[version.version] = [...(store.log[version.version] ?? []), { event: version.status, by: 'admin-demo', at, reason: version.reason }];
  return [200, { connection, version: tenetsView(version, store.accepted), log: store.log[version.version] }];
}

const KNOWLEDGE_PATH = /^\/agents\/engineering\/knowledge\/([^/]+)$/;
const PACK_PATH = /^\/agents\/engineering\/knowledge\/([^/]+)\/([^/]+)\/versions\/([^/]+)(\/approve)?$/;
const TENETS_PATH = /^\/agents\/engineering\/tenets\/([^/]+)$/;
const TENETS_VERSION_PATH = /^\/agents\/engineering\/tenets\/([^/]+)\/versions\/([^/]+)(?:\/(accept|reject))?$/;
const PREVIEW_PATH = /^\/agents\/engineering\/docs\/([^/]+)\/preview$/;
const PUBLISH_PATH = /^\/agents\/engineering\/docs\/([^/]+)\/publish$/;

/** The route a path is (its method, its connection, and how it answers), or null for none of this module's. */
function routeOf(url) {
  const path = url.pathname;
  const reads = [
    [KNOWLEDGE_PATH, (m) => knowledge(m[1])],
    [TENETS_PATH, (m) => { const store = TENETS[m[1]]; return [200, { connection: m[1], head: tenetsHead(m[1]),
      versions: [...(store?.versions ?? [])].reverse().map((v) => withoutRecord(tenetsView(v, store.accepted))) }]; }],
    [PREVIEW_PATH, (m) => preview(m[1], url.searchParams.get('kind') ?? '')],
  ];
  for (const [pattern, answer] of reads) {
    const match = pattern.exec(path);
    if (match) return { method: 'GET', connection: match[1], answer: () => answer(match) };
  }
  const pack = PACK_PATH.exec(path);
  if (pack) {
    if (pack[4]) return { method: 'POST', connection: pack[1], body: () => approve(pack[1], pack[2], pack[3]) };
    return { method: 'GET', connection: pack[1], answer: () => packAnswer(pack[1], pack[2], pack[3]) };
  }
  const tenets = TENETS_VERSION_PATH.exec(path);
  if (tenets) {
    if (tenets[3]) return { method: 'POST', connection: tenets[1], body: (body) => decide(tenets[1], tenets[2], tenets[3], body) };
    return { method: 'GET', connection: tenets[1], answer: () => tenetsAnswer(tenets[1], tenets[2]) };
  }
  const publishing = PUBLISH_PATH.exec(path);
  if (publishing) return { method: 'POST', connection: publishing[1], body: (body) => publish(publishing[1], body) };
  return null;
}

function packAnswer(connection, segment, raw) {
  const version = VERSION.test(raw) ? packOf(connection, segment)?.versions.find((v) => v.version === Number(raw)) : undefined;
  if (!version) return [404, { error: 'no such version' }];
  return [200, { connection, version, documents: documentsOf(version.package, version.version), flagged: 0 }];
}

function tenetsAnswer(connection, raw) {
  const store = TENETS[connection];
  const version = VERSION.test(raw) ? store?.versions.find((v) => v.version === Number(raw)) : undefined;
  if (!version) return [404, { error: 'no such version' }];
  return [200, { connection, version: tenetsView(version, store.accepted), log: store.log[version.version] ?? [] }];
}

export function handleEngineeringKnowledgeRoutes(req, res, url, send, shared) {
  const route = routeOf(url);
  if (route === null) return false;
  const connection = decodeURIComponent(route.connection);
  if (req.method !== route.method) send(405, { message: 'Method not allowed' });
  else if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (!CONNECTION.test(connection)) send(404, { error: 'no such connection' });
  else if (route.method === 'GET') send(...route.answer());
  else shared.collectJson(req, res, (body) => send(...route.body(body ?? {})));
  return true;
}
