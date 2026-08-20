r"""One way to put a persona in front of a model.

Framed like `shared/derivation.py`: N call sites had spelled the same relation N
different ways, so the relation lives here once.

🔴 THE DEFECT THIS EXISTS TO FIX. Four live prompt builders read persona fields
that no writer has ever produced:

    f"- Goals: {', '.join(p.get('goals', [])[:3])}\n"
    f"- Frustrations: {', '.join(p.get('frustrations', [])[:3])}"

Stored personas follow `schemas/persona.schema.json`: goals live under
`goals_motivations.primary_goal` / `.secondary_goals`, frustrations under
`pain_points.current_challenges` / `.blockers`, and the voice line under
`quotes[0].text` — there is no `goals`, no `frustrations`, no `needs` and no
singular `quote` on any row. `.get(key, [])` returns the default for all of them,
so every generated PRD, PR/FAQ, merged document and research report was built
with a persona block whose labels were present and whose values were EMPTY.

That is worse than omitting the persona: `Goals: ` with nothing after it reads to
a model as an assertion that the persona has no goals, and the document then
records `used_persona_ids` in its derivation, claiming provenance from content it
never received.

Compact on purpose, and capped. The research path carries this string across a
Step Functions state boundary (256 KB ceiling) and the chat paths compete with
the history budget, so this is deliberately NOT
`projects.py::_persona_to_markdown` — that renderer is whole-document, uncapped,
and opens an `# H1` per persona, which would flatten the heading structure of the
prompt it is embedded in. Its field paths are reused; its format is not.
"""
from collections.abc import Sequence
from typing import Any

# Enough to characterise a persona without crowding out the feedback evidence
# that shares the same prompt budget.
DEFAULT_MAX_ITEMS = 3

# Keys worth reading off a dict that turned up where a string was expected. An
# imported persona's list entries are LLM-authored, so an object is possible.
_TEXTUAL_KEYS: tuple[str, ...] = ('text', 'description', 'value', 'name')


def _entry_text(entry: Any) -> str:
    """The readable text of one list entry, or '' if there is none.

    🪤 A dict does NOT become `str(entry)`. That put a Python repr
    (`{'goal': 'x', 'weight': 2}`) into an LLM prompt — noise, and extra structure
    in a string that reaches a model, on a path whose content comes from customer
    documents. Read a known text-ish key instead, and drop the entry when none of
    them holds anything.
    """
    if isinstance(entry, str):
        return entry.strip()
    if isinstance(entry, dict):
        for key in _TEXTUAL_KEYS:
            candidate = entry.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        return ''
    if isinstance(entry, (int, float)) and not isinstance(entry, bool):
        return str(entry)
    return ''


def _clean_items(value: Any, limit: int) -> list[str]:
    """Up to `limit` non-empty strings from a list-shaped persona field."""
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    for entry in value:
        text = _entry_text(entry)
        if text:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def persona_voice(persona: dict[str, Any]) -> str:
    """The persona's representative quote, or ''.

    `quotes` is a list of `{text, context}` objects. The `isinstance` tolerance is
    copied from `_persona_to_markdown`, which already handles rows whose quotes
    are bare strings.
    """
    quotes = persona.get('quotes')
    if not isinstance(quotes, (list, tuple)):
        return ''
    for quote in quotes:
        if isinstance(quote, dict):
            text = quote.get('text', '')
        else:
            text = quote
        if isinstance(text, str) and text.strip():
            return text.strip()
    return ''


def persona_goals(persona: dict[str, Any], max_items: int = DEFAULT_MAX_ITEMS) -> list[str]:
    """Primary goal first, then secondary goals, as flat lines."""
    section = persona.get('goals_motivations')
    if not isinstance(section, dict):
        return []
    goals: list[str] = []
    primary = section.get('primary_goal')
    if isinstance(primary, str) and primary.strip():
        goals.append(primary.strip())
    goals += _clean_items(section.get('secondary_goals'), max_items)
    return goals[:max_items]


def persona_frustrations(persona: dict[str, Any], max_items: int = DEFAULT_MAX_ITEMS) -> list[str]:
    """Current challenges first, topped up with blockers if there is room.

    Both belong under "frustrations" for a prompt: a challenge is what hurts and a
    blocker is what stops them, and a model reasoning about a feature needs both.
    """
    section = persona.get('pain_points')
    if not isinstance(section, dict):
        return []
    pains = _clean_items(section.get('current_challenges'), max_items)
    if len(pains) < max_items:
        for blocker in _clean_items(section.get('blockers'), max_items):
            if blocker not in pains:
                pains.append(blocker)
            if len(pains) >= max_items:
                break
    return pains[:max_items]


def persona_prompt_block(persona: dict[str, Any], max_items: int = DEFAULT_MAX_ITEMS) -> str:
    """One persona as a compact labelled block for an LLM prompt.

    A label is emitted ONLY when it has content. That is the point of the change:
    an empty `Goals:` line is a false statement about the persona, so a persona
    with no recorded goals now says nothing about goals rather than asserting the
    absence of them.
    """
    name = str(persona.get('name') or 'Unnamed persona').strip()
    tagline = str(persona.get('tagline') or '').strip()
    lines = [f"**{name}**" + (f" — {tagline}" if tagline else "")]

    voice = persona_voice(persona)
    if voice:
        lines.append(f'- Voice: "{voice}"')

    goals = persona_goals(persona, max_items)
    if goals:
        lines.append(f"- Goals: {'; '.join(goals)}")

    frustrations = persona_frustrations(persona, max_items)
    if frustrations:
        lines.append(f"- Frustrations: {'; '.join(frustrations)}")

    return '\n'.join(lines)


def personas_prompt_context(
    personas: Sequence[Any], header: str = '', max_items: int = DEFAULT_MAX_ITEMS
) -> str:
    """Several personas as one prompt section, or '' when there are none.

    Returning '' for an empty list matters: callers previously built a section
    containing only labels, so `personas_context or '(none)'` could never fire
    even when nothing was known.

    ⚠️ '' is a real return value and the CALLER must decide what it means. Two
    prompt templates (`prd-generation.json`, `prfaq-generation.json`) hard-code a
    `USER PERSONAS:` header before the placeholder, so those call sites append
    `or '(none)'`; `document_merger` instead omits its whole section with
    `if persona_text:`. Both are correct — dropping the guard entirely is not,
    because a bare header with nothing under it is the defect this module exists
    to remove.
    """
    blocks = [
        persona_prompt_block(p, max_items)
        for p in personas
        if isinstance(p, dict)
    ]
    if not blocks:
        return ''
    body = '\n\n'.join(blocks)
    return f"{header}\n\n{body}" if header else body
