// Dev-mock routes and a fake voice session for talking to the personas by voice (7.69.00, docs/voice-personas.md),
// in the wire shape of lambda/shared/voice_session_routes.py and lambda/stream/src/voice/protocol.ts:
//
//   GET  /projects/{id}/personas/{pid}/voice-sessions        -> the offer (enabled, voice, languages, minutes left)
//   POST /projects/{id}/personas/{pid}/voice-sessions        -> 201 {session_id, connect_url: ws://<mock>/mock-voice/<sid>, …};
//                                                               400 consent_required without `consent: true`
//   GET  /projects/{id}/personas/{pid}/voice-sessions/{sid}  -> its status (finalized once ended, with its document)
//   POST /projects/{id}/personas/{pid}/voice-sessions/{sid}/end -> 202; files a persona_interview document at once
//   GET  /projects/voice/usage                               -> this month's voice minutes
//
// The Product tab's interviewer (7.104.00) has the same four routes under /projects/{id}/product-interview/: its end
// saves the answers as one interview source of the project (`source_doc_id`, mock-product-sources.js), no document.
//
// The fake session (handleVoiceUpgrade, the mock server's `upgrade` event): a minimal WebSocket (RFC 6455, no
// dependency: the mock runs only in development, and the frontend has no `ws` package; the relay itself serves /ws
// with `ws`, lambda/stream/src/voice/server.ts) that plays a scripted conversation: ready, the persona's greeting as
// captions (speculative, then final) with a short 24 kHz tone as its "voice", a citation, the person's question, the
// persona's answer, usage every 5 seconds; `{type: 'end'}` (or the browser closing) ends it with `ended`. Microphone
// frames are read and dropped.
import { hash } from 'node:crypto';
import { addInterviewSource } from './mock-product-sources.js';

const OFFER_ROUTE = /^\/projects\/([^/]+)\/personas\/([^/]+)\/voice-sessions$/;
const SESSION_ROUTE = /^\/projects\/([^/]+)\/personas\/([^/]+)\/voice-sessions\/([^/]+)$/;
const END_ROUTE = /^\/projects\/([^/]+)\/personas\/([^/]+)\/voice-sessions\/([^/]+)\/end$/;
const PRODUCT_OFFER_ROUTE = /^\/projects\/([^/]+)\/product-interview\/voice-sessions$/;
const PRODUCT_SESSION_ROUTE = /^\/projects\/([^/]+)\/product-interview\/voice-sessions\/([^/]+)$/;
const PRODUCT_END_ROUTE = /^\/projects\/([^/]+)\/product-interview\/voice-sessions\/([^/]+)\/end$/;
/** The product interviewer as the session's "persona": no id, its own name in the captions. */
const INTERVIEWER = { persona_id: null, name: 'Interviewer', voice_id: 'tiffany' };
const UPGRADE_ROUTE = /^\/mock-voice\/([\w-]+)$/;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MONTHLY_MINUTES = 300;
const SESSION_MINUTES = 15;
const DAILY_SESSIONS = 5;
const CENTS_PER_MINUTE = 2;
const OUTPUT_RATE = 24000;
const TONE_CHUNK_SAMPLES = 1920; // 80 ms at 24 kHz
const USAGE_TICK_MS = 5000;

const sessions = new Map();
const usage = { seconds: 0, sessions: 0, today: 0 };

const nowIso = () => new Date().toISOString();
const minutesLeft = () => Math.max(0, MONTHLY_MINUTES - usage.seconds / 60);
const languages = { supported: ['en', 'de', 'es', 'fr', 'pt'], unsupported: ['ja', 'ko', 'pl', 'zh'] };

function personaOf(shared, projectId, personaId) {
  const detail = shared.mockProjectDetails[decodeURIComponent(projectId)];
  if (personaId === null) return { detail, persona: INTERVIEWER };
  const persona = detail?.personas.find((p) => p.persona_id === decodeURIComponent(personaId));
  return { detail, persona };
}

const voiceOf = (persona) => persona.voice_id ?? (persona.persona_id.length % 2 === 0 ? 'tiffany' : 'matthew');
const genderOf = (voice) => (['matthew', 'arjun', 'florian', 'lorenzo', 'lennart', 'carlos', 'leo'].includes(voice) ? 'masculine' : 'feminine');

function offer(persona) {
  const voice = voiceOf(persona);
  return {
    enabled: true, voice_id: voice, voice_gender: genderOf(voice), languages, session_minutes: SESSION_MINUTES,
    minutes_left: minutesLeft(), sessions_left_today: Math.max(0, DAILY_SESSIONS - usage.today),
    estimated_cents_per_minute: CENTS_PER_MINUTE, sources_full: false,
  };
}

function start(req, shared, detail, persona, body) {
  if (body?.consent !== true) return [400, { success: false, error: 'Consent is required', code: 'consent_required' }];
  if (usage.today >= DAILY_SESSIONS) return [429, { success: false, error: 'Daily limit reached', code: 'daily_limit' }];
  const sessionId = shared.nextMockId('voice').replace(/[^\w-]/g, '');
  const project = detail.project.project_id;
  sessions.set(sessionId, {
    session_id: sessionId, project_id: project, persona_id: persona.persona_id, persona_name: persona.name, status: 'minted',
    kind: persona.persona_id === null ? 'product_interview' : 'persona_interview', source_doc_id: null,
    seconds: 0, cost_cents: 0, end_reason: null, transcript_document_id: null, job_id: null, cited: [], started_at: nowIso(),
  });
  usage.sessions += 1;
  usage.today += 1;
  return [201, {
    success: true, ...offer(persona), session_id: sessionId, expires_in: 60,
    connect_url: `ws://${req.headers.host}/mock-voice/${sessionId}`,
  }];
}

function statusOf(session) {
  return {
    session_id: session.session_id, kind: session.kind, persona_id: session.persona_id, status: session.status, seconds: session.seconds,
    cost_cents: session.cost_cents, end_reason: session.end_reason, started_at: session.started_at,
    ended_at: session.ended_at ?? null, transcript_document_id: session.transcript_document_id,
    source_doc_id: session.source_doc_id, job_id: session.job_id,
  };
}

function transcriptMarkdown(session) {
  const cite = session.cited.length > 0 ? ` [fb:${session.cited[0]}]` : '';
  return [
    `_Synthetic: a voice interview with ${session.persona_name}, an AI persona. Its answers are hypotheses to test, never customer feedback. The audio was never stored._`,
    '', '## Summary', '', 'The persona values reliable deliveries and clear tracking (mock).', '',
    '## Key quotes', '', `> "Knowing when it arrives matters more than speed." (${session.persona_name})`, '',
    '## Transcript', '', `**${session.persona_name}:** Hi, thanks for talking with me (mock).`, '',
    '**You:** How do you feel about our delivery times? (mock)', '',
    `**${session.persona_name}:** I mostly want to know when a parcel will arrive.${cite}`,
  ].join('\n');
}

/** A product interview's answers as one interview source (no summary, no document). */
function saveProductSource(shared, session) {
  if (session.status !== 'finalized') {
    const text = '**AI interviewer:** What is the product called? (mock)\n\n**Team member:** It is called Parcel Pilot. (mock)';
    const doc = addInterviewSource(shared, session.project_id, { mode: 'voice', sessionId: session.session_id, text });
    Object.assign(session, { status: 'finalized', source_doc_id: doc?.doc_id ?? null, job_id: shared.nextMockId('job') });
  }
  return [202, { success: true, status: 'finalizing', job_id: session.job_id }];
}

function end(shared, detail, session) {
  if (session.status === 'minted' || session.status === 'live') {
    Object.assign(session, { status: 'ended', end_reason: session.end_reason ?? 'ended_by_person', ended_at: nowIso() });
  }
  if (session.kind === 'product_interview') return saveProductSource(shared, session);
  if (session.transcript_document_id === null) {
    const at = nowIso();
    const document = {
      document_id: shared.nextMockId('doc'), document_type: 'persona_interview', title: `Interview with ${session.persona_name}`,
      content: transcriptMarkdown(session), synthetic: true, created_at: at, updated_at: at,
      derivation: { kind: 'persona_interview', persona_ids: [session.persona_id], voice_session_id: session.session_id,
        seconds: session.seconds, model_id: 'amazon.nova-2-5-sonic', voice_id: 'tiffany', feedback_count: session.cited.length },
      input_feedback_ids: session.cited,
    };
    detail.documents.push(document);
    detail.project.document_count = (Number(detail.project.document_count) || 0) + 1;
    Object.assign(session, { status: 'finalized', transcript_document_id: document.document_id, job_id: shared.nextMockId('job') });
  }
  return [202, { success: true, status: 'finalizing', job_id: session.job_id }];
}

function usageAnswer() {
  return {
    enabled: true, month: nowIso().slice(0, 7), minutes_used: usage.seconds / 60, monthly_minutes: MONTHLY_MINUTES,
    minutes_left: minutesLeft(), sessions: usage.sessions, cost_cents: (usage.seconds / 60) * CENTS_PER_MINUTE,
    live_sessions: [...sessions.values()].filter((s) => s.status === 'live').length, max_concurrent: 8,
    session_minutes: SESSION_MINUTES, daily_sessions: DAILY_SESSIONS, model_id: 'amazon.nova-2-5-sonic',
  };
}

/** A product-interview route as `[kind, project id, null, session id?]`, or null. */
function productRoute(req, path) {
  const ended = req.method === 'POST' ? path.match(PRODUCT_END_ROUTE) : null;
  if (ended) return ['end', ended[1], null, ended[2]];
  const session = req.method === 'GET' ? path.match(PRODUCT_SESSION_ROUTE) : null;
  if (session) return ['status', session[1], null, session[2]];
  const offered = path.match(PRODUCT_OFFER_ROUTE);
  if (!offered) return null;
  return [req.method === 'GET' ? 'offer' : 'start', offered[1], null];
}

/** `[kind, project id, persona id (null: the product interviewer), session id?]` for a request this module owns, or null. */
function ownRoute(req, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/projects/voice/usage') return ['usage'];
  const product = productRoute(req, path);
  if (product) return product;
  const ended = req.method === 'POST' ? path.match(END_ROUTE) : null;
  if (ended) return ['end', ended[1], ended[2], ended[3]];
  const session = req.method === 'GET' ? path.match(SESSION_ROUTE) : null;
  if (session) return ['status', session[1], session[2], session[3]];
  const offered = path.match(OFFER_ROUTE);
  if (offered && req.method === 'GET') return ['offer', offered[1], offered[2]];
  return offered && req.method === 'POST' ? ['start', offered[1], offered[2]] : null;
}

function answer(req, kind, found, sessionId, shared, body) {
  const { detail, persona } = found;
  if (kind === 'offer') return [200, offer(persona)];
  if (kind === 'start') return start(req, shared, detail, persona, body);
  const session = sessions.get(decodeURIComponent(sessionId ?? ''));
  if (!session || session.persona_id !== persona.persona_id) return [404, { success: false, error: 'Voice session not found' }];
  return kind === 'status' ? [200, statusOf(session)] : end(shared, detail, session);
}

/** Handle this module's routes; returns true when the request was taken. */
export function handleVoiceRoutes(req, res, url, send, shared) {
  const route = ownRoute(req, url);
  if (!route) return false;
  const [kind, projectId, personaId, sessionId] = route;
  if (kind === 'usage') {
    send(200, usageAnswer());
    return true;
  }
  const found = personaOf(shared, projectId, personaId);
  if (!found.detail || !found.persona) {
    send(404, { success: false, error: found.detail ? 'Persona not found' : 'Project not found' });
    return true;
  }
  if (kind !== 'start') {
    send(...answer(req, kind, found, sessionId, shared, null));
    return true;
  }
  shared.collectJson(req, res, (body) => send(...answer(req, kind, found, sessionId, shared, body)));
  return true;
}

// ── The fake session's WebSocket ──────────────────────────────────────────────────────────────────────────────────

function frame(opcode, payload) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length]) : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([head, payload]);
}

const sendJson = (socket, message) => socket.write(frame(0x1, Buffer.from(JSON.stringify(message))));

/** 80 ms of a soft 220 Hz tone, PCM16LE at 24 kHz: the persona's "voice". */
function toneChunk(index) {
  const samples = Buffer.alloc(TONE_CHUNK_SAMPLES * 2);
  for (let n = 0; n < TONE_CHUNK_SAMPLES; n += 1) {
    const t = (index * TONE_CHUNK_SAMPLES + n) / OUTPUT_RATE;
    samples.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * t) * 2500), n * 2);
  }
  return samples;
}

/** Every complete client frame in `buffer` (masked, as a browser sends), and the bytes left over. */
function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 6) {
    const opcode = buffer[offset] & 0x0f;
    const short = buffer[offset + 1] & 0x7f;
    const extra = short === 126 ? 2 : 0;
    const length = short === 126 ? buffer.readUInt16BE(offset + 2) : short;
    if (short === 127) return { frames: [...frames, { opcode: 0x8, payload: Buffer.alloc(0) }], rest: Buffer.alloc(0) };
    const maskAt = offset + 2 + extra;
    if (buffer.length < maskAt + 4 + length) break;
    const mask = buffer.subarray(maskAt, maskAt + 4);
    const payload = Buffer.from(buffer.subarray(maskAt + 4, maskAt + 4 + length).map((byte, i) => byte ^ mask[i % 4]));
    frames.push({ opcode, payload });
    offset = maskAt + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** The lines the fake session speaks: a persona's greeting and answer, or the interviewer's question and thanks. */
function lines(session) {
  if (session.kind === 'product_interview') {
    return {
      greeting: "Hi, I'm an AI interviewer. What is the product called? (mock)",
      question: 'It is called Parcel Pilot. (mock)',
      answer: 'Thanks. In one sentence, what does it do and for whom? (mock)',
    };
  }
  return {
    greeting: `Hi, I'm ${session.persona_name}. Thanks for talking with me.`,
    question: 'How do you feel about our delivery times? (mock)',
    answer: 'I mostly want to know when a parcel will arrive.',
  };
}

function script(session, socket, timers) {
  const said = lines(session);
  const feedbackId = 'fb_mock_1';
  const at = (ms, run) => timers.push(setTimeout(run, ms));
  at(300, () => sendJson(socket, { type: 'ready', voice_id: 'tiffany', session_seconds: SESSION_MINUTES * 60, minutes_left: minutesLeft() }));
  at(900, () => sendJson(socket, { type: 'caption', role: 'assistant', stage: 'speculative', text: said.greeting, turn: 1 }));
  for (let index = 0; index < 12; index += 1) at(1000 + index * 80, () => socket.write(frame(0x2, toneChunk(index))));
  at(2000, () => sendJson(socket, { type: 'caption', role: 'assistant', stage: 'final', text: said.greeting, turn: 1 }));
  at(2100, () => sendJson(socket, { type: 'turn_end', role: 'assistant', turn: 1 }));
  at(4000, () => sendJson(socket, { type: 'caption', role: 'user', stage: 'final', text: said.question, turn: 2 }));
  at(4800, () => sendJson(socket, { type: 'caption', role: 'assistant', stage: 'speculative', text: said.answer, turn: 3 }));
  // (the interviewer has no tools: no citation)
  if (session.kind !== 'product_interview') {
    at(5000, () => {
      session.cited = [feedbackId];
      sendJson(socket, { type: 'citation', turn: 3, feedback_ids: [feedbackId] });
    });
  }
  at(6000, () => sendJson(socket, { type: 'caption', role: 'assistant', stage: 'final', text: said.answer, turn: 3 }));
  const tick = setInterval(() => {
    session.seconds += USAGE_TICK_MS / 1000;
    usage.seconds += USAGE_TICK_MS / 1000;
    session.cost_cents = (session.seconds / 60) * CENTS_PER_MINUTE;
    sendJson(socket, { type: 'usage', seconds: session.seconds, cents: session.cost_cents });
  }, USAGE_TICK_MS);
  timers.push(tick);
}

function close(session, socket, timers, reason) {
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;
  if (session.status === 'live') {
    Object.assign(session, { status: 'ended', end_reason: reason, ended_at: nowIso() });
    if (!socket.destroyed) {
      sendJson(socket, { type: 'ended', reason });
      socket.end(frame(0x8, Buffer.from([0x03, 0xe8])));
    }
  }
}

/** The mock server's `upgrade` event: true when it was a fake voice session's. */
export function handleVoiceUpgrade(req, socket) {
  const matched = new URL(req.url, 'http://localhost').pathname.match(UPGRADE_ROUTE);
  if (!matched) return false;
  const session = sessions.get(matched[1]);
  const key = req.headers['sec-websocket-key'];
  if (!session || session.status !== 'minted' || typeof key !== 'string') {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return true;
  }
  // RFC 6455's handshake digest (a protocol constant, not a secret).
  const accept = hash('sha1', key + WS_GUID, 'base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  session.status = 'live';
  const timers = [];
  const pending = { buffer: Buffer.alloc(0) };
  socket.on('data', (chunk) => {
    const { frames, rest } = readFrames(Buffer.concat([pending.buffer, chunk]));
    pending.buffer = rest;
    for (const { opcode, payload } of frames) {
      if (opcode === 0x8 || (opcode === 0x1 && payload.toString().includes('"end"'))) close(session, socket, timers, 'ended_by_person');
    }
  });
  socket.on('close', () => close(session, socket, timers, 'disconnected'));
  socket.on('error', () => close(session, socket, timers, 'disconnected'));
  script(session, socket, timers);
  return true;
}
