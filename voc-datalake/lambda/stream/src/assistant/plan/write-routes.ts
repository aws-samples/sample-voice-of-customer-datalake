/**
 * The REST request a write becomes, and the route builders the per-pack tables
 * (`write-requests-*.ts`) use. A request is the synthetic-event shape the
 * internal invoker sends (`tools/internal-api.ts` `ApiCall`): the domain
 * function, method, concrete path, API Gateway resource and path parameters,
 * and the JSON body. Paths encode ids exactly as the SPA's API clients do
 * (raw for projects, scrapers, forms and sources; `encodeURIComponent` for
 * feedback, memory, agents and workflows) — ids are already plain identifiers.
 */
import type { ApiFunction } from '../tools/internal-api.js';
import type { Args } from './write-args.js';

export interface WriteRequest {
  fn: ApiFunction;
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  resource: string;
  pathParameters?: Record<string, string>;
  body?: unknown;
}

/**
 * What a write needs beyond its arguments — the parts the SPA takes from the
 * card it showed (time window, language, date basis) or the signed-in user.
 */
export interface WriteEnv {
  /** Feedback window of job writes (the SPA: the global time-range picker). */
  days: number;
  /** Output language of job writes (the SPA: the UI language); omitted = the route's default. */
  responseLanguage?: string;
  /** `review` adds `date_basis: 'review'` to the job bodies that take it (the SPA: projectsApi). */
  dateBasis?: 'review';
  /** Author of a persona note (the SPA: the signed-in username). */
  author?: string;
  /** `edit_id` of a document update (the SPA: a random UUID; a plan: a stable id per step). */
  editId: string;
  /** The current stored state a merge write needs (`write-preconditions.ts`). */
  current?: Readonly<Record<string, unknown>>;
}

export type RequestBuilder = (args: Args, env: WriteEnv) => WriteRequest;

/** A route under a `{proxy+}` resource: `/<root>/<rest>`. */
export function proxied(fn: ApiFunction, method: WriteRequest['method'], root: string, rest: string, body?: unknown): WriteRequest {
  return { fn, method, path: `/${root}/${rest}`, resource: `/${root}/{proxy+}`, pathParameters: { proxy: rest }, ...withBody(body) };
}

/** A route that is its own resource (`POST /projects`, `POST /scrapers`, …). */
export function exact(fn: ApiFunction, method: WriteRequest['method'], path: string, body?: unknown): WriteRequest {
  return { fn, method, path, resource: path, ...withBody(body) };
}

function withBody(body: unknown): { body?: unknown } {
  return body === undefined ? {} : { body };
}

/** The `{ date_basis }` part of the job bodies projectsApi adds it to. */
export function dateBasisOf(env: WriteEnv): Record<string, unknown> {
  return env.dateBasis === 'review' ? { date_basis: 'review' } : {};
}

/** The `response_language` part of a job body. */
export function languageOf(env: WriteEnv): Record<string, unknown> {
  return env.responseLanguage === undefined ? {} : { response_language: env.responseLanguage };
}

export const enc = (id: string) => encodeURIComponent(id);
