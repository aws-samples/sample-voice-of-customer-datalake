/**
 * @fileoverview Every API Gateway method reaches a route its Lambda actually answers.
 *
 * Found in 5.25.01: `GET /feedback/problems/resolved`, `PUT|DELETE /feedback/problems/{problemId}/resolve`
 * (resolution moved to /settings/resolved-problems long ago) and `POST /radar` were wired to Lambdas that
 * register no such route, so each answered a 404 from inside the function: dead surface that still billed
 * an invocation, carried an authorizer and showed up in the API's route list.
 *
 * For every method whose Lambda is a Python Powertools handler (`<module>.lambda_handler`), the handler's
 * `@app.<verb>('<path>')` registrations must match the method's path (`{param}` matches `<param>`; an
 * `ANY …/{proxy+}` needs at least one route under its prefix). Integrations that are not Powertools routers
 * are listed in `NOT_ROUTER_HANDLERS` with the reason, so a new one is a deliberate edit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiTemplate, nonOptions } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

const LAMBDA_DIR = join(__dirname, '..', '..', 'lambda');
const PROXY = '/{proxy+}';

/** Handler -> why it is not checked against `@app.<verb>` registrations. */
const NOT_ROUTER_HANDLERS: Record<string, string> = {
  'index.handler': 'the TypeScript assistant stream (lambda/stream): one route, POST /chat/stream',
  'mcp_global_handler.lambda_handler': 'a JSON-RPC endpoint: answers POST, and 405 to GET/DELETE as MCP requires',
  'handler.lambda_handler': 'a plugin webhook receiver (plugins/<id>/webhook): one route per plugin',
};

/** Directories under lambda/ that hold no API handler. */
const SKIPPED_DIRS = new Set(['test', '__pycache__', 'layers', 'node_modules', 'stream']);

const FunctionSchema = z.object({ Properties: z.object({ Handler: z.string().optional() }) });

/** Every `*.py` under `dir`, recursively: the `*_handler.py` entry points and the Powertools `Router`
 *  modules they include. */
function pythonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : pythonFiles(path);
    return name.endsWith('.py') ? [path] : [];
  });
}

interface Route { verb: string; segments: string[] }

/** A path split into segments; `<param>` and `{param}` both become `*` (any one segment). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean)
    .map((part) => ((part.startsWith('<') && part.endsWith('>')) || (part.startsWith('{') && part.endsWith('}')) ? '*' : part));
}

/** A route registration: `@app.<verb>('<path>')` (the resolver, or a `Router` bound to `app` in a router
 *  module) or `@router.<verb>(…)`. A path may be empty: `@router.get("")` under `include_router(…,
 *  prefix="/x")` serves `/x` itself. */
const DECORATOR = /@(?:app|router)\.(get|post|put|delete|patch)\(\s*["']([^"']*)["']/g;
/** `app.include_router(<module>.app|.router` or `app.include_router(<alias>`, with an optional `prefix=`. */
const INCLUDE_ROUTER = /app\.include_router\(\s*([A-Za-z_][\w.]*)\s*(?:,\s*prefix\s*=\s*["']([^"']*)["'])?/g;
/** The attribute a router module binds its `Router()` to (`app = Router()` here; `router` elsewhere). */
const ROUTER_ATTRIBUTE = /\.(?:app|router)$/;

/** The one `<moduleName>.py` among `files`. */
function moduleSource(files: readonly string[], moduleName: string): string {
  const matching = files.filter((file) => file.endsWith(`/${moduleName}.py`));
  expect(matching, `exactly one ${moduleName}.py under lambda/`).toHaveLength(1);
  return readFileSync(matching[0] ?? '', 'utf-8');
}

function routesMatching(source: string, prefix = ''): Route[] {
  return [...source.matchAll(DECORATOR)]
    .map((match) => ({ verb: (match[1] ?? '').toUpperCase(), segments: segmentsOf(`${prefix}${match[2] ?? ''}`) }));
}

/** The module an `include_router` argument names: `participants_routes.app` (the shape engagement_handler.py
 *  uses, after `from shared import participants_routes`), `participants_routes.router`, or an alias bound by
 *  `from <pkg.>participants_routes import app|router as <alias>`. */
function includedModule(source: string, argument: string): string {
  if (ROUTER_ATTRIBUTE.test(argument)) return argument.replace(ROUTER_ATTRIBUTE, '').split('.').pop() ?? '';
  const alias = new RegExp(`from\\s+([\\w.]+)\\s+import\\s+(?:app|router)\\s+as\\s+${argument}\\b`).exec(source);
  return (alias?.[1] ?? '').split('.').pop() ?? '';
}

/** `@app.<verb>('<path>')` registrations of `<moduleName>.py` among `files` (exactly one such file), plus the
 *  registrations of every Powertools `Router` module it includes (`app.include_router`). */
function registeredRoutes(files: readonly string[], moduleName: string): Route[] {
  const source = moduleSource(files, moduleName);
  const included = [...source.matchAll(INCLUDE_ROUTER)].flatMap((match) => routesMatching(
    moduleSource(files, includedModule(source, match[1] ?? '')), match[2] ?? ''));
  return [...routesMatching(source), ...included];
}

const sameSegment = (a: string, b: string) => a === '*' || b === '*' || a === b;

/** Does a registered route answer `verb apiPath`? */
function answers(routes: readonly Route[], verb: string, apiPath: string): boolean {
  const proxy = apiPath.endsWith(PROXY);
  const wanted = segmentsOf(proxy ? apiPath.slice(0, -PROXY.length) : apiPath);
  return routes.some((route) => {
    if (verb !== 'ANY' && route.verb !== verb) return false;
    const lengthOk = proxy ? route.segments.length > wanted.length : route.segments.length === wanted.length;
    return lengthOk && wanted.every((segment, i) => sameSegment(segment, route.segments[i] ?? ''));
  });
}

interface RouterMethod { route: string; httpMethod: string; path: string; moduleName: string }

describe('every API method reaches a route its Lambda answers', () => {
  let methods: RouterMethod[] = [];
  beforeAll(() => {
    const template = apiTemplate();
    const functions = template.findResources('AWS::Lambda::Function');
    methods = nonOptions(template).flatMap((method) => {
      if (method.integrationFunctionId === undefined) return [];
      const handler = FunctionSchema.parse(functions[method.integrationFunctionId]).Properties.Handler;
      if (handler === undefined || handler in NOT_ROUTER_HANDLERS) return [];
      const moduleName = (handler.split('.')[0] ?? '').split('/').pop() ?? '';
      return [{ route: method.route, httpMethod: method.httpMethod, path: method.path, moduleName }];
    });
  }, SYNTH_TIMEOUT_MS);

  it('has no dead method (a Powertools handler without a matching @app route)', () => {
    const files = pythonFiles(LAMBDA_DIR);
    const routesOf = new Map<string, Route[]>();
    const dead = methods.filter((method) => {
      const routes = routesOf.get(method.moduleName) ?? registeredRoutes(files, method.moduleName);
      routesOf.set(method.moduleName, routes);
      return !answers(routes, method.httpMethod, method.path);
    }).map((method) => `${method.route} (${method.moduleName})`);
    // The CDK app targets ES2022 (no toSorted): sort a copy.
    expect([...dead].sort(byCodeUnit)).toStrictEqual([]);
  });

  it('checks the routers it claims to (the exemptions are not hiding everything)', () => {
    const modules = new Set(methods.map((method) => method.moduleName));
    expect(modules.size).toBeGreaterThan(10);
    expect(['metrics_handler', 'projects_handler', 'radar_handler'].every((name) => modules.has(name))).toBe(true);
  });

  it.each([
    ['from shared import participants_routes', 'participants_routes.app', 'participants_routes'],
    ['from shared import feature_requests_routes', 'shared.feature_requests_routes.app', 'feature_requests_routes'],
    ['from shared.participants_routes import app as participants_app', 'participants_app', 'participants_routes'],
    ['from participants_routes import router as participants_router', 'participants_router', 'participants_routes'],
    ['import participants_routes', 'participants_routes.router', 'participants_routes'],
  ])('resolves the router module of `%s` + include_router(%s) to %s', (source, argument, expected) => {
    expect(includedModule(source, argument)).toBe(expected);
  });

  it('applies an include_router prefix to the router routes', () => {
    expect(routesMatching('@router.get("/lists")', '/participants'))
      .toStrictEqual([{ verb: 'GET', segments: ['participants', 'lists'] }]);
  });

  it('reads the routes of the engagement router modules (`app = Router()`, `@app.<verb>`)', () => {
    const routes = registeredRoutes(pythonFiles(LAMBDA_DIR), 'engagement_handler');
    expect(answers(routes, 'GET', '/participants/lists/{list_id}')).toBe(true);
    expect(answers(routes, 'POST', '/participants/asks')).toBe(true);
    expect(answers(routes, 'PUT', '/feature-requests/{request_id}/status')).toBe(true);
    expect(answers(routes, 'POST', '/unsubscribe')).toBe(true);
  });

  it('reads the company persona routers the projects handler includes', () => {
    const routes = registeredRoutes(pythonFiles(LAMBDA_DIR), 'projects_handler');
    expect(answers(routes, 'GET', '/company-personas')).toBe(true);
    expect(answers(routes, 'ANY', '/company-personas/{proxy+}')).toBe(true);
    expect(answers(routes, 'POST', '/projects/{project_id}/personas/copy')).toBe(true);
  });

  it.each([
    ['GET', '/feedback/problems', 'GET', '/feedback/problems', true],
    ['GET', '/feedback/problems/resolved', 'GET', '/feedback/problems', false],
    ['PUT', '/feedback/{feedback_id}/category', 'PUT', '/feedback/<feedback_id>/category', true],
    ['POST', '/radar', 'GET', '/radar', false],
    ['ANY', '/radar/{proxy+}', 'GET', '/radar', false],
    ['ANY', '/radar/{proxy+}', 'POST', '/radar/scan', true],
    ['ANY', '/integrations/{source}/{proxy+}', 'PUT', '/integrations/<source>/credentials', true],
  ])('%s %s, given the route %s %s, answers: %s', (verb, apiPath, routeVerb, routePath, expected) => {
    expect(answers([{ verb: routeVerb, segments: segmentsOf(routePath) }], verb, apiPath)).toBe(expected);
  });
});
