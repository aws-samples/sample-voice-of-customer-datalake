# Language-Specific Review Checklists

Detailed per-language checks. Referenced from SKILL.md.

## TypeScript / JavaScript

- No `any` without explanation: use `unknown` + narrowing
- Async errors handled: no `.then()` without `.catch()`, no unhandled promises
- `async` functions always `await` something
- Consistent async style per file
- No `as SomeType` on API responses without runtime validation (use Zod)
- Prefer `const` over `let` unless reassignment needed
- Discriminated unions over type assertions

## React / Next.js

- Error boundaries around throwing component trees
- `key` props are stable identifiers (not array index for dynamic lists)
- `memo()` only when re-render cost is measurable
- `useEffect` cleanup for subscriptions, timers, listeners
- `useCallback`/`useMemo` deps arrays complete and correct
- No state updates in render body
- Server vs client component boundaries intentional (`"use client"`)
- No `dangerouslySetInnerHTML` with user content (sanitize with DOMPurify)
- Images use `next/image` or have width/height and alt text
- Forms have accessible labels, error states, loading states

## Python

- Type hints on all public function signatures
- No bare `except:`. Specific exceptions only
- No `except Exception: pass` without logging
- No mutable default arguments
- Context managers for resources
- `logging` module, not `print()` in production
- f-strings preferred (Python 3.6+)
- `pathlib.Path` preferred over `os.path`
- Pydantic models for API validation
- No `import *`
- No hallucinated imports (verify module exports)
- No cross-language idioms (.length, .forEach, .toString)
- No `urllib.request.urlopen()` with dynamic URLs (use `requests`, urllib supports `file://` scheme, bandit B310)
- No `csv.writer()` with user-sourced data (use `defusedcsv`, prevents formula injection via `=CMD()`)
- No `pickle.loads()` on data from network/files (arbitrary code execution)
- No test files with real API keys/tokens (use obviously-fake values like `test-key-not-real-000`)

## Infrastructure (CDK/Terraform/Pulumi)

- IAM least privilege (no `*` actions without justification)
- RemovalPolicy/prevent_destroy gated on environment
- Timeouts set explicitly
- Secrets via SSM/Secrets Manager, not plaintext env vars
- Lambda: explicit memory, timeout, runtime version
- S3: BlockPublicAccess, encryption, SSL
- DynamoDB: encryption, PITR for prod
- Resources tagged for cost tracking
- Full AWS service names on first mention per file
- CDK-nag suppressions reference full names

## Go

- Errors checked (no `_` on error return)
- Context propagation through call chain
- No `interface{}` when concrete type known
- Goroutine leaks: channels closed, use `errgroup`
- `defer` for cleanup in correct order (LIFO)

## Rust

- No `unwrap()` on user-facing paths: use `?` or explicit handling
- No `unsafe` without safety invariant comment
- No `clone()` where reference suffices
- Error types descriptive (not just `Box<dyn Error>` everywhere)
