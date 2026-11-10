/**
 * The prototype CSP viewer-response function (lib/utils/prototype-csp.ts), run
 * from EXACTLY the source CloudFront gets: a prototype's CSP gains a connect-src
 * for its own pin form's full submit URL and nothing else, and every other
 * response keeps the base policy (no connect-src at all).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PIN_SUBMIT_URL_METADATA_KEY, PROTOTYPE_BASE_CSP, prototypeCspFunctionCode } from './prototype-csp';

const META_HEADER = `x-amz-meta-${PIN_SUBMIT_URL_METADATA_KEY}`;
const DOC_ID = 'doc_proto_20260801_abc123';
const URI = `/prototypes/proj_1/${DOC_ID}.html`;
const API = 'https://abcde12345.execute-api.us-east-1.amazonaws.com/v1';

/** lambda/shared/prototype_pins.py::pin_form_id, independently. */
function pinFormId(documentId: string): string {
  const digest = createHash('sha256').update(`prototype_pin|${documentId}`).digest('hex');
  return `pf_${digest.slice(0, 16)}`;
}
const SUBMIT_URL = `${API}/feedback-forms/${pinFormId(DOC_ID)}/submit`;

const ResponseSchema = z.object({ headers: z.record(z.string(), z.object({ value: z.string() })) });

/**
 * The function source loaded as a CommonJS module: cloudfront-js-2.0's only
 * module here is `crypto`, whose createHash Node provides with the same API.
 * Written once to a temp file and required, so the test runs the exact text.
 */
const scratchDir = mkdtempSync(join(tmpdir(), 'prototype-csp-'));
afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

function loadHandler(): (event: unknown) => unknown {
  const file = join(scratchDir, 'function.cjs');
  writeFileSync(file, `${prototypeCspFunctionCode()}\nmodule.exports = { handler };\n`);
  const loaded: unknown = createRequire(__filename)(file);
  const handler: unknown = z.object({ handler: z.unknown() }).parse(loaded).handler;
  if (typeof handler !== 'function') throw new Error('the function source defines no handler');
  return (event) => Reflect.apply(handler, undefined, [event]);
}
const handler = loadHandler();

function runFunction(uri: string, headers: Record<string, { value: string }>) {
  const event = { request: { uri }, response: { statusCode: 200, headers: { ...headers } } };
  return ResponseSchema.parse(handler(event)).headers;
}

const cspOf = (uri: string, metadata?: string) =>
  runFunction(uri, metadata === undefined ? {} : { [META_HEADER]: { value: metadata } })['content-security-policy']?.value;

describe('a prototype whose object carries its own pin submit URL', () => {
  it('gets the base CSP plus a connect-src of exactly that one URL', () => {
    expect(cspOf(URI, SUBMIT_URL)).toBe(`${PROTOTYPE_BASE_CSP} connect-src ${SUBMIT_URL};`);
  });

  it('allows exactly one connect-src source, a full path, never an origin', () => {
    const csp = cspOf(URI, SUBMIT_URL) ?? '';
    const connect = csp.split(';').map((part) => part.trim()).filter((part) => part.startsWith('connect-src'));
    expect(connect).toStrictEqual([`connect-src ${SUBMIT_URL}`]);
    expect(connect[0]?.split(' ')).toHaveLength(2);
  });

  it('never forwards the metadata header to the viewer', () => {
    expect(runFunction(URI, { [META_HEADER]: { value: SUBMIT_URL } })).not.toHaveProperty(META_HEADER);
  });
});

describe('every other response keeps the base CSP, with no connect-src', () => {
  it.each([
    ['no metadata (an older or copied prototype)', URI, undefined],
    ['another document’s form', URI, `${API}/feedback-forms/${pinFormId('doc_other')}/submit`],
    ['another route of its form', URI, SUBMIT_URL.replace('/submit', '/config')],
    ['the API origin alone', URI, `${API}/`],
    ['a non-API host', URI, SUBMIT_URL.replace(/^https:\/\/[^/]+/, 'https://evil.example.com')],
    ['plain http', URI, SUBMIT_URL.replace('https://', 'http://')],
    ['a smuggled second source', URI, `${SUBMIT_URL} https://evil.example.com`],
    ['a smuggled directive', URI, `${SUBMIT_URL}; script-src *`],
    ['a path outside /prototypes', `/assets/${DOC_ID}.html`, SUBMIT_URL],
  ])('%s', (_label, uri, metadata) => {
    expect(cspOf(uri, metadata)).toBe(PROTOTYPE_BASE_CSP);
  });

  it('the base policy itself forbids every connection', () => {
    expect(PROTOTYPE_BASE_CSP).toContain("default-src 'none'");
    expect(PROTOTYPE_BASE_CSP).not.toContain('connect-src');
  });
});

/** The `sandbox` directive's tokens in `csp`, or null when it has none. */
function sandboxTokens(csp: string): string[] | null {
  const directive = csp.split(';').map((part) => part.trim()).find((part) => part.split(' ')[0] === 'sandbox');
  return directive === undefined ? null : directive.split(/\s+/).slice(1);
}

describe('every prototype document gets an opaque origin', () => {
  // Same CloudFront origin as the SPA (Cognito tokens in localStorage): without the
  // sandbox, a prototype opened on its own runs model-authored script on that origin.
  it.each([
    ['the base policy', PROTOTYPE_BASE_CSP],
    ['the function, with the pin exception', cspOf(URI, SUBMIT_URL) ?? ''],
    ['the function, without it', cspOf(URI) ?? ''],
  ])('%s: sandboxed with scripts and popups only, never same-origin', (_label, csp) => {
    expect(sandboxTokens(csp)).toStrictEqual(['allow-scripts', 'allow-popups']);
    expect(['allow-same-origin', 'allow-forms', 'allow-top-navigation'].filter((flag) => csp.includes(flag)))
      .toStrictEqual([]);
    expect(csp).toContain("form-action 'none'");
  });

  it('keeps the pin connect-src as its own directive after the sandbox', () => {
    const csp = cspOf(URI, SUBMIT_URL) ?? '';
    expect(csp.endsWith(`; connect-src ${SUBMIT_URL};`)).toBe(true);
    expect(sandboxTokens(csp)).not.toContain('connect-src');
  });
});

describe('the metadata key', () => {
  it('is the one the document generator writes (lambda/shared/prototype_pins.py)', () => {
    const python = readFileSync(join(__dirname, '..', '..', 'lambda', 'shared', 'prototype_pins.py'), 'utf-8');
    expect(python).toContain(`PIN_SUBMIT_URL_METADATA_KEY = '${PIN_SUBMIT_URL_METADATA_KEY}'`);
  });
});
