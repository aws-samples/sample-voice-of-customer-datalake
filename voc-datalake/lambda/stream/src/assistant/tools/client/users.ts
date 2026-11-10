/**
 * User-administration write tools of the `settings` pack (admin-only): create
 * a Cognito user, change a user's name / role / enabled state, and set which
 * categories (and sources) a user may see. The model proposes; the SPA shows a
 * deterministic approval card and, on approval, executes through the existing
 * admin-only REST routes (`/users/*`) with the user's own token.
 *
 * Every tool reads GET /users (as the caller) before the card is raised: a
 * create whose email exists, an update or grant of a username nobody has, a
 * change of the caller's own role or enabled state, and a grant to an
 * administrator (who sees everything anyway) are refused here. A grant's
 * categories and sources must be configured names (`GET /settings/categories`,
 * `GET /settings/sources`). The SPA re-checks right before it executes.
 *
 * Not tools, on purpose: deleting a user, password resets and the user flags
 * (fallback owner, memory reviewer) — the assistant points to Settings → Users.
 */
import { z } from 'zod';
import type { AssistantRunContext, ClientToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import type { JsonSchemaProperties } from '../spec.js';
import { getSettingsRoute } from '../server/common.js';
import { recordsAt } from '../server/feedback-shape.js';
import { readUsers } from '../server/users.js';
import { defineClientTool, stringProperty } from './define.js';
import {
  ACCESS_WILDCARD,
  USER_LIMITS,
  USER_ROLES,
  createUserArgsSchema,
  createUsersArgsSchema,
  setUserAccessArgsSchema,
  updateUserArgsSchema,
} from './user-schemas.js';

const ADMIN_GROUP = 'admins';
const SELF_GUARD = 'you cannot change your own role or enabled state. Another administrator must do that.';

// ── Model-facing properties ──

const nameProperty = (which: string) => stringProperty(`${which} (1-${USER_LIMITS.maxNameLength} characters).`, USER_LIMITS.maxNameLength);
const NAME_PROPERTIES: JsonSchemaProperties = { given_name: nameProperty('First name'), family_name: nameProperty('Last name') };
const roleProperty: JsonSchemaProperties[string] = {
  type: 'string',
  enum: [...USER_ROLES],
  description: 'admins = full access, including settings and user administration; users = feedback within their category access.',
};
const usernameProperty = stringProperty('Cognito username as list_users returns it — never guessed.', USER_LIMITS.maxUsernameLength);
const grantItems = (maxLength: number) => ({ type: 'string', maxLength });

// ── Reads as the caller ──

/** What the prechecks compare of a listed user; `sub` only identifies the caller and never reaches the model. */
const listedUserSchema = z.object({
  username: z.string().min(1),
  sub: z.string().catch(''),
  email: z.string().catch(''),
  groups: z.array(z.string()).catch([]),
});
type ListedUser = z.infer<typeof listedUserSchema>;

async function listUsers(deps: ToolDeps, ctx: AssistantRunContext): Promise<ListedUser[]> {
  return (await readUsers(deps, ctx)).flatMap((row) => {
    const parsed = listedUserSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

const unknownUser = (username: string) => `no user has username "${username}". Read list_users first.`;
const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isWildcard = (values: readonly string[]) => values.length === 1 && values[0] === ACCESS_WILDCARD;

/** The caller, by the username claim — or by subject, for a token that carries no username. */
function isCaller(user: ListedUser, ctx: AssistantRunContext): boolean {
  return user.username === ctx.claims['cognito:username'] || (user.sub !== '' && user.sub === ctx.claims.sub);
}

interface GrantConfig {
  /** The settings route holding the configured entries, and the key naming each. */
  route: 'categories' | 'sources';
  key: 'name' | 'id';
  what: string;
  /** With nothing configured the route grants its built-in defaults, so any name passes here. */
  anyWhenNoneConfigured: boolean;
  /** Names the API accepts without being configured (mirrors `shared/category_access.validate_access_categories`). */
  alwaysGrantable: readonly string[];
}

// `other` = reviews without a category (the fallback): always grantable, so a restricted user can see the Other row.
const CATEGORY_GRANTS: GrantConfig = { route: 'categories', key: 'name', what: 'categories', anyWhenNoneConfigured: true, alwaysGrantable: ['other'] };
const SOURCE_GRANTS: GrantConfig = { route: 'sources', key: 'id', what: 'source ids', anyWhenNoneConfigured: false, alwaysGrantable: [] };

async function configuredNames(deps: ToolDeps, ctx: AssistantRunContext, config: GrantConfig): Promise<string[]> {
  const body = await getSettingsRoute(deps, ctx, config.route);
  return recordsAt(body, config.route).flatMap((entry) => {
    const value = entry[config.key];
    return typeof value === 'string' ? [value] : [];
  });
}

/** The refusal for granted `values` that are not configured, else undefined (`['*']` always passes). */
async function unknownGrants(deps: ToolDeps, ctx: AssistantRunContext, values: readonly string[], config: GrantConfig): Promise<string | undefined> {
  if (isWildcard(values)) return undefined;
  const known = await configuredNames(deps, ctx, config);
  if (known.length === 0 && config.anyWhenNoneConfigured) return undefined;
  const knownSet = new Set([...known, ...config.alwaysGrantable]);
  const unknown = values.filter((value) => !knownSet.has(value));
  if (unknown.length === 0) return undefined;
  const listed = known.length === 0 ? `No ${config.what} are configured.` : `The configured ${config.what} are: ${known.join(', ')}.`;
  return `unknown ${config.route}: ${unknown.join(', ')}. ${listed}`;
}

/** Omitted = unchanged and null = the default rule: nothing to look up. */
async function unknownSources(deps: ToolDeps, ctx: AssistantRunContext, sources: readonly string[] | null | undefined): Promise<string | undefined> {
  if (sources === undefined || sources === null) return undefined;
  return unknownGrants(deps, ctx, sources, SOURCE_GRANTS);
}

// ── Summaries ──

function countOf(values: readonly string[], singular: string, plural: string): string {
  if (isWildcard(values)) return `all ${plural}`;
  return `${values.length} ${values.length === 1 ? singular : plural}`;
}

function sourcesPart(sources: readonly string[] | null | undefined): string {
  if (sources === undefined) return '';
  return `, ${sources === null ? 'default sources' : countOf(sources, 'source', 'sources')}`;
}

// ── Tools ──

/** The refusal for the first email that is already registered, else undefined. */
async function registeredEmail(deps: ToolDeps, ctx: AssistantRunContext, emails: readonly string[]): Promise<string | undefined> {
  const users = await listUsers(deps, ctx);
  for (const email of emails) {
    const existing = users.find((user) => sameEmail(user.email, email));
    if (existing !== undefined) {
      return `a user with email "${email}" already exists (username ${existing.username}). To change them, propose update_user.`;
    }
  }
  return undefined;
}

const CREATE_USER_PROPERTIES: JsonSchemaProperties = {
  email: stringProperty('Email address; Cognito sends the temporary password there.', USER_LIMITS.maxEmailLength),
  role: roleProperty,
  ...NAME_PROPERTIES,
};
const CREATE_USER_REQUIRED = ['email', 'role'];

function createUser(deps: ToolDeps): ClientToolDefinition {
  return defineClientTool({
    name: 'create_user',
    pack: 'settings',
    description: 'Create a NEW user account (admin). Cognito emails them a temporary password; nothing else is created. '
      + 'Call list_users first — a create is refused when the email already exists. `role` is required (admins or users). '
      + 'To give a users-role account access to categories, propose set_user_access afterwards with the username the '
      + 'result returns. For several people at once use create_users.',
    properties: CREATE_USER_PROPERTIES,
    required: CREATE_USER_REQUIRED,
    schema: createUserArgsSchema,
    precheck: (args, ctx) => registeredEmail(deps, ctx, [args.email]),
    summarize: (args) => `Create user ${args.email} (${args.role}).`,
  });
}

function createUsers(deps: ToolDeps): ClientToolDefinition {
  return defineClientTool({
    name: 'create_users',
    pack: 'settings',
    description: `Create up to ${USER_LIMITS.maxUsersPerCard} NEW user accounts in ONE approval (admin), e.g. from a list `
      + 'the user pasted or attached. Same rules per person as create_user: list_users first, every email new and listed '
      + 'once, `role` required per person. They are created in order; the first failure stops the rest and the result '
      + 'says who was created.',
    properties: {
      users: {
        type: 'array',
        minItems: 1,
        maxItems: USER_LIMITS.maxUsersPerCard,
        items: { type: 'object', properties: CREATE_USER_PROPERTIES, required: CREATE_USER_REQUIRED, additionalProperties: false },
        description: 'The people to create, in order.',
      },
    },
    required: ['users'],
    schema: createUsersArgsSchema,
    precheck: (args, ctx) => registeredEmail(deps, ctx, args.users.map((user) => user.email)),
    summarize: (args) => `Create ${args.users.length} user${args.users.length === 1 ? '' : 's'}.`,
  });
}

function updateUser(deps: ToolDeps): ClientToolDefinition {
  return defineClientTool({
    name: 'update_user',
    pack: 'settings',
    description: 'Change the name, role or enabled state of an EXISTING user (admin). `updates` holds only the fields '
      + 'to change; the user sees a before → after diff. Read list_users first. You cannot change your own role or '
      + 'enabled state.',
    properties: {
      username: usernameProperty,
      updates: {
        type: 'object',
        description: 'Fields to change (at least one).',
        properties: { ...NAME_PROPERTIES, role: roleProperty, enabled: { type: 'boolean', description: 'false blocks sign-in; true allows it again.' } },
        additionalProperties: false,
      },
    },
    required: ['username', 'updates'],
    schema: updateUserArgsSchema,
    precheck: async (args, ctx) => {
      const user = (await listUsers(deps, ctx)).find((listed) => listed.username === args.username);
      if (user === undefined) return unknownUser(args.username);
      const touchesAccount = args.updates.role !== undefined || args.updates.enabled !== undefined;
      return touchesAccount && isCaller(user, ctx) ? SELF_GUARD : undefined;
    },
    summarize: (args) => `Update user ${args.username}: ${Object.keys(args.updates).join(', ')}.`,
  });
}

function setUserAccess(deps: ToolDeps): ClientToolDefinition {
  return defineClientTool({
    name: 'set_user_access',
    pack: 'settings',
    description: 'Set which categories (and optionally which sources) an EXISTING users-role account may see (admin). '
      + 'categories: exactly ["*"] for every category, else configured names (get_categories_config). sources: omit to '
      + 'leave unchanged, null for the default rule (every source that is not restricted), ["*"] for every source, else '
      + 'configured source profile ids. Administrators always see everything, so this never applies to them. Read '
      + 'list_users (and get_user_access) first.',
    properties: {
      username: usernameProperty,
      categories: {
        type: 'array',
        items: grantItems(USER_LIMITS.maxCategoryNameLength),
        minItems: 1,
        maxItems: USER_LIMITS.maxCategories,
        description: 'Exactly ["*"], or configured category names.',
      },
      sources: {
        // `anyOf`, not `type: ['array', 'null']`: the Anthropic API refuses array-form types in a tool input schema.
        anyOf: [{ type: 'array', items: grantItems(USER_LIMITS.maxSourceIdLength), maxItems: USER_LIMITS.maxSources }, { type: 'null' }],
        description: 'Omit = unchanged; null = default rule; ["*"] = every source; a list = exactly those source ids.',
      },
    },
    required: ['username', 'categories'],
    schema: setUserAccessArgsSchema,
    precheck: async (args, ctx) => {
      const user = (await listUsers(deps, ctx)).find((listed) => listed.username === args.username);
      if (user === undefined) return unknownUser(args.username);
      if (user.groups.includes(ADMIN_GROUP)) {
        return `${user.email || user.username} is an administrator; administrators always see every category, so access rules do not apply to them.`;
      }
      return (await unknownGrants(deps, ctx, args.categories, CATEGORY_GRANTS)) ?? unknownSources(deps, ctx, args.sources);
    },
    summarize: (args) => `Set access for user ${args.username}: ${countOf(args.categories, 'category', 'categories')}${sourcesPart(args.sources)}.`,
  });
}

export function createUserClientTools(deps: ToolDeps): ClientToolDefinition[] {
  return [createUser(deps), createUsers(deps), updateUser(deps), setUserAccess(deps)];
}
