# API Verification Patterns

Principal engineer patterns for preventing API hallucination and catching integration errors before they reach production.

The commands are shown as a developer types them. On the platform, a role that runs code runs each as one `run`
argv (no shell pipes); a reviewer, which runs no code, reads the same evidence with `read_file` (the installed
package's source and type definitions under `node_modules/` or the virtual environment) and `read_patch`. The
sandbox has no network, so only the installed source counts as verification.

## Pre-Use Verification

Before calling any third-party API for the first time in a file:

### 1. Import Resolution

Verify the import resolves to a real module:

| Stack | Verification |
|---|---|
| Python | `python3 -c "import <module>; print(<module>.__file__)"` |
| Python | Check `pyproject.toml` or `requirements.txt` for the dependency |
| TypeScript | `node -e "require.resolve('<package>')"` |
| TypeScript | Check `package.json` dependencies |
| Go | `go list <package>` |

Flag: Import exists in code but NOT in dependency manifest = phantom dependency.

### 2. Method/Function Existence

Verify the specific method exists on the module or class:

**Local verification (package installed):**

| Stack | Verification |
|---|---|
| Python | `python3 -c "import <module>; print(dir(<module>.<class>))"` |
| Python | `python3 -c "import inspect; print(inspect.signature(<module>.<func>))"` |
| TypeScript | Read `.d.ts` type definitions in `node_modules/<pkg>/` |
| Go | `go doc <package>.<Symbol>` |

**Package not installed:** the upstream source (its repository, its published docs) needs the network, which the
sandbox does not have. Say in your finding or finish that the call could not be verified, and name the package and
version from the lockfile; never call an unverified API verified.

Flag: Method name not in `dir()` output or the `.d.ts` = hallucinated API.

### 3. Signature Verification

Verify parameter names, types, and return type match actual library:

| Check | How |
|---|---|
| Parameter count | `inspect.signature()` or type stubs |
| Parameter names | Match actual keyword arguments |
| Return type | Check type stubs or docstring |
| Required vs optional | Check for defaults in signature |

Flag: Wrong parameter count or name = will fail at runtime.

### 4. Version Compatibility

| Check | How |
|---|---|
| Feature added in version X | Read CHANGELOG or release notes |
| Deprecated in version Y | Check for deprecation warnings in source |
| Current installed version | `pip show <pkg>` or `npm ls <pkg>` |

Flag: Using API from newer version than installed = runtime error.

## MCP-Assisted Verification

When MCP servers are configured, use them for verification:

| MCP Server | Verification Use |
|---|---|
| GitHub MCP | Read source files from any GitHub repo. `get_file_contents`, `search_code` |
| Context7 | Fetch current docs for the specific library version |
| lsp-mcp | Go-to-definition, hover for type info, find references |
| Codebase-Memory-MCP | Trace call paths, find usage patterns in codebase |

## Dependency Impact Analysis

Before modifying a function signature or removing an export:

1. **Find all callers**: `Grep` for the function name across the codebase
2. **Check test coverage**: Grep test files for the function name
3. **Check type compatibility**: If changing return type, verify all callers handle the new type
4. **Check across packages**: In monorepos, check all packages that import the changed module

### Blast Radius Categories

| Change | Risk | Check |
|---|---|---|
| Add optional parameter | Low | No callers break |
| Remove parameter | High | ALL callers must update |
| Change return type | High | ALL consumers must handle |
| Rename function | High | ALL imports must update |
| Change default value | Medium | Callers relying on default may break |

## Breaking Change Detection

Compare the change against its base: read the patch (`read_patch`, every page) and look for

- added or changed lines starting with `def ` (Python) or `export ` (TypeScript): changed signatures and exports;
- removed lines starting with `def ` or `export `: removed public functions and exports.

Flag: Any removed or renamed public function/export = potential breaking change.

## Circular Dependency Detection

| Stack | Command |
|---|---|
| TypeScript/JS | `npx depcruise --validate .dependency-cruiser.cjs src/` |
| Python | `python3 -c "import importlib; importlib.import_module('<pkg>')"` (fails on circular) |
| Go | `go vet ./...` (catches import cycles) |

Flag: Circular imports cause runtime errors or undefined behavior.

## Test Coverage for New Code

After writing new code, verify test coverage:

```bash
# Python
pytest --cov=src --cov-report=json && python3 -c "
import json
data = json.load(open('coverage.json'))
for f, info in data['files'].items():
    missing = info['summary']['missing_lines']
    if missing > 0: print(f'{f}: {missing} uncovered lines')
"

# TypeScript (with c8 or istanbul)
npx c8 --reporter=json npm test
```

Flag: New public functions without any test = SHOULD level issue.

## Configuration Drift Detection

Verify code and config stay in sync:

| Check | How |
|---|---|
| Env vars in code but not .env.example | `grep -roh 'process\.env\.\w\+\|os\.environ\[.*\]' src/ \| sort -u` vs `.env.example` |
| Routes in code but not documented | Compare route decorators against API docs |
| Feature flags in code but not in config | Grep for flag names across config files |
