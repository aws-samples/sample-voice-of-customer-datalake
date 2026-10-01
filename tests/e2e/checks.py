"""Deterministic checks for an end-to-end AIDLC: Discovery run.

Every check reads files on disk; none of them judges the quality of generated
prose. The required-artifact table and the brief sections are parsed from the
Handoff reference prompt, so the prompt stays the single source of truth.

Standalone use:
    python3 tests/e2e/checks.py discovery <workspace> --project <name> --reference <ref> [--transcript <file>]
    python3 tests/e2e/checks.py aidlc <workspace> --project <name> --transcript <file> [--orchestrate-log <file>]
    python3 tests/e2e/checks.py missing-prd <workspace> --project <name> --transcript <file>
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRIEF_SKILL = ROOT / "skills" / "aidlc-discovery" / "agents" / "05-handoff" / "skills" / "discovery-brief.md"

BRIEF_LIMIT = 200_000
# Salesforce opportunity IDs start with the 006 key prefix (15 or 18 characters).
OPPORTUNITY_ID = re.compile(r"\b006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b")
EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
# Reserved for documentation (RFC 2606, RFC 6761), so never a customer's address:
# prototypes use them as form placeholders, for example "teammate@example.com".
RESERVED_EMAIL_DOMAIN = re.compile(r"@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|net|org)|example|invalid|test|localhost)$",
                                   re.I)
START_COMMAND = re.compile(r"/aidlc (?:workshop|classic)\b")
# Per-item data belongs in discovery/data/, and helper scripts nowhere in the working folder
# (SKILL.md, Data Setup). AI-DLC 2.10.0 counts a folder up to three levels down with a .py,
# .js, or .ts file as an existing codebase (aidlc-utility.ts:5789, 6157-6205).
DATA_SUFFIXES = {".json", ".csv", ".xlsx", ".xls"}
SCRIPT_SUFFIXES = {".py", ".js", ".ts", ".sh"}


@dataclass
class Check:
    """One check. An unverified check could not be decided from the evidence: it is
    neither a pass nor a failure, and the report lists it separately."""

    id: str
    name: str
    passed: bool
    detail: str = ""
    unverified: bool = False

    @property
    def outcome(self) -> str:
        return "unverified" if self.unverified else "pass" if self.passed else "fail"


OUTCOME_ICON = {"pass": "✅", "fail": "❌", "unverified": "⚠️"}


def count_outcomes(checks: list[Check]) -> dict[str, int]:
    return {outcome: sum(c.outcome == outcome for c in checks) for outcome in OUTCOME_ICON}


def required_artifacts() -> list[str]:
    """Return the required artifact paths from the Handoff prompt's table."""
    text = BRIEF_SKILL.read_text(encoding="utf-8")
    table = text.split("## Required Artifacts", 1)[1].split("## Brief Template", 1)[0]
    rows = []
    for line in table.splitlines():
        match = re.match(r"^\| (.+?) \| `([^`]+)` \|$", line)
        if match:
            rows.append((match.group(1), match.group(2)))
    return [path for label, path in rows if "only when a codebase exists" not in label]


def brief_sections() -> list[str]:
    """Return the brief's section titles, in order, from the template."""
    text = BRIEF_SKILL.read_text(encoding="utf-8")
    template = text.split("## Brief Template", 1)[1].split("## Rules", 1)[0]
    return re.findall(r"^## \d+\. (.+)$", template, re.M)


def section(text: str, title: str) -> str:
    match = re.search(rf"^## \d+\. {re.escape(title)}\s*$(.*?)(?=^## \d+\. |\Z)", text, re.M | re.S)
    return match.group(1) if match else ""


def persona_names(brief: str) -> list[str]:
    """The bold name that opens each persona paragraph, without a title the model may add after it
    ("Dana Okafor, The Adoption Champion" or "Dana Okafor — The Adoption Champion")."""
    bold = re.findall(r"^\*\*([^*]+)\*\*", section(brief, "Target customers and personas"), re.M)
    return [re.split(r"\s+[—–-]\s+|,\s+|:\s*|\s+\(", b, maxsplit=1)[0].strip() for b in bold]


def project_files(project_dir: Path) -> list[Path]:
    return [p for p in project_dir.rglob("*") if p.is_file()]


def active_space(workspace: Path) -> str:
    pointer = workspace / "aidlc" / "active-space"
    name = pointer.read_text(encoding="utf-8").strip() if pointer.is_file() else ""
    return name or "default"


def team_knowledge(workspace: Path) -> Path:
    """AI-DLC loads team knowledge only from the active space (aidlc-orchestrate.ts, 2.10.0)."""
    return workspace / "aidlc" / "spaces" / active_space(workspace) / "knowledge"


def check_discovery(workspace: Path, project: str, reference: str, transcript: str = "") -> list[Check]:
    project_dir = workspace / "discovery" / project
    brief_path = project_dir / "handoff" / "discovery-brief.md"
    checks: list[Check] = []

    missing = []
    for relative in required_artifacts():
        if relative.endswith("*.md"):
            found = list((project_dir / relative[: -len("*.md")]).glob("*.md"))
            if len(found) < 2:
                missing.append(f"{relative} ({len(found)} found, 2 required)")
        elif not (project_dir / relative).is_file():
            missing.append(relative)
    checks.append(Check("D01", "Required artifacts exist", not missing, ", ".join(missing)))

    brief = brief_path.read_text(encoding="utf-8") if brief_path.is_file() else ""
    checks.append(Check("D02", "Discovery brief exists", bool(brief), str(brief_path.relative_to(workspace))))

    headings = re.findall(r"^## \d+\. (.+?)\s*$", brief, re.M)
    expected = brief_sections()
    checks.append(Check("D03", "Brief has the 12 sections in order", headings == expected,
                        "" if headings == expected else f"found {headings}"))

    checks.append(Check("D04", f"Brief is under {BRIEF_LIMIT:,} characters", 0 < len(brief) < BRIEF_LIMIT,
                        f"{len(brief):,} characters"))

    reference_text = section(brief, "Engagement reference")
    checks.append(Check("D05", "Brief carries the engagement reference", reference in reference_text,
                        reference_text.strip()[:120]))

    leaks = sorted({m for p in project_files(project_dir) if p.suffix in {".md", ".html"}
                    for m in OPPORTUNITY_ID.findall(p.read_text(encoding="utf-8", errors="ignore"))})
    checks.append(Check("D06", "No opportunity IDs in artifacts", not leaks, ", ".join(leaks)))

    emails = sorted({f"{p.name}: {m}" for p in project_files(project_dir) if p.suffix in {".md", ".html"}
                     for m in EMAIL.findall(p.read_text(encoding="utf-8", errors="ignore"))
                     if not RESERVED_EMAIL_DOMAIN.search(m)})
    checks.append(Check("D07", "No email addresses in artifacts", not emails, "; ".join(emails[:5])))

    names = persona_names(brief)
    knowledge = team_knowledge(workspace) / "aidlc-product-agent" / "discovery-personas.md"
    knowledge_text = knowledge.read_text(encoding="utf-8") if knowledge.is_file() else ""
    absent = [n for n in names if n not in knowledge_text]
    checks.append(Check("D08", "Personas written to AI-DLC team knowledge",
                        bool(knowledge_text) and len(names) >= 2 and not absent,
                        f"{len(names)} named in brief; missing from knowledge: {absent}" if knowledge_text else "file missing"))

    gitignore = workspace / ".gitignore"
    ignored = gitignore.is_file() and "discovery/data/" in gitignore.read_text(encoding="utf-8")
    checks.append(Check("D09", ".gitignore excludes discovery/data/", ignored))

    # Handoff writes only team knowledge under aidlc/; anything else means AI-DLC was set up or started.
    aidlc_dir = workspace / "aidlc"
    started = sorted(str(p.relative_to(workspace)) for p in aidlc_dir.rglob("*") if p.is_file()
                     and team_knowledge(workspace) not in p.parents)
    checks.append(Check("D10", "Handoff did not start AI-DLC", not started, ", ".join(started[:3])))

    links = re.findall(r"\]\(([^)#]+)\)", section(brief, "Full artifacts"))
    broken = [link for link in links if not (brief_path.parent / link).resolve().exists()]
    checks.append(Check("D11", "Brief links to existing artifacts", bool(links) and not broken,
                        f"{len(links)} links; broken: {broken}"))

    prototype = project_dir / "prototype" / "index.html"
    html = prototype.read_text(encoding="utf-8", errors="ignore") if prototype.is_file() else ""
    external = re.findall(r"<script[^>]+src=[\"']https?://", html)
    checks.append(Check("D12", "HTML prototype is self-contained", bool(html) and not external,
                        f"{len(external)} external scripts" if html else "missing"))

    if transcript:
        printed = bool(START_COMMAND.search(transcript)) and "discovery-brief.md" in transcript
        checks.append(Check("D13", "Start command printed with the brief path", printed))

    working = sorted({str(p.relative_to(workspace)) for p in project_files(project_dir)
                      if p.suffix.lower() in DATA_SUFFIXES | SCRIPT_SUFFIXES}
                     | {str(p.relative_to(workspace)) for p in project_files(workspace / "discovery")
                        if p.suffix.lower() in SCRIPT_SUFFIXES})
    checks.append(Check("D14", "No data files in the project folder and no scripts under discovery/", not working,
                        ", ".join(working)))
    return checks


def check_missing_prd(workspace: Path, project: str, transcript: str) -> list[Check]:
    brief_path = workspace / "discovery" / project / "handoff" / "discovery-brief.md"
    return [
        Check("N01", "Handoff wrote no brief while the PRD is missing", not brief_path.exists()),
        Check("N02", "Handoff named the missing PRD", bool(re.search(r"\bPRD\b|prd\.md", transcript))),
    ]


def state_field(state: str, field: str) -> str:
    match = re.search(rf"^- \*\*{re.escape(field)}\*\*: *(.*)$", state, re.M)
    return match.group(1).strip() if match else ""


def active_record(workspace: Path) -> Path | None:
    """Follow AI-DLC's intent cursor (aidlc-lib.ts activeIntent, 2.10.0), else the newest record."""
    intents = workspace / "aidlc" / "spaces" / active_space(workspace) / "intents"
    cursor = intents / "active-intent"
    if cursor.is_file():
        record = intents / cursor.read_text(encoding="utf-8").strip()
        if (record / "aidlc-state.md").is_file():
            return record
    records = sorted(intents.glob("*/aidlc-state.md"))
    return records[-1].parent if records else None


# The files Requirements Analysis writes (requirements-analysis.md, 2.10.0). The stage folder
# can exist earlier, holding only the learnings diary memory.md.
REQUIREMENTS_OUTPUTS = ("requirements-analysis-questions.md", "requirements.md")


def requirements_outputs(record: Path | None) -> list[Path]:
    folder = record / "inception" / "requirements-analysis" if record else None
    return [folder / name for name in REQUIREMENTS_OUTPUTS if folder and (folder / name).is_file()]


def transcript_strings(raw: str) -> str:
    """Decode every string in Claude Code stream-json lines, so tool output is searchable; keep other lines as is."""
    out: list[str] = []

    def walk(value: object) -> None:
        if isinstance(value, str):
            out.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for line in raw.splitlines():
        try:
            walk(json.loads(line))
        except json.JSONDecodeError:
            out.append(line)
    return "\n".join(out)


# The engine hands each stage a run-stage directive whose inline_context_paths include the
# lead agent's team knowledge (aidlc-orchestrate.ts:3539-3563, 2.10.0). Nothing on disk keeps
# that list, so read it from the transcript: as the engine's JSON, or re-printed by the model.
RA_DIRECTIVE = re.compile(r"""["']stage["']:\s*["']requirements-analysis["'][^{}]*?["']inline_context_paths["']:\s*\[([^\]]*)\]""")


def logged_directive_paths(orchestrate_log: str) -> list[list[str]]:
    """Return inline_context_paths of every requirements-analysis directive in the aidlc shim's log."""
    found: list[list[str]] = []

    def walk(value: object) -> None:
        if isinstance(value, dict):
            if value.get("kind") == "run-stage" and value.get("stage") == "requirements-analysis":
                found.append([str(p) for p in value.get("inline_context_paths") or []])
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for line in orchestrate_log.splitlines():
        try:
            stdout = json.loads(line).get("stdout", "")
            walk(json.loads(stdout))
        except (json.JSONDecodeError, AttributeError):
            continue
    return found


def check_aidlc(workspace: Path, project: str, transcript: str = "", orchestrate_log: str = "") -> list[Check]:
    brief_rel = f"discovery/{project}/handoff/discovery-brief.md"
    brief = (workspace / brief_rel).read_text(encoding="utf-8")
    record = active_record(workspace)
    checks = [Check("A01", "AI-DLC created an intent record", record is not None,
                    str(record.relative_to(workspace)) if record else "")]
    if record is None:
        return checks

    pointer = record / ".aidlc-engine" / "document-input-path"
    value = pointer.read_text(encoding="utf-8").strip() if pointer.is_file() else ""
    # AI-DLC accepts a relative or an absolute path here, resolved from the project root.
    points_at_brief = bool(value) and (workspace / value).resolve() == (workspace / brief_rel).resolve()
    checks.append(Check("A02", "AI-DLC recorded the brief as its document input",
                        points_at_brief, value or "document-input-path missing"))

    state = (record / "aidlc-state.md").read_text(encoding="utf-8")
    scope = state_field(state, "Scope")
    checks.append(Check("A03", "Workflow runs a profile that skips Ideation", scope in {"classic", "workshop"}, scope))
    checks.append(Check("A04", "AI-DLC did not run its own Ideation", not (record / "ideation").exists()))

    outputs = requirements_outputs(record)
    checks.append(Check("A05", "Requirements Analysis produced questions or requirements", bool(outputs),
                        ", ".join(p.name for p in outputs)))

    personas = str((team_knowledge(workspace) / "aidlc-product-agent" / "discovery-personas.md").relative_to(workspace))
    text = "\n".join(p.read_text(encoding="utf-8") for p in outputs)
    named = [n for n in persona_names(brief) if n.split()[0] in text]
    name = "Requirements Analysis loaded the Discovery personas"
    logged = logged_directive_paths(orchestrate_log)
    printed = [] if logged else RA_DIRECTIVE.findall(transcript_strings(transcript))
    if not logged and not printed:
        checks.append(Check("A06", name, False, "no requirements-analysis directive in the orchestrate log or the "
                            f"transcript; persona names in output: {named}", unverified=True))
        return checks
    source = "orchestrate log" if logged else "transcript (fallback)"
    loaded = any(personas in paths for paths in logged or printed)
    checks.append(Check("A06", name, loaded, f"{personas} {'in' if loaded else 'not in'} the directive, from the "
                        f"{source}; persona names in output: {named}"))
    return checks


def summarize(title: str, checks: list[Check]) -> str:
    lines = [f"### {title}", "", "| | Check | Detail |", "|---|---|---|"]
    for c in checks:
        lines.append(f"| {OUTCOME_ICON[c.outcome]} {c.id} | {c.name} | {c.detail.replace('|', '/')[:200]} |")
    return "\n".join(lines) + "\n"


def summarize_unverified(results: dict[str, list[Check]]) -> str:
    rows = [(leg, c) for leg, cs in results.items() for c in cs if c.unverified]
    if not rows:
        return ""
    lines = ["### ⚠️ Unverified (not a pass)", "", "These checks found no evidence either way. Verify them by hand.", "",
             "| Leg | Check | Reason |", "|---|---|---|"]
    lines += [f"| {leg} | {c.id} {c.name} | {c.detail.replace('|', '/')[:200]} |" for leg, c in rows]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("leg", choices=["discovery", "aidlc", "missing-prd"])
    parser.add_argument("workspace", type=Path)
    parser.add_argument("--project", required=True)
    parser.add_argument("--reference", default="")
    parser.add_argument("--transcript", type=Path)
    parser.add_argument("--orchestrate-log", type=Path, help="aidlc leg: <run>/aidlc.orchestrate.jsonl")
    args = parser.parse_args()
    transcript = args.transcript.read_text(encoding="utf-8", errors="ignore") if args.transcript else ""
    if args.leg == "discovery":
        checks = check_discovery(args.workspace, args.project, args.reference, transcript)
    elif args.leg == "missing-prd":
        checks = check_missing_prd(args.workspace, args.project, transcript)
    else:
        log = args.orchestrate_log.read_text(encoding="utf-8") if args.orchestrate_log else ""
        checks = check_aidlc(args.workspace, args.project, transcript, log)
    print(summarize(args.leg, checks))
    print(summarize_unverified({args.leg: checks}))
    print(json.dumps([{**asdict(c), "outcome": c.outcome} for c in checks], indent=2))
    print(count_outcomes(checks))
    return 1 if count_outcomes(checks)["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
