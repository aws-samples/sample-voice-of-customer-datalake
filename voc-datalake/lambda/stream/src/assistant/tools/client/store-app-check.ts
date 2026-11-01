/**
 * `create_app_connector` checks the store before its approval card (#38): an App Store id or Google Play
 * package that the store does not have is refused with a reason the model can act on (find the id with
 * find_app_store_app, or ask the user) instead of saving a connector whose every run fails; a found app puts
 * its store name and developer on the card, so the user can see it is the right company's app.
 *
 * A store that cannot be read (timeout, 5xx, blocked) refuses nothing: the card says it could not be checked.
 * One lookup per tool call: the precheck and the card text share it (memoised per run context).
 */
import { IOS_STOREFRONTS, type StoreAppLookup } from '../../../tools/store-app-lookup.js';
import type { AssistantRunContext } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { q } from './define.js';

type Platform = 'ios' | 'android';

interface StoreArgs {
  source: string;
  app_id?: string;
  package_name?: string;
}

const STORE_NAME: Record<Platform, string> = { ios: 'App Store', android: 'Google Play' };

/** The store and id a connector reads, or undefined for a web-reviews page. */
export function storeIdentity(args: StoreArgs): { platform: Platform; id: string } | undefined {
  if (args.source === 'app_reviews_ios' && args.app_id !== undefined) return { platform: 'ios', id: args.app_id };
  if (args.source === 'app_reviews_android' && args.package_name !== undefined) return { platform: 'android', id: args.package_name };
  return undefined;
}

const lookups = new WeakMap<AssistantRunContext, Map<string, Promise<StoreAppLookup>>>();

function lookup(deps: ToolDeps, ctx: AssistantRunContext, platform: Platform, id: string): Promise<StoreAppLookup> {
  const perRun = lookups.get(ctx) ?? new Map<string, Promise<StoreAppLookup>>();
  lookups.set(ctx, perRun);
  const key = `${platform}:${id}`;
  const cached = perRun.get(key);
  if (cached !== undefined) return cached;
  const pending = deps.lookupStoreApp(platform, id);
  perRun.set(key, pending);
  return pending;
}

function missingMessage(platform: Platform, id: string): string {
  return platform === 'ios'
    ? `No App Store app has id ${id} (looked up in the ${IOS_STOREFRONTS.length} storefronts the iOS connector reads). `
      + 'Do not guess an id: find it with find_app_store_app, or ask the user.'
    : `Google Play has no app ${id} (its store page answers 404). Do not guess a package name: find it with `
      + 'find_app_store_app (Google Play links from web search), or ask the user.';
}

export type StoreLookupFn = (platform: Platform, id: string) => Promise<StoreAppLookup>;

/**
 * The refusal when the store answered that it has no such app; undefined otherwise (also when it could not be
 * read). Shared by the chat precheck and the plan-step write (`plan-step/write-step.ts`).
 */
export async function missingStoreAppRefusal(args: StoreArgs, lookupFn: StoreLookupFn): Promise<string | undefined> {
  const identity = storeIdentity(args);
  if (identity === undefined) return undefined;
  const result = await lookupFn(identity.platform, identity.id);
  if (result.status === 'unknown') console.warn(`create_app_connector: ${identity.platform} store not checked (${result.reason})`);
  return result.status === 'missing' ? missingMessage(identity.platform, identity.id) : undefined;
}

/** The chat precheck: `missingStoreAppRefusal` with this run's memoised lookup. */
export function storeAppRefusal(deps: ToolDeps, ctx: AssistantRunContext, args: StoreArgs): Promise<string | undefined> {
  return missingStoreAppRefusal(args, (platform, id) => lookup(deps, ctx, platform, id));
}

/** The card's extra sentence: the store's own name and developer of the app, or why it could not be checked. */
export async function storeAppNote(deps: ToolDeps, ctx: AssistantRunContext, args: StoreArgs): Promise<string> {
  const identity = storeIdentity(args);
  if (identity === undefined) return '';
  const store = STORE_NAME[identity.platform];
  const result = await lookup(deps, ctx, identity.platform, identity.id);
  if (result.status === 'unknown') return ` ${store} could not be checked (${result.reason}).`;
  if (result.status !== 'found' || result.app.name === '') return '';
  const developer = result.app.developer === '' ? '' : ` by ${q(result.app.developer)}`;
  return ` ${store}: ${q(result.app.name)}${developer}.`;
}
