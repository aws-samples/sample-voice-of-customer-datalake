/**
 * Authorization invariant for every method on the VoC REST API.
 *
 * Regression guard for the Checkov CKV_AWS_59 finding on `/feedback-forms`.
 * The item routes sat behind an `anyMethod` proxy that was created without
 * `defaultMethodOptions`, so API Gateway defaulted them to
 * AuthorizationType.NONE: form update, form delete and reads of submitted
 * customer feedback were reachable with no credentials at all, while the
 * collection directly above them was Cognito-protected.
 *
 * The defect was a MISSING ARGUMENT. Nothing threw, no test broke, and a
 * cdk-nag suppression applied to the whole proxy subtree made the entire
 * prefix look assessed. A test asserting "these four routes are protected"
 * would not have caught it either, because the routes did not exist as
 * distinct constructs. So the guard is an invariant over the whole template.
 *
 * OPTIONS is excluded throughout because API Gateway generates unauthenticated
 * CORS preflight methods from `defaultCorsPreflightOptions`, and cdk-nag's own
 * APIG4 rule excludes them for the same reason.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';

import { ManifestSchema } from '../plugin-loader';
import {
  CUSTOM_AUTHORIZER_ROUTE_PREFIXES, INTENTIONALLY_PUBLIC_ROUTES, INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES, PLUGINS_DIR, apiMethods, apiTemplate, apiTemplateAllPlugins, apiTemplateFlagged, callerFormsPaths, discoverPluginIds, functionIdForHandler, nonOptions, readRepoFile, resolveMethod, unauthenticatedRoutes,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

// Synthesize the shared default template once, outside any single case's 5s
// budget: the first case to call apiTemplate() would otherwise pay for it.
beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

/** How the default template authorizes `route`, or `undefined` when it is not wired. */
function authorizationOf(route: string): { authorizationType: string; hasAuthorizerId: boolean } | undefined {
  const method = apiMethods(apiTemplate()).find((m) => m.route === route);
  return method && { authorizationType: method.authorizationType, hasAuthorizerId: method.hasAuthorizerId };
}

/** A Cognito-protected method: the user-pool authorization type AND an authorizer. */
const COGNITO = { authorizationType: 'COGNITO_USER_POOLS', hasAuthorizerId: true };

describe('VocApiStack authorization invariant', () => {
  it('leaves only the allowlisted widget and ballot routes unauthenticated', () => {
    // The COUNT as well as the contents, and here rather than in one of the
    // per-feature describes below: five is the number a change to either public
    // set has to argue past, so it belongs with the invariant itself instead of
    // being restated once per feature that touches those routes. A throttle, a
    // CORS value or a rewired resource tree is not an authorization change — this
    // is the single guard that says so for all of them.
    expect(INTENTIONALLY_PUBLIC_ROUTES).toHaveLength(5);
    expect(unauthenticatedRoutes(apiTemplate())).toStrictEqual(INTENTIONALLY_PUBLIC_ROUTES);
  });

  it('discovers the real plugins, excluding scaffolding', () => {
    // Two guards below are only as good as this enumeration, so pin it: it must
    // find plugins, and must not pick up `_template`/`_shared` (which are not
    // deployable) or the Python test files sitting in the same directory.
    const ids = discoverPluginIds();

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => id.startsWith('_'))).toStrictEqual([]);
    expect(ids.filter((id) => id.endsWith('.py'))).toStrictEqual([]);
    expect(ids).toContain('webscraper');
  });

  it.each([
    'POST /voting-sessions',
    'GET /voting-sessions/{session_id}',
    'POST /voting-sessions/{session_id}/close',
  ])('keeps the facilitator half of a voting session behind Cognito: %s', (route) => {
    // The public half of this feature is two routes and no more. OPENING a
    // session is what authorizes anonymous writes, and CLOSING one is the
    // revocation — publishing either would mean anyone could open a write window
    // on any document, or shut a meeting's vote down from outside the room.
    // Asserted per route rather than left to the invariant above, because that
    // one would also pass if these three vanished from the template entirely.
    expect(authorizationOf(route), `${route} is not wired behind Cognito`).toStrictEqual(COGNITO);
  });

  it('adds only the allowlisted webhook receivers with every plugin enabled', () => {
    // The empty-plugin shape is not what anyone deploys. Plugin webhook
    // receivers are deliberately unauthenticated, so a plugin declaring a
    // webhook fails this until its route is a considered entry in
    // INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES rather than a silent anonymous route.
    expect(unauthenticatedRoutes(apiTemplateAllPlugins())).toStrictEqual(
      [...INTENTIONALLY_PUBLIC_ROUTES, ...INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES].sort(byCodeUnit),
    );
  });

  it('pins the fact that makes the webhook allowlist complete: which plugins declare one', () => {
    // Webhook receivers are added with no method options, i.e. deliberately
    // anonymous. Reading the manifests directly makes the allowlist above fail
    // loudly the day another plugin declares a webhook — the previous test only
    // sees routes of plugins it enables, so on its own it cannot.
    //
    // Parsed with the canonical ManifestSchema and `.parse`, deliberately: a
    // local partial schema plus `safeParse` would treat a renamed or moved
    // `infrastructure.webhook.enabled` as "no webhook" and silently disable this
    // guard. Shape drift must throw here, not pass.
    const pluginIds = discoverPluginIds();
    expect(pluginIds.length, 'no plugins discovered — the enumeration is broken').toBeGreaterThan(0);

    const withWebhook = pluginIds.filter((id) => {
      const raw: unknown = JSON.parse(readFileSync(join(PLUGINS_DIR, id, 'manifest.json'), 'utf-8'));
      return ManifestSchema.parse(raw).infrastructure.webhook?.enabled === true;
    });

    expect(
      withWebhook.map((id) => `POST /webhooks/${id}`),
      'The set of plugins declaring a webhook changed. Webhook methods are unauthenticated by design, '
      + 'so update INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES deliberately rather than widening the assertion.',
    ).toStrictEqual(INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES);
  });

  it('authenticates every other method with Cognito, not merely "something"', () => {
    // Asserting `!== NONE` would accept a method that regressed to AWS_IAM or
    // picked up a stray authorizer.
    const offenders = nonOptions(apiTemplateAllPlugins())
      .filter((m) => !INTENTIONALLY_PUBLIC_ROUTES.includes(m.route))
      .filter((m) => !INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES.includes(m.route))
      .filter((m) => !CUSTOM_AUTHORIZER_ROUTE_PREFIXES.some((prefix) => m.path.startsWith(prefix)))
      .filter((m) => m.authorizationType !== 'COGNITO_USER_POOLS' || !m.hasAuthorizerId)
      .map((m) => `${m.route} [${m.authorizationType}]`)
      .sort(byCodeUnit);

    expect(offenders).toStrictEqual([]);
  });

  it('authenticates the custom-authorizer routes with a real authorizer', () => {
    const mcp = nonOptions(apiTemplateAllPlugins())
      .filter((m) => CUSTOM_AUTHORIZER_ROUTE_PREFIXES.some((prefix) => m.path.startsWith(prefix)));

    expect(mcp.length).toBeGreaterThan(0);
    for (const method of mcp) {
      expect(method.authorizationType, method.route).toBe('CUSTOM');
      expect(method.hasAuthorizerId, method.route).toBe(true);
    }
  });

  it.each([
    'PUT /feedback-forms/{form_id}',
    'DELETE /feedback-forms/{form_id}',
    'GET /feedback-forms/{form_id}/submissions',
    'GET /feedback-forms/{form_id}/stats',
  ])('requires an authorizer on %s', (route) => {
    expect(authorizationOf(route), `${route} is not wired behind Cognito`).toStrictEqual(COGNITO);
  });
});

/** Routes a Python handler registers but API Gateway does not route to it.
 *
 *  Each entry is either dead code in the handler or a missing route in
 *  api-stack.ts; the owner decides which. It is listed so the check below is
 *  green on today's template while ANY NEW gap fails it. Removing an entry
 *  (by wiring the route or deleting the handler code) is always welcome; adding
 *  one needs the same justification as any unreachable code. Keyed by handler
 *  file; values in the handler's own spelling (`<param>`), sorted. */
const KNOWN_UNWIRED: Record<string, string[]> = {
  // Empty: at the time this check was introduced every registered route of
  // every resolver handler resolved to its own Lambda. Keep it that way.
};

/** Every `lambda/api/*_handler.py` that registers Powertools resolver routes. */
function resolverHandlers(): string[] {
  const apiDir = join(__dirname, '..', '..', 'lambda', 'api');
  return readdirSync(apiDir)
    .filter((file) => file.endsWith('_handler.py'))
    .filter((file) => registeredRoutes(readRepoFile('lambda', 'api', file)).length > 0)
    .sort(byCodeUnit);
}

/** `@app.<verb>('<path>'...)` decorators, in the handler's own spelling. */
function registeredRoutes(source: string): { verb: string; path: string }[] {
  return [...source.matchAll(/^[ \t]*@app\.(get|post|put|delete|patch|route)\(\s*['"]([^'"]+)['"]/gm)]
    .map(([, verb = '', path = '']) => ({ verb: verb.toUpperCase(), path }))
    .sort((a, b) => `${a.verb} ${a.path}`.localeCompare(`${b.verb} ${b.path}`));
}


describe('stack and callers stay in step', () => {
  it.each(resolverHandlers())(
    'wires every route %s registers, to that handler\'s own Lambda',
    (handlerFile) => {
      // Independent oracle: the handler source, not the template under test.
      // Without a catch-all, a route the handler registers but nobody wires
      // returns 403 Missing Authentication Token instead of working — and for
      // the public feedback-form and ballot routes that 403 lands on a customer's
      // page or a phone that has just scanned a QR, with nothing able to explain
      // it. Since vulture ignores route decorators, this is also the only check
      // that a registered route is reachable at all, i.e. not dead code.
      //
      // SCOPE: every `lambda/api/*_handler.py` that registers Powertools routes
      // (`@app.get/post/put/delete/patch/route(...)`). Each one's Lambda is a
      // LambdaIntegration on the REST API, so each registered route must resolve
      // to a method integrated with THAT Lambda (not merely wired somewhere).
      // `mcp_global_handler.py` registers no `@app` routes — it is JSON-RPC at
      // `/mcp/global` and delegates to the domain Lambdas by direct invoke — so it
      // falls out of scope here and is covered by 'builds only routes that API
      // Gateway wires' in api-stack-mcp-global.test.ts. A route reachable ONLY by such a direct
      // invoke would still appear below as unwired; that is deliberate, because
      // the browser cannot reach it either.
      const handler = readRepoFile('lambda', 'api', handlerFile);
      const registered = registeredRoutes(handler);
      expect(registered.length).toBeGreaterThan(0);

      const functionId = functionIdForHandler(apiTemplate(), handlerFile);
      const methods = apiMethods(apiTemplate());
      const unwired = registered
        .filter(({ verb, path }) => resolveMethod(methods, verb, path)?.integrationFunctionId !== functionId)
        .map(({ verb, path }) => `${verb} ${path}`);

      expect(unwired).toStrictEqual(KNOWN_UNWIRED[handlerFile] ?? []);
    },
  );

  it('lists known gaps only for handlers the check above covers', () => {
    // A key left behind after its handler is renamed or deleted would never be
    // compared against anything, and would read as a gap that still exists.
    expect(Object.keys(KNOWN_UNWIRED).filter((file) => !resolverHandlers().includes(file))).toStrictEqual([]);
  });

  it.each([
    ['the API client', join('frontend', 'src', 'api', 'client.ts')],
    ['the embeddable widget', join('lambda', 'api', 'static', 'feedback-widget.js')],
    ['the embed URL builder', join('frontend', 'src', 'api', 'feedbackFormUrls.ts')],
  ])('wires every /feedback-forms path %s calls', (_label, relativePath) => {
    // Callers fail opaquely now: an unwired path returns 403 rather than the
    // handler's 404, so a caller-side path with no method is a live bug.
    //
    // The third entry is the producer of the path the corrected docs now name as
    // THE embed URL (#374): `feedbackFormUrls.ts` builds `/{form_id}/iframe`, and
    // the UI hands it out as a link, a copyable string and an <iframe> snippet —
    // yet `client.ts` mentions `iframe` nowhere, so before this the one route the
    // docs advertise had no parity check from the code that constructs it.
    //
    // Asserted as "wired", matching its two siblings rather than the
    // unauthenticated oracle below: this module runs in the authenticated
    // dashboard, and what it produces for a stranger's browser is checked at the
    // docs snippet.
    //
    // Known narrowing, inherited from `callerFormsPaths`: the returned URL is a
    // template literal, so `${base}/feedback-forms/${encodeURIComponent(formId)}`
    // collapses at the `)` and the `/iframe` segment is recovered from the
    // module's docblock, which names the literal path twice. Losing those lines
    // would quietly reduce this entry to checking `/feedback-forms/{form_id}`.
    const wiredPaths = new Set(apiMethods(apiTemplate()).map((m) => m.path));
    const referenced = callerFormsPaths(readRepoFile(...relativePath.split('/')));

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((path) => !wiredPaths.has(path))).toStrictEqual([]);
  });

  // The companion to the check above, and the reason it is a separate `it` rather
  // than a third column on that `it.each`: this PR's standing verification claim is
  // that `api-stack.test.ts` gains tests without editing an existing assertion, so
  // that the deletion's correctness rests on untouched oracles. Adding a column
  // would have edited the tuples and the callback signature. Additions only.
  //
  // What it closes: `callerFormsPaths` extracts with a regex, so anything defeating
  // the regex shrinks the extracted set and "every path resolves" then holds
  // VACUOUSLY over what survived — green for the wrong reason, which `length > 0`
  // cannot distinguish from a full extraction. Not hypothetical for the third
  // entry: its URL is a template literal, so
  // `${base}/feedback-forms/${encodeURIComponent(formId)}` collapses at the `)` and
  // `/iframe` is recovered only from that module's DOCBLOCK, which names the literal
  // path. Deleting a comment line there reduced this to checking
  // `/feedback-forms/{form_id}` while staying green.
  it.each([
    ['the API client', join('frontend', 'src', 'api', 'client.ts'),
      '/feedback-forms/{form_id}/submissions'],
    ['the embeddable widget', join('lambda', 'api', 'static', 'feedback-widget.js'),
      '/feedback-forms/{form_id}/config'],
    ['the embed URL builder', join('frontend', 'src', 'api', 'feedbackFormUrls.ts'),
      '/feedback-forms/{form_id}/iframe'],
  ])('still extracts the path %s is checked for', (_label, relativePath, requiredPath) => {
    const referenced = callerFormsPaths(readRepoFile(...relativePath.split('/')));

    expect(
      referenced,
      `extraction lost ${requiredPath} — this caller's paths are no longer being checked, `
      + 'even though the wiring assertion still passes over whatever survived',
    ).toContain(requiredPath);
  });

  it.each([
    ['the integrator guide', join('..', 'docs', 'feedback-forms.md')],
    ['the system documentation', join('..', 'docs', 'SYSTEM_DOCUMENTATION.md')],
  ])('wires every /feedback-forms path the embed snippet in %s hands to customers', (_label, relativePath) => {
    // A copy-pasteable snippet is a caller, and it is the one caller whose
    // failure lands on somebody outside this repo. #374 found both of these
    // pages advertising `/feedback-forms/{form_id}/widget.js`, a route neither
    // the handler nor the stack has ever registered — so the snippet returned
    // 403 Missing Authentication Token, which reads as an authorization problem
    // rather than a wrong URL. Prose is checked nowhere else, and the docs are
    // where the wrong path outlived the code by longest.
    //
    // Fenced blocks are read, not the prose around them: the fix for that finding
    // was to state in prose that `widget.js` does NOT exist, so scanning the whole
    // page would fail on the very sentences that prevent the mistake recurring.
    // What is asserted is narrower and is the thing that matters — every URL
    // offered for pasting is one a customer's browser can actually call.
    const page = readRepoFile(...relativePath.split('/'));
    // EVERY fence, whatever its info string — scoping this to ```html was a hole,
    // not a narrowing. Measured on the retired URL: `widget.js` inside a ```js
    // fence passed, and inside ```html title="embed.html" passed, while the same
    // URL in a plain ```html fence failed. Both misses are the exact defect class
    // this test exists to prevent, and neither is exotic: a highlighter tag is
    // cosmetic, and what makes a URL copy-pasteable is the fence, not the label.
    //
    // `[^\n\r]*` consumes the tag and any info string after it, so ```HTML,
    // ```js and ```html title="x" are all read. `\r?` so a CRLF checkout matches;
    // a fence needs the newline straight after its info string, and without it
    // every block misses silently — the no-op the assertion below rules out.
    //
    // Consequence to know before adding examples: an authenticated example in a
    // fence (a `curl` with a bearer token against `submissions`) now fails the
    // unauthenticated check below, correctly by these lights but inconveniently.
    // The fix then is an explicit allowlist of such blocks, not a retreat to
    // reading one tag — which is what let the bad URL through in the first place.
    // Pairing is what makes the scan above sound: the regex consumes fences two at a
    // time, so a single unclosed fence shifts every subsequent pairing and blocks
    // start reading as prose and prose as blocks — silently, which is the one failure
    // mode this whole test exists to avoid. The ```html anchor used to make that
    // harmless. Checked rather than assumed, and cheap. (Currently sound: 6 and 32
    // delimiters. A four-backtick block would still count even here while confusing
    // the scan — no such block exists in either page, and this is the guard that
    // would have to grow if one arrived.)
    const fenceDelimiters = (page.match(/^```/gm) ?? []).length;
    expect(
      fenceDelimiters % 2,
      `odd number of \`\`\` fence delimiters (${fenceDelimiters}) — one is unclosed, so the `
      + 'block scan below is mis-paired and reads prose as code',
    ).toBe(0);

    // BOTH patterns are `^`-anchored with `m`, and they have to be the same shape or
    // the parity check above measures something the scan does not consume. An earlier
    // version counted `/^```/gm` while scanning unanchored: a triple-backtick inside a
    // prose sentence then shifted the scan's pairing while leaving the counted total
    // even, so parity passed and the scan silently read prose as code — the guard not
    // guarding what its own comment claimed. Anchoring fixes it at the source rather
    // than detecting it, since a markdown fence opens at the start of a line anyway.
    const fencedBlocks = [...page.matchAll(/^```[^\n\r]*\r?\n([\s\S]*?)^```/gm)].map(([, body = '']) => body);

    // Assert the EMBED snippet was found, not merely that some fence was.
    // Counting all fences (or worse, the character length of their joined bodies,
    // which is what this line used to do) is satisfiable by any unrelated block —
    // a theming or <div> example — so moving the embed URL out of its fence into
    // prose would silently reduce the guard to checking nothing while still
    // reporting green. Requiring a fence that actually mentions the route scopes
    // the check to the snippet whose correctness is the point. Retagging no longer
    // matters, which is the point of reading every fence above.
    const formsBlocks = fencedBlocks.filter((body) => body.includes('/feedback-forms'));

    // Reading every fence was the fix for a real hole (see above), but applying the
    // UNAUTHENTICATED oracle to every fence overshoots: these pages are also API
    // references, so the first `curl -H "Authorization: Bearer …" …/submissions`
    // example added to either would fail this test — and the fix a future author
    // reaches for is deleting the example, or narrowing back to one fence tag, which
    // is exactly the regression that let the bad URL through. So the SCAN stays wide
    // and the ORACLE is scoped instead.
    //
    // The discriminator is whether the block pastes a URL into markup a browser
    // loads unattended. Both pages today have exactly one forms-mentioning fence and
    // both are `<iframe src=…>`, so this splits the real content correctly; `src=`
    // also covers the `<script src>` shape the deleted docs used, which is the one
    // most likely to come back.
    const isEmbedContext = (body: string) => body.includes('<iframe') || body.includes('src=');
    const embedBlocks = formsBlocks.filter(isEmbedContext);
    const referenceBlocks = formsBlocks.filter((body) => !isEmbedContext(body));

    expect(
      embedBlocks.length,
      'no fenced block pastes a /feedback-forms path into markup — did the embed snippet move out of its fence, lose its src=, or change path?',
    ).toBeGreaterThan(0);

    // Resolved against the UNAUTHENTICATED subset, unlike the two caller checks
    // above. Those run from an authorized context — `client.ts` carries a Cognito
    // token and the widget source is inlined into a route that is already public
    // — so "is it wired?" is their whole question. A docs snippet is the one
    // caller for which wired is not enough: it executes in a stranger's browser
    // with no credentials on somebody else's site, so pointing it at a wired but
    // Cognito-protected per-form route (`submissions`, `stats`) hands out a
    // 401/403 rather than a form. Asserting only "wired" leaves that green.
    //
    // Derived from the synthesized template rather than from
    // INTENTIONALLY_PUBLIC_ROUTES, keeping this an independent oracle in the
    // same shape as the handler-parity tests above. OPTIONS is excluded the way
    // `nonOptions` does, since generated CORS preflights are unauthenticated by
    // construction and would re-admit every path they cover.
    // One synthesis, two views of it: the unauthenticated subset for pasted markup,
    // every wired method for the rest.
    const methods = nonOptions(apiTemplate());
    const publicPaths = new Set(
      methods.filter((m) => m.authorizationType === 'NONE').map((m) => m.path),
    );
    const wiredPaths = new Set(methods.map((m) => m.path));

    const embedPaths = callerFormsPaths(embedBlocks.join('\n'));
    expect(
      embedPaths.length,
      'an embed block was found but no /feedback-forms path could be extracted from it — '
      + 'the check below would then pass over an empty set',
    ).toBeGreaterThan(0);
    expect(
      embedPaths.filter((path) => !publicPaths.has(path)),
      'the snippet names a path an unauthenticated browser cannot call — it is either unwired or behind Cognito',
    ).toStrictEqual([]);

    // The relaxation is of the oracle, not of the check. A non-embed example may
    // name a Cognito-protected route — that is what an API reference is for — but a
    // path that is wired nowhere is the `widget.js` defect in a different fence, and
    // it 403s for whoever pastes it just the same.
    expect(
      callerFormsPaths(referenceBlocks.join('\n')).filter((path) => !wiredPaths.has(path)),
      'a non-embed example names a /feedback-forms path that is wired nowhere — it answers 403 Missing Authentication Token, not 404',
    ).toStrictEqual([]);
  });

  it('has no proxy resource left without explicit method options', () => {
    // The original defect in source form: `addProxy` without
    // `defaultMethodOptions` silently publishes everything beneath it.
    //
    // Each call's argument list is delimited by matching its parentheses, not by
    // a fixed window: a fixed slice both false-fails when the option sits just
    // past the cutoff and false-passes on an unrelated occurrence just inside it.
    // Every VocApiStack module (api-stack.ts and the api-*.ts builders it
    // composes), with a positive control: routes moving between files must not
    // turn this into a scan over a file with no proxies in it.
    const stacksDir = __dirname;
    const source = readdirSync(stacksDir)
      .filter((file) => file.startsWith('api-') && file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => readFileSync(join(stacksDir, file), 'utf8'))
      .join('\n');
    expect(source.match(/addProxy\(/g)?.length ?? 0, 'no addProxy call found in the api-*.ts modules').toBeGreaterThan(5);
    const bareProxies = [...source.matchAll(/addProxy\(/g)]
      .map((match) => {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        for (let i = open; i < source.length; i += 1) {
          if (source[i] === '(') depth += 1;
          else if (source[i] === ')') {
            depth -= 1;
            if (depth === 0) return source.slice(open, i + 1);
          }
        }
        return source.slice(open);
      })
      .filter((call) => !call.includes('defaultMethodOptions'));

    expect(bareProxies).toStrictEqual([]);
  });
});

describe('skipFeedbackFormItemRoutes (transitional upgrade flag)', () => {
  const flagged = apiTemplateFlagged;

  it('omits the item routes so the old {proxy+} can be retired first', () => {
    // {form_id} cannot be created while {proxy+} still exists, and CloudFormation
    // creates before deleting, so the upgrade needs one deploy without these.
    const routes = apiMethods(flagged()).map((m) => m.route);

    expect(routes.filter((route) => route.includes('{form_id}'))).toStrictEqual([]);
    expect(routes).toContain('GET /feedback-forms');
    expect(routes).toContain('POST /feedback-forms');
  });

  it('leaves no FORM route unauthenticated during that transitional deploy', () => {
    // The window is fail-closed for the forms: the public widget routes live
    // under {form_id}, so they are absent too rather than exposed.
    //
    // The public BALLOT routes are unaffected and stay up, which is the intended
    // scope of a flag named for the feedback-form item routes: it exists to retire
    // one old {proxy+}, and taking a prioritization meeting's voting down with it
    // would be an unrelated outage. Asserted as an exact list rather than by
    // filtering the forms out, so a future public route cannot join this window
    // unremarked.
    expect(unauthenticatedRoutes(flagged())).toStrictEqual([
      'GET /voting-sessions/{session_id}/config',
      'POST /voting-sessions/{session_id}/submit',
    ]);
  });

  it('is a no-op when absent — the default template keeps the item routes', () => {
    expect(unauthenticatedRoutes(apiTemplate())).toStrictEqual(INTENTIONALLY_PUBLIC_ROUTES);
    expect(apiMethods(apiTemplate()).map((m) => m.route)).toContain('PUT /feedback-forms/{form_id}');
  });
});
