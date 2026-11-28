"""The roadmap gate (docs/feature-tests/README.md): every released roadmap item mapped to the tests that prove it.

Modules: registry (the files and their schema), items (the CHANGELOG's releases and the seed), resolve (a test's
static resolution, digest and pinned command), verdict (an evaluator's verdict file), ratchet (gaps and the
shrink-only allowed list), report (stats, the evaluator's brief, the per-sha run), lock (scripts/suite-lock.sh), cli
(scripts/feature_gate.py).
"""
