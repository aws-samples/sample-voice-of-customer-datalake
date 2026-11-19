# Profiling Tools Reference

The commands are shown as a developer types them. In the sandbox, run each as one `run` argv with the repository's
installed binaries (`node_modules/.bin/clinic` rather than `npx clinic`), with no pipes, no `$(...)` and no signals
to other processes; a profiler the repository does not have is a dependency decided before your first command.

## Python Profiling

### py-spy (production-safe sampling profiler)

```bash
# Install
pip install py-spy

# Attach to running process
py-spy top --pid 12345

# Record flame graph
py-spy record -o flame.svg --pid 12345

# Record with native extensions (C/Rust)
py-spy record --native -o flame.svg --pid 12345

# Profile a script directly
py-spy record -o flame.svg -- python3 app.py
```

**When to use**: production profiling, finding hot functions, flame graph visualization.
**Overhead**: < 1%. Safe for production.
**Limitation**: sampling-based, may miss short functions.

### scalene (CPU + memory + GPU)

```bash
# Install
pip install scalene

# Profile script
scalene app.py

# Profile with GPU tracking
scalene --gpu app.py

# Output as JSON (for CI)
scalene --json --outfile profile.json app.py
```

**When to use**: combined CPU + memory + GPU profiling in development.
**Overhead**: 10-20% (sampling-based, not instrumentation).
**Strength**: distinguishes Python vs C time, shows memory allocation per line.

### memray (memory profiler)

```bash
# Install
pip install memray

# Record allocations
memray run app.py

# Generate flame graph
memray flamegraph memray-*.bin -o memory-flame.html

# Generate summary
memray summary memray-*.bin

# Live view (attach to process)
memray attach 12345
```

**When to use**: tracking memory leaks, finding large allocations.
**Overhead**: low in native-tracking-off mode; the maintainers do not claim it is safe for
production, so benchmark on your own workload before enabling outside development.
**Output**: flame graphs, summary tables, leak reports.

### tracemalloc (stdlib, zero-install)

```python
import tracemalloc

tracemalloc.start()

# ... run code ...

# Top 10 allocators
snapshot = tracemalloc.take_snapshot()
for stat in snapshot.statistics("lineno")[:10]:
    print(stat)

# Compare snapshots (find leaks)
snapshot1 = tracemalloc.take_snapshot()
# ... more code ...
snapshot2 = tracemalloc.take_snapshot()
for stat in snapshot2.compare_to(snapshot1, "lineno")[:10]:
    print(stat)
```

**When to use**: quick allocation tracking without external deps.
**Overhead**: ~10-30%.
**Limitation**: Python allocations only (not C extensions).

### cProfile (stdlib, function-level)

```bash
# Command line
python3 -m cProfile -s cumulative app.py

# Save to file for visualization
python3 -m cProfile -o profile.pstats app.py

# Visualize with snakeviz
pip install snakeviz && snakeviz profile.pstats
```

**When to use**: development, understanding call hierarchy.
**Overhead**: ~30%.
**Limitation**: function-level only (not line-level).

### line_profiler (line-level)

```python
# Decorate functions to profile
@profile  # added by kernprof
def slow_function():
    result = []           # 0.1ms
    for item in data:     # 200ms  ← bottleneck
        result.append(transform(item))
    return result
```

```bash
# Run with kernprof
kernprof -l -v app.py
```

**When to use**: narrowing down hot lines within a function.
**Overhead**: ~50%.
**Limitation**: must decorate functions in advance.

## TypeScript/Node Profiling

### clinic.js (auto-diagnosis)

```bash
# Install
npm install -g clinic

# Auto-detect issue type
npx clinic doctor -- node app.js

# Flame graph
npx clinic flame -- node app.js

# Event loop analysis
npx clinic bubbleprof -- node app.js
```

**When to use**: first pass, auto-detects whether issue is CPU, I/O, or event loop.

### 0x (flame graph)

```bash
npx 0x app.js
# Opens flame graph in browser
```

### V8 built-in profiler

```bash
# Record
node --prof app.js

# Process
node --prof-process isolate-*.log > profile.txt

# Heap snapshot (memory)
node --heapsnapshot-signal=SIGUSR2 app.js
kill -USR2 $(pgrep -f app.js)
# Load .heapsnapshot in Chrome DevTools
```

## Async Debugging

### Python: asyncio debug mode

```python
import asyncio

# Enable debug mode
asyncio.get_event_loop().set_debug(True)

# Or via environment variable
# PYTHONASYNCIODEBUG=1 python3 app.py
```

Detects:
- Coroutines that were never awaited
- Callbacks taking > 100ms (blocking event loop)
- Slow I/O operations

### Node: event loop monitoring

```javascript
const { monitorEventLoopDelay } = require('perf_hooks');
const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();

setInterval(() => {
  console.log(`Event loop p99: ${h.percentile(99) / 1e6}ms`);
  h.reset();
}, 5000);
```

## Profiling Workflow

```
1. Reproduce the slow behavior
   └─ Isolate: single request? load? specific endpoint?

2. Quick triage (30 seconds)
   └─ py-spy top / clinic doctor
   └─ Answer: CPU-bound? I/O-bound? Memory?

3. Deep profile (5 minutes)
   └─ CPU: py-spy record → flame graph
   └─ Memory: memray run → flamegraph
   └─ I/O: OpenTelemetry trace → waterfall

4. Identify bottleneck
   └─ One function? One query? One external call?

5. Fix and measure
   └─ Before/after with same profiling tool
   └─ Confirm improvement at p50 AND p99
```

## Tool Selection Matrix

| Need | Python | Node | Go |
|---|---|---|---|
| Quick check | py-spy top | clinic doctor | pprof |
| Flame graph | py-spy record | 0x / clinic flame | go tool pprof |
| Memory leak | memray | --heapsnapshot | pprof heap |
| Line-level | line_profiler | N/A | N/A |
| Production | py-spy | clinic | pprof (built-in) |
| Combined | scalene | clinic | N/A |
| Event loop | asyncio debug | monitorEventLoopDelay | runtime/trace |
