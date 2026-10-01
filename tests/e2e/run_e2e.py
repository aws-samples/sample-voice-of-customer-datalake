"""Run AIDLC: Discovery end to end in a real harness and check the results.

Legs, run in this order when selected:
  discovery    Unattended workshop on the bundled sample data, ending in the Discovery brief
  missing-prd  Negative test: Handoff on a copy of that workspace without the PRD must refuse
  aidlc        Start AI-DLC from the brief and drive it until Requirements Analysis writes its questions

Each run writes to --out (default .e2e/<timestamp>/):
  workspace/             the scratch repository the harness worked in
  <leg>.transcript.*     raw harness output
  report.md, report.json check results; report.md is also appended to $GITHUB_STEP_SUMMARY

Exit code 0 means every selected check passed. See TESTING.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checks  # noqa: E402

ROOT = checks.ROOT
PROMPTS = Path(__file__).resolve().parent / "prompts"
SAMPLE_DATA = ROOT / "skills" / "aidlc-discovery" / "knowledge-base" / "voc-data" / "example-feedback.json"
MIN_AIDLC = (2, 10, 0)


def log(message: str) -> None:
    print(f"[e2e {datetime.now():%H:%M:%S}] {message}", flush=True)


def git(workspace: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=workspace, check=True, capture_output=True)


def prepare_workspace(workspace: Path, project: str, reference: str) -> None:
    workspace.mkdir(parents=True)
    git(workspace, "init", "-q")
    data = workspace / "discovery" / "data"
    data.mkdir(parents=True)
    shutil.copy(SAMPLE_DATA, data / SAMPLE_DATA.name)
    (workspace / "config.md").write_text(
        "# AIDLC: Discovery Workshop Configuration (end-to-end test)\n\n```yaml\n"
        'data_folder: "discovery/data/"\nresearch_folder: ""\noutput_folder: "discovery/"\n'
        f'project: "{project}"\nengagement_reference: "{reference}"\nunattended: true\n'
        'doc_format: "markdown"\ndefault_persona_count: 3\ncategories: "auto"\n```\n',
        encoding="utf-8",
    )


def stream_text(raw: str) -> tuple[str, dict[str, float]]:
    """Return assistant text and the cost so far of each session in Claude Code stream-json output.

    total_cost_usd is a session's running total: it is repeated on the result event
    emitted each time background subagents wake the main thread, and it carries over
    to --continue. So keep the largest value per session id.
    """
    texts, costs = [], {}
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "text":
                    texts.append(block["text"])
        elif event.get("type") == "result":
            texts.append(str(event.get("result", "")))
            session = str(event.get("session_id", ""))
            costs[session] = max(costs.get(session, 0.0), float(event.get("total_cost_usd") or 0))
    return "\n".join(texts), costs


class Harness:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.sessions: dict[str, float] = {}

    @property
    def cost(self) -> float:
        return sum(self.sessions.values())

    def run(self, workspace: Path, prompt: str, out: Path, name: str, *, resume: bool = False, plugin: bool = True,
            env: dict[str, str] | None = None) -> str:
        a = self.args
        if a.harness == "claude":
            cmd = ["claude", "-p", prompt, "--permission-mode", "bypassPermissions",
                   "--output-format", "stream-json", "--verbose", "--max-budget-usd", str(a.budget_usd)]
            if plugin:
                cmd += ["--plugin-dir", str(ROOT)]
            if resume:
                cmd.append("--continue")
            if a.model:
                cmd += ["--model", a.model]
            if a.isolated:
                cmd += ["--setting-sources", "project"]
        else:
            cmd = ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools"]
            if resume:
                cmd.append("--resume")
            if a.model:
                cmd += ["--model", a.model]
            cmd.append(prompt)
        log(f"{name}: {a.harness} ({'continue' if resume else 'new session'})")
        started = time.monotonic()
        result = subprocess.run(cmd, cwd=workspace, capture_output=True, text=True,
                                timeout=a.timeout_minutes * 60, env={**os.environ, **(env or {})})
        raw = result.stdout + ("\n[stderr]\n" + result.stderr if result.stderr else "")
        suffix = "jsonl" if a.harness == "claude" else "txt"
        with (out / f"{name}.transcript.{suffix}").open("a", encoding="utf-8") as f:
            f.write(raw + "\n")
        text, costs = stream_text(result.stdout) if a.harness == "claude" else (result.stdout, {})
        before = self.cost
        for session, total in costs.items():
            self.sessions[session] = max(self.sessions.get(session, 0.0), total)
        log(f"{name}: exit {result.returncode} in {time.monotonic() - started:.0f}s, cost ${self.cost - before:.2f}")
        return text


def install_skill_for_kiro(workspace: Path) -> None:
    target = workspace / ".kiro" / "skills" / "aidlc-discovery"
    if not target.exists():
        shutil.copytree(ROOT / "skills" / "aidlc-discovery", target)


def aidlc_version() -> tuple[int, ...]:
    try:
        output = subprocess.run(["aidlc", "--version"], capture_output=True, text=True, timeout=30).stdout
    except FileNotFoundError:
        return ()
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", output)
    return tuple(int(x) for x in match.groups()) if match else ()


def leg_discovery(h: Harness, ws: Path, out: Path) -> list[checks.Check]:
    text = h.run(ws, (PROMPTS / "discovery.md").read_text(encoding="utf-8"), out, "discovery")
    return checks.check_discovery(ws, h.args.project, h.args.reference, text)


def leg_missing_prd(h: Harness, ws: Path, out: Path) -> list[checks.Check]:
    copy = out / "workspace-missing-prd"
    shutil.copytree(ws, copy, ignore=shutil.ignore_patterns(".git"))
    git(copy, "init", "-q")
    project = copy / "discovery" / h.args.project
    (project / "working-backwards" / "prd.md").unlink(missing_ok=True)
    shutil.rmtree(project / "handoff", ignore_errors=True)
    text = h.run(copy, (PROMPTS / "handoff-only.md").read_text(encoding="utf-8"), out, "missing-prd")
    return checks.check_missing_prd(copy, h.args.project, text)


def leg_aidlc(h: Harness, ws: Path, out: Path) -> list[checks.Check]:
    version = aidlc_version()
    if version < MIN_AIDLC:
        found = ".".join(map(str, version)) or "not installed"
        return [checks.Check("A00", "AI-DLC 2.10.0 or later is installed", False, f"found {found}")]
    harness = "claude" if h.args.harness == "claude" else "kiro"
    subprocess.run(["aidlc", "config", "--project-dir", str(ws), "--harness", harness, "--mcp", "none", "--quiet"],
                   check=True, capture_output=True, text=True)
    git(ws, "add", "-A")
    git(ws, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "Discovery output")
    p, ref = h.args.project, h.args.reference
    start = (f"/aidlc classic Build the product described in the Discovery brief at "
             f"discovery/{p}/handoff/discovery-brief.md (engagement {ref})")
    env = {"AIDLC_DISABLE_SUMMARY_CONFIRMATION": "1", "AIDLC_DISABLE_LEARNINGS": "1"}
    answer = (PROMPTS / "aidlc-answer.md").read_text(encoding="utf-8")
    h.run(ws, start, out, "aidlc", plugin=False, env=env)
    for turn in range(1, h.args.aidlc_turns + 1):
        if checks.requirements_outputs(checks.active_record(ws)):
            break
        log(f"aidlc: turn {turn}, Requirements Analysis not reached yet")
        h.run(ws, answer, out, "aidlc", resume=True, plugin=False, env=env)
    return checks.check_aidlc(ws, p)


LEGS = {"discovery": leg_discovery, "missing-prd": leg_missing_prd, "aidlc": leg_aidlc}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--harness", choices=["claude", "kiro"], default="claude")
    parser.add_argument("--legs", default="discovery,missing-prd,aidlc",
                        help="comma-separated subset of: " + ", ".join(LEGS))
    parser.add_argument("--out", type=Path, default=ROOT / ".e2e" / datetime.now().strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--workspace", type=Path, help="reuse a finished discovery workspace (for --legs aidlc)")
    parser.add_argument("--project", default="anycompany-e2e")
    parser.add_argument("--reference", default="E2E-0001")
    parser.add_argument("--model", help="harness model id (default: the harness default)")
    parser.add_argument("--budget-usd", type=float, default=25.0, help="Claude Code cost cap per session")
    parser.add_argument("--timeout-minutes", type=int, default=60, help="per harness session")
    parser.add_argument("--aidlc-turns", type=int, default=8, help="max follow-up turns in the AI-DLC leg")
    parser.add_argument("--isolated", action="store_true",
                        help="Claude Code: ignore user settings and plugins (CI default)")
    args = parser.parse_args()

    legs = [leg.strip() for leg in args.legs.split(",") if leg.strip()]
    unknown = set(legs) - LEGS.keys()
    if unknown:
        parser.error(f"unknown legs: {', '.join(sorted(unknown))}")
    binary = "claude" if args.harness == "claude" else "kiro-cli"
    if not shutil.which(binary):
        parser.error(f"{binary} is not on PATH")

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.workspace:
        ws = args.workspace.resolve()
    else:
        ws = out / "workspace"
        prepare_workspace(ws, args.project, args.reference)
    if args.harness == "kiro":
        install_skill_for_kiro(ws)

    harness = Harness(args)
    started = time.monotonic()
    results: dict[str, list[checks.Check]] = {}
    for leg in [name for name in LEGS if name in legs]:
        if leg != "discovery" and "discovery" in results and not all(c.passed for c in results["discovery"]):
            results[leg] = [checks.Check(f"{leg}-skipped", "Skipped: the discovery leg failed", False)]
            continue
        results[leg] = LEGS[leg](harness, ws, out)

    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    passed = all(c.passed for leg_checks in results.values() for c in leg_checks)
    meta = {
        "passed": passed, "harness": args.harness, "model": args.model or "default", "commit": commit,
        "aidlc": ".".join(map(str, aidlc_version())) or "not installed",
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "minutes": round((time.monotonic() - started) / 60, 1), "cost_usd": round(harness.cost, 2),
        "workspace": str(ws),
    }
    report = [f"## AIDLC: Discovery end-to-end {'✅ passed' if passed else '❌ failed'}", "",
              " | ".join(f"**{k}**: {v}" for k, v in meta.items() if k not in {"passed", "workspace"}), ""]
    report += [checks.summarize(leg, leg_checks) for leg, leg_checks in results.items()]
    markdown = "\n".join(report)
    (out / "report.md").write_text(markdown, encoding="utf-8")
    (out / "report.json").write_text(json.dumps(
        {**meta, "legs": {leg: [asdict(c) for c in cs] for leg, cs in results.items()}}, indent=2), encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(markdown + "\n")
    print(markdown)
    log(f"report: {out / 'report.md'}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
