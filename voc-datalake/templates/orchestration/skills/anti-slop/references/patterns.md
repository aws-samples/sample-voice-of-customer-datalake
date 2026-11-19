# Anti-Slop Pattern Reference

Detailed patterns with code examples. Referenced from SKILL.md when explaining findings to users.

## Code Slop (12 patterns)

### 1. Defensive Multi-Format Parsing
Multiple try/catch JSON parse attempts, `ast.literal_eval`, regex munging on API responses.
```python
# SLOP: parsing defensively instead of fixing the source
try:
    data = json.loads(response)
except:
    try:
        data = ast.literal_eval(response)
    except:
        data = {}
```

### 2. Unsafe Type Assertions on External Data
`as SomeType` on API responses, `JSON.parse`, `localStorage`.
```typescript
// SLOP: trusting external data
const user = JSON.parse(body) as User;
// FIX: validate at boundary
const user = UserSchema.parse(JSON.parse(body));
```

### 3. Silenced Errors
Empty `catch {}` or `except: pass` without logging.

### 4. Premature Abstraction
Helpers/utils with exactly 1 caller. Inline unless 3+ callers exist.

### 5. Cargo-Cult Patterns
- `useCallback` not in dependency arrays
- `useMemo` on cheap computations
- `React.memo` on components rendered once
- `@lru_cache` on functions called once
- `@functools.wraps` on non-decorator functions
- ABCs with exactly 1 implementation
- Factory functions that always return the same type

### 6. Inconsistent Async
Mixing `.then()` and `async/await` in same file. `.then()` without `.catch()`. `async` functions that never `await`.

### 7. Unnecessary Type Complexity
`Record<string, unknown>` where a 5-field interface suffices. `any` without comment. Generics always used with same concrete type.

### 8. Dead Code
Exports with 0 importers. Commented-out blocks > 3 lines. Unused imports. Unreachable branches.

### 9. Magic Values
Bare numbers (not 0, 1, -1) encoding business logic. Bare strings as discriminators.

### 10. Over-Engineering
Feature flags that never toggle. Config for values that never change. Plugin systems with 1 plugin. Strategy pattern with 1 strategy. Builder for 3-field objects.

### 11. Copy-Paste Normalization
Same mapping logic in frontend AND backend. Same validation in client AND server without shared schema. Same enum in 2+ places.

### 12. Defensive Null Chains
3+ `?.` chains masking missing boundary validation.

### 48. Write-Only Fields
Fields or attributes that are set or incremented but never read. Common AI pattern: adding tracking fields "just in case" without any consumer.
```python
# SLOP: access_count incremented but never read (LRU uses OrderedDict ordering)
class _AccessRecord:
    __slots__ = ("adapter_id", "access_count", "last_access")
    def __init__(self, adapter_id: str) -> None:
        self.adapter_id = adapter_id  # duplicates the dict key
        self.access_count = 0         # incremented but never checked
        self.last_access = time.monotonic()
    def touch(self) -> None:
        self.access_count += 1
        self.last_access = time.monotonic()

# FIX: remove write-only fields
class _AccessRecord:
    __slots__ = ("last_access",)
    def __init__(self) -> None:
        self.last_access: float = time.monotonic()
    def touch(self) -> None:
        self.last_access = time.monotonic()
```
Grep: look for fields in `__init__` that are only assigned, never appear in conditionals, returns, or method calls. `vulture` catches some but misses incremented-never-read fields.

### 49. Impossible Condition Guards
A null/error check placed after a code path that structurally guarantees the condition cannot occur. AI adds these as "defensive programming" but they mask logic confusion.
```python
# SLOP: ensure_gpu() already raises KeyError if adapter not registered
# so meta can never be None here
self._cache.ensure_gpu(adapter_id)
meta = self._registry.get(adapter_id)
if meta is None:  # impossible, ensure_gpu already validated this
    return [_error_result("Adapter not found")]

# FIX: remove the impossible check, add a comment explaining why it's safe
self._cache.ensure_gpu(adapter_id)
# Registry lookup guaranteed to succeed: ensure_gpu already verified the adapter exists
meta = self._registry.get(adapter_id)
```
Detection: trace data flow. If the preceding code raises or returns on the failure case, a subsequent check for that same failure is dead logic.

### 50. Silent Data Fallbacks
Using `dict.get(key, dangerous_default)` where the fallback silently produces wrong results instead of failing loudly. AI generates these to "handle missing keys gracefully" but they mask data corruption.
```python
# SLOP: if "id2label" key is missing, uses the ENTIRE raw dict as the label map
label_map = raw_map.get("id2label", raw_map)

# SLOP: missing key silently returns default instead of surfacing the problem
config_value = settings.get("batch_size", settings)

# FIX: require the key, fail explicitly
if "id2label" not in raw_map:
    msg = f"label_map.json missing 'id2label' key for {adapter_id}"
    raise ValueError(msg)
label_map = {int(k): v for k, v in raw_map["id2label"].items()}
```
Grep: `\.get\(.*,\s*\w+\)` where the fallback is a variable (not a simple literal like `0`, `""`, `None`, `False`, `[]`).

### 51. Deprecated API Usage
Using deprecated stdlib or framework APIs when modern replacements exist. AI training data contains older patterns.
```python
# SLOP: deprecated since Python 3.10, emits DeprecationWarning in 3.12+
loop = asyncio.get_event_loop()
future = loop.create_future()

# FIX: use get_running_loop() in async context
loop = asyncio.get_running_loop()
future = loop.create_future()

# SLOP: datetime
from datetime import datetime
now = datetime.utcnow()  # deprecated in 3.12

# FIX
from datetime import datetime, timezone
now = datetime.now(timezone.utc)
```
Grep targets: `get_event_loop`, `utcnow`, `utcfromtimestamp`, `pkg_resources` (use `importlib.metadata`), `distutils` (use `setuptools`), `typing.Optional` in 3.10+ (use `X | None`).

### 52. Duplicated Constants
Same magic value defined in two or more files instead of a shared constant. AI generates each file independently and doesn't check for existing definitions.
```python
# SLOP: 1_000_000 defined in both registry.py and loader.py
# registry.py
_MAX_CONFIG_BYTES = 1_000_000

# loader.py (same value, different variable)
_MAX_FILE_SIZE = 1_000_000

# FIX: define once, import everywhere
# constants.py or the canonical module
_MAX_CONFIG_BYTES = 1_000_000

# loader.py
from mimecast.adapters.registry import _MAX_CONFIG_BYTES
```
Detection: grep for the same numeric or string literal appearing in 2+ files. Check if they represent the same concept.

### 53. Framework Anti-Patterns
Fighting framework conventions instead of working with them. Common: reading file contents before checking file size (DoS vector), mutating Pydantic models after validation.
```python
# SLOP: reads entire file into memory THEN checks size (2GB file = OOM)
raw = config_file.read_bytes()
if len(raw) > _MAX_CONFIG_BYTES:
    raise ValueError("File too large")
config = json.loads(raw)

# FIX: check size via stat() before reading
if config_file.stat().st_size > _MAX_CONFIG_BYTES:
    raise ValueError("File too large")
config = json.loads(config_file.read_bytes())

# SLOP: mutating Pydantic model fields after construction
config = AppConfig()
config.max_batch_size = 128  # bypasses validation

# FIX: pass values at construction time
config = AppConfig(max_batch_size=128)
```
Grep: `read_bytes()` or `read()` followed by `len(` check. `model.field =` on Pydantic models outside `__init__`.

### 54. Inconsistent Import Style
Same package imported at module level AND inside a function in the same file. AI adds deferred imports to avoid circular deps but also imports the same package at the top.
```python
# SLOP: peft imported at top AND inside function body
from peft import PeftModel  # top-level

def _placeholder_config():
    from peft import TaskType  # deferred, why? peft is already imported above
    return LoraConfig(task_type=TaskType.SEQ_CLS)

# FIX: import everything from the same package at the same level
from peft import LoraConfig, PeftModel, TaskType

def _placeholder_config():
    return LoraConfig(task_type=TaskType.SEQ_CLS)
```
Detection: for each `from X import` at module level, check if `from X import` also appears inside any function body in the same file. If so, consolidate.

## AI Hallucination (6 patterns)

### 12a. Hallucinated Imports
Imports from modules that don't exist or wrong module.
```python
from collections import OrderedSet  # doesn't exist
from typing import Annotated  # wrong module for < 3.9
```

### 12b. Language Leaks
Python code using Java/JS patterns:
```python
# SLOP: Java-style
class User:
    def get_name(self): return self._name
    def set_name(self, name): self._name = name
# FIX: @property

# SLOP: JS methods on Python objects
items.forEach(lambda x: process(x))  # doesn't exist
len = items.length  # .length is JS
```
Detectable: `.length`, `.push()`, `.forEach()`, `.toString()`, `.isEmpty()`, `.equals()` on Python objects.

### 12c. Hedging Comments
"should work", "hopefully", "probably", "might work", "try this". These signal low confidence.

### 12d. Placeholder Implementations
`pass`, `...`, or `raise NotImplementedError` in non-abstract methods.

### 12e. Single-Method Classes
Classes with one public method. Should be a plain function.
```python
# SLOP
class DataProcessor:
    def process(self, data): return [x * 2 for x in data]
# FIX
def process_data(data): return [x * 2 for x in data]
```

### 12f. Overconfident/Apologetic Comments
"obviously", "simply", "just", "trivially", "sorry", "hacky", "ugly but works".

## AI Content Slop (prose, docs, comments, commit messages)

### 12g. Em Dash Overuse
LLMs use em dashes (`—`) 3-10x more than human writers. Replace with punctuation humans actually use.
```markdown
# SLOP
Skills for writing clean code, and catching AI slop, before it ships.
# FIX (use period, comma, colon, or parentheses)
Skills for writing clean code and catching AI slop before it ships.
```
Look for: `—` (U+2014). Allowed in table separators only.

### 12h. Weasel Words
Vague corporate verbs that say nothing. Replace with direct language.
```markdown
# SLOP                              # FIX
leverage                             use
utilize                              use
ensure                               check / verify / confirm
facilitate                           help / allow
implement                            build / write / add
comprehensive                        (delete, or be specific: "covers X, Y, Z")
robust                               (delete, or be specific: "handles X errors")
streamline                           simplify / speed up
optimize                             speed up / reduce / shrink
scalable                             (delete, or be specific: "handles 10k requests/sec")
```

### 12i. Filler Qualifiers and AI Slop Phrases
Words and phrases that pad sentences without adding meaning. Delete them.

**Single-word/short filler:**
```markdown
# SLOP                              # FIX
"It's worth noting that X"          "X"
"Importantly, ..."                  (delete)
"Essentially, ..."                  (delete)
"Ultimately, ..."                   (delete)
"In order to"                       "To"
"At the end of the day"             (delete)
"It should be noted that"           (delete)
"As a matter of fact"               (delete)
"Needless to say"                   (delete, and don't say it)
"Due to the fact that"              "Because"
"Prior to"                          "Before"
"In the event that"                 "If"
"With regard to"                    "About" or "For"
"At this point in time"             "Now"
```

**Complete AI slop phrases (ban entirely):**
These are hallmarks of AI-generated text. Delete on sight:
```
"In today's rapidly evolving landscape..."
"Leveraging the power of..."
"Let's dive in / dive deep..."
"This comprehensive guide will..."
"In conclusion, [restates everything]"
"Whether you're a beginner or expert..."
"In this blog post, we will..."
"In this section, we will..."
"As we can see..."
"It is important to note that..."
"Without further ado..."
"Before we begin..."
"First and foremost..."
```

**Nominalizations (turn back into verbs):**
```markdown
# SLOP                              # FIX
"Make a decision"                   "Decide"
"Perform an analysis"               "Analyze"
"Conduct a review"                  "Review"
"Provide assistance"                "Help"
"Give consideration to"             "Consider"
```

### 12j. Minimizers
Words that imply something is easy when it may not be. Removes useful signal about complexity.
```markdown
# SLOP                              # FIX
"Simply run the install script"     "Run the install script"
"Just add the config"               "Add the config"
"Easily configure X"                "Configure X"
"Trivially extends to Y"            "Extends to Y"
```

### 12k. Marketing Speak
Superlatives and buzzwords with no technical content. Never in code, docs, or comments.
```
# NEVER USE
cutting-edge, industry-leading, best-in-class, next-generation
world-class, state-of-the-art, revolutionary, game-changing
seamless, frictionless, blazing-fast, enterprise-grade
innovative, transformative, empowering, synergy
```

### 12l. Vague Quantifiers
Numbers exist. Use them.
```markdown
# SLOP                              # FIX
"Various tools are supported"       "6 tools are supported: ruff, pyright, ..."
"Numerous improvements"             "3 improvements: ..."
"Significant performance gain"      "40% faster"
"Many patterns detected"            "48 patterns detected"
"Several options available"         "4 options available"
```

## SOLID/DRY Violations (5 patterns)

### SRP: Single Responsibility
- Files > 500 lines
- Classes > 15 methods
- Functions > 50 lines
- > 20 imports in one file

### OCP: Open/Closed
Switch/case or if-elif chains on type discriminators:
```python
if obj.type == "a": handle_a(obj)
elif obj.type == "b": handle_b(obj)
elif obj.type == "c": handle_c(obj)
```
Grep: `if.*\.type\s*==`, `switch.*\.kind`, `isinstance.*isinstance` chains

### DRY: Duplicated Logic
Same logic in multiple places. Tool: `pylint --disable=all --enable=R0801`, `jscpd`.

### YAGNI: Speculative Generalization
ABCs with 1 impl, plugin systems with 1 plugin, factories returning 1 type, config nobody changes.

### KISS: Unnecessary Complexity
- Cyclomatic complexity > 10
- Nesting depth > 4
- Cognitive complexity > 15

## Comment Slop (6 patterns)

### 13. Restating Comments
```python
# SLOP
def get_user_by_id(user_id):
    """Gets a user by their ID."""
# OK: explains WHY
def get_user_by_id(user_id):
    """Fetches from cache first, falls back to DB. Returns None if soft-deleted."""
```

### 14. AI-Preamble Comments
Block comments at top explaining what AI was asked to do.

### 15. Stale Comments
Comments describing code that changed. "retry 3 times" but code retries 5.

### 16. Excessive Inline Comments
More comment lines than code lines. Simplify the code instead.

### 17. TODO Without Owner
`// TODO: fix this later` with no ticket or owner.

### 18. Docstrings on Private Functions
Private functions don't need docstrings unless genuinely non-obvious.

## Test Slop (6 patterns)

### 19. Over-Mocked Tests
Mock setup longer than code under test.

### 20. Sleep-Based Tests
`time.sleep()` / `setTimeout()` / `Thread.sleep()` in tests. Use proper synchronization.

### 21. Snapshot Overuse
Snapshots for frequently-changing UI. Use targeted assertions.

### 22. Tests That Can't Fail
No assertions, or always-true assertions.

### 23. Test Logic Duplication
Same setup/teardown in 10 tests. Use fixtures/beforeEach.

### 24. Testing Implementation, Not Behavior
Asserting internal state, method call order, private methods.

## Performance Slop (5 patterns)

### 25. N+1 Queries
```python
# SLOP
for user_id in user_ids:
    user = db.get_user(user_id)
# FIX
users = db.get_users(user_ids)
```

### 26. Allocation in Hot Loops
Creating objects, compiling regexes, opening connections inside high-iteration loops.

### 27. Synchronous I/O in Async Context
`requests.get()`, `time.sleep()` in `async` functions. Use async equivalents.

### 28. Unbounded Collections
Loading entire tables without pagination or limits.

### 29. Redundant Computation
Same value computed multiple times in same scope. `len()` in every loop iteration.

## Frontend Slop (14 patterns)

### 30-34. React/Component Slop
- **30. Unnecessary Re-renders**: State too high, missing `memo()` on expensive children
- **31. Missing Effect Cleanup**: `useEffect` without cleanup for listeners/timers
- **32. Prop Drilling**: Props through 4+ levels. Use context or state management
- **33. Uncontrolled Forms with Validation**: Mixing ref and state for forms
- **34. Client-Side Business Logic**: Pricing, auth checks in React components

### 35-37. Visual Design Slop
- **35. Generic AI Gradients**: Purple-to-blue, pink-to-purple defaults. Grep: `linear-gradient`, `bg-gradient-to-`
- **36. Card Syndrome**: > 10 identical `rounded-lg shadow` wrappers
- **37. Missing Design Tokens**: > 10 unique hardcoded hex colors. Use `var(--color-*)` instead

### 38-39. Markup/CSS Slop
- **38. Div Soup**: Nesting > 6 levels of divs. `<div onClick>` instead of `<button>`
- **39. Tailwind Class Overload**: > 12 utility classes on one element

### 40-43. Accessibility Slop
- **40. Missing Alt Text**: Images without `alt` or generic alt ("image", "photo")
- **41. Missing Focus Indicators**: `outline: none` without `focus-visible` replacement
- **42. Non-Interactive Click Handlers**: `<div onClick>` or `<span onClick>` instead of `<button>`
- **43. Form Inputs Without Labels**: Only `placeholder`, no `<label>` or `aria-label`

## Config Slop (4 patterns)

### 44. Unused Config Keys
Env vars read but never used. Config keys with no consumer.

### 45. Conflicting Defaults
Default in code contradicts default in config file.

### 46. Hardcoded Environment Logic
`if (process.env.NODE_ENV === 'production')` scattered in business logic. Centralize.

### 47. IAM Policy Bloat
Wildcard `Action: "*"` or `Resource: "*"` when only specific actions needed.
