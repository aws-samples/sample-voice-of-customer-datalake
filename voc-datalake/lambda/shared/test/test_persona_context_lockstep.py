"""`shared/persona_context.py` and `stream/src/context/persona-fields.ts` are a
cross-runtime MIRROR, and this pins them.

Two renderers answer the same question — where a persona's goals, frustrations
and voice live — because the document paths are Python and the chat paths are
TypeScript. That is the same situation as `shared/image_limits.py` mirroring the
TS allowlist, and this repo's convention for a mirror is a lockstep test rather
than trust. Without one they drift silently: someone teaches the Python side to
read `blockers`, the TS side keeps ignoring it, and project chat quietly shows
less than a PRD does.

What is deliberately NOT locked: the per-list cap. Python defaults to 3 because
the research string crosses a Step Functions state boundary; TypeScript defaults
to 4 because chat prompts have more room. Both are asserted here so a change to
either is a decision rather than an accident.

Pattern follows test_kiro_exportable_types_lockstep.py and
test_avatar_image_model_lockstep.py (same repo).
"""
import re
from pathlib import Path

from shared import persona_context

TS_SOURCE = 'lambda/stream/src/context/persona-fields.ts'

# Field paths BOTH renderers read. Naming the pairs explicitly is the point: a
# section taught to one runtime and not the other fails here.
MIRRORED_FIELD_PATHS = (
    ('goals_motivations', 'primary_goal'),
    ('goals_motivations', 'secondary_goals'),
    ('pain_points', 'current_challenges'),
    ('pain_points', 'blockers'),
)

# 🔑 Read by TYPESCRIPT ONLY, and that asymmetry is deliberate — this test caught
# it on its first run, which is the whole reason it exists.
#
# The phantom `needs` key appeared only at the two stream sites, so only the TS
# renderer has a `personaNeeds`, mapping it to the two canonical fields that
# answer the same question. No Python caller ever had a "needs" concept, and
# adding `persona_needs` there purely for symmetry would be dead code.
TS_ONLY_FIELD_PATHS = (
    ('goals_motivations', 'underlying_motivations'),
    ('pain_points', 'workarounds'),
)


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _ts_source() -> str:
    path = _repo_root() / TS_SOURCE
    assert path.is_file(), f'{TS_SOURCE} not found — did the file move?'
    return path.read_text(encoding='utf-8')


def _py_source() -> str:
    path = Path(persona_context.__file__)
    assert path.is_file()
    return path.read_text(encoding='utf-8')


def _code_only(source: str, *, python: bool) -> str:
    """Source with comments and docstrings removed.

    🪤 Necessary, not fussiness: both renderers DOCUMENT the phantom keys they no
    longer read (`.get('goals', [])` appears verbatim in the Python module
    docstring explaining the defect). Scanning raw text made the phantom-key guard
    fail on its own explanation — a guard that cannot tell code from prose is
    worse than none, because the obvious "fix" is to delete the explanation.

    KNOWN CEILING: this is lexical, not a parse. It strips comments and
    triple-quoted blocks, so it would also strip a legitimate triple-quoted code
    string, and it cannot see a phantom key reached INDIRECTLY —
    `KEY = 'goals'; persona.get(KEY)` passes. Both renderers access their fields
    literally today, which is what makes the trade sound. If either ever needs
    dynamic field access, upgrade this to an `ast` walk on the Python side and
    accept the TypeScript side as advisory.
    """
    if python:
        # Triple-quoted blocks first, so a `#` inside a docstring is already gone.
        source = re.sub(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'', '', source)
        return re.sub(r'#.*', '', source)
    source = re.sub(r'/\*[\s\S]*?\*/', '', source)
    return re.sub(r'//.*', '', source)


def _py_code() -> str:
    return _code_only(_py_source(), python=True)


def _ts_code() -> str:
    return _code_only(_ts_source(), python=False)


def test_both_runtimes_read_the_same_canonical_field_paths():
    """Neither renderer may know about a shared field the other does not."""
    ts, py = _ts_code(), _py_code()
    for section, key in MIRRORED_FIELD_PATHS:
        assert section in py, f'python renderer lost the {section} section'
        assert section in ts, f'TS renderer lost the {section} section'
        assert key in py, f'python renderer stopped reading {section}.{key}'
        assert key in ts, f'TS renderer stopped reading {section}.{key}'


def test_the_typescript_only_fields_stay_typescript_only():
    """Pins the asymmetry so it reads as a decision, not an oversight.

    If a Python caller ever wants a "needs" concept, this test is where that
    choice gets made explicitly instead of drifting in.
    """
    ts, py = _ts_code(), _py_code()
    for section, key in TS_ONLY_FIELD_PATHS:
        assert key in ts, f'TS renderer stopped reading {section}.{key}'
        assert key not in py, (
            f'python now reads {section}.{key} — move it to MIRRORED_FIELD_PATHS'
        )


def test_neither_runtime_reads_a_phantom_key():
    """The defect being fixed, pinned in both runtimes at once.

    `goals`, `frustrations`, `needs` and singular `quote` exist on no stored row.
    A bare-word match would false-positive on `goals_motivations` and on the
    `personaGoals` / `persona_goals` function names, so each is matched as a FIELD
    ACCESS — the only form that would reintroduce the bug.
    """
    phantom_accesses = (
        # python: item.get('goals'), persona.get('frustrations'), …
        r"\.get\(\s*['\"](?:goals|frustrations|needs|quote)['\"]",
        # typescript: persona.goals, p.frustrations, …
        # The trailing guard keeps `goals_motivations` and `quotes` out: `\b`
        # alone already stops at `goals_`, and `(?![s_])` also excludes `quotes`.
        r"\.(?:goals|frustrations|needs|quote)\b(?![s_])",
    )
    for source, label in ((_py_code(), 'python'), (_ts_code(), 'typescript')):
        for pattern in phantom_accesses:
            found = re.findall(pattern, source)
            assert not found, f'{label} renderer reads a phantom key: {found}'


def test_the_caps_differ_on_purpose_and_are_both_pinned():
    """A cap change should be a decision, not a drift."""
    assert persona_context.DEFAULT_MAX_ITEMS == 3, (
        'python caps at 3 because the research context crosses Step Functions state'
    )
    match = re.search(r'DEFAULT_PERSONA_ITEMS\s*=\s*(\d+)', _ts_source())
    assert match, 'DEFAULT_PERSONA_ITEMS not found in the TS renderer'
    assert int(match.group(1)) == 4, (
        'TS caps at 4 because chat prompts have more room than the document paths'
    )


def test_every_python_reader_has_a_typescript_counterpart():
    """The exported surfaces mirror each other by name."""
    ts = _ts_source()
    for py_name, ts_name in (
        ('persona_voice', 'personaVoice'),
        ('persona_goals', 'personaGoals'),
        ('persona_frustrations', 'personaFrustrations'),
    ):
        assert hasattr(persona_context, py_name), f'python lost {py_name}'
        assert f'export function {ts_name}' in ts, f'TS lost {ts_name}'
