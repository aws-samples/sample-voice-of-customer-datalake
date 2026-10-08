"""
Deterministic text analysis for GitHub issues and comments — no network, no model.

Everything here is a PURE function of the issue's markdown and labels, so the
ingestor (polling) and the webhook (push) derive byte-identical fields for the
same issue, and two reports of one bug land on the same ``error_signature`` /
``component`` and cluster. Shared through ``_shared`` because the two Lambdas are
bundled separately and each copies only its own folder plus ``_shared``.

The functions:

* :func:`strip_markdown` — the text sentiment / categorisation read.
* :func:`parse_software_version` — form field, then label, then body pattern;
  first confident match wins, else ``None``.
* :func:`error_signature` — the first error line, normalised (numbers, paths,
  quoted strings, ids masked) so the same crash reported twice compares equal.
* :func:`detect_component`, :func:`has_repro`, :func:`linked_pull_requests`.
"""

import re
from collections.abc import Iterable

__all__ = [
    "detect_component",
    "error_signature",
    "has_repro",
    "linked_pull_requests",
    "parse_software_version",
    "strip_markdown",
]

# ----------------------------------------------------------------------------
# Issue-form sections
# ----------------------------------------------------------------------------


def _text(value: str | None) -> str:
    """*value*, or the empty string for a missing body."""
    return value or ""


_HEADING = re.compile(r"^\s{0,3}#{2,4}\s+(.+?)\s*#*\s*$")
_NO_RESPONSE = re.compile(r"^\s*_no response_\s*$", re.IGNORECASE)


def _form_sections(body: str) -> list[tuple[str, str]]:
    """``[(heading, content)]`` for every ``##`` to ``####`` heading in *body*.

    GitHub issue forms render each field as ``### <label>`` followed by the
    answer, and an unanswered optional field as ``_No response_`` — which is
    returned as empty content, so a skipped field never reads as an answer.
    """
    sections: list[tuple[str, list[str]]] = []
    for line in body.splitlines():
        match = _HEADING.match(line)
        if match:
            sections.append((match.group(1).strip().lower(), []))
        elif sections and not _NO_RESPONSE.match(line):
            sections[-1][1].append(line)
    return [(heading, "\n".join(lines).strip()) for heading, lines in sections]


# ----------------------------------------------------------------------------
# Software version
# ----------------------------------------------------------------------------

# `1.2`, `1.2.3`, `v1.2.3`, `1.2.3-beta.1`. Not part of a longer dotted number
# (`10.0.0.1`), and not glued to letters/digits on either side.
_VERSION = r"(?<![\w.])[vV]?(\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?![\w.]*\d)(?![A-Za-z])"
_VERSION_RE = re.compile(_VERSION)
_THREE_PART_V = re.compile(r"(?<![\w.])[vV](\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?![\w.]*\d)(?![A-Za-z])")
_VERSION_KEY_RE = re.compile(r"\bversion\s*[:=]\s*" + _VERSION, re.IGNORECASE)
_VERSION_LABEL = re.compile(r"^(?:v|version\s*[:/=\-]\s*v?)(\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:-[0-9A-Za-z.]+)?)$", re.IGNORECASE)

# Words that, right before a version, name the ENVIRONMENT rather than the
# software the issue is about: "Node v18.17.0", "macOS 14.2.1", "VS Code version:
# 1.85". A version after one of these is never the product's.
_ENVIRONMENT_WORDS = frozenset({
    "os", "macos", "osx", "windows", "win", "linux", "ubuntu", "debian", "fedora", "kernel",
    "node", "nodejs", "node.js", "npm", "pnpm", "yarn", "python", "pip", "java", "jdk", "go",
    "rust", "cargo", "ruby", "php", "dotnet", ".net", "browser", "chrome", "chromium", "firefox",
    "safari", "edge", "electron", "vscode", "code", "docker", "git", "ios", "android", "system",
})
_WORD_BEFORE = re.compile(r"([A-Za-z][\w.+-]*)\W*$")


def _after_environment_word(text: str, start: int, window: int = 24) -> bool:
    """True when the word just before *start* (within *window* chars) is an environment name."""
    match = _WORD_BEFORE.search(text[max(0, start - window):start])
    return bool(match) and match.group(1).lower() in _ENVIRONMENT_WORDS


def _is_version_heading(heading: str) -> bool:
    if "version" not in heading:
        return False
    words = set(re.findall(r"[a-z.+]+", heading))
    return not (words & _ENVIRONMENT_WORDS) and "operating" not in words


def _version_from_form(body: str) -> str | None:
    for heading, content in _form_sections(body):
        if _is_version_heading(heading):
            match = _VERSION_RE.search(content)
            if match:
                return match.group(1)
    return None


def _version_from_labels(labels: Iterable[str]) -> str | None:
    for label in labels:
        match = _VERSION_LABEL.match(label.strip())
        if match:
            return match.group(1)
    return None


def _first_unqualified(pattern: re.Pattern[str], body: str) -> str | None:
    """The first match of *pattern* not directly preceded by an environment word."""
    for match in pattern.finditer(body):
        if not _after_environment_word(body, match.start()):
            return match.group(1)
    return None


def _version_from_body(body: str, product_names: Iterable[str]) -> str | None:
    # `version: 1.2.3` — the qualifier is the word before "version" ("Node version: 18").
    found = _first_unqualified(_VERSION_KEY_RE, body)
    if found:
        return found
    # `Kiro 0.4.2` / `Kiro v0.4.2` for each product name the plugin knows.
    for name in product_names:
        if not name:
            continue
        product = re.compile(rf"(?<![\w-]){re.escape(name)}\s+(?:version\s+)?{_VERSION}", re.IGNORECASE)
        match = product.search(body)
        if match:
            return match.group(1)
    # A bare `v0.4.2`: the leading v and three parts are what make it confident.
    return _first_unqualified(_THREE_PART_V, body)


def parse_software_version(
    body: str | None, labels: Iterable[object] = (), product_names: Iterable[str] = (),
) -> tuple[str, str] | None:
    """The software version an issue is about, and where it was found.

    Returns ``(version, source)`` with *source* one of ``'form'`` (a ``### …
    Version`` issue-form section), ``'label'`` (``v1.2.3`` / ``version:1.2``) or
    ``'body'`` (``version: x.y.z``, ``<product> x.y.z``, a bare ``vX.Y.Z``), in
    that order — the first confident match wins. ``None`` when nothing confident
    is found: a guess would split one release's trend across fake versions.

    The leading ``v`` is dropped (``v0.4.2`` and ``0.4.2`` are one release);
    a pre-release suffix is kept (``1.0.0-beta.2`` is not ``1.0.0``).
    """
    text = _text(body)
    label_list = [label for label in labels if isinstance(label, str)]
    for source, found in (
        ("form", _version_from_form(text)),
        ("label", _version_from_labels(label_list)),
        ("body", _version_from_body(text, product_names)),
    ):
        if found:
            return found, source
    return None


# ----------------------------------------------------------------------------
# Markdown → plain text
# ----------------------------------------------------------------------------

_FENCE = re.compile(r"^(```|~~~).*?$\n?(.*?)^\1\s*$", re.MULTILINE | re.DOTALL)
_FENCE_KEEP_LINES = 5
_MD_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"<!--.*?-->", re.DOTALL), ""),
    (re.compile(r"^\s*_no response_\s*$", re.IGNORECASE | re.MULTILINE), ""),
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), ""),
    (re.compile(r"\[([^\]]+)\]\([^)]*\)"), r"\1"),
    (re.compile(r"<(https?://[^>\s]+)>"), r"\1"),
    (re.compile(r"<[^>\n]+>"), ""),
    (re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE), ""),
    (re.compile(r"^\s{0,3}>\s?", re.MULTILINE), ""),
    (re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$", re.MULTILINE), ""),
    (re.compile(r"\|"), " "),
    (re.compile(r"(\*\*|__|~~)(.+?)\1"), r"\2"),
    (re.compile(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])"), r"\1"),
    (re.compile(r"(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)"), r"\1"),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"^\s*-\s\[[ xX]\]\s*", re.MULTILINE), "- "),
    (re.compile(r"[ \t]+"), " "),
    (re.compile(r" *\n *"), "\n"),
    (re.compile(r"\n{3,}"), "\n\n"),
)


def _keep_fence_head(match: re.Match[str]) -> str:
    lines = [line for line in match.group(2).splitlines() if line.strip()]
    head = lines[:_FENCE_KEEP_LINES]
    if len(lines) > _FENCE_KEEP_LINES:
        head.append("…")
    return "\n".join(head) + "\n"


def strip_markdown(markdown: str | None, cap: int) -> str:
    """*markdown* as plain text for sentiment / categorisation, at most *cap* characters.

    Fenced code keeps only its first few lines (a pasted 400-line log is not
    customer voice, and would crowd out the words that are); links keep their
    text, images, HTML and comments go, emphasis and heading marks are dropped.
    """
    text = _FENCE.sub(_keep_fence_head, _text(markdown).replace("\r\n", "\n"))
    for pattern, replacement in _MD_RULES:
        text = pattern.sub(replacement, text)
    text = text.strip()
    if len(text) > cap:
        text = text[: max(cap - 1, 0)].rstrip() + "…"
    return text


# ----------------------------------------------------------------------------
# Error signature
# ----------------------------------------------------------------------------

_SIGNATURE_CAP = 160
# `TypeError: x`, `java.lang.IllegalStateException: x`, `Uncaught ReferenceError: x`
_EXCEPTION_LINE = re.compile(r"\b((?:[A-Za-z_][\w.$]*)?(?:Error|Exception|Fault))\b\s*:\s*(\S.*)$")
# `panic: x`, `fatal: x`, `error: x`, `error[E0382]: x`, `FATAL ERROR: x`, `npm ERR! x`
_PREFIX_LINE = re.compile(r"^(?:\W*)(panic|fatal(?: error)?|error(?:\[\w+\])?|err!)\s*:?\s+(\S.*)$", re.IGNORECASE)
_SIGNATURE_MASKS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"https?://\S+"), "<url>"),
    (re.compile(r"(['\"`]).*?\1"), "<str>"),
    (re.compile(r"(?:[A-Za-z]:\\|~?/)[\w.\-\\/]+"), "<path>"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE), "<id>"),
    (re.compile(r"\b0x[0-9a-f]+\b", re.IGNORECASE), "<hex>"),
    (re.compile(r"\b[0-9a-f]{12,}\b", re.IGNORECASE), "<hex>"),
    (re.compile(r"\d+"), "<n>"),
    (re.compile(r"\s+"), " "),
)


def _code_lines_first(body: str) -> list[str]:
    """Lines inside fenced code first (where stack traces live), then the prose."""
    code: list[str] = []
    for match in _FENCE.finditer(body):
        code.extend(match.group(2).splitlines())
    # A fence spans whole lines, so whatever replaces it is a line of its own
    # that never reads as an error.
    prose = _FENCE.sub("", body)  # pragma: no mutate  the replacement text is unobservable (own non-error line)
    return code + prose.splitlines()


def _normalize_signature(kind: str, message: str) -> str:
    for pattern, replacement in _SIGNATURE_MASKS:
        message = pattern.sub(replacement, message)
    signature = f"{kind.lower()}: {message.strip().lower()}".strip()
    return signature[:_SIGNATURE_CAP].rstrip()


def error_signature(body: str | None) -> str | None:
    """The first error line in *body*, normalised so duplicates compare equal.

    ``TypeError: Cannot read properties of undefined (reading 'id') at 12:3`` and
    the same crash with another property name both become
    ``typeerror: cannot read properties of undefined (reading <str>) at <n>:<n>``.
    Code blocks are searched first. ``None`` when no line looks like an error.
    """
    for raw_line in _code_lines_first(_text(body)):
        line = raw_line.strip()
        if not line or len(line) > 1000:
            continue
        match = _EXCEPTION_LINE.search(line) or _PREFIX_LINE.match(line)
        if match:
            return _normalize_signature(match.group(1), match.group(2))
    return None


# ----------------------------------------------------------------------------
# Repro, component, linked PRs
# ----------------------------------------------------------------------------

_REPRO_HEADING = re.compile(r"reproduc|repro\b|steps")
_REPRO_PHRASE = re.compile(
    r"\b(steps to reproduce|to reproduce|repro steps|reproduction steps|minimal (?:repro|reproduction|example)|repro:)",
    re.IGNORECASE,
)


def has_repro(body: str | None) -> bool:
    """Whether the report carries reproduction steps.

    An issue form decides by its own repro field (an unanswered ``_No response_``
    field is NOT a repro, though its heading says "reproduce"); free-form text
    decides by the usual phrases.
    """
    text = _text(body)
    repro_sections = [content for heading, content in _form_sections(text) if _REPRO_HEADING.search(heading)]
    if repro_sections:
        return any(content for content in repro_sections)
    return bool(_REPRO_PHRASE.search(text))


_COMPONENT_LABEL = re.compile(r"^(?:area|component|comp|scope|module|feature)\s*[:/]\s*(.+)$", re.IGNORECASE)
_COMPONENT_HEADING = re.compile(r"\b(component|area|feature|which part|module)\b")
_COMPONENT_CAP = 60


def _clean_component(value: str) -> str | None:
    first_line = value.strip().splitlines()[0]
    cleaned = re.sub(r"\s+", " ", first_line).strip(" .-*_`").lower()
    return cleaned[:_COMPONENT_CAP] or None


def detect_component(labels: Iterable[object], body: str | None) -> str | None:
    """The product area: an ``area:``/``component:`` label, else an issue-form "Component" field."""
    for label in labels:
        match = _COMPONENT_LABEL.match(label.strip()) if isinstance(label, str) else None
        if match:
            return _clean_component(match.group(1))
    for heading, content in _form_sections(_text(body)):
        if _COMPONENT_HEADING.search(heading) and content:
            return _clean_component(content)
    return None


_PR_MENTION = re.compile(r"\b(?:PR|pull request)\s*#(\d{1,7})\b", re.IGNORECASE)
_MAX_LINKED_PRS = 50


def linked_pull_requests(text: str | None, repo: str) -> list[int]:
    """Pull-request numbers *text* links to: ``github.com/<repo>/pull/N`` and ``PR #N``.

    A bare ``#N`` is not counted — it is equally an issue. (GitHub's own
    "linked PR" relation lives in the timeline API, one extra request per issue;
    see docs/github-issues.md.)
    """
    body = _text(text)
    url = re.compile(rf"github\.com/{re.escape(repo)}/pull/(\d{{1,7}})\b", re.IGNORECASE)
    numbers = {int(n) for n in url.findall(body)} | {int(n) for n in _PR_MENTION.findall(body)}
    return sorted(numbers)[:_MAX_LINKED_PRS]
