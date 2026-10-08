/**
 * Helpers shared by the server-tool packs.
 */
import type { Tool } from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import { z } from 'zod';
import { ALL_TIME_DAYS, type ServerToolName, type ToolPack } from '../../contract.js';
import type { AssistantRunContext, ServerToolDefinition, ServerToolResult } from '../../types.js';
import type { ToolDeps } from '../deps.js';

/** Default analysis window when neither the model nor the page picker says otherwise. */
const DEFAULT_WINDOW_DAYS = 30;
/**
 * Widest window the backend answers (`MAX_FEEDBACK_WINDOW_DAYS` in
 * lambda/shared/api.py): feedback is never deleted, so any window up to this is
 * served. Pinned against the SPA and the Python constant by
 * `frontend/src/api/daysWindow.lockstep.test.ts`.
 */
export const MAX_WINDOW_DAYS = 9999;

/** The `days` argument every windowed tool accepts: ALL_TIME_DAYS (0) to MAX_WINDOW_DAYS. */
export const windowDaysSchema = z.number().int().min(ALL_TIME_DAYS).max(MAX_WINDOW_DAYS);

/** JSON-schema fragment for a model-facing `days` argument. */
export function windowDaysProperty(description: string): DocumentType {
  return {
    type: 'integer',
    minimum: ALL_TIME_DAYS,
    maximum: MAX_WINDOW_DAYS,
    description: `${description} 0 = all time.`,
  };
}

export function serverTool(
  name: ServerToolName,
  pack: ToolPack,
  spec: Tool,
  execute: (input: unknown, ctx: AssistantRunContext) => Promise<ServerToolResult>,
): ServerToolDefinition {
  return { kind: 'server', name, pack, spec, execute };
}

/** The analysis window: explicit days, else the page's time-range picker, else the default. */
export function windowQuery(ctx: AssistantRunContext, days?: number): { days: number; date_basis?: string } {
  const requested = Math.trunc(days ?? ctx.props.days ?? DEFAULT_WINDOW_DAYS);
  const effective = Math.min(Math.max(requested, ALL_TIME_DAYS), MAX_WINDOW_DAYS);
  return ctx.props.dateBasis ? { days: effective, date_basis: ctx.props.dateBasis } : { days: effective };
}

/** Path segment for an already-validated id. */
export function seg(id: string): string {
  return encodeURIComponent(id);
}

/**
 * A GET on a settings route as the caller: `/settings/<route>` through the
 * `{proxy+}` resource. `route` is a literal chosen by the tool, never model input.
 */
export function getSettingsRoute(deps: Pick<ToolDeps, 'invoke'>, ctx: AssistantRunContext, route: string): Promise<unknown> {
  return deps.invoke({
    fn: 'settings',
    method: 'GET',
    path: `/settings/${route}`,
    resource: '/settings/{proxy+}',
    pathParameters: { proxy: route },
  }, ctx.claims);
}

/**
 * A GET on the Projects API under one project, as the caller: `/projects/{id}`
 * itself when `subpath` is omitted, `/projects/{id}/<subpath>` otherwise.
 * `subpath` is a route literal chosen by the tool (never model input), so it
 * is spliced into both the path and the API Gateway resource template as is.
 */
export function getProjectRoute(
  deps: Pick<ToolDeps, 'invoke'>,
  ctx: AssistantRunContext,
  projectId: string,
  subpath?: string,
): Promise<unknown> {
  const suffix = subpath === undefined ? '' : `/${subpath}`;
  return deps.invoke({
    fn: 'projects',
    method: 'GET',
    path: `/projects/${seg(projectId)}${suffix}`,
    resource: `/projects/{project_id}${suffix}`,
    pathParameters: { project_id: projectId },
  }, ctx.claims);
}
