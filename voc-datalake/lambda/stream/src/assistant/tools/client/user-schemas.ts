/**
 * Argument schemas of the user-administration write tools (`settings` pack):
 * `create_user`, `update_user` and `set_user_access`.
 *
 * Bounds mirror what the routes validate, narrower where the two differ:
 *   - users: `lambda/api/users_handler.py` (`group` must be one of
 *     `ROLE_GROUPS`, i.e. `('admins', 'users')`; `given_name` / `family_name` are free strings
 *     there — capped at 100 here; a Cognito username is at most 128 chars);
 *   - category access: `lambda/shared/category_access.py`
 *     (`MAX_ACCESS_CATEGORIES`, `MAX_ACCESS_SOURCES`, the `'*'` wildcard that
 *     stands alone), `lambda/shared/category_config.py` (`MAX_NAME_CHARS`, a
 *     name has no whitespace or `#`) and `lambda/shared/source_profiles.py`
 *     (`SOURCE_ID_RE`).
 *
 * LOCKSTEP: the SPA boundary (`frontend/src/assistant/approvals/userSchemas.ts`)
 * holds the same limits, roles and patterns, and the same argument shapes;
 * `userSchemas.lockstep.test.ts` reads this file (and the Python sources) and
 * fails when they drift. Field names and their order ARE the contract.
 */
import { z } from 'zod';

/** users_handler.py: `if group not in ROLE_GROUPS` (`(ADMIN_GROUP, USER_GROUP)`). */
export const USER_ROLES = ['admins', 'users'] as const;

export const USER_LIMITS = {
  maxEmailLength: 254,
  maxNameLength: 100,
  maxUsernameLength: 128,
  maxCategories: 50,
  maxCategoryNameLength: 64,
  maxSources: 50,
  maxSourceIdLength: 48,
  maxUsersPerCard: 25,
} as const;

/** Cognito usernames here are UUIDs; email aliases are allowed too. */
export const USERNAME_PATTERN = /^[A-Za-z0-9@._+-]{1,128}$/;
/** source_profiles.SOURCE_ID_RE. */
export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** category_config._NAME_RE: no whitespace, no `#`. */
export const CATEGORY_NAME_PATTERN = /^[^\s#]{1,64}$/;
/** category_access.WILDCARD: `['*']` grants every category / every source. */
export const ACCESS_WILDCARD = '*';

const MIN_EMAIL_LENGTH = 3;

/** Why `value` is not an address the route would accept, else undefined. */
function emailProblem(value: string): string | undefined {
  if (/\s/.test(value)) return 'must not contain whitespace';
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) {
    return 'must have exactly one "@" with text on both sides';
  }
  return undefined;
}

const emailSchema = z.string().trim().min(MIN_EMAIL_LENGTH).max(USER_LIMITS.maxEmailLength).superRefine((value, ctx) => {
  const problem = emailProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: `email ${problem}` });
});

const nameSchema = z.string().trim().min(1).max(USER_LIMITS.maxNameLength);
const roleSchema = z.enum(USER_ROLES);
const usernameSchema = z.string().trim().regex(USERNAME_PATTERN, 'must be 1-128 letters, digits, "@", ".", "_", "+" or "-"');

/** `role` is required on purpose: an account's role is never defaulted. */
export const createUserArgsSchema = z.object({
  email: emailSchema,
  role: roleSchema,
  given_name: nameSchema.optional(),
  family_name: nameSchema.optional(),
}).strict();

/** `create_users`: up to 25 `create_user` rows, each email once (compared case-insensitively). */
export const createUsersArgsSchema = z.object({
  users: z.array(createUserArgsSchema).min(1).max(USER_LIMITS.maxUsersPerCard).refine(
    (users) => new Set(users.map((user) => user.email.toLowerCase())).size === users.length,
    'each email may appear only once',
  ),
}).strict();

export const updateUserArgsSchema = z.object({
  username: usernameSchema,
  updates: z.object({
    given_name: nameSchema.optional(),
    family_name: nameSchema.optional(),
    role: roleSchema.optional(),
    enabled: z.boolean().optional(),
  }).strict().refine((updates) => Object.keys(updates).length > 0, 'updates must change at least one field'),
}).strict();

interface GrantRule {
  noun: 'categories' | 'sources';
  pattern: RegExp;
  patternMessage: string;
}

/** The issue a grant list raises, else undefined: `['*']` alone, or distinct values matching the rule. */
function grantProblem(values: readonly string[], rule: GrantRule): string | undefined {
  if (values.includes(ACCESS_WILDCARD)) {
    return values.length === 1 ? undefined : `'${ACCESS_WILDCARD}' cannot be combined with other ${rule.noun}`;
  }
  if (new Set(values).size !== values.length) return `${rule.noun} must not repeat`;
  return values.every((value) => rule.pattern.test(value)) ? undefined : rule.patternMessage;
}

/** `['*']`, or at most `max` distinct trimmed values each matching the rule. */
function grantListSchema(rule: GrantRule, max: number) {
  return z.array(z.string().trim()).max(max).superRefine((values, ctx) => {
    const problem = grantProblem(values, rule);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  });
}

const CATEGORY_RULE: GrantRule = {
  noun: 'categories',
  pattern: CATEGORY_NAME_PATTERN,
  patternMessage: `each category must be 1-${USER_LIMITS.maxCategoryNameLength} characters with no spaces or "#"`,
};
const SOURCE_RULE: GrantRule = {
  noun: 'sources',
  pattern: SOURCE_ID_PATTERN,
  patternMessage: `each source id must be 1-${USER_LIMITS.maxSourceIdLength} lowercase letters, digits, "_" or "-"`,
};

/**
 * `categories`: `['*']` (every category) or 1-50 configured names. `sources`:
 * omitted = unchanged, null = the default rule (every source that is not
 * restricted), `['*']` = every source, a list = exactly those ids.
 */
export const setUserAccessArgsSchema = z.object({
  username: usernameSchema,
  categories: grantListSchema(CATEGORY_RULE, USER_LIMITS.maxCategories).min(1),
  sources: grantListSchema(SOURCE_RULE, USER_LIMITS.maxSources).nullable().optional(),
}).strict();
