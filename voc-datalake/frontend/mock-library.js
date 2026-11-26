// The Documents Library (docs/documents-library.md), as lambda/shared/library_routes.py answers it:
//   GET    /projects/library?q=&tag=&project_id=&sort=&cursor=&limit=   {items, total, tags, next_cursor}
//   GET    /projects/library/suggest?q=                                 {items} (at most 8 ready ones)
//   POST   /projects/library                                            201 {item, upload: {url, headers, expires_in}}
//   POST   /projects/library/context                                    {items, native, passages, missing, pending}
//   GET    /projects/library/{id}                                       {item, preview: {text_excerpt, text_parts, original_url}}
//   GET    /projects/library/{id}/text?page=                            {item_id, page, parts, paged, text}
//   PUT    /projects/library/{id}                                       {item} (409 stale / slug_taken)
//   DELETE /projects/library/{id}                                       {success, deleted}
//   POST   /projects/library/{id}/uploaded                              202 {item} (the reading starts)
//   POST   /projects/library/{id}/retry                                 202 {item}
// and the presigned PUT's target, `PUT /mock-upload/library/{id}` (written once: a second PUT is 412, as S3's
// `If-None-Match: *`). An uploaded item reads for a moment, then is ready with the uploaded text (a text file's own
// words; any other file a line about it). Errors are `{success: false, error, code}`.
//
// Stateful for the life of the mock process, seeded with three fictional ready items, so the assistant's `#` picker
// and the Library page have something to show in `npm run dev`. Wired into mock-server.js by handleDomainModules.

import { randomBytes } from 'node:crypto';

const LIBRARY_PATH = /^\/projects\/library(?:\/([^/]+))?(?:\/(text|uploaded|retry))?$/;
const UPLOAD_PATH = /^\/mock-upload\/library\/([^/]+)$/;
const ITEM_ID = /^lib_\d{14}_[0-9a-f]{8}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_ITEMS = 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3_750_000;
const PAGE_SIZE = 50;
const MAX_SUGGESTIONS = 8;
const READING_MS = 2500;
const PAGE_BREAK = '\f';
const PART_CHARS = 20_000;
const SORTS = ['newest', 'oldest', 'title', 'doc_date'];
const CALLER = { sub: 'sub-admin-demo', name: 'admin-demo' };
// = lambda/shared/library_extract.py FORMATS (and frontend/src/pages/Library/libraryFormats.ts).
const FORMATS = {
  'application/pdf': 'pdf', 'text/csv': 'csv', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'text/html': 'html', 'text/plain': 'txt',
  'text/markdown': 'md', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp',
};
const NATIVE_DOCUMENTS = new Set(['pdf', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'html', 'txt', 'md']);

const items = new Map(); // item_id -> stored item (with `text` and `uploaded` beside its public fields)
const seeded = { done: false };

const nowIso = () => new Date().toISOString();
const stamp = (date = new Date()) => date.toISOString().replace(/\D/g, '').slice(0, 14);
const newItemId = () => `lib_${stamp()}_${randomBytes(4).toString('hex')}`;
const bad = (status, error, code) => [status, { success: false, error, ...(code ? { code } : {}) }];
const IMAGES = new Set(['png', 'jpeg', 'gif', 'webp']);
/** library_extract.py is_native: a Converse document of at most 4.5 MB, an image of at most 3.75 MB (never a pptx). */
const isNative = (format, bytes) => (NATIVE_DOCUMENTS.has(format) && bytes <= 4_500_000) || (IMAGES.has(format) && bytes <= MAX_IMAGE_BYTES);

function slugify(text) {
  const plain = String(text).normalize('NFKD').replace(/[^ -~]/g, '').toLowerCase();
  const slug = plain.replace(/[^a-z0-9]+/g, '-').replace(/^-/, '').replace(/-$/, '').slice(0, 64).replace(/-$/, '');
  return slug || 'document';
}

/** What a client is answered of an item (library_store.py PUBLIC_FIELDS: never its text or the upload flag). */
const PUBLIC_FIELDS = [
  'item_id', 'title', 'slug', 'source', 'doc_date', 'tags', 'project_id', 'filename', 'content_type', 'format', 'bytes',
  'status', 'error', 'extracted_chars', 'pages', 'chunks', 'native', 'truncated', 'method', 'created_by', 'created_at',
  'updated_by', 'updated_at', 'version',
];
function publicView(item) {
  const view = Object.fromEntries(PUBLIC_FIELDS.filter((field) => item[field] !== undefined).map((field) => [field, item[field]]));
  return { ...view, tags: [...item.tags] };
}

const pagesOf = (item) => (item.pages ? item.text.split(PAGE_BREAK) : partsOf(item.text));
function partsOf(text) {
  const parts = [];
  for (let start = 0; start < text.length; start += PART_CHARS) parts.push(text.slice(start, start + PART_CHARS));
  return parts.length ? parts : [''];
}

function seedItem({ id, slug, title, source, docDate, tags, filename, contentType, bytes, text, pages, createdAt }) {
  const format = FORMATS[contentType];
  items.set(id, {
    item_id: id, title, slug, source, doc_date: docDate, tags, filename, content_type: contentType, format, bytes,
    status: 'ready', extracted_chars: text.length, ...(pages ? { pages } : {}), chunks: Math.max(1, Math.ceil(text.length / 1600)),
    native: isNative(format, bytes), method: 'stdlib', created_by: CALLER, created_at: createdAt, updated_by: CALLER,
    updated_at: createdAt, version: 1, text, uploaded: true,
  });
}

function seed() {
  if (seeded.done) return;
  seeded.done = true;
  seedItem({
    id: 'lib_20261101090000_a1b2c3d4', slug: 'q3-market', title: 'Q3 market report (Example Ltd)', source: 'Example Ltd research team',
    docDate: '2026-10-01', tags: ['market', 'q3'], filename: 'q3-market-report.pdf', contentType: 'application/pdf', bytes: 1_840_000,
    pages: 3, createdAt: '2026-11-01T09:00:00Z',
    text: [
      'Q3 market report (Example Ltd)\n\nSummary: demand for self-service onboarding grew 18% quarter on quarter. Mid-size teams ask for faster setup.',
      'Pricing\n\nTwo in five surveyed buyers compared us with a cheaper competitor. Annual plans convert better after a guided trial.',
      'Outlook\n\nWe expect the onboarding segment to keep growing through Q4. Recommended: shorten the first-run setup to under ten minutes.',
    ].join(PAGE_BREAK),
  });
  seedItem({
    id: 'lib_20261105103000_b2c3d4e5', slug: 'onboarding-survey', title: 'Onboarding survey results', source: 'In-app survey, October',
    docDate: '2026-10-28', tags: ['survey', 'onboarding'], filename: 'onboarding-survey.csv', contentType: 'text/csv', bytes: 48_200,
    createdAt: '2026-11-05T10:30:00Z',
    text: 'question,answer,count\nHow easy was setup?,Easy,412\nHow easy was setup?,Hard,97\nWhat slowed you down?,Importing data,151\n',
  });
  seedItem({
    id: 'lib_20261110141500_c3d4e5f6', slug: 'pricing-faq', title: 'Pricing FAQ', source: 'Sales enablement', docDate: '',
    tags: ['pricing'], filename: 'pricing-faq.md', contentType: 'text/markdown', bytes: 6_300, createdAt: '2026-11-10T14:15:00Z',
    text: '# Pricing FAQ\n\n## Is there a free trial?\n\nYes: 14 days, no card needed.\n\n## Can I pay yearly?\n\nYes, with two months free.\n',
  });
}

function matches(item, needle) {
  const haystack = [item.title, item.slug, item.source, item.filename, ...item.tags].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function sorted(list, sort) {
  const by = (field) => (a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
  if (sort === 'oldest') return [...list].sort(by('created_at'));
  if (sort === 'title') return [...list].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  if (sort === 'doc_date') return [...list].sort(by('doc_date')).reverse();
  return [...list].sort(by('created_at')).reverse();
}

function listRoute(url) {
  const params = url.searchParams;
  const sort = params.get('sort') || 'newest';
  if (!SORTS.includes(sort)) return bad(400, `sort must be one of: ${SORTS.join(', ')}`);
  const all = [...items.values()];
  const tags = [...new Set(all.flatMap((item) => item.tags))].sort();
  const needle = (params.get('q') ?? '').trim().toLowerCase();
  const tag = (params.get('tag') ?? '').trim().toLowerCase();
  const projectId = (params.get('project_id') ?? '').trim();
  const shown = all.filter((item) => (!needle || matches(item, needle)) && (!tag || item.tags.includes(tag))
    && (!projectId || item.project_id === projectId));
  const start = Number(params.get('cursor') || 0);
  const limit = Number(params.get('limit') || PAGE_SIZE) || PAGE_SIZE;
  if (!Number.isInteger(start) || start < 0) return bad(400, 'cursor must be a whole number');
  const page = sorted(shown, sort).slice(start, start + limit);
  const following = start + limit;
  return [200, { items: page.map(publicView), total: shown.length, tags, next_cursor: following < shown.length ? String(following) : null }];
}

function suggestRoute(url) {
  const needle = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const ready = sorted([...items.values()].filter((item) => item.status === 'ready' && (!needle || matches(item, needle))), 'newest');
  ready.sort((a, b) => Number(!a.slug.startsWith(needle)) - Number(!b.slug.startsWith(needle)));
  return [200, { items: ready.slice(0, MAX_SUGGESTIONS).map((item) => {
    const { item_id, slug, title, format, bytes, native, chunks, pages, extracted_chars, project_id, updated_at } = item;
    return { item_id, slug, title, format, bytes, native, chunks, extracted_chars, updated_at, ...(pages ? { pages } : {}), ...(project_id ? { project_id } : {}) };
  }) }];
}

const slugTaken = (slug, exceptId) => [...items.values()].some((item) => item.slug === slug && item.item_id !== exceptId);

function tagsOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error('tags must be a list of at most 10');
  const tags = value.map((tag) => String(tag).replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
  if (tags.some((tag) => tag.length > 40)) throw new Error('a tag is at most 40 characters');
  return [...new Set(tags)];
}

/** The refusal of a create's file (its type and size, library_store.py validate_new_item), or null. */
function fileRefusal(body) {
  if (items.size >= MAX_ITEMS) return bad(409, `This library holds ${MAX_ITEMS} items, its most. Delete some first.`, 'library_full');
  const contentType = String(body?.content_type ?? '').toLowerCase();
  if (!FORMATS[contentType]) return bad(400, 'This file type is not supported.', 'unsupported_type');
  const image = contentType.startsWith('image/');
  const bytes = body.bytes;
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > (image ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES)) {
    return bad(400, image ? 'Images must be at most 3.75 MB' : 'Files must be at most 25 MB', 'too_large');
  }
  return String(body.filename ?? '').trim() ? null : bad(400, 'filename is required');
}

/** The slug a create takes: the one given (400 malformed, 409 taken), else the title's, with -2 … -5 when taken. */
function slugFor(body, title) {
  const given = typeof body.slug === 'string' && body.slug !== '';
  if (given && !SLUG.test(body.slug)) return bad(400, 'slug must be 1 to 64 lower-case letters, digits and hyphens');
  const base = given ? body.slug : slugify(title);
  const candidates = given ? [base] : [base, ...[2, 3, 4, 5].map((n) => `${base.slice(0, 60)}-${n}`)];
  return candidates.find((candidate) => !slugTaken(candidate))
    ?? bad(409, 'Another library item already has this short name.', 'slug_taken');
}

function createRoute(req, body) {
  const refusal = fileRefusal(body);
  if (refusal) return refusal;
  const contentType = String(body.content_type).toLowerCase();
  const format = FORMATS[contentType];
  const bytes = body.bytes;
  const filename = String(body.filename).trim();
  const title = String(body.title ?? '').trim().slice(0, 200) || filename.replace(/\.[^.]*$/, '') || 'Untitled';
  const slug = slugFor(body, title);
  if (Array.isArray(slug)) return slug;
  const tags = tagsOf(body.tags);
  const itemId = newItemId();
  const at = nowIso();
  const item = {
    item_id: itemId, title, slug, source: String(body.source ?? '').slice(0, 200), doc_date: String(body.doc_date ?? ''), tags,
    ...(body.project_id ? { project_id: String(body.project_id) } : {}), filename, content_type: contentType, format, bytes,
    status: 'pending', extracted_chars: 0, chunks: 0, native: isNative(format, bytes), created_by: CALLER, created_at: at,
    updated_by: CALLER, updated_at: at, version: 1, text: '', uploaded: false,
  };
  items.set(itemId, item);
  const upload = {
    url: `http://${req.headers.host}/mock-upload/library/${itemId}`,
    headers: { 'Content-Type': contentType, 'If-None-Match': '*' }, expires_in: 900,
  };
  return [201, { item: publicView(item), upload }];
}

/** Read the uploaded file "for a moment", then ready (unless it was deleted or moved meanwhile). */
function startReading(item) {
  item.status = 'extracting';
  item.updated_at = nowIso();
  delete item.error;
  setTimeout(() => {
    if (items.get(item.item_id) !== item || item.status !== 'extracting') return;
    item.status = 'ready';
    item.extracted_chars = item.text.length;
    item.chunks = Math.max(1, Math.ceil(item.text.length / 1600));
    item.method = 'stdlib';
  }, READING_MS).unref?.();
  return [202, { item: publicView(item) }];
}

const NOT_ALLOWED = [405, { success: false, error: 'Method not allowed' }];

function textRoute(item, url) {
  if (item.status !== 'ready') return bad(409, 'This item has no text yet.', 'not_ready');
  const parts = pagesOf(item);
  const page = Number(url.searchParams.get('page') || 1);
  if (!Number.isInteger(page) || page < 1 || page > parts.length) return bad(400, `page must be a whole number from 1 to ${parts.length}`);
  return [200, { item_id: item.item_id, page, parts: parts.length, paged: Boolean(item.pages), text: parts[page - 1] }];
}

function detailRoute(req, item) {
  const ready = item.status === 'ready';
  return [200, { item: publicView(item), preview: {
    text_excerpt: ready ? item.text.slice(0, 2000) : '', text_parts: ready ? pagesOf(item).length : 0,
    original_url: item.status === 'pending' ? null : `http://${req.headers.host}/mock-upload/library/${item.item_id}`,
  } }];
}

/** `{id}/<action>` by method: `POST uploaded`, `POST retry`, `GET text`; `{id}` itself: GET, PUT, DELETE. */
const ITEM_ACTIONS = {
  'POST uploaded': (item) => {
    if (item.status !== 'pending') return [202, { item: publicView(item) }];
    return item.uploaded ? startReading(item) : bad(409, 'The file has not arrived yet. Upload it again.', 'not_uploaded');
  },
  // As the server (library_routes.py retry): a failed item, or an extraction that outlived the worker (`stale`: the mock
  // keeps no clock, so a fixture marks it).
  'POST retry': (item) => (item.status === 'failed' || (item.status === 'extracting' && item.stale === true)
    ? startReading(item) : bad(409, 'Only a failed or stopped item can be read again.', 'not_failed')),
  'GET text': (item, { url }) => textRoute(item, url),
  'GET ': (item, { req }) => detailRoute(req, item),
  'PUT ': (item, { body }) => updateRoute(item, body),
  'DELETE ': (item) => {
    items.delete(item.item_id);
    return [200, { success: true, deleted: item.item_id }];
  },
};

function itemRoute(req, item, action, body, url) {
  const route = ITEM_ACTIONS[`${req.method} ${action ?? ''}`];
  return route ? route(item, { req, body, url }) : NOT_ALLOWED;
}

function updateRoute(item, body) {
  if (!Number.isInteger(body?.expected_version)) return bad(400, 'expected_version is required: the version you opened');
  if (body.expected_version !== item.version) {
    return bad(409, 'This item was changed since you opened it. Reload it and try again.', 'stale');
  }
  if ('slug' in body && (typeof body.slug !== 'string' || !SLUG.test(body.slug))) return bad(400, 'slug must be 1 to 64 lower-case letters, digits and hyphens');
  if ('slug' in body && slugTaken(body.slug, item.item_id)) return bad(409, 'Another library item already has this short name.', 'slug_taken');
  if ('title' in body && String(body.title).trim() === '') return bad(400, 'title is required');
  const changes = {};
  for (const field of ['title', 'slug', 'source', 'doc_date', 'project_id']) if (field in body) changes[field] = String(body[field] ?? '').trim();
  if ('tags' in body) changes.tags = tagsOf(body.tags);
  if (Object.keys(changes).length === 0) return bad(400, 'Give at least one of: title, slug, source, doc_date, tags, project_id');
  if (changes.project_id === '') {
    delete changes.project_id;
    delete item.project_id;
  }
  Object.assign(item, changes, { updated_by: CALLER, updated_at: nowIso(), version: item.version + 1 });
  return [200, { item: publicView(item) }];
}

function contextRoute(body) {
  const ids = Array.isArray(body?.item_ids) ? body.item_ids : [];
  const slugs = Array.isArray(body?.slugs) ? body.slugs : [];
  const named = [...ids.map((id) => items.get(id)), ...slugs.map((slug) => [...items.values()].find((item) => item.slug === slug))];
  const present = named.filter(Boolean);
  const ready = present.filter((item) => item.status === 'ready');
  const brief = ({ item_id, slug, title, source, doc_date, format, pages, chunks, status, native, bytes }) => (
    { item_id, slug, title, source, doc_date, format, chunks, status, native, bytes, ...(pages ? { pages } : {}) });
  return [200, {
    items: present.map(brief), native: [],
    passages: ready.map((item) => ({ item_id: item.item_id, slug: item.slug, title: item.title, page: item.pages ? 1 : null, text: item.text.slice(0, 1200) })),
    missing: named.length - present.length,
    pending: present.filter((item) => item.status !== 'ready').map((item) => ({ item_id: item.item_id, status: item.status })),
  }];
}

function libraryRoute(req, match, body, url) {
  const [, segment, action] = match;
  if (!segment) {
    if (req.method === 'GET') return listRoute(url);
    return req.method === 'POST' ? createRoute(req, body) : NOT_ALLOWED;
  }
  if (segment === 'suggest' && !action) return req.method === 'GET' ? suggestRoute(url) : NOT_ALLOWED;
  if (segment === 'context' && !action) return req.method === 'POST' ? contextRoute(body) : NOT_ALLOWED;
  const item = ITEM_ID.test(segment) ? items.get(segment) : undefined;
  if (!item) return bad(404, 'Library item not found');
  return itemRoute(req, item, action, body, url);
}

/** The presigned PUT: the item's file, written once; a text file's words become its "extracted" text. */
function uploadTarget(req, res, send, itemId) {
  const chunks = [];
  req.on('data', (chunk) => { chunks.push(chunk); });
  req.on('end', () => {
    const item = items.get(itemId);
    if (!item) return send(404, { success: false, error: 'Upload target not found' });
    if (item.uploaded) return send(412, { success: false, error: 'At least one of the pre-conditions you specified did not hold' });
    const data = Buffer.concat(chunks);
    item.uploaded = true;
    item.text = item.content_type.startsWith('text/')
      ? data.toString('utf8').slice(0, 200_000)
      : `${item.title}\n\n(The mock read ${data.length} bytes of ${item.filename}.)`;
    return send(200, { success: true });
  });
}

export function handleLibraryRoutes(req, res, url, send, shared) {
  const upload = url.pathname.match(UPLOAD_PATH);
  if (upload && req.method === 'PUT') {
    uploadTarget(req, res, send, decodeURIComponent(upload[1]));
    return true;
  }
  if (upload && req.method === 'GET') {
    seed();
    const item = items.get(decodeURIComponent(upload[1]));
    if (!item) send(404, { success: false, error: 'Not found' });
    else send(200, { success: true, filename: item.filename, note: 'The mock keeps no original file.' });
    return true;
  }
  const match = url.pathname.match(LIBRARY_PATH);
  if (!match) return false;
  seed();
  const respond = (body) => {
    try {
      send(...libraryRoute(req, match, body, url));
    } catch (error) {
      send(400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  if (req.method === 'GET' || req.method === 'DELETE') respond(null);
  else shared.collectJson(req, res, respond);
  return true;
}
