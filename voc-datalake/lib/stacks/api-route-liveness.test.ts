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

/** Every `*_handler.py` under `dir`, recursively. */
function handlerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : handlerFiles(path);
    return name.endsWith('_handler.py') ? [path] : [];
  });
}

interface Route { verb: string; segments: string[] }

/** A path split into segments; `<param>` and `{param}` both become `*` (any one segment). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean)
    .map((part) => ((part.startsWith('<') && part.endsWith('>')) || (part.startsWith('{') && part.endsWith('}')) ? '*' : part));
}

const DECORATOR = /@app\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g;

/** `@app.<verb>('<path>')` registrations of `<moduleName>.py` among `files` (exactly one such file). */
function registeredRoutes(files: readonly string[], moduleName: string): Route[] {
  const matching = files.filter((file) => file.endsWith(`/${moduleName}.py`));
  expect(matching, `exactly one ${moduleName}.py under lambda/`).toHaveLength(1);
  const source = readFileSync(matching[0] ?? '', 'utf-8');
  return [...source.matchAll(DECORATOR)]
    .map((match) => ({ verb: (match[1] ?? '').toUpperCase(), segments: segmentsOf(match[2] ?? '') }));
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
    const files = handlerFiles(LAMBDA_DIR);
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
