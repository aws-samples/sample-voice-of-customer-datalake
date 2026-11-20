---
name: typescript-engineer
description: "Sets the protocol for TypeScript code, tests and dependencies with pnpm, Biome, Vitest and Zod: strict tsconfig, discriminated unions, runtime validation at boundaries, build tools, error handling, monorepos. Read it when writing, refactoring or reviewing TypeScript."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/typescript-engineer"
license: MIT
adapted: "The spec-loader step reads the repository's STANDARDS.md with read_file. Registry-reaching package commands belong to the one install step; commands are run's argv. Lint and format run on the changed files only (never a whole-tree rewrite). Slash references name library skills (tdd, code-review, verification-before-completion); description reworded for Claude 5.5 skill discovery"
---

Apply staff engineer TypeScript development practices to your task.

## Step 0: Load Project Specs

If the repository has a STANDARDS.md, read it with `read_file` for its conventions; else the built-in defaults
below.

STANDARDS.md overrides: `typescript.version`, `typescript.package_manager`, `typescript.linter`, `typescript.type_checker`, `typescript.test_framework`, `typescript.schema_validator`, `size_limits.*`, `naming.typescript.*`. Cite STANDARDS.md in findings.

## Package Management (pnpm)

Use the package manager the repository's lockfile shows; prefer `pnpm` over npm where the repository has a choice:
- Install: `pnpm add <package>`
- Dev install: `pnpm add -D <package>`
- Sync: `pnpm install --frozen-lockfile`
- Run: `pnpm run <script>`
- Lock: `pnpm-lock.yaml` (kept in the change)

Every command that reaches the registry (`pnpm add`, `pnpm install`, `npm ci`) is the dependency step:
`install_dependencies`, once, before any other command; the sandbox has no network after it. Use npm if pnpm is
unavailable, and note it in your finish.

## Build Tools

| Project Type | Tool | Command |
|---|---|---|
| Library (npm package) | tsup | `tsup src/index.ts --format esm,cjs --dts` |
| Web application | Vite | `vite build` |
| Type checking only | tsc | `tsc --noEmit` |

## Type System Patterns

### tsconfig.json (strict mode required)
```json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022"
  }
}
```

### Patterns to Use
- **Discriminated unions** for state machines (not enums)
- **`as const`** for literal type narrowing
- **Branded types** for semantic safety (`UserId` vs `string`)
- **`satisfies`** to validate without widening types
- **`unknown`** + narrowing instead of `any`
- **`z.infer<typeof Schema>`** for types derived from Zod schemas

### Patterns to Avoid
- `any` without documented justification
- `as SomeType` on API responses (use Zod `safeParse`)
- Enums when union types work (`type Status = "active" | "inactive"`)
- `interface` for objects that won't be extended (use `type`)

## Runtime Validation (Zod)

Validate at system boundaries (API routes, form handlers, env vars):

```typescript
import { z } from "zod";

const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(["admin", "user"]),
});

type User = z.infer<typeof UserSchema>;

// API route
const result = UserSchema.safeParse(req.body);
if (!result.success) {
  return res.status(400).json(z.flattenError(result.error));
}
// result.data is typed User

// Environment variables (validate at startup)
const EnvSchema = z.object({
  API_URL: z.url(),
  PORT: z.coerce.number().default(3000),
});
const env = EnvSchema.parse(process.env);
```

## Testing Protocol

New behaviour and bug fixes go test-first: the `tdd` skill owns the red-green cycle and the undo-the-fix proof. This section covers the TypeScript-specific mechanics only.

### Before writing code:
1. Read existing tests to identify patterns
2. Check test framework (Vitest preferred)
3. Check for shared setup files

### After writing code:
1. Run tests: `pnpm vitest run` or `pnpm test`
2. Check coverage: `pnpm vitest run --coverage`
3. Fix any failures before you submit

### Test stack:
- **Unit/integration**: Vitest (Vite-native, faster than Jest)
- **Component testing**: React Testing Library (behavior-first, not implementation)
- **API mocking**: MSW (network-level interception, reusable across test types)
- **E2E**: Playwright (a browser run may not be possible in the sandbox: say so rather than skip it silently)

### Test quality:
- Every new function gets at least one happy-path test
- Error paths tested for functions handling external input
- Use `vi.mock()` for module mocks, MSW for HTTP mocks
- No `any` in test code (defeats type safety)
- Test behavior, not implementation (don't test internal state)
- Regression tests proven by undoing the fix and seeing red (the `tdd` skill, Step 5)
- Use @testing-library/user-event for DOM interactions (`await user.click(button)`) instead of fireEvent. Prefer user-centric queries: getByRole, getByLabelText over getByTestId.

## Code Quality Protocol

### Before editing:
1. Read the file completely
2. Understand existing patterns
3. Check for related code that might be affected

### During editing:
1. Follow existing code conventions
2. `unknown` + narrowing, never bare `any`
3. Zod validation at boundaries (not `as Type`)
4. No unhandled promises (always `await` or `.catch()`)
5. Consistent async style (don't mix `.then()` and `await` in same file)
6. Verify imports resolve (read the package's `exports` in `node_modules/<package>/package.json`)

### After editing:
1. Type check: `pnpm tsc --noEmit`
2. Lint + format the files you changed: `pnpm biome check --write <changed files>` (never the whole tree: a
   reformat of files the task does not need is noise in the patch)
3. Dead code: `pnpm knip --no-exit-code`
4. Run tests
5. Apply the `code-review` skill for full scope validation

## Error Handling

```typescript
// Discriminated union for typed errors
type AppError =
  | { type: "not_found"; resource: string }
  | { type: "validation"; errors: z.ZodError }
  | { type: "unauthorized"; reason: string };

// Use try-catch at boundaries, typed errors internally
function getUser(id: string): User | AppError {
  const user = db.find(id);
  if (!user) return { type: "not_found", resource: `user:${id}` };
  return user;
}
```

## Monorepo Patterns

### Turborepo (recommended for TypeScript projects)
```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "lint": {}
  }
}
```

Commands:
- `turbo build --filter=@myapp/web` - Build specific package + deps
- `turbo run test --affected` - Only changed packages

### Workspace structure:
```
packages/
  shared/        # Shared types, utils
  web/           # Next.js app
  api/           # API server
  config/        # Shared tsconfig, biome config
```

## Biome Configuration

```json
{
  "linter": {
    "enabled": true,
    "rules": {
      "complexity": { "recommended": true },
      "style": { "recommended": true },
      "suspicious": { "recommended": true },
      "performance": { "recommended": true }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  }
}
```

Use Biome by default for new projects (~35x faster than Prettier on formatting, single tool for lint+format). Keep ESLint if you depend on framework-specific plugins (eslint-plugin-react-hooks, @next/eslint-plugin-next) that lack Biome equivalents.

## Architecture Decisions

- Keep functions under 50 lines
- Keep files under 500 lines
- Extract shared logic only when used 3+ times
- Prefer composition over inheritance
- Use discriminated unions for state, not classes
- ESM by default (`"type": "module"` in package.json)
- `const` over `let` unless reassignment needed

Before you claim the work is done, apply the `verification-before-completion` skill.
