/**
 * The public feedback-form routes: which are public, how each is throttled,
 * and that the widget, the docs and the stack stay in step. Split out of
 * api-stack.test.ts; shared template readers live in
 * lib/test-support/api-stack-template.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';

import {
  apiMethods, apiTemplate, apiTemplateAllPlugins, apiTemplateFlagged, methodSettings, unauthenticatedRoutes,
  unwiredMethodKeys,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

// Synthesize the shared default template once, outside any single case's 5s
// budget: the first case to call apiTemplate() would otherwise pay for it.
beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('the public feedback-form routes', () => {
  /** The pair each of the three public widget routes carries, and WHY it is not
   *  one pair.
   *
   *  `submit` joins the ballots at 20/40: the request itself is three operations
   *  (form get_item, conditional brand update_item, SQS send_message — it does NOT
   *  write the feedback table, the role is read-only there), and the enqueued
   *  record then drives Comprehend, Translate and a Bedrock invocation in
   *  lambda/processor/handler.py. A per-request model call against a shared
   *  account quota is what the 20 buys protection from.
   *
   *  `config` and `iframe` are stated at 100/200 — the same numbers as the stage
   *  default, deliberately restated rather than inherited. Their legitimate demand
   *  is a CUSTOMER's page-view rate (feedback-widget.js fetches `config` on every
   *  page load; `iframe` renders per embed), the setting is keyed by path so the
   *  ceiling is shared across every form and caller in the deployment, and a 429
   *  surfaces as an unretried "Feedback form unavailable." on `config`
   *  specifically — indistinguishable from a disabled form (`submit` and `iframe`
   *  fail differently again; the three symptoms are enumerated on
   *  publicWidgetReadThrottle in api-stack.ts). So the bounded-room argument
   *  behind 20 rps does not reach them, and pinning their own value keeps a future
   *  tightening of the stage-wide default from silently squeezing a third party's
   *  page.
   *
   *  Keys are `deployOptions.methodOptions`' own form, `{resource path}/{METHOD}`,
   *  and `{form_id}` is the spelling of the resource created as
   *  `feedbackFormsResource.addResource('{form_id}')`. A key naming a path that
   *  does not exist throttles nothing and reports nothing, so the spelling is
   *  compared against the wired routes below rather than trusted. */
  const EXPECTED_FORM_THROTTLES = {
    '/feedback-forms/{form_id}/config/GET': { rate: 100, burst: 200 },
    '/feedback-forms/{form_id}/submit/POST': { rate: 20, burst: 40 },
    '/feedback-forms/{form_id}/iframe/GET': { rate: 100, burst: 200 },
  } satisfies Record<string, { rate: number; burst: number }>;

  /** DERIVED from the record, not maintained beside it. Two hand-kept lists of
   *  the same three keys can disagree, and indexing the record with a key it
   *  lacks reads as `{rate; burst}` to the compiler (`noUncheckedIndexedAccess`
   *  is off in this tsconfig), so a mismatch would surface as "cannot read
   *  properties of undefined" instead of naming the missing key. The case that
   *  needs the pairs iterates `Object.entries` for the same reason: no indexing,
   *  so no unchecked lookup to get wrong. */
  const PUBLIC_FORM_METHOD_KEYS = Object.keys(EXPECTED_FORM_THROTTLES);

  /** The substring a document uses to name a route, and the method-setting key
   *  whose numbers that row must state. The short forms are what the two
   *  documents actually write (`POST /submit`, not the full path), so they are
   *  what a line has to contain to be judged.
   *
   *  The ballot routes are here as well as the three form routes, answering a
   *  review question rather than only the task's scope. They share
   *  `publicRouteThrottle` with the widget's `submit` today, so they cannot drift
   *  from it while that constant is shared — but the named follow-up (a per-form
   *  submission cap) is precisely the thing that would DECOUPLE them, moving the
   *  form figure and leaving the ballot prose behind with the suite still green.
   *
   *  BOTH ballot routes are named, by FULL PATH, and that is the fix for a hole
   *  review found in the version that named only the ballot's config: a line
   *  spelled `POST /voting-sessions/{session_id}/submit` contains `/submit`, was
   *  shadowed by nothing, and was judged against the FORM's submit pair. It passed
   *  only because both are 20/40 — that is, precisely until the follow-up above
   *  decouples them, at which point a correct document fails and accuses itself.
   *  Registering the route is what closes it, because the shadowing rule below is
   *  containment between a doc-facing NAME and another route's KEY: once the
   *  ballot's submit path is a name, it shadows `/submit` with no new mechanism,
   *  and — the half a family-based rule would have missed — the line is judged
   *  against the ballot submit's OWN pair rather than against the ballot config's.
   *
   *  Hence full paths for the ballot pair and short names for the form: each is
   *  what its own document writes, which is the rule stated above. */
  const DOCUMENTED_ROUTE_KEYS = {
    '/config': '/feedback-forms/{form_id}/config/GET',
    '/iframe': '/feedback-forms/{form_id}/iframe/GET',
    '/submit': '/feedback-forms/{form_id}/submit/POST',
    '/voting-sessions/{session_id}/config': '/voting-sessions/{session_id}/config/GET',
    '/voting-sessions/{session_id}/submit': '/voting-sessions/{session_id}/submit/POST',
  } satisfies Record<string, string>;

  /** Every document that publishes these figures, and which routes each one
   *  publishes. THE SINGLE SOURCE for both cases below, which is the point: the
   *  lockstep case READS these files, and the class-level guard EXEMPTS them from
   *  its "no third document states these unpinned" sweep.
   *
   *  Two separately-maintained copies of this list is the defect review found —
   *  adding a third document to the guard's copy alone silenced the guard (the
   *  file counts as pinned) while the lockstep never read it (its own list was
   *  untouched), so a document publishing 999/999 passed the whole block. The
   *  guard's failure message even pointed at the OTHER list, making the half-fix
   *  the natural one. Derived over one declaration, adding a document is one edit
   *  that necessarily does both, which is the same reasoning as
   *  `PUBLIC_FORM_METHOD_KEYS` being `Object.keys` of the record above.
   *
   *  Typed against `DOCUMENTED_ROUTE_KEYS`, so a route name that no longer exists
   *  fails to compile instead of quietly asserting nothing for it. */
  const PINNED_DOCS = {
    'docs/feedback-forms.md': ['/config', '/iframe', '/submit'],
    '.kiro/steering/structure.md': [
      '/config', '/iframe', '/submit',
      '/voting-sessions/{session_id}/config', '/voting-sessions/{session_id}/submit',
    ],
  } satisfies Record<string, (keyof typeof DOCUMENTED_ROUTE_KEYS)[]>;

  /** Every spelling of a per-second rate, as an un-anchored alternation. THE
   *  SHARED VOCABULARY of the two doc cases below, and shared for the same reason
   *  `PINNED_DOCS` is: two hand-kept copies disagreed, and the disagreement was
   *  invisible in both.
   *
   *  The lockstep case SELECTS candidate lines with it; the class-level guard
   *  DISCOVERS documents with it. Those two keep their opposite biases — see the
   *  comment on `statesALimit` — but a spelling one of them recognises and the
   *  other does not is a gap rather than a bias, and review found the gap it
   *  produced: discovery accepted `requests/second`, selection accepted only
   *  `rps` / `req/s`, so a pinned document reworded to the broad-only spelling
   *  stayed discovered while none of its lines was judged, and the failure that
   *  followed named the document rather than the parse.
   *
   *  Longest alternatives first, so `requests/second` is not consumed as
   *  `requests/s` with `econd` left over. The trailing `\/\s*s` is the bare
   *  `100/s` form. */
  const RATE_UNIT = String.raw`requests? per second|requests?\/sec(?:ond)?|req\/sec(?:ond)?|requests?\/s|req\/s|rps|\/\s*s`;

  /** The documented names that are about a MORE SPECIFIC route than `names`: their
   *  route key CONTAINS this name, so a line naming them is not a line about this
   *  route.
   *
   *  `/voting-sessions/{session_id}/config/GET` contains `/config`, so a ballot row
   *  spelled with its full path — which the steering file already does for the form
   *  (`/feedback-forms/{id}/config`) — would otherwise be selected for `/config`
   *  and judged against the FORM's 100/200, failing as a stale ceiling while
   *  correctly publishing the ballot's 20/40. Reproduced before fixing: rewriting
   *  the ballot row that way fails with "stale for /config: this row states 20/40
   *  but the template deploys 100/200".
   *
   *  Today's ballot row writes `/{id}/…` and so does not collide — this is one
   *  full-path rewording away, and the failure it produces accuses a document that
   *  is correct. A separate function so `attributes a line to the most specific
   *  route it names` can pin it without needing a document that collides. */
  const moreSpecificThan = (names: string) => Object.entries(DOCUMENTED_ROUTE_KEYS)
    .filter(([other, key]) => other !== names && key.includes(names))
    .map(([other]) => other);

  /** Whether `line` is a documentation row ABOUT `names`.
   *
   *  ONE definition, used by the lockstep loop and by `attributes a line to the
   *  most specific route it names`. Splitting them is what a mutation caught: with
   *  the test calling `moreSpecificThan` and the loop applying the exclusion
   *  inline, disabling the loop's copy left every case green — the helper was
   *  pinned and its USE was not, which is the same shape as the duplicated lists
   *  this block already fixed twice.
   *
   *  Containment is the ONLY rule, and an intermediate version of this fix had a
   *  second one — shadowing by route FAMILY, so that a line naming one family's
   *  root was never a row about the other. It is deleted rather than kept: naming
   *  the ballot's submit route in `DOCUMENTED_ROUTE_KEYS` closes the same hole
   *  through the rule already here, and does it BETTER, because a family rule
   *  excludes the ballot submit line from the form's pair while still judging it
   *  against the ballot CONFIG's pair — the same wrong-pair failure one route
   *  over, waiting for the same follow-up to decouple them. One mechanism that
   *  judges every named route against its own pair beats two that share a hole. */
  const isRowFor = (names: string, line: string) => line.includes(names)
    // A more specific route, whichever family it belongs to:
    // `/voting-sessions/{session_id}/config/GET` contains `/config`, and
    // `/voting-sessions/{session_id}/submit/POST` contains `/submit`.
    && !moreSpecificThan(names).some((other) => line.includes(other));

  /** A stated rate FIGURE: digits immediately followed by one of those units.
   *
   *  Both predicates below use THIS, not a bare `RATE_UNIT`, and the digits are
   *  the whole correction. Sharing only the unit made selection as wide as
   *  discovery, and two legitimate lines then hard-failed as "states no rate pair
   *  this test can parse" — the false positive the comment on `statesALimit` says
   *  the precise bias exists to avoid:
   *
   *    - `The /submit route sustains roughly 30x what the feature needs in
   *      requests per second.` — prose that names a route and a unit, claims no
   *      figure, and was judged as though it had.
   *    - `| /submit | write | Sized for 50 MB/s of payload … |` — the bare
   *      `\/\s*s` alternative matches ANY `<word>/s`, so `MB/s`, `GB/s`, `ops/s`
   *      and `reads/s` all counted as stating a rate.
   *
   *  Both reproduced against the real documents before this changed. Requiring the
   *  digits makes selection match what `allStatedPairs` can actually parse, which
   *  is the property that was missing: a line is judged only if a rate figure is
   *  there to judge. `50 MB/s` no longer qualifies because the digits are not
   *  adjacent to the unit — `MB` sits between them.
   *
   *  Discovery gets the same treatment on purpose, and it does not lose reach for
   *  its job: a third document that PUBLISHES one of these ceilings states it in
   *  digits, which is the only form the lockstep can pin anyway (its own failure
   *  message says "digits, not words"). What discovery stops doing is flagging a
   *  document for mentioning throughput in prose. The two predicates keep their
   *  opposite biases where the comment says those live — SCOPE (whole file versus
   *  one line) and the anchored burst — not in what counts as a figure.
   *
   *  IT CAPTURES THE FIGURE, in group 1, so that `allStatedPairs` can be BUILT from
   *  this string instead of re-spelling it. Review found the re-spelling: the parser
   *  wrote its own `(\d+)\s*(?:${RATE_UNIT})` while its comment asserted the prefix
   *  was "exactly `RATE_FIGURE`" — an equality the compiler cannot check, and the
   *  same two-hand-kept-copies shape this block has already fixed for `PINNED_DOCS`
   *  and `PUBLIC_FORM_METHOD_KEYS`. They agreed at the time, which is what makes it
   *  worth fixing before they stop agreeing: the invariant the comment names (a line
   *  that is SELECTED is a line the parser can PARSE) is load-bearing, and breaking
   *  it in either direction produces one of the two failures described above.
   *
   *  The capture is inert for the selector — `RegExp.test` ignores groups — so one
   *  constant serves both without either paying for the other. */
  const RATE_FIGURE = String.raw`(\d+)\s*(?:${RATE_UNIT})\b`;

  it('gives each of the three an explicit pair, tight for submit and generous for the reads', () => {
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));

    for (const [key, expected] of Object.entries(EXPECTED_FORM_THROTTLES)) {
      const setting = settings.get(key);

      expect(setting, `${key} has no method-level throttle`).toBeDefined();
      expect(setting?.rate).toBe(expected.rate);
      expect(setting?.burst).toBe(expected.burst);
    }
  });

  it('holds submit strictly tighter than the two reads, which is the whole split', () => {
    // The pins above would still pass if all three were "fixed" back to one pair.
    // This is the case that fails then: the asymmetry is the decision, and it is
    // argued from cost (a Bedrock invocation per submission) versus demand (a
    // third party's page views), not from who is allowed to call.
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));
    const submit = settings.get('/feedback-forms/{form_id}/submit/POST');

    for (const read of ['/feedback-forms/{form_id}/config/GET', '/feedback-forms/{form_id}/iframe/GET']) {
      expect(submit?.rate, `submit should be tighter than ${read}`)
        .toBeLessThan(settings.get(read)?.rate ?? 0);
    }
  });

  it('spells those throttle keys the same way the wired routes are spelled', () => {
    expect(unwiredMethodKeys(apiTemplate(), PUBLIC_FORM_METHOD_KEYS)).toStrictEqual([]);
  });

  it('drops the throttle entries when skipFeedbackFormItemRoutes omits the routes', () => {
    // The transitional deploy does not create the {form_id} subtree at all, so a
    // method setting naming those paths would be a claim about routes this stage
    // does not serve. Harmless to API Gateway — an unmatched setting is simply
    // never applied — but the template should not assert what it does not deploy.
    const keys = new Set(methodSettings(apiTemplateFlagged()).map((s) => s.key));

    expect(PUBLIC_FORM_METHOD_KEYS.filter((key) => keys.has(key))).toStrictEqual([]);

    // The ballot entries are unaffected: the flag is named for the form routes and
    // taking a prioritization meeting's throttle down with it would be unrelated.
    expect(keys.has('/voting-sessions/{session_id}/config/GET')).toBe(true);
    expect(keys.has('/voting-sessions/{session_id}/submit/POST')).toBe(true);
  });

  it('every method setting on the stage names a route this stage wires', () => {
    // The general form of the two cases above, over BOTH template shapes: a
    // setting whose path is not deployed is dead weight, and this is what makes
    // the conditional above self-enforcing rather than a one-off.
    for (const template of [apiTemplate(), apiTemplateFlagged()]) {
      const wiredKeys = new Set(apiMethods(template).map((m) => `${m.path}/${m.httpMethod}`));
      const orphans = methodSettings(template)
        .map((s) => s.key)
        // `*/*` is the STAGE-WIDE default that `throttlingRateLimit` /
        // `throttlingBurstLimit` on deployOptions produce. It names no resource
        // by design and is the one form API Gateway accepts as a wildcard.
        .filter((key) => key !== '*/*')
        .filter((key) => {
          const path = key.slice(0, key.lastIndexOf('/'));
          const verb = key.slice(key.lastIndexOf('/') + 1);
          // `/mcp/{proxy+}/…` keys name concrete verbs served by the proxy's ANY.
          return !wiredKeys.has(`${path}/${verb}`) && !wiredKeys.has(`${path}/ANY`);
        });

      expect(orphans).toStrictEqual([]);
    }
  });

  it('CORS preflight is unauthenticated and reaches no compute, which is why it is excluded above', () => {
    // The two facts `nonOptions` rests on, asserted rather than described. Review
    // asked whether the OPTIONS methods belong in the "every unauthenticated route
    // is throttled" invariant; they do belong to the concern, and this is why they
    // are already satisfied by the stage default.
    //
    // NEITHER fact is a count. The number of preflights changes with every route
    // added, so pinning it would fail on unrelated work; what must hold is that
    // ALL of them are still MOCK and still NONE.
    for (const template of [apiTemplate(), apiTemplateFlagged(), apiTemplateAllPlugins()]) {
      const preflights = apiMethods(template).filter((m) => m.httpMethod === 'OPTIONS');
      expect(preflights.length, 'no OPTIONS methods at all — CORS is not wired, so this is vacuous').toBeGreaterThan(0);

      // Unauthenticated by necessity: a browser sends no credentials on a preflight.
      expect(
        [...new Set(preflights.map((m) => m.authorizationType))],
        'a preflight gained an authorizer, which breaks CORS for every caller',
      ).toStrictEqual(['NONE']);

      // MOCK is the load-bearing one: it is why an unauthenticated preflight needs
      // no per-method pair. A Lambda-backed OPTIONS would cost real compute per
      // call and would have to join EXPECTED_FORM_THROTTLES' treatment instead.
      // Parsed, not asserted — this file's convention for template values.
      const PreflightSchema = z.object({
        Properties: z.object({
          HttpMethod: z.string(),
          Integration: z.object({ Type: z.string().optional() }).optional(),
        }),
      });
      const backed = Object.entries(template.findResources('AWS::ApiGateway::Method'))
        .filter(([, resource]) => {
          const { HttpMethod, Integration } = PreflightSchema.parse(resource).Properties;
          return HttpMethod === 'OPTIONS' && Integration?.Type !== 'MOCK';
        })
        .map(([logicalId]) => logicalId);

      expect(
        backed,
        'an OPTIONS method is no longer a MOCK integration, so a preflight now reaches compute — '
        + 'it needs its own throttle pair, and `nonOptions` must stop excluding it',
      ).toStrictEqual([]);
    }
  });

  it('gives EVERY unauthenticated route an explicit throttle, not just these three', () => {
    // The CONVERSE of the case above, and the one that generalises this PR rather
    // than pinning its three routes. The orphan check asks "does every setting
    // name a wired route?"; this asks "does every route that needs a setting have
    // one?" Without it, a SIXTH public route added later passes every other test
    // in this file while silently riding the stage default — which is exactly the
    // gap that existed for these three before this change, so leaving only the
    // per-key pins would fix the instance and not the class.
    //
    // Quantified over the unauthenticated routes the TEMPLATE declares, not over
    // INTENTIONALLY_PUBLIC_ROUTES, so it needs no maintenance: publishing a route
    // puts it in scope here automatically.
    //
    // THREE shapes, and the third is the one that makes this non-vacuous for the
    // scenario named above. The realistic "sixth public route" in this repo is a
    // PLUGIN WEBHOOK: api-stack.ts adds them as `pluginResource.addMethod(method,
    // webhookIntegration)` with no method options, i.e. deliberately
    // AuthorizationType NONE. Those exist only when plugins are enabled, so with
    // apiTemplate()/apiTemplateFlagged() alone (both synthesized with
    // `enabledSources: []`) the route this case should flag would not be in any
    // template it inspects. apiTemplateAllPlugins() is the fixture the sibling
    // authorization invariant already uses for exactly this reason. No manifest
    // declares a webhook today, so this adds no failure now and starts working on
    // the day one does.
    for (const template of [apiTemplate(), apiTemplateFlagged(), apiTemplateAllPlugins()]) {
      const settings = new Map(methodSettings(template).map((s) => [s.key, s]));
      const explicitPair = (key: string) =>
        settings.get(key)?.rate !== undefined && settings.get(key)?.burst !== undefined;
      const unthrottled = unauthenticatedRoutes(template)
        // `GET /a/b` is keyed `/a/b/GET` in deployOptions.methodOptions.
        .map((route) => {
          const [verb, path] = route.split(' ');
          return { path, verb, key: `${path}/${verb}` };
        })
        // A rate limit with no burst, or vice versa, is not an explicit pair: the
        // missing half falls back to the stage or account default silently.
        //
        // `ANY` needs the same allowance the orphan check above makes, and for the
        // converse reason. A route wired through `addProxy({ anyMethod: true })`
        // reports httpMethod ANY, but API Gateway REJECTS `ANY` as a method-setting
        // httpMethod (the deploy-probe finding recorded on methodOptions in
        // api-stack.ts), so demanding `/…/{proxy+}/ANY` would make this case
        // unsatisfiable rather than merely strict — it would fail against a
        // correct, maximally-throttled stack. For such a method, a concrete-verb
        // setting on the SAME path is the throttled form, which is how the /mcp
        // proxy entries are spelled.
        //
        // "Same path" is compared by splitting each setting key at its LAST `/`
        // and requiring equality, not with `startsWith`. A prefix test also
        // matches DESCENDANTS, so a setting on `/webhooks/some-plugin/POST` would
        // excuse an un-throttled ANY method on `/webhooks` — a false negative, and
        // the wrong direction for a guard whose job is to flag a public route
        // riding the stage default.
        //
        // NO CURRENT FIXTURE EXERCISES THIS BRANCH: no manifest declares a webhook
        // (pinned by the sibling case above), and every `addProxy({ anyMethod:
        // true })` in api-stack.ts passes `authMethodOptions`, so no template here
        // holds an unauthenticated ANY route. Its correctness rests on reading
        // rather than on a passing assertion — which is why the predicate is
        // written to be exact rather than merely sufficient for today's template.
        .filter(({ path, verb, key }) => (verb === 'ANY'
          ? ![...settings.keys()].some((k) => k.slice(0, k.lastIndexOf('/')) === path && explicitPair(k))
          : !explicitPair(key)))
        .map(({ key }) => key);

      expect(unthrottled, 'public routes riding the stage default').toStrictEqual([]);
    }
  });

  it('attributes a line to the most specific route it names', () => {
    // Pins `moreSpecificThan`, which stops a BALLOT row being judged against the
    // FORM's ceiling. Pinned here rather than through the documents because
    // neither document collides today — the exposure is one full-path rewording
    // away, so a fixture is the only way to keep the guard honest.
    //
    // The relationship is containment between a doc-facing NAME and another
    // route's KEY, not string length: `/voting-sessions/{session_id}/config/GET`
    // contains `/config`, which is what makes a ballot row look like a form row.
    //
    // THE SAME RELATIONSHIP FOR SUBMIT, which review found missing. With the ballot
    // pair named by its config alone, `/submit` was shadowed by nothing, so a line
    // spelled `POST /voting-sessions/{session_id}/submit` was judged against the
    // FORM's submit pair, passing only because both are 20/40 — until the per-form
    // cap follow-up moves one of them. Naming the ballot's submit route brings it
    // under the containment rule that was already here.
    //
    // And the converse, which is what stops this over-reaching: the ballot routes are
    // named by full path, so nothing is more specific than either, and `/iframe`
    // appears in no other key. If these returned a value, rows would start being
    // skipped rather than misjudged — the opposite failure.
    const names = [
      '/config', '/submit', '/voting-sessions/{session_id}/config', '/voting-sessions/{session_id}/submit', '/iframe',
    ];
    expect(Object.fromEntries(names.map((name) => [name, moreSpecificThan(name)]))).toStrictEqual({
      '/config': ['/voting-sessions/{session_id}/config'],
      '/submit': ['/voting-sessions/{session_id}/submit'],
      '/voting-sessions/{session_id}/config': [],
      '/voting-sessions/{session_id}/submit': [],
      '/iframe': [],
    });
  });

  // The selection rule itself: a line naming a ballot route is not a form row, and
  // a line naming only the form's short name still is. `isRowFor` itself, the SAME
  // predicate the lockstep loop filters with — not a restatement of it here. A
  // local copy left the loop's use of it unpinned.
  const ballotConfigRow = '> `GET /voting-sessions/{session_id}/config` carries 20 rps / 40';
  const ballotSubmitRow = '> `POST /voting-sessions/{session_id}/submit` carries 20 rps / 40';
  const formRow = '> | `GET /config`, `GET /iframe` | **100 rps / 200** |';
  const formSubmitRow = '> | `POST /submit` | **20 rps / 40** |';

  it('judges a ballot line against its own pair, never the form\'s', () => {
    // The submit half is the pair that fails without the ballot submit route
    // registered: the ballot's submit line is not the form's row, and it IS judged
    // — against its OWN pair, which is the half a family-based exclusion would
    // have got wrong (it would have judged this line against the ballot CONFIG's
    // pair instead).
    expect({
      configAsFormConfig: isRowFor('/config', ballotConfigRow),
      configAsBallotConfig: isRowFor('/voting-sessions/{session_id}/config', ballotConfigRow),
      configAsBallotSubmit: isRowFor('/voting-sessions/{session_id}/submit', ballotConfigRow),
      submitAsFormSubmit: isRowFor('/submit', ballotSubmitRow),
      submitAsBallotSubmit: isRowFor('/voting-sessions/{session_id}/submit', ballotSubmitRow),
      submitAsBallotConfig: isRowFor('/voting-sessions/{session_id}/config', ballotSubmitRow),
    }, 'a ballot row must be judged as its own route only').toStrictEqual({
      configAsFormConfig: false,
      configAsBallotConfig: true,
      configAsBallotSubmit: false,
      submitAsFormSubmit: false,
      submitAsBallotSubmit: true,
      submitAsBallotConfig: false,
    });
  });

  it('still treats the form\'s own lines as its rows', () => {
    // What over-reach breaks.
    expect({
      config: isRowFor('/config', formRow),
      submit: isRowFor('/submit', formSubmitRow),
    }).toStrictEqual({ config: true, submit: true });
  });

  it('counts a rate FIGURE, not a bare unit, so prose about throughput is not judged', () => {
    // The predicate both doc cases select and discover with, pinned directly.
    //
    // Reaching it through the real documents is not enough: both defects below
    // were found by a reviewer, not by this suite, because they are exposures to
    // the NEXT line either document gains — every line present today happens to
    // state a well-formed pair. Measured: with the digits removed the real-doc
    // lockstep still PASSES, so the shapes are named here, where a revert fails
    // immediately rather than on the next doc edit.
    //
    // Reproduced against the real docs/feedback-forms.md before fixing: each
    // `MUST_NOT_SELECT` row, appended to that file, failed the lockstep case with
    // "states no rate pair this test can parse" — a legitimate line accused of
    // being a stale ceiling.
    const selects = (line: string) => new RegExp(RATE_FIGURE).test(line);

    const MUST_SELECT = [
      '| `/submit` | 5 req/s, burst 10 |',
      '| `/config` | **100 rps / 200** |',
      'the reads allow 100 requests per second, burst 200',
      'documented as 100 requests/second, burst 200',
      'the bare form, 100/s / 200, is also accepted',
    ];
    const MUST_NOT_SELECT = [
      // Names a route and a unit; claims no figure. Judged as though it had.
      'The `/submit` route sustains roughly 30x what the feature needs in requests per second.',
      // The bare `\/\s*s` alternative matches any `<word>/s`.
      '| `/submit` | write | Sized for 50 MB/s of payload, not room-sized bursts. |',
      'throughput of 12 GB/s across the fleet',
      'the handler manages 40 ops/s per shard',
      // A path segment must never read as a rate.
      'see /feedback-forms/{form_id}/submissions for the reads',
      // AND THE ONE THAT ACTUALLY EXERCISES THE TRAILING `\b`, which review found
      // this list was missing: the row above carries no digits, so it is rejected
      // for want of a figure whatever `\b` does — vacuous cover for the guard it
      // was added for. Here `1/s` (stage `v1`, then a segment starting with `s`)
      // DOES match `\d+` followed by the bare `\/\s*s` unit, and only the boundary
      // rejects it, because `ubmissions` continues the word. Drop the `\b` and this
      // line reads as "1 per second" and gets judged against the template.
      'the raw reads live under /v1/submissions in the deployed stage',
    ];

    for (const line of MUST_SELECT) {
      expect(selects(line), `should be judged but was not selected: ${line}`).toBe(true);
    }
    for (const line of MUST_NOT_SELECT) {
      expect(selects(line), `states no figure but was selected for judgement: ${line}`).toBe(false);
    }
  });

  it('keeps the two prose copies of these numbers in step with the template', () => {
    // The pairs are stated in FIVE places: the two constants in api-stack.ts, the
    // record above, and two documents — docs/feedback-forms.md (integrator-facing)
    // and .kiro/steering/structure.md. The first three are enforced against the
    // synthesized template by the cases above; without this, the two prose copies
    // drift silently on the next tuning and mislead the exact reader they were
    // added for.
    //
    // A .md file is a new thing for this suite to read, but not a new IDEA: the
    // `stack and callers stay in step` block already reads feedback_form_handler.py,
    // ballots_handler.py, api.py and api-stack.ts itself, and the Python side
    // carries a family of *_lockstep tests for constants shared across languages.
    // A number published as an integrator-facing contract is exactly the kind of
    // claim this repo pins rather than trusts, so the docs are held to the same
    // standard as the code — that is the answer to "should prose stay unpinned":
    // no, when it states a number a deploy can contradict.
    //
    // Deliberately asserts only the NUMBERS, and only on the lines that state a
    // limit for the route: the prose around them is explanatory and should stay
    // free to be reworded without a test edit. Where a route IS named with a
    // limit, EVERY such line must state the template's pair — see the per-row
    // comparison below for the false pass that "some line does" allowed.
    //
    // PER ROUTE rather than per document, which a first version got wrong and a
    // mutation caught: searching the whole file for "100 … 200" passes even after
    // `config`'s row is falsified, because `iframe` legitimately carries the same
    // pair elsewhere in the file. Scoping the search to lines that name the route
    // is what makes a single stale row fail. The docs are read from the repo ROOT,
    // one level above `voc-datalake`.
    //
    // That scoping fixed the CROSS-ROUTE false pass and left the WITHIN-LINE one.
    // Any "do these digits occur on the line" predicate is satisfied by a row that
    // states the WRONG limit and mentions the right one in passing — `| GET /config
    // | 20 rps / 40 | was 100 rps / 200 before |` matches 100/200 — and prose beside
    // a number ("raised from 100 to 250", or a "Why" column citing another route's
    // figures) is exactly how a doc goes stale.
    //
    // Requiring the two numbers to be ADJACENT does not close it either: in `was
    // 100 rps / 200 before` the correct pair IS adjacent, so that row still passes.
    // Checked against the falsified row before settling on the predicate below.
    //
    // So it is not a search. Each candidate line is PARSED for the pair it STATES
    // and that pair is compared to the template's numerically: the property
    // asserted is "this row is correct", not "the right digits are present
    // somewhere on it". Both phrasings parse: "100 req/s, burst 200" and
    // "**100 rps / 200**".
    //
    // And the parse is NOT POSITIONAL, which is the second half of the same defect.
    // Taking the FIRST pair on the line just picks whichever of two well-formed
    // pairs comes first, so the stale row survives with its clauses reversed:
    // `| GET /config | raised from 100 rps / 200 to **250 rps / 500** |` parses as
    // 100/200, matches, and passes while the document publishes 250/500 — and
    // "raised from X to Y" is the more natural phrasing of the two, since it reads
    // chronologically. So every pair on the line is collected and a candidate row
    // must state EXACTLY ONE, which removes the ordering question instead of
    // answering it. Both orderings were checked against the real documents.
    //
    // Candidates are lines that STATE A LIMIT, i.e. that name the route AND carry
    // a rate token, rather than every line mentioning the route. That is what keeps
    // two kinds of line out of the candidate set: the embed snippet in
    // docs/feedback-forms.md (`src="…/{form_id}/iframe"`, which carries a digit in
    // `/v1/` and so survives a bare digit filter), and the 429-symptom table, whose
    // rows name each route and say nothing about its ceiling. A "must be a markdown
    // table row" test would exclude the snippet too, but not the symptom rows, and
    // it would exclude the BALLOT figure below, which is stated in prose.
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));

    for (const [names, key] of Object.entries(DOCUMENTED_ROUTE_KEYS)) {
      // Guards the case itself: an absent setting would search for "undefined" and
      // every assertion below would fail confusingly rather than say what is wrong.
      expect(settings.get(key), `${names} has no method-level throttle to document`).toBeDefined();
    }

    /** A line stating a rate limit, in ANY spelling of a per-second rate the
     *  discovery guard below recognises — `RATE_FIGURE` is shared with it rather
     *  than restated here, and that sharing is the point.
     *
     *  The two predicates keep their OPPOSITE BIASES, which is what earlier
     *  rounds established and this deliberately does not undo: discovery is
     *  evaluated over the WHOLE FILE (over-inclusive, so a drifting third
     *  document cannot hide), while this one is evaluated PER
     *  LINE and the parse below additionally demands an anchored burst (precise,
     *  so a legitimate line is not failed). What they must not disagree about is
     *  the VOCABULARY, and they did: discovery accepted `requests/second` and
     *  `req/sec` while this accepted only `rps` and `req/s`, so a pinned document
     *  reworded to a broad-only spelling stayed DISCOVERED (satisfying the
     *  converse assertion) while every line of it stopped being a candidate here —
     *  and the `rows.length > 0` guard then reported "documents no rate limit for
     *  /config" about a document that plainly states one. The guard fired, so
     *  nothing drifted silently, but it named the wrong cause and pointed the
     *  author at the document instead of at the parse. Reproduced before fixing.
     *
     *  One alternation removes the class rather than the instance: any spelling
     *  either predicate recognises, both recognise. The biases live in the SCOPE
     *  and in the burst anchoring, not in the list of words for "per second".
     *
     *  A FIGURE, not just a unit — `RATE_FIGURE` requires digits adjacent to the
     *  unit. Selecting on the bare unit made this as wide as discovery and failed
     *  two legitimate lines; see `RATE_FIGURE`. */
    const statesALimit = (line: string) => new RegExp(RATE_FIGURE).test(line);

    /** EVERY `<rate> <per-second unit> <separator> <burst>` pair a line states, in order.
     *
     *  All of them, not the first, and that is the whole point. Parsing the FIRST
     *  pair is still positional, so it picks whichever of two well-formed pairs
     *  comes first and the stale-row defect survives with the clauses reversed:
     *  `raised from 100 rps / 200 to **250 rps / 500**` parses as 100/200, matches
     *  the template, and passes while the document publishes 250/500. Verified
     *  against the real steering doc before this was widened.
     *
     *  THE BURST IS ANCHORED TO THE TOKEN THAT INTRODUCES IT, not to "the next
     *  digits anywhere after the rate". An unanchored `[^0-9]*` spans any run of
     *  non-digits, so a row publishing NO burst still parsed one by adopting an
     *  unrelated later number — `| 100 req/s | burst raised in PR 200 |` yielded
     *  100/200, matched the template, satisfied the exactly-one check, and passed
     *  while telling an integrator nothing about the burst. A PR number, an issue
     *  reference, a version or a percentage later in the row was enough, and the
     *  row need not even be wrong on purpose, just reworded. Reproduced before
     *  fixing; that is the same class as the two defects the previous round fixed,
     *  one field over.
     *
     *  Both real phrasings put a word or a bare `/` immediately before the burst —
     *  `100 req/s, burst 200` and `**100 rps / 200**` — so requiring one of those
     *  two separators accepts every current row and yields ZERO pairs for a row
     *  that states no burst, which then fails as "states no parseable pair" rather
     *  than passing.
     *
     *  The rate-and-unit prefix here IS `RATE_FIGURE` — concatenated, not restated,
     *  which is the correction review asked for. `RATE_FIGURE` is what
     *  `statesALimit` selects with, so a line that is selected is a line this can
     *  parse — that equality is the invariant, and losing it in either direction
     *  is a defect this file has already seen twice. A NARROWER unit here would
     *  report "states no rate pair this test can parse" for a spelling the
     *  selector had just accepted; a WIDER selector would judge a line that never
     *  claimed a figure, which is what requiring the digits fixed.
     *
     *  It used to be a second spelling of that prefix with this comment claiming
     *  they were "exactly" equal. They were, so nothing was broken — but a comment
     *  is not a check, and the two copies could only stay equal by hand. Building
     *  the pattern from the constant makes the invariant hold by construction, so
     *  widening the vocabulary in one place cannot leave the other behind. Group 1
     *  is the rate, captured by `RATE_FIGURE`; group 2 is the burst, captured here. */
    const allStatedPairs = (line: string): { rate: number; burst: number }[] =>
      [...line.matchAll(new RegExp(RATE_FIGURE + String.raw`\s*(?:,\s*burst\s+|\/\s*)(\d+)`, 'g'))]
        .map((match) => ({ rate: Number(match[1]), burst: Number(match[2]) }));

    for (const [doc, routes] of Object.entries(PINNED_DOCS)) {
      const lines = readFileSync(join(__dirname, '..', '..', '..', ...doc.split('/')), 'utf-8').split('\n');

      for (const names of routes) {
        const setting = settings.get(DOCUMENTED_ROUTE_KEYS[names]);
        // The steering file groups the two reads onto one row, so a route may be
        // documented by more than one line — and EVERY such line is judged, not
        // just one of them. See the loop below for why that changed.
        const rows = lines.filter((line) => isRowFor(names, line) && statesALimit(line));

        expect(rows.length, `${doc} documents no rate limit for ${names}`).toBeGreaterThan(0);

        // EXACTLY ONE pair per line, which removes the ordering question rather
        // than answering it. Every candidate row in both documents states exactly
        // one today, so this costs nothing now and forces a future "was 100/200"
        // aside — the phrasing that defeats any positional parse — onto its own
        // line or into a footnote, where it cannot be mistaken for the row's
        // claim. Checked before adopting: no current row states two.
        //
        // TWO ASSERTIONS, NOT ONE `toBe(1)`. A single two-sided assertion can only
        // carry one message, and the one it carried described only the greater-than
        // side: a row stating ZERO parseable pairs failed with "states more than
        // one … move the aside to its own line", advising an author to split a row
        // that has nothing to split, with `expected +0 to be 1` the only clue that
        // the diagnosis was inverted. Reproduced verbatim by spelling a burst in
        // words. The zero case is not hypothetical — it is reached by omitting the
        // burst, spelling it in words, or any rewording the parse stops matching,
        // and it is the state the anchored burst above now correctly produces for a
        // row that publishes no burst, so the two interact. Assertion messages here
        // are load-bearing, so a message that misdescribes the failure it fires on
        // is a defect rather than a wording nit.
        //
        // AND EVERY ROW IS COMPARED TO THE TEMPLATE, which is the last member of
        // the family the two previous rounds worked through — the same defect one
        // level up, ACROSS rows rather than within a line. The comparison used to
        // be a single `toContainEqual` over `rows.flatMap(allStatedPairs)`, which
        // pooled the pairs of every candidate row and asked only that the correct
        // one appear SOMEWHERE in the pool. So one correct row satisfied the
        // assertion on behalf of every other row naming the route, and the loop
        // here did not cover that: it bounded each row's pair COUNT and never
        // compared a row's pair to anything. Review reproduced it by ADDING a row
        // beside the correct one:
        //
        //     | `GET /…/config` | 100 req/s, burst 200 |
        //     | `GET /…/config` (legacy deployments) | 20 req/s, burst 40 |
        //
        // The pool was [{100,200},{20,40}], `toContainEqual({100,200})` passed, and
        // the document told an integrator that `/config` is 20 req/s. Adding a row
        // is how a document grows — a version caveat, a "self-hosted" note, a
        // per-tier table — so this is the more likely direction of drift than the
        // single-row cases already closed.
        //
        // Judging each row subsumes the pooled check, so it is gone rather than
        // kept alongside. It stays satisfiable for the legitimate multi-row case
        // the pooling was written for: the steering doc's `GET /config`, `GET
        // /iframe` row is matched by BOTH route names and states the pair both
        // expect, so requiring every row to agree passes unchanged. `rows.length >
        // 0` above still carries the "documented nowhere" case, which per-row
        // judgement cannot express.
        for (const row of rows) {
          const pairs = allStatedPairs(row);

          expect(
            pairs.length,
            `${doc} names ${names} and carries a rate token but states no rate pair this test can `
            + 'parse, so nothing pins it — write it as "100 req/s, burst 200" or "100 rps / 200" '
            + `(digits, not words): ${row.trim()}`,
          ).toBeGreaterThan(0);

          expect(
            pairs.length,
            `${doc} states more than one rate pair on one line for ${names}, so which one the row `
            + `CLAIMS is ambiguous — move the aside to its own line: ${row.trim()}`,
          ).toBeLessThan(2);

          expect(
            pairs[0],
            `${doc} is stale for ${names}: this row states ${pairs[0]?.rate}/${pairs[0]?.burst} but the `
            + `template deploys ${setting?.rate}/${setting?.burst} — EVERY row naming the route must `
            + `agree, a correct row elsewhere does not excuse this one: ${row.trim()}`,
          ).toStrictEqual({ rate: setting?.rate, burst: setting?.burst });
        }
      }
    }
  });

  it('finds no THIRD document stating these numbers unpinned', () => {
    // The case above reads an ENUMERATED LIST OF TWO FILES, which is the same "fix
    // the instance, not the class" shape the converse throttle invariant was added
    // to avoid: a third document stating these figures would drift with nothing
    // to stop it, and nothing would point that out. This is the class-level half —
    // it enumerates every markdown file in the repository and fails if one states
    // a rate limit for these routes without being in the pinned list.
    //
    // Cheap enough to be worth it (a few dozen small files) and it answers the
    // second half of the review question: prose is not exempt, and the exemption
    // is not obtained by writing the numbers somewhere the lockstep does not look.
    //
    // The predicate below is DELIBERATELY OVER-INCLUSIVE, which is the opposite
    // bias from `statesALimit` in the case above, and the two remain separate
    // FUNCTIONS for exactly that reason. `statesALimit` picks lines out of two
    // KNOWN documents, so a false positive there fails a legitimate line and it
    // must be precise. This one has to DISCOVER unknown documents written by
    // someone who never read this test, so a false negative silently excuses a
    // drifting file while a false positive only asks an author to pin the file or
    // drop the figures. Two consequences, both found by review:
    //
    //   - IT DEMANDS ONLY A UNIT, not a parseable rate/burst pair. Requiring the
    //     anchored pair the lockstep parses would miss a third document that
    //     states the rate and omits the burst, or states it in words — exactly the
    //     document that most needs pinning. The lockstep is strict about the pair
    //     because it must judge a row; this only needs to notice the subject.
    //   - IT IS EVALUATED OVER THE WHOLE FILE, not per line. Requiring the route
    //     and the rate on ONE line misses a table styled like the steering doc's
    //     own, whose route column reads `POST /submit` while only the heading says
    //     `/feedback-forms`. That gap also made `.kiro/steering/structure.md`
    //     itself discoverable ONLY via its ballot prose sentence — so a reword of
    //     one line about a DIFFERENT feature would have turned the converse
    //     assertion below red for an unrelated reason.
    //
    // WHAT IS NO LONGER A DIFFERENCE is the VOCABULARY. This predicate once
    // carried its own, wider list of spellings, on the reasoning that a third
    // author reaches for "a different word for per second" — sound reasoning, but
    // it left the two disagreeing over a set of spellings, and review showed the
    // gap that opened: a PINNED document reworded to `100 requests/second, burst
    // 200` stayed discovered here (so the converse assertion was satisfied) while
    // no line of it was a candidate in the lockstep, which then failed with
    // "documents no rate limit for /config" about a document that states one. The
    // guard fired, so nothing drifted silently, but it accused the document
    // instead of the parse. Both now share `RATE_FIGURE`, so anything wide enough
    // to be DISCOVERED is wide enough to be JUDGED, and the biases live where they
    // belong: in the scope (file vs line) and in the burst anchoring.
    //
    // Sharing the UNIT alone was the first attempt and it over-corrected: it made
    // selection as wide as discovery, so prose naming a route and any `<word>/s`
    // throughput was judged as though it had stated a ceiling. `RATE_FIGURE` adds
    // the digits both sides actually need — see its comment for the two lines that
    // failed.
    //
    // Verified over the tree: whole-file scope with the shared figure flags exactly
    // the two pinned documents and nothing else, so the over-inclusion costs no
    // false positive today.
    const ROOT = join(__dirname, '..', '..', '..');
    /** THE SAME DECLARATION the lockstep case above reads, not a second copy of
     *  the same two paths. Two separately-maintained lists could disagree, and
     *  review demonstrated the half-fix they invited: appending a stale table to a
     *  third document and adding it HERE ONLY — the edit this case's own failure
     *  message most directly suggests, since this is the list literally named
     *  "pinned" — left the whole block green with that document publishing
     *  999/999. This case stopped complaining (the file is now pinned) and the
     *  lockstep never read it (its list was untouched). One declaration makes
     *  adding a document necessarily both pin it and exempt it. */
    const PINNED = Object.keys(PINNED_DOCS);
    const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.venv', 'cdk.out']);

    const markdownFiles = (dir: string, prefix = ''): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : markdownFiles(join(dir, entry.name), rel);
        return entry.name.endsWith('.md') ? [rel] : [];
      });

    const ROUTES = ['/feedback-forms', '/voting-sessions'];
    /** Any spelling of a per-second rate FIGURE — `RATE_FIGURE`, the SAME shared
     *  pattern the lockstep case selects and parses with, so the two cannot
     *  disagree about which spellings count. */
    const STATES_A_RATE = new RegExp(RATE_FIGURE);
    const stating = markdownFiles(ROOT).filter((rel) => {
      const text = readFileSync(join(ROOT, ...rel.split('/')), 'utf-8');
      return STATES_A_RATE.test(text) && ROUTES.some((route) => text.includes(route));
    });

    expect(
      stating.filter((rel) => !PINNED.includes(rel)).sort(byCodeUnit),
      'a markdown file states a public-route rate limit but is not read by the lockstep case above — '
      + 'add it to PINNED_DOCS (which both pins and exempts it, naming the routes it publishes), '
      + 'or remove the figures and point at api-gateway.ts',
    ).toStrictEqual([]);

    // And the converse: a pinned document that stops stating them would leave the
    // case above asserting nothing, so both must still be in the discovered set.
    expect(
      PINNED.filter((rel) => !stating.includes(rel)),
      'a document in PINNED_DOCS no longer states any public-route rate limit, so the lockstep case '
      + 'above is now asserting nothing for it — restore the figures or drop it from PINNED_DOCS',
    ).toStrictEqual([]);

    // THE THIRD DIRECTION, and the one neither assertion above covers: a route
    // that no document publishes at all.
    //
    // Both checks above are about DOCUMENTS — is this file pinned, does a pinned
    // file still state figures. Neither looks at ROUTES, so deleting a route from
    // every PINNED_DOCS array leaves both green while the lockstep silently stops
    // asserting anything about that route's ceiling: its loop simply iterates one
    // route fewer. `DOCUMENTED_ROUTE_KEYS` would still name it, and the throttle
    // pins above would still check the template, so the only thing lost is the
    // prose-versus-template lockstep — quietly, which is this whole block's
    // stated failure mode applied to itself.
    //
    // Every key in DOCUMENTED_ROUTE_KEYS must therefore appear in at least one
    // pinned document's route list. That is also the invariant that makes the
    // `satisfies` type meaningful in the other direction: the type stops a route
    // name that does not EXIST, this stops a route that exists and is UNREAD.
    // `Set<string>`, not the inferred union: the keys being compared come from
    // `Object.keys`, which is typed `string[]`.
    const documentedSomewhere = new Set<string>(Object.values(PINNED_DOCS).flat());
    expect(
      Object.keys(DOCUMENTED_ROUTE_KEYS).filter((names) => !documentedSomewhere.has(names)),
      'a route in DOCUMENTED_ROUTE_KEYS appears in no PINNED_DOCS array, so the lockstep case above '
      + 'iterates past it and nothing checks its published ceiling against the template — add it to '
      + 'the document that publishes it, or drop it from DOCUMENTED_ROUTE_KEYS',
    ).toStrictEqual([]);
  });

  // No "adds no public route" case here: that is `VocApiStack authorization
  // invariant`'s first test, which pins both the contents and the count of
  // INTENTIONALLY_PUBLIC_ROUTES once for the whole file.
});
