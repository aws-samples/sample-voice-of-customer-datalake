# Agent brief: quality gates for dead code, duplication, "slop" and security — Rust + TypeScript

> **Proven on 2026-11-11** by autonomous coding-agent sessions on a Linux arm64 build machine (192 vCPU), with
> rustc/clippy 1.99.1, Node 22, cargo-shear 1.14.0, cargo-deny 0.20.2, cargo-mutants 27.1.0, cargo-fallow 0.3.0,
> jscpd 5.2.1, ast-grep 0.51.1, gitleaks 8.30.1, zizmor 1.31.1, ESLint 10.14.0, typescript-eslint 8.67.0, sonarjs
> 4.2.2, knip 6.37.0 and vitest 4.1.12: in a scratch workspace built only from this file's blocks, then on a real
> codebase of 20 cargo workspaces and 3 standalone crates (2,238 Rust files: Rust/wasm web apps, Lambdas, a desktop
> app) and 18 npm packages (1,919 TypeScript files). Every Rust and repo-wide row of Phase 4 was planted and failed
> its gate (marked **[proven 2026-11-11]**, 64 places); every TypeScript row failed as written except "eslint shell"
> and "knip (production)", both fixed.
>
> **What the gates found on the real codebase, first measure:** 251 lint suppressions, 213 source files over the
> length limit, 11 ignored tests, 7 tests that asserted nothing, and 2,826 duplicated blocks (989 of them between
> folders). Two hours later, with one agent session fixing each folder: 58, 135, 7, 5 and 1,802, and the clones
> between folders held by a baseline that only shrinks (989, down from 1,178). The secrets scan found 31 hits in the
> tree and 27 in 2,237 commits, every one a test fixture, each allow-listed by file and exact text. The security
> report (3.7) ran osv-scanner (273 advisory groups, 2 real: a legacy TLS stack in 5 services and an archive library's
> advisories), semgrep (301 findings, 2 real), CodeQL JavaScript/TypeScript (49, 2 real) and CodeQL Rust (317, none
> real): 6 real findings in 4 issues, each filed as a bug, every false positive an exception with its reason.
>
> **The gaps those runs found are fixed below** (marked **[fixed 2026-11-11]**, 17 places), among them: the
> commented-out-code rule flagged prose (21 false hits, rule rewritten); `dead_code_pub_in_binary` is not a rustc
> lint in the pinned toolchain; the shell row and two TypeScript rows did not fail as written; a plant was too small
> for jscpd 5.2.1 to see; knip reports a plant in a new file as an unused file, not an unused export; sonarjs 4.2.2's
> recommended set leaves several security rules off; two scripts returned the wrong exit code. Not exercised: the
> Stryker row on the changed lines, `cargo hack`, CodeQL's Rust semantic analysis (it needs a cargo workspace at the
> scan root), and the macOS-only targets of a desktop app inside the gate.

You are setting up a repository's quality gates from nothing, then fixing the code until every gate passes.
After that, the gates keep the code in that shape. This file is self-contained: every config, script and rule
you need is in it. Copy the blocks as written, change only the placeholders marked `<LIKE_THIS>`, and follow
the phases in order.

**What "slop" means here**, and the gate that catches each kind:

| Slop | Rust | TypeScript |
| --- | --- | --- |
| A function, type, field or file nothing uses | rustc `dead_code`, `unreachable_pub`; cargo-shear (unlinked files); the visibility report (3.3) for `pub` items across crates | knip, tsc `noUnused*` |
| Code only a test keeps alive | rustc `dead_code` (the non-test build of each crate is linted); the visibility report on a production copy | `knip --production` |
| An unused or misplaced dependency | cargo-shear | knip |
| Copy-pasted code, including a test that re-implements the code it tests | jscpd over code **and** tests in one run | the same run |
| An import that does not import | `unused_imports`, `redundant_imports`, `unused_qualifications`, `clippy::pub_use` | tsc, knip, `custom/no-re-exports` |
| Logic that says more than it does: `if c { true } else { false }`, a fn that always returns `Ok`, `async` without `await`, unused `self`, identical match arms, a needless `.clone()`/`.collect()`, a collection never read | clippy `all` + `pedantic` + a curated nursery/restriction set | typescript-eslint `no-unnecessary-*`, sonarjs, unicorn |
| An escape hatch: `.unwrap()`, unchecked indexing, `panic!`/`todo!`, `let _ = result`, `.ok();` | clippy `unwrap_used`, `expect_used`, `indexing_slicing`, `string_slice`, `panic`, `todo`, `let_underscore_must_use`, `unused_result_ok` | `no-non-null-assertion`, `noUncheckedIndexedAccess`, `no-floating-promises` |
| A test that does not test: asserts nothing, is ignored, or passes whatever the code does | ast-grep `rust-test-asserts-nothing`, `rust-no-ignored-test`; cargo-mutants on the changed lines | vitest rules; Stryker on the changed lines |
| A suppression that hides any of the above | ast-grep `rust-no-lint-suppression`; clippy `allow_attributes`; `unfulfilled_lint_expectations` | `eslint-comments/no-use` |
| Commented-out code | ast-grep `rust-no-commented-out-code` | `sonarjs/no-commented-code` |
| A file or function too big to review | `clippy::too_many_lines`, `excessive_nesting`, `too_many_arguments`; `scripts/rust-file-length.sh` | `max-lines`, `complexity`, `max-depth` |
| A vulnerable, yanked, unmaintained or wrongly licensed dependency | cargo-deny | `npm audit --omit=dev` |
| A committed secret | gitleaks (tree and history) | the same |
| Injectable code (XSS, eval, shell, ReDoS) or `unsafe` | `unsafe_code = "forbid"`; CodeQL and semgrep in the security report | sonarjs security rules, `no-unsanitized`, `eslint-plugin-regexp`; CodeQL |
| A CI workflow an attacker can steer | zizmor | the same |

---

## Ground rules (read twice)

1. **Zero is the gate.** A gate passes only with zero findings. No per-area "debt ceiling" scripts. If a tree
   cannot reach zero in this change, use the tool's own baseline (jscpd `--baseline` + `--fail-on-new-clones`)
   and never raise it.
2. **Never suppress.** No `#[allow(..)]`, `#[expect(..)]`, `#![allow(..)]`, `#[cfg_attr(.., allow(..))]`,
   `// eslint-disable`, `@ts-ignore`, `@ts-expect-error`, non-null `!`, `as T` to drop `undefined`, or
   `.unwrap()` to make a type checker quiet. Fix the code, or make the type tell the truth. The only exceptions
   live in config files (`Cargo.toml` lint table, `clippy.toml`, `deny.toml`, an ast-grep rule's `ignores:`),
   each with a comment saying why.
3. **Measure before you enable.** Run each new rule once as a warning, count its findings, and record the count.
   Turn it into an error in the same change that fixes them.
4. **Prove every gate looked.** A gate that scanned nothing also passes. For every gate, plant one violation,
   see it fail with the expected message, and revert it (Phase 4).
5. **Do not change behaviour.** This work changes structure, types and tests, not what the program does. If a
   fix would change behaviour (for example, replacing a panic with an error the caller now has to handle),
   stop and report it. Do not delete a test to make a gate pass; fix the test.
6. **One phase per commit, with conventional messages** (`chore:`, `test:`, `docs:`). Commit only if the person
   who asked you allows it. Stage files by name, never `git add .`.
7. **Keep what the repo already enforces.** If a stricter existing rule conflicts with this brief, keep the
   stricter one. Merge into existing `clippy.toml`, `deny.toml`, `rustfmt.toml` and ESLint configs.
8. **Say what you could not verify.** A green command is not proof unless you also proved it scanned something.

---

## Phase 0: detect (read-only)

```bash
git ls-files | sed -n 's/.*\.\([A-Za-z0-9]*\)$/\1/p' | sort | uniq -c | sort -rn | head -20   # languages
git ls-files | grep -E '(^|/)Cargo\.toml$'                     # every cargo workspace root and member
git ls-files | grep -E '(^|/)(rust-toolchain(\.toml)?|clippy\.toml|\.clippy\.toml|rustfmt\.toml|\.rustfmt\.toml|deny\.toml|\.cargo/config\.toml|\.cargo/mutants\.toml)$'
cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; m=json.load(sys.stdin); [print(p["name"], p.get("publish"), sorted({k for t in p["targets"] for k in t["kind"]}), sorted(p["features"])) for p in m["packages"]]'
git ls-files '*.rs' | grep -E '(^|/)(tests|benches|examples)/' | head    # integration tests, benches, examples
git grep -nE '#\[cfg\(test\)\]' -- '*.rs' | wc -l                          # inline test modules
git grep -nlE 'compile_error!|mutually exclusive' -- '*.rs' 'Cargo.toml' | head   # features that cannot all be on
git ls-files | grep -E '(^|/)build\.rs$'; git grep -lE 'include!\(concat!\(env!\("OUT_DIR"' -- '*.rs' | head
git ls-files | grep -E '(^|/)package\.json$'; git ls-files | grep -E '(^|/)tsconfig[^/]*\.json$'
git ls-files | grep -E '\.(spec|test)\.[jt]sx?$' | head
ls .github/workflows 2>/dev/null; rustc --version; cargo --version; node --version
```

[fixed 2026-11-11] `git ls-files` also lists tracked files deleted in the working tree (a move in progress): count
with `git ls-files | while read -r f; do [ -f "$f" ] && echo "$f"; done` when the tree is not clean, and never feed
`git ls-files` to a tool that opens each file without that check (3.1 does it now). A repo with one cargo workspace
per app (no root workspace) runs every `<RUST_DIR>` step once per workspace, and the repo-wide steps (ast-grep,
jscpd, gitleaks, zizmor) once at the root: give each folder's `validate.sh` its own share (ast-grep scan of the
folder, file length, clones inside the folder) and keep the rest in one root script.

| Question | Your answer | Consequence |
| --- | --- | --- |
| Cargo workspace root(s) (`<RUST_DIR>`, `.` when it is the repo root) | | One clippy/test/shear/deny run per workspace |
| Members: lib, bin, proc-macro, cdylib (wasm), Lambda bins | | Bins and cdylibs are entry points for the visibility report |
| Are workspace libs internal (`publish = false`)? | | Internal libs: their `pub` items are only for this workspace (3.3). Set `publish = false` on every lib nobody publishes |
| Features that cannot all be on together | | `<FEATURE_ARGS>`: `--all-features` if none, else `--features <set>` per supported set (or cargo-hack) |
| Targets the code ships to (host, `wasm32-unknown-unknown`, Linux for Lambda) | | Lint each target that has its own `cfg` code: one clippy step per target |
| Test layout: inline `mod tests`, `<stem>_tests.rs` files, `tests/`, doctests | | 2.5 rules and 3.1 file-length counter; `tests/` with several files → one integration-test crate (Phase 5, step 1) |
| Generated Rust (`build.rs` → `OUT_DIR`, checked-in generated files) | | Never lint/scan checked-in generated files: list them in 2.5 `ignores:` and the jscpd `ignore`, with the generator named |
| TS/JS packages (each dir with its own package.json), TS source dirs (`<TS_SRC>`), entry files (`<TS_ENTRIES>`) | | Each package: its own tsc, knip, vitest runs |
| Test runner for TS: vitest or jest | | jest: `eslint-plugin-jest` with the same rule names |
| Existing lints and configs to merge | | Ground rule 7 |
| CI system | | CI calls `scripts/validate.sh`, nothing else |

Pick the Rust version from what the repo already pins (`rust-toolchain.toml`, `rust-version` in Cargo.toml, the
CI image) and the Node version from the runtime the code ships to, not from your shell.

---

## Phase 1: install (pinned, dev-only)

**[rust]** The toolchain is pinned in `rust-toolchain.toml` (2.1); rustup installs it on first use in the repo.
Cargo tools, exact versions, `--locked` so their own dependencies are the ones their CI tested:

```bash
cargo install --locked cargo-shear@1.14.0      # unused/misplaced deps, unlinked .rs files   [checked: 37 s]
cargo install --locked cargo-deny@0.20.2       # advisories, licences, bans, sources        [checked: 73 s]
cargo install --locked cargo-mutants@27.1.0    # mutation testing, report only              [checked: 42 s]
# optional, only for the visibility report (3.3):
cargo install --locked cargo-fallow@0.3.0      # experimental 0.x, syntax-based; see 3.3 before relying on it
```

In CI, install the same versions from prebuilt binaries if you prefer (`cargo binstall --no-confirm
cargo-shear@1.14.0 …`, or the release archives with their checksums); never an unpinned `cargo install x`.

**[ts]** In every JS/TS package that has TypeScript code. Versions changed from the sibling brief, with the
reason: vitest 4.1.10 and 4.1.11 are affected by GHSA-82fw-gwwq-j7x9 and GHSA-qxg6-89mg-rqv8 (fixed in 4.1.12);
ESLint 9 left support on 2026-08-06, so ESLint 10, which needs sonarjs 4; Stryker 10.1.x fixes false
"survived" reports of mutants that only break module loading. [checked: this set, minus the two security
plugins and ast-grep, ran green and failed every TS row of Phase 4 as written; the security plugins were checked
with ESLint 9.39.5 only.] Keep TypeScript on 5.9: typescript-eslint 8 supports `>=4.8.4 <6.1.0`, and TypeScript 7 (the native
port) has no JS API that typed linting can use yet.

```bash
npm i -D --save-exact typescript@5.9.3 eslint@10.14.0 typescript-eslint@8.67.0 \
  eslint-plugin-sonarjs@4.2.2 eslint-plugin-unicorn@62.0.0 \
  @eslint-community/eslint-plugin-eslint-comments@4.7.2 \
  eslint-plugin-no-unsanitized@4.1.5 eslint-plugin-regexp@3.3.3 \
  knip@6.37.0 jscpd@5.2.1 @ast-grep/cli@0.51.1
# vitest users (every @vitest/* package at the same exact version as vitest):
npm i -D --save-exact vitest@4.1.12 @vitest/eslint-plugin@1.6.27 \
  @stryker-mutator/core@10.1.1 @stryker-mutator/vitest-runner@10.1.1
```

A Rust-only repo still needs a root `package.json` for jscpd and ast-grep (`npm init -y`, then delete the
`main` field). Keep `@vitest/eslint-plugin` at 1.6.27: 1.6.28 needs TypeScript 6.

**[security]** Two scanners are not npm or cargo packages. Pin them in CI by release version and checksum:
`gitleaks` 8.30.1 and `zizmor` 1.31.1 (zizmor is also on PyPI: `pipx install zizmor==1.31.1`, and on crates.io:
`cargo binstall --locked zizmor@1.31.1` [proven 2026-11-11]). Locally, `brew install gitleaks zizmor` is fine; check
the versions match. gitleaks 8.30.1's `gitleaks_8.30.1_linux_arm64.tar.gz` has sha256
`e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080` (its release checksums file, 2026-11-11); pin the
hash in the install script, not the download's own checksums file.

[fixed 2026-11-11] **`sg` is not ast-grep on Linux.** `/usr/bin/sg` is shadow-utils' "execute as another group"
command on every Debian/Ubuntu machine. `npx sg` still finds the package's `node_modules/.bin/sg` first, but a bare
`sg` in a script or a shell runs the wrong program. Every command below says `ast-grep` (the package installs both
names). CodeQL (2.27.x) and semgrep (1.18x) run only in
the security report (3.7), not in `validate.sh`.

Make sure `target/`, `node_modules/`, `mutants.out/`, `.stryker-tmp/`, `reports/` and `coverage/` are in
`.gitignore`.

---

## Phase 2: configuration

### 2.1 [rust] `rust-toolchain.toml` (in each `<RUST_DIR>`)

```toml
# The compiler, clippy and rustfmt every gate runs with. Bump it in its own change and rerun Phase 4:
# a new clippy can add findings to lints that are already on.
[toolchain]
channel = "<1.99.1>"
components = ["clippy", "rustfmt"]
profile = "minimal"
```

Trap [checked]: any `cargo`/`rustup` command in a directory with this file installs the pinned toolchain if it
is missing (463 MB). In scratch copies where you do not want that, set `RUSTUP_AUTO_INSTALL=0`. [proven 2026-11-11]
A `stable` toolchain that is the same version does not count: rustup installs `1.99.1-<host>` beside it.
The pinned toolchain has only the targets the file lists: add `targets = ["wasm32-unknown-unknown", …]` for every
target a build or a clippy step uses (web, Lambda cross-builds), or those builds fail on a machine that had the
targets under `stable` [docs]. The pin also governs the release builds, so in a repo that deploys from another
machine it is agreed with whoever deploys.

### 2.2 [rust] lints in the workspace `Cargo.toml`

Every lint is `warn`; `scripts/validate.sh` runs clippy with `-D warnings`, which turns every warning (rustc's
and clippy's) into an error [checked]. Warn, not deny, so a developer's `cargo build` and `cargo test` still run
while code is half written. Groups first (`priority = -1`), then single lints, which override their group.
Every member crate gets `[lints] workspace = true`. A crate that must write `unsafe` cannot override one lint of
an inherited table (Cargo does not merge them): give it a copy of this table with `unsafe_code` removed, and say
why in a comment.

```toml
[workspace.lints.rust]
unused = { level = "warn", priority = -1 }            # dead_code, unused_imports/variables/mut/must_use, unreachable_code, ...
rust_2018_idioms = { level = "warn", priority = -1 }  # elided_lifetimes_in_paths, bare_trait_objects, ...
unreachable_pub = "warn"          # `pub` on an item nothing outside the crate can reach: say pub(crate), and dead_code sees it
unused_qualifications = "warn"    # `crate::a::b()` where `b` is already in scope
unused_import_braces = "warn"     # `use a::{b};`
redundant_imports = "warn"        # an import of what is already in scope (the prelude, a glob)
unused_lifetimes = "warn"
redundant_lifetimes = "warn"
single_use_lifetimes = "warn"
trivial_casts = "warn"            # `x as &dyn T` where a type annotation says it
trivial_numeric_casts = "warn"    # `x as u32` where x is already u32
let_underscore_drop = "warn"      # `let _ = value_with_drop;` drops it on the spot, or hides an unused parameter
unit_bindings = "warn"            # `let x = ();`
unsafe_code = "forbid"            # security: no `unsafe` in this workspace (see the note above for a crate that needs it)

[workspace.lints.clippy]
all = { level = "warn", priority = -1 }               # correctness, suspicious, style, complexity, perf
pedantic = { level = "warn", priority = -1 }
# pedantic lints that are style, docs or API taste, not slop: each gave hundreds of hits on real code, none a defect
must_use_candidate = "allow"
missing_errors_doc = "allow"
missing_panics_doc = "allow"
doc_markdown = "allow"
unreadable_literal = "allow"
many_single_char_names = "allow"
similar_names = "allow"
items_after_statements = "allow"
single_match_else = "allow"
if_not_else = "allow"
map_unwrap_or = "allow"
default_trait_access = "allow"
assigning_clones = "allow"
trivially_copy_pass_by_ref = "allow"
large_types_passed_by_value = "allow"
needless_pass_by_value = "allow"
wildcard_imports = "allow"
struct_excessive_bools = "allow"
return_self_not_must_use = "allow"
float_cmp = "allow"
assert_is_empty = "allow"
format_push_string = "allow"      # its fix, `write!(s, ..)`, returns a Result that let_underscore_must_use then flags
# numeric casts that may truncate or wrap: real bugs on untrusted sizes, but hundreds of hits in numeric/graphics
# code. Off here; counted in the security report (3.7). cast_lossless (`as` where From works) stays on.
cast_possible_truncation = "allow"
cast_possible_wrap = "allow"
cast_sign_loss = "allow"
cast_precision_loss = "allow"
# nursery: only these (the whole group has false positives on wasm, fn-pointer tables and style)
redundant_clone = "warn"
needless_collect = "warn"
collection_is_never_read = "warn"
useless_let_if_seq = "warn"
branches_sharing_code = "warn"
equatable_if_let = "warn"
trait_duplication_in_bounds = "warn"
type_repetition_in_bounds = "warn"
unnecessary_struct_initialization = "warn"
set_contains_or_insert = "warn"
unused_peekable = "warn"
iter_on_single_items = "warn"
iter_on_empty_collections = "warn"
needless_type_cast = "warn"
unused_rounding = "warn"
fallible_impl_from = "warn"
# restriction: escape hatches and leftovers
unwrap_used = "warn"
expect_used = "warn"
unwrap_in_result = "warn"
indexing_slicing = "warn"
string_slice = "warn"
panic = "warn"
todo = "warn"
unimplemented = "warn"
unreachable = "warn"
exit = "warn"
dbg_macro = "warn"
print_stdout = "warn"
print_stderr = "warn"
allow_attributes = "warn"
allow_attributes_without_reason = "warn"
let_underscore_must_use = "warn"
unused_result_ok = "warn"
cfg_not_test = "warn"
# restriction: imports that do not import
pub_use = "warn"
unnecessary_self_imports = "warn"
# restriction: logic that says more than it does
if_then_some_else_none = "warn"
redundant_type_annotations = "warn"
unneeded_field_pattern = "warn"
rest_pat_in_fully_bound_structs = "warn"
empty_structs_with_brackets = "warn"
empty_enum_variants_with_brackets = "warn"
empty_drop = "warn"
try_err = "warn"
verbose_file_reads = "warn"
map_with_unused_argument_over_ranges = "warn"
lossy_float_literal = "warn"
missing_assert_message = "warn"
# security: when a crate is allowed `unsafe`, every block says why it is sound, one operation per block
undocumented_unsafe_blocks = "warn"
multiple_unsafe_ops_per_block = "warn"
# size and shape (thresholds in clippy.toml)
excessive_nesting = "warn"
# cargo: only the feature and dependency mistakes a repo can fix
wildcard_dependencies = "warn"
redundant_feature_names = "warn"
negative_feature_names = "warn"
```

In every member's `Cargo.toml`:

```toml
[lints]
workspace = true
```

[fixed 2026-11-11: `dead_code_pub_in_binary` is not in the shared table any more.] Under `--all-targets` a
library's own unit-test harness (`<crate> (lib test)`) is a binary for this lint, so every `pub` item the crate's
own `#[cfg(test)]` tests do not call fails with ``function `x` is never used`` / "in binaries, they cannot, so this
`pub` item is unused", including items other crates use [proven 2026-11-11, twice: a scratch library with one
`pub fn` its tests do not call]. A crate that is a binary and nothing else may add it to its own `[lints]` copy;
cross-crate `pub` items are the visibility report's job (3.3).
Lint pairs that contradict each other; leave the second of each off: `unreachable_pub` vs
`redundant_pub_crate`; `needless_return` vs `implicit_return`; `self_named_module_files` vs `mod_module_files`;
`pub_without_shorthand` vs `pub_with_shorthand`; `semicolon_inside_block` vs `semicolon_outside_block`;
`separated_literal_suffix` vs `unseparated_literal_suffix`. Do not use `unused_crate_dependencies`: it is per
target and reports false positives both ways [checked]; cargo-shear does that job. Do not enable the whole
`restriction` group (clippy's own docs say so), `nursery` or `cargo`.

### 2.3 [rust] `clippy.toml` (next to the workspace `Cargo.toml`)

```toml
# Lint the public API as hard as private code: without this, unnecessary_wraps, unused_self and
# needless_pass_by_ref_mut skip every `pub fn`.                                                  [checked]
avoid-breaking-exported-api = false
# Tests: `.expect("what the fixture promised")` is allowed, `.unwrap()` is not; indexing and panics are fine.
allow-unwrap-in-tests = false
allow-expect-in-tests = true
allow-indexing-slicing-in-tests = true
allow-panic-in-tests = true
allow-print-in-tests = false
allow-dbg-in-tests = false
# Size and shape. excessive_nesting counts the fn body and an enclosing impl as levels [checked]:
# 5 allows four nested blocks in a free function and three in a method (the TS brief's max-depth 3).
too-many-lines-threshold = 100
too-many-arguments-threshold = 7
excessive-nesting-threshold = 5
```

Trap [checked]: clippy does not notice a newly created `clippy.toml` until a source file of the crate changes
(edits to an existing one are picked up). After creating it, `touch` one source file per crate before measuring.

Rust has no cyclomatic-complexity lint; `cognitive_complexity` is off on purpose (clippy moved it out of the
default groups because its scores are not reliable). `too_many_lines` and `excessive_nesting` are the limits.

### 2.4 [rust] formatting

`cargo fmt --all --check` is the gate. Keep the repo's `rustfmt.toml`; options marked unstable print a warning
and are ignored on stable (exit 0) [checked], so do not rely on them.

### 2.5 [rust] ast-grep rules: what rustc and clippy do not check

At the repo root: `sgconfig.yml`, `sg/utils/*.yml`, `sg/rules/*.yml`, `sg/rule-tests/*.yml`. ast-grep parses
Rust with tree-sitter; attributes such as `#[test]` are the function's preceding **siblings**, not its children,
which is why the rules use `follows`. [proven 2026-11-11: `ast-grep test` passes every case as written, each
rule fails on its plant (Phase 4), and the scan of 1839 Rust files of a real repo gave 251 suppressions, 11 ignored
tests, 7 tests asserting nothing, and 21 commented-out-code hits that were all prose (fixed below).]

Vendored code that must stay as its upstream wrote it (and checked-in generated files) goes in each rule's
`ignores:`, with the reason [fixed 2026-11-11: the rules had no place for it]:

```yaml
ignores:
  # vendored upstream code: pristine by design; our overlay is outside it
  - "**/upstream/**"
```

`sgconfig.yml`:

```yaml
# ast-grep 0.51.1: the Rust source checks clippy and rustc do not provide. `npx ast-grep scan` runs every rule;
# `npx ast-grep test` runs the fixtures in sg/rule-tests.
ruleDirs: [sg/rules]
utilDirs: [sg/utils]
testConfigs:
  - testDir: sg/rule-tests
```

`sg/utils/rust-test-fn.yml`:

```yaml
# A function with a test attribute. Attributes are the fn's preceding SIBLINGS, so this walks back over
# attributes and comments and stops at the first other node.
id: rust-test-fn
language: Rust
rule:
  kind: function_item
  follows:
    stopBy:
      not:
        any: [{ kind: attribute_item }, { kind: line_comment }, { kind: block_comment }]
    kind: attribute_item
    # test, tokio::test, test_log::test, sqlx::test, rstest, test_case, wasm_bindgen_test
    regex: '^#\[\s*(?:[A-Za-z_]\w*\s*::\s*)*(?:test|rstest|test_case|wasm_bindgen_test)\b'
```

`sg/utils/rust-direct-assertion.yml`:

```yaml
# An assertion written in place: an assert-family macro, panic!/unreachable!, or a call to a function, method or
# macro named assert_*/expect_* (helpers, mock expectations, assert_cmd's `.assert()`).
# `.unwrap()`, `.expect(..)` and `?` are not assertions: they only say "no error".
id: rust-direct-assertion
language: Rust
rule:
  any:
    - kind: macro_invocation
      has:
        field: macro
        regex: '(?:^|::)(?:assert\w*|debug_assert\w*|prop_assert\w*|expect_\w*|panic|unreachable)$'
    - kind: call_expression
      has:
        field: function
        regex: '(?:^|[.:])(?:assert(?:_\w*)?|expect_\w*)(?:::<.*>)?$'
```

`sg/utils/rust-assertion.yml`:

```yaml
# An assertion: in place, or a call to a function or macro_rules! macro of the same file whose body asserts in
# place (one level, like a helper you can read on the same screen).
id: rust-assertion
language: Rust
rule:
  any:
    - matches: rust-direct-assertion
    - kind: call_expression
      all:
        - has:
            field: function
            any:
              - { kind: identifier, pattern: $HELPER }
              - { kind: scoped_identifier, has: { field: name, pattern: $HELPER } }
        - inside:
            kind: source_file
            stopBy: end
            has:
              stopBy: end
              kind: function_item
              all:
                - has: { field: name, pattern: $HELPER }
                - has: { stopBy: end, matches: rust-direct-assertion }
    - kind: macro_invocation
      all:
        - has: { field: macro, pattern: $MACRO }
        - inside:
            kind: source_file
            stopBy: end
            has:
              stopBy: end
              kind: macro_definition
              all:
                - has: { field: name, pattern: $MACRO }
                - regex: '(?:assert\w*|debug_assert\w*|prop_assert\w*|panic|unreachable)\s*!'
```

`sg/rules/rust-test-asserts-nothing.yml`:

```yaml
id: rust-test-asserts-nothing
language: Rust
severity: error
message: test asserts nothing
note: >-
  A test that calls code and asserts nothing passes whatever the code does. Assert on the result
  (`?`, `.unwrap()` and `.expect()` alone only say "no error"), use #[should_panic(expected = "...")],
  or call a helper named assert_*/expect_* that asserts.
rule:
  matches: rust-test-fn
  not:
    any:
      - follows:
          stopBy:
            not:
              any: [{ kind: attribute_item }, { kind: line_comment }, { kind: block_comment }]
          kind: attribute_item
          regex: '^#\[\s*should_panic\b'
      - has: { stopBy: end, matches: rust-assertion }
```

`sg/rules/rust-assert-helper-asserts-nothing.yml`:

```yaml
id: rust-assert-helper-asserts-nothing
language: Rust
severity: error
message: helper named like an assertion asserts nothing
note: >-
  A test that calls an assert_*/expect_* function or macro counts as asserting, so the helper must assert:
  an assert-family macro, panic!, or another assert_*/expect_* call.
rule:
  any:
    - kind: function_item
      has: { field: name, regex: '^(?:assert|expect)_' }
      not: { has: { stopBy: end, matches: rust-direct-assertion } }
    - kind: macro_definition
      has: { field: name, regex: '^(?:assert|expect)_' }
      not:
        regex: '(?:assert\w*|debug_assert\w*|prop_assert\w*|expect_\w*|panic|unreachable)\s*!|(?:assert|expect)_\w*\s*\('
```

`sg/rules/rust-no-lint-suppression.yml`:

```yaml
id: rust-no-lint-suppression
language: Rust
severity: error
message: lint suppression attribute
note: >-
  Fix the finding instead of silencing it (#[allow], #[expect], #![allow], #![expect], or either one inside
  #[cfg_attr(..)]). clippy::allow_attributes only covers #[allow]. An exception is a file in this rule's
  `ignores:` list, with a comment saying why.
# ignores:
#   - "<path/to/generated.rs>"   # <why: generated by build.rs from <schema>; never edited by hand>
rule:
  any:
    - kind: attribute_item
    - kind: inner_attribute_item
  regex: '^#!?\[\s*(?:allow|expect)\s*\(|^#!?\[\s*cfg_attr\s*\((?s:.*)\b(?:allow|expect)\s*\('
```

`sg/rules/rust-no-ignored-test.yml`:

```yaml
id: rust-no-ignored-test
language: Rust
severity: error
message: disabled test
note: >-
  An ignored test passes whatever the code does. Make it run (fast, hermetic) or delete it; a reason string
  does not change that. cfg(any()) is always false and disables an item the same way.
rule:
  kind: attribute_item
  regex: '^#\[\s*ignore\b|^#\[\s*cfg_attr\s*\((?s:.*)\bignore\b|^#\[\s*cfg\s*\(\s*any\s*\(\s*\)\s*\)'
```

`sg/rules/rust-no-commented-out-code.yml` (a heuristic like ruff's ERA001; measure it in Phase 5 and tighten a
regex that hits prose, never add an ignore):

```yaml
id: rust-no-commented-out-code
language: Rust
severity: error
message: commented-out code
note: >-
  Delete it; git keeps the history. Doc comments (/// //! /** /*!) and their doctests are not checked. Prose
  that starts like code (`// if the cache is cold, ...`) does not match: only a line shaped like Rust does
  (`let x = ..`, `fn f(`, `use a::b;`, `if .. {`, `x = ..;`, `f(..);`, `a.b(..);`, a lone `}`).
rule:
  any:
    - kind: line_comment
      not: { regex: '^//(?:!|/(?:[^/]|$))' }          # /// and //! are docs
      any:
        - regex: '^//\s*(?:let\s+(?:mut\s+)?[A-Za-z_(][\w, ()]*\s*(?::[^=]*)?=[^=>]|(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+|const\s+|unsafe\s+)*fn\s+\w+\s*[<(])'
        - regex: '^//\s*(?:pub(?:\([\w:]+\))?\s+)?(?:use\s+[\w:{}*, ]+;|mod\s+\w+\s*[;{]|(?:struct|enum|trait|union)\s+\w+.*[{;(]\s*$|impl\b.*\{\s*$|type\s+\w+.*=.*;\s*$)'
        - regex: '^//\s*(?:\}\s*else\s*(?:if\b.*)?\{\s*$|(?:if|while|match)\s+.+\{\s*$|for\s+.+\s+in\s+.+\{\s*$|loop\s*\{\s*$|return\b.*;\s*$|else\s*\{\s*$)'
        # a statement: an assignment, or a call/macro/method chain, then `;` (prose that ends in `;` does not match)
        - regex: '^//\s*(?:break|continue|[\w.:\[\]&*]+\s*[-+*/|&^]?=\s*[^=\s].*|[\w:.]+!?\(.*\)[\w.()?:<>]*)\s*;\s*$'
        - regex: '^//\s*[})\]]+\s*[;,)]*\s*$'          # a lone closing brace or bracket
        - regex: '^//\s*#!?\[\w'                       # an attribute
    - kind: block_comment
      not: { regex: '^/\*(?:!|\*(?:[^*/]|$))' }        # /** and /*! are docs
      regex: '(?m)^\s*(?:/\*+|\*+)?\s*(?:let\s+(?:mut\s+)?\w+\s*(?::[^=]*)?=[^=>]|(?:pub\s+)?fn\s+\w+\s*[<(]|use\s+[\w:{}*, ]+;|(?:if|while|match|for)\s+.+\{\s*$|(?:break|continue|[\w.:\[\]&*]+\s*[-+*/|&^]?=\s*[^=\s].*|[\w:.]+!?\(.*\)[\w.()?:<>]*)\s*;\s*(?:\*/)?\s*$|[})\]]+\s*[;,]?\s*(?:\*/)?\s*$)'
```

[fixed 2026-11-11] The statement arm was `'^//.*\S;\s*$'` (any comment ending in `;`). On a real repo whose prose
uses semicolons, all 21 hits were sentences (`// … reading only what the page already shows;`) and none was code.
It now needs a statement's shape; the fixtures below hold both sides.

Rule tests: ast-grep wants one test file per rule id in `sg/rule-tests/`. Create these five (each `invalid`
case must be reported, each `valid` case must not):

```yaml
# sg/rule-tests/rust-test-asserts-nothing-test.yml
id: rust-test-asserts-nothing
valid:
  - "#[test]\nfn adds() { assert_eq!(add(1, 2), 3); }"
  - "#[tokio::test]\nasync fn loads() { let r = load().await; assert!(r.is_ok(), \"load failed\"); }"
  - "#[test]\n#[should_panic(expected = \"empty\")]\nfn rejects_empty() { parse(\"\"); }"
  - "fn assert_total(v: u32) { assert_eq!(v, 3); }\n#[test]\nfn total() { assert_total(add(1, 2)); }"
  - "#[test]\nfn cli() { Command::new(\"app\").assert().success(); }"
invalid:
  - "#[test]\nfn adds() { add(1, 2); }"
  - "#[test]\nfn parses() -> Result<(), Error> { parse(\"1\")?; Ok(()) }"
  - "#[tokio::test]\nasync fn loads() { load().await.expect(\"loads\"); }"
---
# sg/rule-tests/rust-assert-helper-asserts-nothing-test.yml
id: rust-assert-helper-asserts-nothing
valid:
  - "fn assert_total(v: u32) { assert_eq!(v, 3); }"
invalid:
  - "fn assert_total(v: u32) { let _ = v; }"
---
# sg/rule-tests/rust-no-lint-suppression-test.yml
id: rust-no-lint-suppression
valid:
  - "#[derive(Debug)]\nstruct A;"
  - "#[cfg(test)]\nmod tests {}"
invalid:
  - "#[allow(dead_code)]\nfn f() {}"
  - "#[expect(clippy::unwrap_used, reason = \"x\")]\nfn f() {}"
  - "#![allow(unused)]"
  - "#[cfg_attr(test, allow(dead_code))]\nfn f() {}"
---
# sg/rule-tests/rust-no-ignored-test-test.yml
id: rust-no-ignored-test
valid:
  - "#[test]\nfn runs() { assert!(true, \"runs\"); }"
invalid:
  - "#[test]\n#[ignore]\nfn slow() { assert!(true, \"slow\"); }"
  - "#[test]\n#[ignore = \"needs network\"]\nfn net() { assert!(true, \"net\"); }"
  - "#[cfg(any())]\nfn hidden() {}"
---
# sg/rule-tests/rust-no-commented-out-code-test.yml
id: rust-no-commented-out-code
valid:
  - "// If the cache is cold, the first read fills it.\nfn f() {}"
  - "/// ```\n/// let x = 1;\n/// ```\nfn f() {}"
  # prose that ends in a semicolon
  - "// The home and a profile are dashboards of tiles (Kernel 6.2: 32 / 16 / 12);\nfn f() {}"
  - "// `onload` fires once the PDF has actually rendered inside the iframe;\nfn f() {}"
  - "/* Who cannot open what a message carries: the samples are everyone's; */\nfn f() {}"
invalid:
  - "// let total = add(1, 2);\nfn f() {}"
  - "fn f() {\n    // }\n}"
  - "/* use std::fs; */\nfn f() {}"
  - "fn f() {\n    // total = add(1, 2);\n}"
  - "fn f() {\n    // self.items.push(item).unwrap();\n}"
  - "fn f() {\n    // println!(\"{x}\");\n}"
  - "/*\n   cache.clear();\n*/\nfn f() {}"
```

Write each block after its comment line to its own file (without the `---` separators).

### 2.6 [rust] `.cargo/mutants.toml` (in `<RUST_DIR>`)

```toml
# cargo-mutants 27.1.0. List values here are appended to the command line's; scalars on the command line win.
# Each exclusion names ONE equivalent mutant, as `cargo mutants --list` prints it ("path:line:col: name"),
# with the reason on the line above. An exclusion that names a whole file or function is not allowed.
exclude_re = [
    # '<why the mutant cannot change behaviour>'
    # '^crates/<crate>/src/<file>\.rs:\d+:\d+: replace > with >= in <fn>$',
]
# Mutants build and test with the committed lockfile, like CI.
additional_cargo_args = ["--locked"]
# cargo test, not nextest: nextest skips doctests, so behaviour only a doctest checks would show as MISSED.
test_tool = "cargo"
# Under the gitignored target/, never in the source tree.
output = "target/mutants"
```

[checked] `exclude_re` matches the `path:line:col: name` text; `#[mutants::skip]` needs the `mutants` crate as a
dependency (`#[cfg_attr(test, mutants::skip)]` with `mutants = "0.0.4"` as a dev-dependency works; `any()`,
`not(test)` forms are not honoured). Prefer the config entry: it keeps the reason next to it and no attribute
in the source.

[proven 2026-11-11] Two traps. An agent sandbox may treat `.cargo/` as a protected path and refuse to write the file:
`cargo mutants --config <path/to/mutants.toml>` reads the same file from anywhere (its `--locked` was seen applied).
A repo whose policy forbids a `target/` in the tree (one shared target for the machine) passes `--output <dir outside
the tree>` and points `TMPDIR` at a big volume: each scratch copy builds in its own `target/` inside the copy.

### 2.7 [security] `deny.toml` (in `<RUST_DIR>`)

```toml
# cargo-deny 0.20.2: every crate in Cargo.lock, four checks. scripts/validate.sh runs `cargo deny --locked check`.
# An exception lives here with its reason, never in a CLI flag.

[graph]
# Check what any feature can pull in, not only the default build.
all-features = true
# Every platform by default. To check only what you ship, list the targets:
# targets = ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "wasm32-unknown-unknown"]

[advisories]
# The RustSec advisory DB, cloned into $CARGO_HOME/advisory-dbs and fetched on every online run.
# Vulnerability and notice advisories are always errors; yanked, unmaintained and unsound need these settings.
yanked = "deny"
unmaintained = "all"
unsound = "all"
# An ignore that no longer matches anything is stale: delete it.
unused-ignored-advisory = "deny"
ignore = [
  # Every entry: the advisory id, why it does not apply or what replaces the crate, and a review date.
  # { id = "RUSTSEC-<YYYY-NNNN>", reason = "<why>; review by <YYYY-MM-DD>" },
]

[licenses]
confidence-threshold = 0.93
# Permissive licences only. Add one only after reading it; a copyleft licence is a product decision.
allow = ["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unicode-3.0", "Zlib"]
# The allow list is policy, not an inventory: a licence nothing uses yet is not an error.
unused-allowed-license = "allow"
# A per-crate exception names the crate, the licence and the reason:
# [[licenses.exceptions]]
# crate = "<crate>"
# allow = ["<SPDX-ID>"]   # reason: <why this one crate may use it>

[licenses.private]
# Workspace crates with `publish = false` are ours; their licence field is not checked.
ignore = true

[bans]
# Two versions of one crate are a build-size question, not a security one: `cargo tree -d` in the report.
multiple-versions = "allow"
# `foo = "*"` resolves to whatever is newest: deny it (path dependencies inside the workspace are fine).
wildcards = "deny"
allow-wildcard-paths = true
deny = [
  # { crate = "<crate>", use-instead = "<crate>", reason = "<why>" },
]

[sources]
# crates.io only. A git or other-registry dependency is added here, by URL, with a comment saying why.
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
allow-git = []
```

cargo-deny replaces cargo-audit (it reads the same RustSec database and adds licences, bans and sources). It needs
network to fetch the database; offline runs (`--offline`/`--disable-fetch`) fail once the local copy is older than
`maximum-db-staleness` (90 days by default) [docs].

### 2.8 [security] gitleaks: `.gitleaks.toml` and `.gitleaksignore` (repo root)

```toml
# gitleaks 8.30.1: the built-in rules, plus the repo's exceptions. Inline `gitleaks:allow` comments are ignored
# on purpose (scripts/secrets.sh passes --ignore-gitleaks-allow): an exception lives here, with its reason.
[extend]
useDefault = true

# [[allowlists]]
# description = "<what this is and why it is not a secret, e.g. a public test key from the vendor's docs>"
# paths = ['''<regex of the path>''']
```

`.gitleaksignore` holds one finding fingerprint per line (gitleaks prints it), each under a comment saying what it
was and that it was rotated: a secret that was ever committed is published, and deleting the line from the file
does not unpublish it.

[proven 2026-11-11] **A false positive (a test fixture, a published sample key) goes in `.gitleaks.toml`, not in
`.gitleaksignore`.** A tree-scan fingerprint is `file:rule:line`, so it breaks the moment a line above it moves; a
history fingerprint is per commit, so one fixture needs a line per commit that touched it. An `[[allowlists]]` entry
that names the file and the exact fixture text holds across edits and history (gitleaks 8.30.1):

```toml
[[allowlists]]
description = "RFC 6455 section 1.3's published sample key, used to check the accept value"
paths = ['''^src/ws/server\.test\.ts$''']
regexTarget = "line"
regexes = ['''SAMPLE_KEY = '<the RFC's sample key, verbatim>';''']
condition = "AND"
```

On a 2,240-commit repo the built-in rules gave 31 tree and 27 history findings, every one `generic-api-key` or
`pkcs12-file` on a fixture (emoji manifest keys, `aria-keyshortcuts`, test tokens, vendored test certificates);
read each one before allow-listing it. Allow both paths of a file that moved (`(upstream/)?`): the history sees the
old one.

### 2.9 [security] zizmor (GitHub Actions)

No config file unless there is an exception. Exceptions go in `.github/zizmor.yml`, per rule and file, with a
comment saying why:

```yaml
# rules:
#   <rule-id>:
#     ignore:
#       - <workflow>.yml:<line>   # <why this finding does not apply>
```

The gate runs `zizmor --offline .github` (deterministic, no GitHub API). The security report runs it online with a
token, which adds the audits that need the API (impostor commits, known-vulnerable actions). Exit codes [docs]:
0 clean, 11–14 findings (highest severity informational … high), 3 no workflows found, 1/2 errors.

[proven 2026-11-11: the plant below exited 14 with `dangerous-triggers` and `template-injection`.] Two traps:
zizmor reads a bare `a/b` argument as the GitHub repository `a/b`, not a directory (`can't fetch remote
repository: a/b` under `--offline`): write `./a/b`. And a vendored project's own `.github/` below the root never
runs (GitHub reads only the root's): gate on `.github`, and report the others by path (`./vendor/x/.github`). When
the root has no workflows, `zizmor .github` cannot run: the gate says so and passes (the brief's "drop the step"),
and comes back by itself when a workflow is added.

### 2.10 [ts] every `tsconfig*.json`

Add to `compilerOptions` of **every** TypeScript program (the app, the config-files program, each package):

```json
"strict": true,
"noUncheckedIndexedAccess": true,
"noUnusedLocals": true,
"noUnusedParameters": true,
"noImplicitReturns": true
```

Config files (`vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`) need a program that includes them,
for example `tsconfig.node.json` with `"include": ["*.config.ts"]`.

### 2.11 [ts] `eslint.config.mjs` (one config at the repo root)

Replace `<TS_GLOBS>` (for example `'web/src/**/*.{ts,tsx}'`); drop the vitest block if there is no vitest. For
jest, swap `@vitest/eslint-plugin` for `eslint-plugin-jest` and `vitest/` for `jest/`. `tseslint.config()` is
marked deprecated in favour of ESLint's `defineConfig` but works with ESLint 10 [checked]; switch only together
with a Phase 4 rerun.

```js
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import vitest from '@vitest/eslint-plugin';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import * as regexp from 'eslint-plugin-regexp';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import noReExports from './eslint-rules/no-re-exports.mjs';

const SPECS = ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/node_modules/**', '**/target/**', '**/pkg/**', '**/.stryker-tmp/**', '**/reports/**', '**/*.d.ts', '*.config.*', 'eslint-rules/**'] },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,   // includes ~65 security rules: eval, Function, os-command, slow-regex, pseudo-random, hard-coded passwords ...
  eslintComments.recommended,
  {
    // No suppression comments at all: fix the finding.
    rules: { '@eslint-community/eslint-comments/no-use': ['error', { allow: [] }] },
  },
  {
    files: [<TS_GLOBS>],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: {
      unicorn,
      regexp,
      'no-unsanitized': noUnsanitized,
      custom: { rules: { 'no-re-exports': noReExports } },
    },
    rules: {
      // size and shape
      complexity: ['error', 12],
      'max-depth': ['error', 3],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      // no escape hatches
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }],
      // imports that do not import, and code that is not code
      'custom/no-re-exports': 'error',
      'sonarjs/no-commented-code': 'error',   // no longer in sonarjs 4's recommended set
      // logic that says more than it does
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      'no-else-return': 'error',
      'no-lonely-if': 'error',
      'no-useless-return': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/no-useless-fallback-in-spread': 'error',
      // promises: awaited, returned, caught, or explicitly `void`ed
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      // sonarjs 4's recommended set turned these off [fixed 2026-11-11: the shell row did not fail without it]
      'sonarjs/os-command': 'error',
      // security beyond sonarjs: DOM XSS sinks, ReDoS, string-to-code
      'no-unsanitized/property': 'error',
      'no-unsanitized/method': 'error',
      ...regexp.configs['flat/recommended'].rules,
      'regexp/no-super-linear-move': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
    },
  },
  {
    files: SPECS,
    plugins: { vitest },
    rules: {
      'max-lines': ['error', { max: 730, skipBlankLines: true, skipComments: true }],
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*'] }],
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'vitest/no-standalone-expect': 'error',
      'vitest/max-expects': ['error', { max: 4 }],
      'vitest/no-conditional-in-test': 'error',
      'vitest/no-conditional-expect': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-commented-out-tests': 'error',
      'vitest/prefer-strict-equal': 'error',
      'vitest/prefer-called-with': 'error',
      'vitest/require-to-throw-message': 'error',
    },
  },
);
```

Not added, on purpose: `eslint-plugin-security` (its `detect-object-injection` flags every `obj[key]`; the rest
overlaps sonarjs) and `@microsoft/eslint-plugin-sdl` (overlaps `no-unsanitized` and `sonarjs/pseudo-random`)
[checked with ESLint 9.39.5 and sonarjs 3.0.7: every TS security plant of Phase 4 is caught without them].

### 2.12 [ts] `eslint-rules/no-re-exports.mjs`

A module exports only what it declares: no barrels, no `export … from`, no re-exporting an imported name. A
library's published entry file is the one place a re-export can be legitimate: list it in an `ignores` of the
rule's block, with a comment saying why. (Rust's equivalent is `clippy::pub_use`.)

```js
function findVariable(scope, name) {
  const found = scope.set.get(name);
  if (found) return found;
  return scope.upper ? findVariable(scope.upper, name) : undefined;
}

function isImported(context, node, identifier) {
  if (identifier?.type !== 'Identifier') return false;
  const variable = findVariable(context.sourceCode.getScope(node), identifier.name);
  return Boolean(variable?.defs.some((definition) => definition.type === 'ImportBinding'));
}

export default {
  meta: {
    type: 'problem',
    docs: { description: "Disallow re-exporting another module's names; import from the defining module" },
    messages: {
      reExportFrom: "Re-export from '{{source}}': import from the defining module where the name is used, and delete this line.",
      reExportImport: "'{{name}}' is imported, not declared here: its importers should import it from the defining module.",
    },
    schema: [],
  },
  create(context) {
    const reportFrom = (node) => context.report({ node, messageId: 'reExportFrom', data: { source: node.source.value } });
    return {
      ExportAllDeclaration: reportFrom,
      ExportNamedDeclaration(node) {
        if (node.source) {
          reportFrom(node);
          return;
        }
        for (const specifier of node.specifiers) {
          if (isImported(context, node, specifier.local)) {
            context.report({ node: specifier, messageId: 'reExportImport', data: { name: specifier.local.name } });
          }
        }
      },
      ExportDefaultDeclaration(node) {
        if (isImported(context, node, node.declaration)) {
          context.report({ node, messageId: 'reExportImport', data: { name: node.declaration.name } });
        }
      },
    };
  },
};
```

### 2.13 [ts] `knip.jsonc` (one per JS/TS package) and `scripts/knip-production.mjs` (once)

The `!` suffix marks production files; `--production` analyses only those, so an export only a spec imports is
reported. The two `rules` lines close knip's namespace-import blind spot (a module a spec imports as
`import * as x` would otherwise have all its exports counted as used).

```jsonc
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": [<TS_ENTRIES with a trailing ! each, e.g. "src/main.tsx!">],
  "project": [
    "<TS_SRC>/**/*.{ts,tsx}!",
    "!<TS_SRC>/**/*.{spec,test}.{ts,tsx}!",
    "!<TS_SRC>/**/*-fixtures.{ts,tsx}!",
    "!<TS_SRC>/test/**!"
  ],
  // Off: an export only its own file uses is a finding. knip-production.mjs turns it back on for --production,
  // where an export its own file uses and a spec imports is a testing seam.
  "ignoreExportsUsedInFile": false,
  "rules": { "nsExports": "error", "nsTypes": "error" }
}
```

```js
/**
 * knip's production run: the knip.jsonc of the directory knip runs from, with ignoreExportsUsedInFile turned
 * back on. Usage (from the package directory): npx knip --config <path-to>/scripts/knip-production.mjs --production --strict
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

// The package's own typescript reads the JSONC (comments allowed).
const ts = createRequire(path.join(process.cwd(), 'package.json'))('typescript');
const file = path.join(process.cwd(), 'knip.jsonc');
const { config } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));

export default { ...config, ignoreExportsUsedInFile: true };
```

knip reports a dependency that only non-JS config uses (a CLI named only in a shell script) as unused: add it to
`"ignoreDependencies"` with a comment, or name it in a `package.json` script. Never put a real source file in
`ignore`. A stale `"main"` field is a configuration hint: delete it.

### 2.14 `.jscpd.json` (repo root: Rust and TypeScript, code and tests in one run)

```json
{
  "format": ["rust", "typescript", "tsx"],
  "mode": "weak",
  "crossFormats": ["typescript,tsx"],
  "minTokens": 40,
  "minLines": 5,
  "threshold": 0,
  "gitignore": true,
  "absolute": false,
  "reporters": ["console"],
  "path": [<every Rust and TS source and test dir, quoted>],
  "ignore": ["**/target/**", "**/node_modules/**", "**/dist/**", "**/pkg/**", "**/coverage/**", "**/*.d.ts", <checked-in generated files>],
  "ignorePattern": [
    "(?m)^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?use\\s+[^;]+;",
    "import\\s+(?:type\\s+)?[\\w$]+(?:\\s*,\\s*\\{[^}]*\\})?\\s+from\\s+['\"][^'\"]+['\"];?",
    "import\\s+(?:type\\s+)?\\{[^}]*\\}\\s*from\\s+['\"][^'\"]+['\"];?",
    "import\\s+\\*\\s+as\\s+[\\w$]+\\s+from\\s+['\"][^'\"]+['\"];?"
  ]
}
```

[checked, jscpd 5.2.1 and 5.4.3 alike] jscpd has a Rust tokenizer; `weak` mode skips `//`, `/* */`, `///`,
`//!` and `/** */` comments (the default `mild` mode found only identical copies, not copies with different
comments); the `use` pattern removes single-line, multi-line and nested `use a::{…};` blocks. Rust is never
compared with TypeScript, even with `crossFormats` (a clone across the two languages needs a test that reads
both copies, Phase 6). `--ignore-identifiers` (renamed copies) is an audit flag, not the gate. A baseline
(`--baseline <file>` + `--fail-on-new-clones`) works for Rust; its directory must exist first, and its path is
resolved from the config file's directory. A pair kept on purpose is marked:

```rust
// jscpd:ignore-start — <why this pair stays>
...
// jscpd:ignore-end of the accepted pair
```

The end marker carries words so the commented-out-code rule does not read it as code.

[fixed 2026-11-11, jscpd 5.2.1] The baseline, as run:
- `threshold: 0` in `.jscpd.json` still fails a baseline run on the percentage ("too many duplicates (1.4%) over
  threshold (0.0%)"), whatever the baseline says: a baseline run passes `--threshold 100`, and
  `--fail-on-new-clones` decides.
- `--fail-on-new-clones [N]` takes an optional number and swallows the next argument: `--fail-on-new-clones
  src` is an error (`invalid digit found in string`). Write `--fail-on-new-clones 0`.
- Fingerprints are the clone's content: editing inside an accepted clone makes it a new one, and so does a
  restructure that moves the files. On a repo where 15 sessions were fixing lint findings, a one-hour-old baseline
  had 2 "new" clones that were lint edits of accepted pairs; one restructure commit then made 32 "new" while the
  total fell from 1178 to 1015. So `--fail-on-new-clones` cannot be the gate while the code moves. Counting per pair
  of folders does not hold either: jscpd reports each clone with ONE partner, so when code lives in three folders
  and one copy moves, the same clone is reported against another folder (that restructure took one pair from 191 to
  21 and raised two others, 37 → 42 and 5 → 6, with no new copy). What held: the gate is the TOTAL of clones between
  folders, which never grows (an edit, a move or a re-pairing keeps it; a new copy raises it), taken from
  `--reporters json --absolute` and kept in a committed file next to the baseline with the per-pair counts to read
  where a rise came from; jscpd's baseline only marks `[NEW]`. Build both from the committed tree
  (`git archive HEAD` into a temporary folder, the same config and paths), never from a working tree that holds
  uncommitted edits, and re-record them only when no pair went up.
- A repo of many apps: each folder's own run (every clone inside it) is that folder's zero gate; clones BETWEEN
  folders are one root run with `--skip-local <folder> <folder> …` (only pairs whose files sit under different
  paths). In that run the report names files relative to their path argument (`apps/x/src/a.rs`, not
  `docs-app/apps/x/src/a.rs`): add `--absolute` to read the pairs.
- Proven: a 10-line Rust fn copied into another folder with a different comment is a new clone (exit 1); the same
  in TS; an empty folder with `--fail-on-empty` exits 1 ("analyzed no files").

### 2.15 [ts, vitest] `stryker.config.mjs` (per package that has vitest specs)

```js
export default {
  testRunner: 'vitest',
  // Stryker's vitest runner does not support Vitest Browser Mode: point it at a jsdom/node config.
  // vitest: { configFile: 'vitest.unit.config.ts' },
  mutate: ['<TS_SRC>/**/*.{ts,tsx}', '!<TS_SRC>/**/*.{spec,test}.{ts,tsx}', '!<TS_SRC>/**/*-fixtures.{ts,tsx}', '!<TS_SRC>/test/**', '!<TS_SRC>/**/__tests__/**', '!<TS_SRC>/**/*.d.ts'],
  ignorePatterns: ['/target', '/pkg', '/dist', '/coverage', '/reports'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress'],
  clearTextReporter: { allowColor: false, reportTests: false },
  tempDirName: '.stryker-tmp',
  timeoutMS: 20000,
  timeoutFactor: 2,
  thresholds: { high: 100, low: 0, break: null },
};
```

`break: null` is deliberate: mutation is a report you act on, not a percentage gate. Anchor `ignorePatterns`
with `/` (an unanchored `reports` also matches `src/components/Reports`).

### 2.16 [ts] `<TS_SRC>/test/definedValue.ts` (spec helper)

```ts
/** A spec read a value its fixture promised and found nothing there: the fixture, not the code under test, is wrong. */
class FixtureValueMissingError extends Error {
  constructor(what: string) {
    super(`The fixture has no ${what}`);
    this.name = 'FixtureValueMissingError';
  }
}

/** `definedValue(rows[0], 'the first row')`: the value a spec indexes out of its own fixture, or a throw. */
export function definedValue<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new FixtureValueMissingError(what);
  }
  return value;
}
```

Rust's equivalent needs no helper: in tests, `.expect("the fixture has a first row")` (allowed by `clippy.toml`),
never `.unwrap()`.

---

## Phase 3: scripts

Create each file with `chmod +x`. They are bash and must run on macOS's bash 3.2 as well as on Linux.

[fixed 2026-11-11] **Never `<producer> | grep -q` under `set -o pipefail`.** `grep -q` exits at its first match;
the producer (`git ls-files`, `printf` of a long list) then dies of SIGPIPE (141) and the pipeline fails, so an `if`
reads "not found" exactly when the list is long and the match early. On a real repo a folder gate skipped its
ast-grep and file-length steps for every big folder this way and passed small ones. Count instead
(`n="$(git ls-files … | grep -cE '\.rs$' || true)"`) or feed grep a here-string (`grep -q … <<< "$list"`).
`<RUST_DIR>` is passed as the `RUST_DIR` environment variable (default `.`).

### 3.1 [rust] `scripts/rust-file-length.sh`: the `max-lines` of Rust

```bash
#!/usr/bin/env bash
# Rust file length, like eslint max-lines with skipBlankLines/skipComments: 400 code lines per source file,
# 730 per test file (tests/, *_tests.rs, */tests.rs). In a source file the count stops at the first column-0
# `#[cfg(test)]`: clippy's items_after_test_module keeps an inline test module last, so what follows is tests.
# Checked-in generated files: list them in GENERATED (an extended regex), each named in a comment with its generator.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
cd "${RUST_DIR:-.}"
MAX_SRC=400
MAX_TEST=730
GENERATED='^$'   # e.g. '^crates/proto/src/generated\.rs$'   # <generated by build.rs from proto/*.proto>
status=0
checked=0
while IFS= read -r f; do
  # a tracked file deleted in the working tree (a move in progress) is not there to count
  [[ -f "$f" ]] || continue
  case "$f" in
    tests/*|*/tests/*|*_tests.rs|*/tests.rs) max=$MAX_TEST; is_test=1 ;;
    *) max=$MAX_SRC; is_test=0 ;;
  esac
  n="$(awk -v is_test="$is_test" '
    !is_test && /^#\[cfg\(test\)\]/ { exit }
    { line = $0; sub(/^[ \t]+/, "", line) }
    inblock { if (index(line, "*/")) inblock = 0; next }
    line == "" { next }
    substr(line, 1, 2) == "//" { next }
    substr(line, 1, 2) == "/*" { if (!index(substr(line, 3), "*/")) inblock = 1; next }
    { count++ }
    END { print count + 0 }' "$f")"
  checked=$((checked + 1))
  if (( n > max )); then
    echo "$f: $n code lines (max $max): split it"
    status=1
  fi
# tracked files and new ones not yet added (not ignored): what the next commit can contain
done < <(git ls-files --cached --others --exclude-standard '*.rs' | sort -u | grep -vE "$GENERATED")
echo "rust-file-length: $checked files checked"
exit "$status"
```

[fixed 2026-11-11] As first written it read `git ls-files '*.rs'` only: a new file not yet `git add`ed was never
counted (the 401-line plant passed), and a tracked file deleted in the working tree stopped the script (awk could
not open it, `set -e`). [proven 2026-11-11: `<file>: 401 code lines (max 400): split it`, exit 1.]

### 3.2 [rust] `scripts/production-copy.sh`: the tree as production sees it

Used by the visibility report (3.3). [checked]

```bash
#!/usr/bin/env bash
# A copy of the committed tree with every test removed, so a visibility tool sees only production uses.
#   scripts/production-copy.sh <dest-dir>
# Removes: the bodies of tests/, benches/ and examples/ targets (each file becomes `fn main() {}` so
# [[test]]/[[bench]]/[[example]] paths stay valid), and every `#[cfg(test)]` module, inline or out-of-line.
# The non-test build never compiles those, so the copy builds exactly like production.
set -euo pipefail
dest="${1:?usage: $0 <dest-dir>}"
root="$(git rev-parse --show-toplevel)"
rm -rf "$dest"
mkdir -p "$dest"
git -C "$root" archive HEAD | tar -x -C "$dest"
cd "$dest"
# 1. test, bench and example targets: keep the file, drop the code.
find . -type f -name '*.rs' \( -path '*/tests/*' -o -path '*/benches/*' -o -path '*/examples/*' \) \
  -not -path './target/*' -print | while IFS= read -r f; do
  printf 'fn main() {}\n' > "$f"
done
# 2. #[cfg(test)] modules: `#[cfg(test)] mod x { ... }` (balanced braces) and `#[cfg(test)] mod x;`.
find . -type f -name '*.rs' -not -path './target/*' -print | while IFS= read -r f; do
  perl -0pi -e 's/^[ \t]*#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*(\{(?:[^{}]++|(?1))*\})//mg; s/^[ \t]*#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*;//mg' "$f"
done
```

It copies the **committed** tree (`git archive HEAD`): commit first, because uncommitted edits are not in the report.

### 3.3 [rust] `scripts/visibility-report.sh`: `pub` items across crates (report, not a gate)

rustc sees one crate at a time: a `pub` item exported from a library is never `dead_code`, even when no crate
of the workspace uses it, or only tests do. No tool for this is mature enough to be a zero-finding gate yet.
What a scratch fixture showed [checked]:

| Plant | cargo-fallow 0.3.0 | cargo-hawk 0.1.17 | cargo-workspace-unused-pub / warnalyzer |
| --- | --- | --- | --- |
| `pub fn` nobody uses | reported | reported | reported |
| `pub fn` only its own crate uses (should be `pub(crate)`) | reported | reported | missed |
| unread `pub` field | reported | reported | missed |
| `pub fn` only integration tests use | missed; reported on the production copy | the same | missed |
| used only via another crate's `macro_rules!`, a `#[serde(default = "f")]` string, or a feature | kept (correct) | kept (a `hawk.toml` feature profile must include all features) | warnalyzer: false positives; the other: a test fn reported |
| Run time on the fixture | 0.1–0.5 s, no build | 21 s cold, 4.7 s warm (compiles) | writes `index.scip` into the repo |

[proven 2026-11-11, cargo-fallow 0.3.0 on a scratch workspace] An unused `pub fn` gives `dead-public: No code
reaches the function `x`` and exit 1 with `--fail-on-issues`; a `pub fn` only tests use (unit or `tests/`) is already
reported without the production copy: `unnecessary-public: Only test code uses the function `x`. Put #[cfg(test)]
on it, or move it into the test module.` (the table's "missed" row is out of date for this version). Its advice is
not this brief's: delete such a function with its test, or move it into the test support it is; never put
`#[cfg(test)]` on production code. In a repo with one workspace per app, crates shared by path (a common library
workspace) look unused from their own workspace: check those findings against the whole repo.

cargo-fallow is syntax-based, 0.x and new (its JSON can change in a minor release). cargo-hawk is compiler-exact
but experimental and needs the exact rustc it was built for (0.1.17: 1.99.0), which may not be the repo's pinned
toolchain. Library crates without `publish = false` are treated as public API by both: set it (Phase 0).

```bash
#!/usr/bin/env bash
# pub items no production code of the workspace uses, or only their own crate uses. A report you act on in
# Phase 5 and before releases, not a gate: every finding is checked by hand before it is fixed.
#   scripts/visibility-report.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
copy="$(mktemp -d "${TMPDIR:-/tmp}/visibility.XXXXXX")"
trap 'rm -rf "$copy"' EXIT
bash scripts/production-copy.sh "$copy"
cd "$copy/${RUST_DIR:-.}"
# Exit 1 = findings (with --fail-on-issues), 2 = the run failed: never hide a 2.
status=0
cargo fallow visibility --fail-on-issues || status=$?
if [[ "$status" -ge 2 ]]; then echo "visibility report failed (exit $status)" >&2; exit "$status"; fi
echo "visibility report: exit $status (1 = findings above)"
```

For each finding: `pub` only its own crate uses → `pub(crate)` (then rustc's `dead_code` takes over); nothing
uses it → delete it; only tests use it → delete it with its test, or move it into the test support it really is.
Check a finding against macros, string references (serde, `#[wasm_bindgen]`, FFI names) and features before
acting: the report is a list of suspects, not a verdict.

### 3.4 [rust] `scripts/mutate-rust.sh`: mutation testing, whole or changed lines

[checked with cargo-mutants 27.1.0: exit codes, `--in-diff` with `--unified=0`, the empty-diff case]

```bash
#!/usr/bin/env bash
# Mutation testing for Rust (cargo-mutants). Not a gate: a tool you run on what a change touches.
#
#   scripts/mutate-rust.sh                                  # every package of the workspace, whole
#   scripts/mutate-rust.sh --package <crate>                # one package, whole
#   scripts/mutate-rust.sh --file <path/to/file.rs>         # one file, whole (repeatable)
#   scripts/mutate-rust.sh --in-diff <git-range>            # only the lines the range added or changed
#   scripts/mutate-rust.sh --in-diff origin/main --package <crate>   # the filters combine
#
# --in-diff takes `git diff <range>`; a single ref compares it with the working tree, which is what you
# want (a two-ref range must end at the working tree, or cargo-mutants exits 5). Untracked files are not
# in a diff: `git add -N <file>` first. Each mutant runs the tests of its own package, doctests included.
# A MISSED mutant is a statement no test observes (strengthen the test) or one with no effect (delete it);
# an equivalent mutant is the one case to leave, excluded by name in .cargo/mutants.toml with the reason.
# Exit status is cargo-mutants': 0 all caught, 2 missed, 3 timeouts (wins over 2), 4 tests fail unmutated.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
cd "${RUST_DIR:-.}"

RANGE=""
DIFF_FILE=""
FILTERS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --in-diff) RANGE="${2:?--in-diff needs a git range}"; shift 2 ;;
    --diff-file) DIFF_FILE="${2:?--diff-file needs a path}"; shift 2 ;;   # a prepared diff (mutation-report.sh)
    --package) FILTERS+=(--package "${2:?--package needs a crate name}"); shift 2 ;;
    --file) FILTERS+=(--file "${2:?--file needs a path}"); shift 2 ;;
    --) shift; break ;;
    *) sed -n '4,8p' "$0" >&2; exit 1 ;;
  esac
done
EXTRA=("$@")   # anything after `--` goes to cargo-mutants as is (e.g. `-- --timeout 60`)

# A shared absolute CARGO_TARGET_DIR makes every mutant build fight for one build lock.
unset CARGO_TARGET_DIR
OUT="target/mutants"
if [[ -n "$RANGE" ]]; then
  DIFF_FILE="$(mktemp "${TMPDIR:-/tmp}/mutants-diff.XXXXXX")"
  trap 'rm -f "$DIFF_FILE"' EXIT
  # --relative: paths from this directory, as cargo-mutants reads them. Fixed a/ b/ prefixes: a user's
  # diff.noprefix or diff.mnemonicPrefix setting would otherwise break the paths.
  git diff --relative --unified=0 --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ "$RANGE" -- '*.rs' > "$DIFF_FILE"
fi
DIFF_ARGS=()
if [[ -n "$DIFF_FILE" ]]; then
  # cargo-mutants treats an empty (or non-diff) file as "no changes" and exits 0 having tested nothing.
  if [[ ! -s "$DIFF_FILE" ]]; then
    echo "No Rust lines changed${RANGE:+ in $RANGE}: nothing to mutate (drop --in-diff for whole files)" >&2
    exit 0
  fi
  DIFF_ARGS=(--in-diff "$DIFF_FILE")
fi

echo "==> $(cargo mutants --version)${RANGE:+, the lines changed in $RANGE}${FILTERS[*]:+, ${FILTERS[*]}}"
status=0
# Never `--baseline skip`: with tests that fail unmutated, every mutant then counts as caught.
cargo mutants --workspace --output "$OUT" --jobs "${CARGO_MUTANTS_JOBS:-4}" --colors never \
  ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"} ${FILTERS[@]+"${FILTERS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"} || status=$?

for kind in missed timeout; do
  list="$OUT/mutants.out/$kind.txt"
  if [[ -s "$list" ]]; then
    echo "==> $(wc -l < "$list" | tr -d ' ') $kind (each diff: ${RUST_DIR:-.}/$OUT/mutants.out/diff/)"
    cat "$list"
  fi
done
exit "$status"
```

Mutant counts grow fast: a 150-file crate set listed ~8,600 mutants and a 400-file one ~65,000 [checked with
`cargo mutants --list`]. Whole-workspace runs are a campaign; the release report below mutates changed lines.

### 3.5 `scripts/mutation-report.sh`: the change's lines, mutated against their tests

Rust half [checked]; TypeScript half carried from the sibling brief with a new spec lookup that also finds specs in
`test/`/`__tests__/` folders and with extra suffixes such as `.unit.test.ts` [docs].

```bash
#!/usr/bin/env bash
# The mutation report of a change: every module it touched, mutated against its own tests, only the lines it
# added or changed. A source file whose tests alone changed is mutated whole: a test change is the moment to
# ask what else the tests miss. A report you act on before merging/releasing, not a gate.
#
#   scripts/mutation-report.sh <base-ref>            # e.g. origin/main, or the last release tag
#   scripts/mutation-report.sh <base-ref> --whole    # every changed file whole
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${1:?usage: $0 <base-ref> [--whole]}"
WHOLE="${2:-}"
ROOT="$PWD"
# A here-string, not a pipe: under pipefail `printf … | grep -q` fails when grep exits at an early match and
# printf's write of a long list gets SIGPIPE.   [fixed 2026-11-11]
is_in() { grep -qxF -- "$1" <<< "$2"; }

# ---- Rust: ONE cargo-mutants run (one baseline build) over the changed lines plus the whole files ----
export RUST_DIR="${RUST_DIR:-.}"
rust_report() {
  cd "$ROOT/$RUST_DIR"
  local gitdiff="git diff --relative --unified=0 --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/"
  local production changed with_mutants f stem dir crate target pkg diff_file
  local in_diff="" whole="" tests=""
  # The files cargo-mutants mutates: library and binary sources, never tests/ or #[cfg(test)] modules.
  production="$(cargo mutants --workspace --list-files)"
  changed="$(git diff --relative --name-only --diff-filter=d "$BASE" -- '*.rs')"
  if [[ -z "$changed" ]]; then echo "--- Rust: no .rs file changed since $BASE"; return 0; fi
  diff_file="$(mktemp "${TMPDIR:-/tmp}/mutation-report.XXXXXX")"
  $gitdiff "$BASE" -- '*.rs' > "$diff_file"
  with_mutants="$(cargo mutants --workspace --list --in-diff "$diff_file" | cut -d: -f1 | sort -u)"

  for f in $changed; do
    if ! is_in "$f" "$production"; then tests="$tests$f"$'\n'
    elif [[ "$WHOLE" == "--whole" ]]; then whole="$whole$f"$'\n'; echo "--- $f (whole: --whole)"
    elif is_in "$f" "$with_mutants"; then in_diff="$in_diff$f"$'\n'; echo "--- $f (changed lines)"
    else whole="$whole$f"$'\n'; echo "--- $f (whole: only its inline tests or comments changed)"
    fi
  done
  # A changed test file: its namesake source file whole. <dir>/<stem>_tests.rs and <dir>/<stem>/tests.rs test
  # <dir>/<stem>.rs; <crate>/tests/<stem>.rs tests the crate's src/**/<stem>.rs or src/**/<stem>/mod.rs.
  for f in $tests; do
    stem="$(basename "$f" .rs)"; dir="$(dirname "$f")"; crate=""; target=""
    case "$f" in
      tests/*|*/tests/*)
        case "$f" in */tests/*) crate="${f%%/tests/*}/" ;; esac
        target="$(printf '%s\n' "$production" | grep -E "^${crate}src/(.*/)?(${stem}\.rs|${stem}/mod\.rs)$" | head -1 || true)" ;;
      *_tests.rs) target="$(printf '%s\n' "$production" | grep -xE "${dir}/${stem%_tests}(\.rs|/mod\.rs)" | head -1 || true)" ;;
      */tests.rs) target="$(printf '%s\n' "$production" | grep -xE "${dir}(\.rs|/mod\.rs)" | head -1 || true)" ;;
      *) echo "--- $f: not a library or binary source, and not a test file: not mutated"; continue ;;
    esac
    if [[ -z "$target" ]]; then
      pkg="$(sed -n 's/^name *= *"\(.*\)"$/\1/p' "${crate}Cargo.toml" 2>/dev/null | head -1 || true)"
      echo "--- $f: tests with no namesake source file (a finding); mutate their crate whole: scripts/mutate-rust.sh --package ${pkg:-<crate>}"
    elif ! is_in "$target" "$in_diff" && ! is_in "$target" "$whole"; then
      whole="$whole$target"$'\n'; echo "--- $target (whole: its tests $f changed)"
    fi
  done

  # One diff: the changed lines of $in_diff, then every whole file as if it were new (all lines added).
  : > "$diff_file"
  for f in $in_diff; do $gitdiff "$BASE" -- "$f" >> "$diff_file"; done
  for f in $whole; do $gitdiff --no-index /dev/null "$f" >> "$diff_file" || true; done   # exits 1: files differ
  bash "$ROOT/scripts/mutate-rust.sh" --diff-file "$diff_file" || echo "    (exit $?: survivors above, or the tests fail unmutated)"
  rm -f "$diff_file"
}

# ---- TypeScript: file -> its specs anywhere in the package; Stryker line ranges per changed hunk ----
# Set PKG to the package directory that holds stryker.config.mjs (e.g. "web"), or "." for the root.
PKG="${PKG:-.}"
SPEC_RE='\.(spec|test)\.tsx?$'
regex_escape() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|]/\\&/g'; }   # a basename: no '/' to escape
specs_of() {   # src/a/price.ts -> price.spec.ts, price.unit.test.ts, __tests__/price.test.tsx, test/price.spec.ts ...
  local stem; stem="$(regex_escape "$(basename "${1%.*}")")"
  git ls-files -- "$PKG" | grep -E "(^|/)${stem}(\.[A-Za-z0-9_-]+)?${SPEC_RE}" || true
}
module_of() {   # the inverse: a changed spec -> the one production file it names (none or several: no module)
  local base stem hits; base="$(basename "$1")"; stem="${base%%.*}"
  hits="$(git ls-files -- "$PKG" | grep -E "(^|/)$(regex_escape "$stem")\.tsx?$" | grep -vE "${SPEC_RE}|\.d\.ts$" || true)"
  if [[ -n "$hits" && "$(printf '%s\n' "$hits" | wc -l | tr -d ' ')" == 1 ]]; then echo "$hits"; fi
}
ts_report() {
  cd "$ROOT"
  local f file target relative
  for f in $(git diff --name-only --diff-filter=d "$BASE" -- "$PKG" | grep -E '\.tsx?$' | grep -vE '\.d\.ts$|-fixtures\.'); do
    if [[ "$f" =~ $SPEC_RE ]]; then module_of "$f"; else echo "$f"; fi
  done | sort -u | while IFS= read -r file; do
    [[ -n "$file" && -f "$file" ]] || continue
    if [[ -z "$(specs_of "$file")" ]]; then echo "--- $file: NO SPEC (a finding)"; continue; fi
    relative="${file#"$PKG"/}"
    target="$relative"
    if [[ "$WHOLE" != "--whole" ]] && ! git diff --quiet "$BASE" -- "$file"; then
      target="$(git diff --unified=0 "$BASE" -- "$file" \
        | sed -nE 's/^@@ -[0-9,]+ \+([0-9]+)(,([0-9]+))? @@.*/\1 \3/p' \
        | awk -v f="$relative" '{ n = ($2 == "" ? 1 : $2); if (n > 0) printf "%s%s:%d-%d", (c++ ? "," : ""), f, $1, $1 + n - 1 }')"
    fi
    if [[ -z "$target" ]]; then echo "--- $file: only deletions"; continue; fi
    echo "--- $file ($target)"
    (cd "$PKG" && npx stryker run --mutate "$target") | grep -E '^\[Survived\]|^[-+] |^ *[A-Za-z].*\|' || true
  done
}

rust_report
ts_report
```

Delete the half for a language the repo does not have. Every survivor the report prints gets exactly one
outcome before merge or release: a test that kills it; deleting the statement it proves has no effect; or an
equivalence entry with its reason (`.cargo/mutants.toml` `exclude_re`, or `// Stryker disable next-line
<mutator>: <reason>`). A spec that lives in `__tests__/` and tests a module of another name is still found by
Stryker's per-test coverage; only the "NO SPEC" warning depends on the names.

### 3.6 [security] `scripts/secrets.sh`: gitleaks over the tree and the history

```bash
#!/usr/bin/env bash
# Secrets (gitleaks 8.30.1), two scans, one gate.
#   tree     every file git tracks or would add (untracked and not ignored): what the next commit can contain.
#            Ignored files (target/, node_modules/, a local .env) are not scanned: keep real credentials there or
#            outside the repo, never in a tracked file.
#   history  every commit reachable from HEAD: a secret deleted by a later commit is still published.
#            After Phase 5 proved the whole history clean, set HISTORY_FROM to that commit: later runs scan only
#            the commits after it (the full scan returns by itself if that commit is no longer an ancestor).
# Inline `gitleaks:allow` comments are ignored on purpose. Exceptions: .gitleaksignore or .gitleaks.toml (2.8).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
HISTORY_FROM=""   # e.g. HISTORY_FROM="<40-char sha of the commit Phase 5 scanned clean>"
gl() { gitleaks "$@" --no-banner --no-color --redact --ignore-gitleaks-allow \
  --config "$ROOT/.gitleaks.toml" --gitleaks-ignore-path "$ROOT/.gitleaksignore"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do
  if [[ -f "$f" && ! -L "$f" ]]; then printf '%s\0' "$f"; fi
done | tar --null -T - -cf - | tar -xf - -C "$tmp"
# Both scans run whatever the first found: one gate, and the report shows both.
status=0
echo "secrets: tree ($(find "$tmp" -type f | wc -l | tr -d ' ') files)"
(cd "$tmp" && gl dir -v .) || status=1

if [[ -n "$HISTORY_FROM" ]] && git merge-base --is-ancestor "$HISTORY_FROM" HEAD 2>/dev/null; then
  echo "secrets: history after ${HISTORY_FROM:0:12}"
  gl git -v --log-opts="$HISTORY_FROM..HEAD" . || status=1
else
  echo "secrets: history (all $(git rev-list --count HEAD) commits)"
  gl git -v . || status=1
fi
exit "$status"
```

Create an empty `.gitleaksignore` so the path exists. gitleaks exits 1 on a leak (or an error) [docs].
[fixed 2026-11-11] Under `set -e` the first version stopped at a tree finding, so the history scan never ran on the
run that needed it most. [proven 2026-11-11: the tree plant gave `leaks found: 1`, rule `aws-access-token`, exit 1;
the history scan of 2,237 commits found fixtures at paths a later commit had moved away, so it reads past
deletions.] Add `--report-format json --report-path <file>` to `gl` when you need the list for Phase 5.

### 3.7 [security] `scripts/security-report.sh`: the periodic report (not a gate)

Weekly in CI and before every release. It runs everything that is slow, needs network or a token, or reports
findings that need a person's judgement. Every finding gets one outcome: a fix, an ignore entry with its reason
and review date, or an issue with an owner.

```bash
#!/usr/bin/env bash
# Security report: dependencies including dev ones, workflows online, SAST (semgrep, CodeQL), risky casts.
# No `-e`: every section runs, and the report lists all of them. Output in reports/ (gitignored).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
RUST_DIR="${RUST_DIR:-.}"
TS_PACKAGES=(<every JS/TS package dir, e.g. "web">)
mkdir -p reports
step() { printf '\n==> %s\n' "$1"; }

step "osv-scanner: every lockfile, dev dependencies included (exit 1 = vulnerabilities)"
osv-scanner scan source -r .
for pkg in ${TS_PACKAGES[@]+"${TS_PACKAGES[@]}"}; do
  step "npm audit, dev dependencies included: $pkg"
  (cd "$pkg" && npm audit)
done
step "zizmor online (needs GH_TOKEN): impostor commits, known-vulnerable actions"
zizmor .
step "duplicate crate versions (size, and old copies of security fixes)"
(cd "$RUST_DIR" && cargo tree -d --workspace --edges normal --depth 0)
step "numeric casts and arithmetic that can truncate, wrap or overflow (counts per lint)"
(cd "$RUST_DIR" && cargo clippy --workspace --all-targets --locked --message-format=json -- \
  -W clippy::cast_possible_truncation -W clippy::cast_possible_wrap -W clippy::cast_sign_loss \
  -W clippy::arithmetic_side_effects | node "$ROOT/scripts/clippy-counts.mjs")
step "semgrep (registry rules: network; free for internal use under the Semgrep Rules License)"
semgrep scan --metrics=off --config p/rust --config p/typescript --config p/javascript \
  --sarif --output reports/semgrep.sarif --error .
step "CodeQL: Rust and JavaScript/TypeScript, no build needed"
for lang in rust javascript-typescript; do
  rm -rf "reports/codeql-db-$lang"
  codeql database create "reports/codeql-db-$lang" --language="$lang" --build-mode=none --source-root=. --overwrite &&
  codeql database analyze "reports/codeql-db-$lang" --download "codeql/${lang%%-*}-queries:codeql-suites/${lang%%-*}-security-extended.qls" \
    --format=sarif-latest --output="reports/codeql-$lang.sarif"
done
printf '\nsecurity report: read every section above and reports/*.sarif\n'
```

`scripts/clippy-counts.mjs` (also used for the Phase 5 counts):

```js
// Count cargo's JSON diagnostics per lint: `cargo clippy --message-format=json ... | node scripts/clippy-counts.mjs`.
import { createInterface } from 'node:readline';

const counts = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.startsWith('{')) continue;
  const message = JSON.parse(line);
  const code = message.reason === 'compiler-message' ? message.message?.code?.code : undefined;
  if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
}
for (const [code, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(6), code);
console.log(String([...counts.values()].reduce((a, b) => a + b, 0)).padStart(6), 'total');
```

CodeQL analyses Rust since 2.23.3 (generally available, `--build-mode=none` supported) [docs]. The query pack
names follow the language (`codeql/rust-queries`, `codeql/javascript-queries`); check them with
`codeql resolve packs` the first time. Optional supply-chain extras, not part of this brief: cargo-vet (audits
per crate version: worth it only with people to do the audits), cargo-geiger (counts `unsafe` in dependencies),
cargo-auditable (embeds the dependency list in shipped binaries so they can be scanned later).

### 3.8 `scripts/validate.sh`: every gate, in order, each a hard stop

Delete the steps for a language the repo does not have. Add one clippy step per shipped target that has its own
`cfg` code, one `tsc` step per TypeScript program, and one knip/vitest pair per JS/TS package. CI runs this
script and nothing else.

```bash
#!/usr/bin/env bash
# Every gate, cheapest first, tests last; a green run here is a green CI run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
RUST_DIR="${RUST_DIR:-.}"
export RUST_DIR
# One command per step: under `set -e` a failure on the left of `&&` does not stop the script.
step() { printf '\n==> %s\n' "$1"; }
in_rust() { (cd "$ROOT/$RUST_DIR" && "$@"); }

# ---- Rust ----
step "rustfmt";                           in_rust cargo fmt --all --check
step "clippy (host)";                     in_rust cargo clippy --workspace --all-targets <FEATURE_ARGS> --locked -- -D warnings
# step "clippy (wasm)";                   in_rust cargo clippy -p <web-crate> --target wasm32-unknown-unknown --all-targets --locked -- -D warnings
step "ast-grep: rule fixtures";           npx ast-grep test --skip-snapshot-tests
step "ast-grep: Rust source rules";       npx ast-grep scan
step "Rust file length";                  bash scripts/rust-file-length.sh
step "cargo-shear: deps, unlinked files"; in_rust cargo shear --deny-warnings
step "cargo test (incl. doctests)";       in_rust cargo test --workspace <FEATURE_ARGS> --locked

# ---- TypeScript (repeat per program / package) ----
step "tsc: <program>";                    npx tsc -p <tsconfig.json> --noEmit
step "eslint";                            npx eslint .
step "knip: <pkg>";                       (cd <pkg> && npx knip)
step "knip --production: <pkg>";          (cd <pkg> && npx knip --config <rel-path-to>/scripts/knip-production.mjs --production --strict)
step "vitest: <pkg>";                     (cd <pkg> && npx vitest run)

# ---- Everything ----
step "jscpd: Rust and TS, code and tests"; npx jscpd --fail-on-empty

# ---- Security ----
step "cargo-deny: advisories, licences, bans, sources"; in_rust cargo deny --locked check
step "npm audit (production dependencies): <pkg>";      (cd <pkg> && npm audit --omit=dev)
step "secrets (gitleaks)";                bash scripts/secrets.sh
step "workflows (zizmor, offline)";       zizmor --offline .github

printf '\nvalidate: every gate passed\n'
```

Notes:
- `cargo test` without `--all-targets` runs unit, integration and doc tests (`--all-targets` would skip
  doctests). It prints `test result: ok. N passed` per target: record the totals (Phase 4).
- `-D warnings` stops at the first crate that fails, and never lints the crates that depend on it [checked]. For
  counting (Phase 5), run clippy without `-D warnings` and with `--message-format=json` instead.
- `--all-features` fails on features that cannot be on together (a `compile_error!`) [checked]. Then
  `<FEATURE_ARGS>` is the set you ship, one clippy/test step per supported set, or
  `cargo hack clippy --feature-powerset --mutually-exclusive-features <a>,<b>` (cargo-hack 0.6.46) [checked].
- zizmor exits 3 when there are no workflows: drop that step in a repo without `.github/workflows`.

Add to the root `package.json` (knip reads `package.json` scripts, not shell scripts: a tool only `validate.sh`
calls is reported as an unused devDependency until a script names it):

```json
"scripts": {
  "validate": "bash scripts/validate.sh",
  "duplication": "jscpd --fail-on-empty",
  "duplication:pairs": "jscpd --reporters consoleFull",
  "rust:rules": "ast-grep scan",
  "rust:rules:test": "ast-grep test --skip-snapshot-tests",
  "dead-code": "knip",
  "dead-code:prod": "knip --config scripts/knip-production.mjs --production --strict",
  "mutation:report": "bash scripts/mutation-report.sh",
  "security:report": "bash scripts/security-report.sh"
}
```

---

## Phase 4: prove every gate works (mandatory)

For each row: make the planted change in a scratch file (or a real file), run the gate, confirm it **fails with
the message shown**, then revert by deleting what you added (never `git checkout --` a file with other edits in
progress). Put the table, with a ✔ per row and the exact text you saw, in your report. A row you cannot make fail
means that gate is not wired: fix the wiring, not the row. Rows marked [checked] were seen with the pinned
versions; for the others the text is what the rule or the docs say, so record what you actually see.

| Gate | Plant this | Must fail with |
| --- | --- | --- |
| clippy unwrap_used | `.unwrap()` on a `Result` in library code | `clippy::unwrap_used` … `used \`unwrap()\` on a \`Result\` value` [proven 2026-11-11] |
| clippy indexing_slicing | `v[0]` on a `Vec` in library code | `clippy::indexing_slicing` … `indexing may panic` [proven 2026-11-11] |
| clippy needless_bool | `if x { true } else { false }` | `clippy::needless_bool` [proven 2026-11-11] |
| clippy unnecessary_wraps | a `pub fn` that always returns `Ok(..)` | `clippy::unnecessary_wraps` [proven 2026-11-11] |
| clippy unused_async | an `async fn` with no `.await` | `clippy::unused_async` [proven 2026-11-11] |
| clippy match_same_arms | two match arms with identical bodies | `clippy::match_same_arms` [proven 2026-11-11] |
| clippy redundant_clone | `.clone()` of a value never used again | `clippy::redundant_clone` [proven 2026-11-11] |
| clippy collection_is_never_read | a `Vec` pushed to and never read | `clippy::collection_is_never_read` [proven 2026-11-11] |
| clippy let_underscore_must_use / unused_result_ok | `let _ = fallible();` / `fallible().ok();` | `clippy::let_underscore_must_use` / `clippy::unused_result_ok` (the first also fires rustc `let_underscore_drop` on the same line) [proven 2026-11-11] |
| clippy pub_use | `pub use crate::a::b;` | `clippy::pub_use` … `using \`pub use\`` [proven 2026-11-11] |
| clippy allow_attributes | `#[allow(dead_code)]` | `clippy::allow_attributes` … `#[allow] attribute found` [proven 2026-11-11] |
| clippy too_many_lines | a function with 101 lines in its BODY (103 with its signature and closing brace; 100 body lines pass) | `clippy::too_many_lines` … `(101/100)` [fixed 2026-11-11: the plant's size] |
| clippy excessive_nesting | five nested `if` blocks in a free function | `clippy::excessive_nesting` … `this block is too nested` [proven 2026-11-11] |
| rustc dead_code (test-only) | a private fn only a `#[cfg(test)]` test calls | `dead_code` … `function \`<name>\` is never used` [proven 2026-11-11] |
| rustc unreachable_pub | an unused `pub fn` in a private module | `unreachable_pub` and `dead_code` [proven 2026-11-11] |
| rustc dead_code (test helper) | an unused helper in `tests/it/common.rs` | `dead_code` [proven 2026-11-11] |
| clippy in tests | `.unwrap()` inside a `#[test]` | `clippy::unwrap_used` (`.expect("…")` passes) [proven 2026-11-11] |
| rustfmt | mis-indent one line | `Diff in …` and exit 1 [proven 2026-11-11] |
| ast-grep fixtures | change one `invalid` case of a rule test to valid code | `[Missing] Expect rule <id> to report issues, but none found in:`, `Error: test failed. 4 passed; 1 failed;`, exit 4 [proven 2026-11-11] |
| ast-grep test-asserts-nothing | `#[test] fn adds() { add(1, 2); }` | `error[rust-test-asserts-nothing]: test asserts nothing` [proven 2026-11-11] |
| ast-grep no-lint-suppression | `#[expect(dead_code, reason = "x")]` (clippy does not ban it) | `error[rust-no-lint-suppression]` [proven 2026-11-11] |
| ast-grep no-ignored-test | `#[ignore = "slow"]` on a test | `error[rust-no-ignored-test]: disabled test` [proven 2026-11-11] |
| ast-grep commented-out code | `// let total = add(1, 2);` | `error[rust-no-commented-out-code]` [proven 2026-11-11] |
| Rust file length | a source file with 401 code lines before its `#[cfg(test)]` | `<file>: 401 code lines (max 400): split it` [proven 2026-11-11] |
| cargo-shear (deps) | add an unused crate to `[dependencies]` | a finding naming the crate, exit 1 [checked: found] [proven 2026-11-11] |
| cargo-shear (misplaced) | a crate used only in `tests/` listed in `[dependencies]` | a misplaced-dependency finding [checked: found] [proven 2026-11-11] |
| cargo-shear (files) | a `.rs` file no `mod` declares | an unlinked-file finding; exit 1 only with `--deny-warnings` [proven 2026-11-11] |
| cargo test | `assert_eq!(add(1, 2), 4)` | `test result: FAILED` [proven 2026-11-11] |
| jscpd (Rust) | copy a 10-line Rust function into another crate, with different comments | `Clone found (rust)` and exit 1; in the between-folders run with a baseline: `Found N clones (1 new).`, `jscpd found 1 new clones not in the baseline (allowed: 0)` [proven 2026-11-11] |
| jscpd empty scan | `npx jscpd --fail-on-empty <an empty dir>` | exit 1 [proven 2026-11-11] |
| tsc noUncheckedIndexedAccess | `const xs = [1]; const n: number = xs[0];` | `error TS2322: Type 'number \| undefined' is not assignable to type 'number'.` [proven 2026-11-11, site/] |
| tsc noUnusedLocals | an unused `const` | `error TS6133: … is declared but its value is never read.` [proven 2026-11-11, site/] |
| eslint no-unnecessary-condition | `const s: string = 'a'; const t = s ?? 'b';` | `Unnecessary conditional, expected left-hand side of \`??\` operator to be possibly null or undefined` [proven 2026-11-11, site/] |
| eslint no-floating-promises | a bare call returning a promise | `@typescript-eslint/no-floating-promises` [proven 2026-11-11, site/] |
| eslint no-re-exports | `export { a } from './a';` | `custom/no-re-exports` [proven 2026-11-11, site/] |
| eslint no-use | `// eslint-disable-next-line` above any line | `Unexpected ESLint directive comment  @eslint-community/eslint-comments/no-use` [proven 2026-11-11, site/] |
| vitest expect-expect | `it('does something', () => { render(); });` | `vitest/expect-expect` (and `sonarjs/assertions-in-tests`) [proven 2026-11-11, site/] |
| vitest no-focused-tests | `it.only(...)` | `vitest/no-focused-tests` (and `sonarjs/no-exclusive-tests`) [proven 2026-11-11, site/] |
| knip (default) | in a non-entry file, `export` a const only that file uses | `Unused exports (1)` [proven 2026-11-11, site/] |
| knip (production) | an exported function only a spec imports, in a file production already imports | `Unused exports (1)` in the `--production` run only [fixed 2026-11-11: in a NEW file the same plant shows as `Unused files (1)`] |
| knip (files) | a new `.ts` file nothing imports | `Unused files (1)` [proven 2026-11-11, site/] |
| jscpd (TS) | copy a 10-line function into another file | `Found 1 clones.` and exit 1 [proven 2026-11-11] |
| eslint no-unsanitized | `el.innerHTML = userInput` | `no-unsanitized/property` [proven 2026-11-11, site/] |
| eslint string-to-code | `eval(x)` / `new Function(x)` | `no-eval` + `sonarjs/code-eval` / `no-new-func` + `@typescript-eslint/no-implied-eval` [proven 2026-11-11, site/] |
| eslint shell | `exec(\`ls ${dir}\`)` from `node:child_process` | `sonarjs/os-command` [fixed 2026-11-11: sonarjs 4.2.2's recommended set has it off, so nothing failed until 2.11 turned it on; also off in v4: no-unsafe-unzip, no-intrusive-permissions, no-mixed-content, frame-ancestors, unicode-aware-regex] |
| eslint ReDoS | `/(a+)+$/` | `regexp/no-super-linear-backtracking` + `sonarjs/slow-regex` [proven 2026-11-11, site/] |
| eslint weak random | `Math.random()` building a token | `sonarjs/pseudo-random` [proven 2026-11-11, site/] |
| cargo-deny advisories | pin `smallvec = "=1.6.0"` | `error[vulnerability]` … `ID: RUSTSEC-2021-0003`, `advisories FAILED`, exit 1 [proven 2026-11-11] |
| cargo-deny licences | delete `"MIT"` from `allow` | `error[rejected]: failed to satisfy license requirements`, exit 4 (cargo-deny's exit is a bit per failed check: advisories 1, bans 2, licences 4, sources 8) [fixed 2026-11-11: the exit code] |
| cargo-deny sources | a `git = "https://…"` dependency | `error[source-not-allowed]: detected 'git' source not explicitly allowed`, exit 8 [fixed 2026-11-11: the exit code] |
| npm audit --omit=dev | a production dependency `lodash@4.17.20` | `found … vulnerabilities` and exit 1 [proven 2026-11-11 another way, without installing into a shared node_modules: a real advisory with its exception removed failed the exceptions wrapper (Findings: npm audit has no ignore list)] |
| gitleaks (tree) | an untracked, not-ignored file with `AKIA` + 16 characters from A–Z and 2–7 (not ending `EXAMPLE`: the vendor's example key is allow-listed) | `leaks found: 1` (rule `aws-access-token`) and exit 1 [proven 2026-11-11] |
| gitleaks (history) | commit that file, then delete it in a second commit | still `leaks found: 1` from the history scan [proven 2026-11-11 another way, where no scratch commit was allowed: the history scan reported fixtures at paths a later commit had moved away, and passed once they were allow-listed] |
| zizmor | a workflow on `pull_request_target` that checks out the PR head, and `run: echo "${{ github.event.issue.title }}"` | `dangerous-triggers` and `template-injection`; exit 13 or 14 [proven 2026-11-11] |
| visibility report | a `pub fn` in a library nobody calls | `dead-public: No code reaches the function `<name>`. Remove it when no code needs it.`, exit 1 with `--fail-on-issues` [proven 2026-11-11, cargo-fallow 0.3.0] |
| mutation (Rust) | a function whose test calls it but never checks the result | a `MISSED` line and exit 2 from `scripts/mutate-rust.sh` [proven 2026-11-11] |
| mutation (Rust, changed lines) | change one line of a function, run `--in-diff HEAD` | mutants only on that function [proven 2026-11-11 with `--diff-file` of a one-line change: `Found 3 mutants to test`, all in that function] |
| mutation (TS) | the same, with `npx stryker run --mutate "<file>:<a>-<b>"` | a `[Survived]` line, mutants only on lines a–b [checked] |

[proven 2026-11-11] Plants often fire more than the row's lint, and that is fine: five nested `if`s also give
four `collapsible_if`, a `Vec::new()` then `.push` gives `vec_init_then_push`, a `&Vec` parameter gives `ptr_arg`,
`#[allow(dead_code)]` also gives `allow_attributes_without_reason`. Exit codes seen: clippy and cargo test 101,
rustfmt 1, cargo-shear 1 (`--deny-warnings` for the unlinked file: 0 without it), ast-grep scan 1, ast-grep test 4,
zizmor 14 for a high finding, cargo-mutants 2 for a MISSED mutant. In an agent sandbox that refuses `git init`, a
row that needs scratch commits is proven on the real repo's history instead, and `--in-diff` with a prepared diff
(`--diff-file`).

Write the plants so the brief itself never contains a key-shaped string: build the fake key in the scratch file,
not here. Also confirm each gate **scanned what it should**: jscpd prints "Files analyzed" per format (compare
with `git ls-files | grep -cE '\.(rs|ts|tsx)$'`); `cargo test` and vitest print their test counts; `sg test`
prints the cases it ran; `secrets.sh` prints the number of files in the tree scan. Record the numbers.

---

## Phase 5: baseline, then fix, in this order

Run every new rule once as a warning, count the findings, and write the counts down. Then fix one group, turn
it on in the gate, run `scripts/validate.sh`, and commit. Cheapest group first.

```bash
# Rust: every lint of the table at warn, counted per lint (no -D warnings, so every crate is linted)
(cd <RUST_DIR> && cargo clippy --workspace --all-targets <FEATURE_ARGS> --locked --message-format=json) | node scripts/clippy-counts.mjs
npx ast-grep scan --json=stream | node -e 'let c={};require("readline").createInterface({input:process.stdin}).on("line",l=>{const r=JSON.parse(l).ruleId;c[r]=(c[r]||0)+1}).on("close",()=>console.log(c))'
(cd <RUST_DIR> && cargo shear) ; bash scripts/rust-file-length.sh | tail -1
# TS: eslint once with the new rules at "warn", counted per rule
npx eslint . -f json -o /tmp/eslint.json; node -e 'const r=require("/tmp/eslint.json");const c={};for(const f of r)for(const m of f.messages)c[m.ruleId]=(c[m.ruleId]||0)+1;console.log(c)'
npx tsc -p <tsconfig.json> --noEmit --noUncheckedIndexedAccess 2>&1 | grep -c 'error TS'
# Everything
npx jscpd --reporters consoleFull | tail -5
(cd <RUST_DIR> && cargo deny --locked check 2>&1 | grep -cE '^error'); bash scripts/secrets.sh; zizmor --offline .github
```

1. **Dead code, imports, files and duplication.** rustc `dead_code`/`unreachable_pub`/`unused*`, cargo-shear,
   `clippy::pub_use`, knip, `no-re-exports`, jscpd; then run `scripts/visibility-report.sh` once and act on what
   holds up. Delete what is dead. Wire in what is really used but invisible to the tool (an entry point, a
   string reference), with a comment. Extract duplicates into a module with a specific name, never `utils`.
   Several integration-test files sharing a `tests/common/mod.rs`? Move them into one integration-test crate
   (`tests/it/main.rs` with `mod common; mod <area>;`): then `dead_code` sees every helper's use and an unused
   helper is reported [checked], instead of being "unused" in every other test binary.
2. **Logic that says more than it does.** The clippy `all`/`pedantic`/nursery set; typescript-eslint
   `no-unnecessary-*`, `no-else-return`, `no-lonely-if`, unicorn. `cargo clippy --fix --allow-dirty` and
   `eslint --fix` do part of it; review every automatic change.
3. **Escape hatches and suppressions.** `unwrap_used`, `expect_used`, `indexing_slicing`, `panic`, `todo`,
   `let_underscore_must_use`, `unused_result_ok`, the ast-grep suppression rule, `eslint-comments/no-use`. This
   group can change behaviour (a panic becomes an error a caller handles): follow the fix rules below and stop
   at any change a caller can observe.
4. **Tests that test.** The ast-grep test rules, the vitest rules. Rename assertion helpers `assert_…`/`expect…`.
   Fill in or delete empty tests; a "never fails" test asserts on its result.
5. **Types that do not lie (TS).** `noUncheckedIndexedAccess` in every tsconfig, then `no-unnecessary-condition`,
   `no-floating-promises`, `no-misused-promises`. If it has more than about 150 findings, split the tree into
   folders that do not overlap and give each worker the rules below. Re-run jscpd and knip afterwards.
6. **Security.** cargo-deny, `npm audit --omit=dev`, gitleaks on the tree and the whole history, zizmor, the TS
   security rules; then the security report once (3.7). A secret found in the history is **rotated** first and
   reported to the person who asked; rewriting history is their decision, never yours.
7. **Mutation on the change.** `scripts/mutation-report.sh <base>` on the branch: kill, delete or mark every survivor.

### How to fix each kind (the rules that keep a fix from becoming new slop)

**Rust**
- **`.unwrap()` / `.expect()` in production code:** return the error with `?` into a typed error (an enum with
  `thiserror`, or the crate's existing error type), or `let Some(x) = … else { return Err(Error::Missing("what")) };`.
  `.unwrap_or(default)` only when the default is what the code *should* do. Never `.unwrap_or_default()` to make an
  error disappear. In tests: `.expect("the fixture has a first row")`, saying what the fixture promised.
- **Indexing and slicing:** `.get(i)`, `.first()`, `.split_first()`, iterators, `zip`, slice patterns
  (`if let [a, b] = v.as_slice()`), `chunks_exact`, `str::get(a..b)` or `char_indices` for text. A length checked just
  above does not make indexing "safe enough": restructure so the check and the access are one operation.
- **`as` casts:** `From`/`Into` when lossless, `TryFrom` with an error when not. A conversion meant to saturate
  or wrap says so: `u8::try_from(x).unwrap_or(u8::MAX)` saturates; `wrapping_*` arithmetic wraps.
- **A fn that always returns `Ok`/`Some` (`unnecessary_wraps`):** return the plain value and update callers;
  if a trait requires the `Result`, the lint does not fire.
- **`async` without `await`, unused `self`:** make it a plain fn / an associated fn, and update callers.
- **`pub` that should not be:** `pub(crate)` first, then let `dead_code` tell you whether it is used at all.
- **`let _ = fallible()`, `.ok();`:** handle the error, or propagate it. If dropping it is right (best-effort
  cleanup), log it at the level the code uses for that, then drop it.
- **Identical match arms, `branches_sharing_code`:** merge the patterns (`A | B => …`) or hoist the shared code.
- **A dead test helper in `tests/`:** delete it; one integration-test crate (step 1) keeps this true.
- **Too long / too nested:** extract a named helper or a type with methods. Never raise the threshold.
- **A finding in generated code:** do not edit it; exclude the file by name with its generator in the comment.

**TypeScript** (as in the sibling brief)
- **An index read in production code:** destructuring with a default, `.find(...)`, `for…of`, `Object.entries`, a
  `Map`, or a non-empty tuple type. `?? fallback` only when the fallback is what the code should do; otherwise a
  small named error class. Never `!`, never a cast. In a spec: `definedValue(rows[0], 'the first row')`.
- **A guard the types say can never fire:** if the value crosses a boundary (HTTP body, `JSON.parse`, storage,
  env, DOM), keep the guard and make the type honest (optional field, `unknown`, `Partial<…>`); if it is internal,
  delete the guard. Check the producer first; fix a lying shared type at its source.
- **A floating promise:** `await` it; `void p` only when `p` catches its own errors; otherwise `.catch(...)`.
- **Complexity over 12, a test over 4 `expect`s:** split; never delete an assertion to pass `max-expects`.

**Security**
- **An advisory with a fixed version:** update to it (`cargo update -p <crate> --precise <v>`, `npm i <pkg>@<v>`),
  run the gates. **No fixed version:** replace the crate/package, or add an ignore entry with the id, why it does
  not apply here, and a review date. Unmaintained: plan the replacement; the ignore entry names the plan.
- **A dev-dependency advisory** (security report): bump within the pinned major when a fix exists; otherwise record it.
- **A licence outside the allow list:** replace the dependency, or ask the person who asked; never widen `allow`
  silently.
- **A secret:** rotate it at the provider first, then remove it from the tree. Mark the old fingerprint in
  `.gitleaksignore` only after rotation, with the date.
- **XSS sink (`innerHTML`, `insertAdjacentHTML`):** `textContent`, DOM building, or a sanitiser at the sink.
  **eval/Function:** a lookup table or a parser. **Shell:** `execFile`/`spawn` with an argument array, never an
  interpolated string. **ReDoS:** rewrite the regex (no nested quantifiers) or bound the input length first.
  **Weak random:** `crypto.getRandomValues` / `crypto.randomUUID` (TS), `getrandom`/`rand::rngs::OsRng` (Rust).
- **A workflow finding:** `pull_request_target` never checks out the PR head; pass untrusted `${{ … }}` values
  through `env:` and quote them; pin third-party actions to a full commit SHA; set `permissions:` minimal.
- **Release-profile hardening** (`[profile.release] overflow-checks = true`) turns silent integer wrap into a
  panic: it changes behaviour, so propose it to the person who asked; do not switch it on yourself.

---

## Phase 6: keep it (every future change)

- Run `scripts/validate.sh` before calling any change done. Green means every gate, not "mostly".
- Before merging or releasing, run `scripts/mutation-report.sh <base-ref>` and resolve every survivor it names.
  Write the survivor count and what you did about each into the PR or release notes.
- Weekly and before a release, run `scripts/security-report.sh` and give every finding an outcome.
- Adding code:
  - Rust: `pub` only for what another crate uses; `pub(crate)` otherwise. A function only a test uses is dead.
  - TS: export only what another module imports. An export only a test uses is dead.
  - A value kept in both a Rust and a TS copy (a route, an enum of states, a limit) needs a test that reads both.
  - New test helpers go in `tests/it/common.rs` (Rust) or `*-fixtures.ts`/`src/test/` (TS).
  - No new `jscpd:ignore` without its reason; no new entry in any allowlist, ignore list or `exclude_re` without
    its comment.
- Bumping the Rust toolchain, clippy or any pinned tool is its own change: rerun Phase 4 and the Phase 5 counts.
- Never raise a limit (100 lines per fn, nesting 5, 7 arguments, 400/730 lines per file, complexity 12, depth 3,
  4 expects, 0 clones). If something cannot fit, split it.
- A finding that looks wrong is usually a type that lies, a missing entry point, or a real bug. Investigate it
  before adding an exception, and never add a suppression attribute or comment.

---

## Report (what you hand back)

1. The **Phase 0 table** as filled in.
2. **What you installed**, with versions, and which files you created or changed.
3. The **Phase 4 proof table**, with ✔ per row, the exact text you saw, and the scan counts. Every row whose
   text differs from this brief, or that did not fail, is a numbered finding against this brief.
4. The **Phase 5 counts** per rule, before and after (after must be 0), and which fixes were automatic and
   which by hand.
5. **Every behaviour question you stopped at** (a panic that became an error, an `overflow-checks` proposal, a
   guard kept at a boundary), with file:line.
6. The **visibility report's findings** and the outcome of each.
7. The **security findings**: advisories (fixed or ignored with reason and date), secrets (rotated?), workflow
   findings, and what the security report raised.
8. The **mutation report's survivors** and the outcome for each.
9. **What you could not verify**, stated plainly.

---

## Findings from the first application (2026-11-11, one session per folder on a 20-workspace repo)

Each was seen by the session named; the fixes above already cover the Rust and repo-wide ones.

**Rust**
- `dead_code_pub_in_binary` on libraries (fixed in 2.2): 39 false findings in one two-crate workspace, 52 in
  another, 6 in a third, all items another crate uses. A bin crate may keep it as a level on its own `main.rs`
  (`#![warn(dead_code_pub_in_binary)]` is a level, not a suppression).
- `cargo shear` takes no `--manifest-path`: run it from the workspace directory.
- cargo-deny `wildcards = "deny"` fails on vendored path crates that do not say `publish = false`
  (`allow-wildcard-paths` covers only unpublished ones). When vendored code must stay pristine, the workspace says
  `wildcards = "allow"` with that reason, and `clippy::wildcard_dependencies` keeps covering its own members.
- A repo that already gates licences elsewhere (a third-party notices list) uses that list as `deny.toml`'s
  `allow` (ground rule 7): the brief's list is the minimum, not a cap set by this file.
- A new dependency in a shared path crate changes the `Cargo.lock` of every workspace that links it: commit those
  locks with it, or `--locked` fails for the others. Where several people edit one working tree, measure without
  `--locked` there (never committing a lock from it) and gate on a checkout of the commit plus your own files,
  where `--locked` stays.
- The `dead_code_pub_in_binary` numbers per library, for scale: 255, 235, 174, 136, 64, 55, 52, 39, 6; every one an
  item another crate uses (`--lib`: 0; `--lib --tests`: all of them).
- `cargo clippy --fix` with `unreachable_pub` on a Leptos `#[component] pub fn` writes `pub(crate)(crate) fn` (the
  macro repeats the span) and the whole crate's fixes roll back: change those by hand first, then `--fix`.
- The Phase 4 advisory plant `smallvec = "=1.6.0"` does not resolve in a tree that needs smallvec ^1.10 (rsa 0.9 via
  num-bigint-dig): `cargo metadata` fails before cargo-deny looks. `atty = "=0.2.14"` resolves anywhere and gives
  RUSTSEC-2024-0375 and RUSTSEC-2021-0145; or plant in a scratch crate.

**TypeScript**
- Phase 1: npm 10.9 (Node 22) crashed (`Cannot read properties of null (reading 'edgesOut')`) installing vitest in
  the same `npm i` as the ESLint set; two installs work.
- Phase 5 "review every automatic change" has teeth: `eslint --fix` with `unicorn/no-useless-spread` turned
  `for (const n of [...url.searchParams.keys()]) url.searchParams.delete(n)` into a live iteration that skips names
  (a behaviour change). Keep the rule; write the snapshot as `Array.from(...)` with a comment saying why.
- `@typescript-eslint/no-unnecessary-type-assertion`'s autofix (8.67.0) removed casts tsc needed
  (`querySelector(...) as (HTMLElement & {...}) | null`): rewrite as `querySelector<T>(...)` or a typed const.
- sonarjs 4 `no-skipped-tests` flags Playwright's conditional `test.skip(cond, 'reason')`; the rule accepts a comment
  with the reason on the same or the next line.
- knip 6.37 does not count a computed key (`{ [NAME]: v }`) as a use of `NAME`: an export used only that way is
  reported by the production run. Use it in a plain call or property access (`headers.set(NAME, v)`).
- `no-unsanitized/method` flags `import(pathToFileURL(file).href)` of a module a spec writes at run time; there is
  no honest rewrite, so the exception lives in the ESLint config, naming the spec files and the reason (never a
  comment in the source).
- `npm audit` has no ignore list, so "an ignore entry with the id, the reason and a review date" needs a small
  wrapper (a JSON file of exceptions; fail on an unlisted advisory, a passed review date or a stale entry). A
  dependency bundled inside another package (`bundleDependencies`) cannot be fixed with `overrides`.

**The repo-wide pieces** (one session for the whole repo, the folders using them)
- No root workspace: each folder's `validate.sh` runs its share of the repo-wide tools (ast-grep over the folder,
  file length, clones inside the folder) through one script; the root runs fixtures, clones between folders,
  secrets and workflows once per batch.
- Every machine that runs a gate needs the same pinned tools: one install script with `--check`, called by the gates
  so a missing or wrong version says what to run.

---

## Sources

Checked against the tools' own documentation on 2026-11-10:
[clippy lint list](https://rust-lang.github.io/rust-clippy/stable/index.html),
[rustc allowed-by-default lints](https://doc.rust-lang.org/rustc/lints/listing/allowed-by-default.html) (`dead_code_pub_in_binary`),
[Cargo `[lints]`](https://doc.rust-lang.org/cargo/reference/manifest.html#the-lints-section),
[cargo-shear](https://github.com/Boshen/cargo-shear),
[cargo-mutants `--in-diff`](https://mutants.rs/in-diff.html),
[cargo-deny advisories config](https://embarkstudios.github.io/cargo-deny/checks/advisories/cfg.html),
[cargo-fallow](https://github.com/fallow-rs/cargo-fallow),
[cargo-hawk](https://github.com/astral-sh/hawk),
[gitleaks](https://github.com/gitleaks/gitleaks),
[zizmor usage and exit codes](https://docs.zizmor.sh/usage/),
[osv-scanner configuration](https://google.github.io/osv-scanner/configuration/),
[CodeQL Rust generally available](https://github.blog/changelog/2025-10-23-codeql-2-23-3-adds-a-new-rust-query-rust-support-and-easier-c-c-scanning/),
[Semgrep rules licensing](https://semgrep.dev/docs/licensing),
[vitest advisory GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8),
[ESLint version support](https://eslint.org/version-support/).
