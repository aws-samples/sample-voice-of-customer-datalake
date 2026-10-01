"""Self-tests for the end-to-end checks, on a synthetic workspace.

These run in the free tier on every pull request, so a broken check is caught
before anyone pays for a live harness run.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "e2e"))
import checks  # noqa: E402

PROJECT = "sample"
REFERENCE = "E2E-0001"
PERSONAS = ("Marcus Rivera", "Sarah Chen", "Priya Patel")


def build_workspace(root: Path) -> Path:
    project = root / "discovery" / PROJECT
    for relative in checks.required_artifacts():
        if relative.endswith("*.md"):
            folder = project / relative[: -len("*.md")]
            folder.mkdir(parents=True, exist_ok=True)
            for name in PERSONAS:
                (folder / f"{name.split()[0].lower()}.md").write_text(f"# {name}\n", encoding="utf-8")
        else:
            path = project / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("<html><body>prototype</body></html>" if path.suffix == ".html" else "# artifact\n",
                            encoding="utf-8")
    body = {
        "Engagement reference": f"Intake record: {REFERENCE} | Date: 2026-10-01 | Route: AI-DLC workshop",
        "Target customers and personas": "\n\n".join(f"**{n}** needs faster reports." for n in PERSONAS),
        "Full artifacts": "- [PRD](../working-backwards/prd.md)\n- [Prototype](../prototype/index.html)",
    }
    brief = "# Discovery brief: Sample\n\n" + "".join(
        f"## {i}. {title}\n{body.get(title, 'Content.')}\n\n" for i, title in enumerate(checks.brief_sections(), 1)
    )
    handoff = project / "handoff"
    handoff.mkdir(parents=True, exist_ok=True)
    (handoff / "discovery-brief.md").write_text(brief, encoding="utf-8")
    knowledge = root / "aidlc" / "spaces" / "default" / "knowledge" / "aidlc-product-agent"
    knowledge.mkdir(parents=True)
    (knowledge / "discovery-personas.md").write_text("\n".join(f"# {n}" for n in PERSONAS), encoding="utf-8")
    (root / ".gitignore").write_text("discovery/data/\n", encoding="utf-8")
    return root


TRANSCRIPT = f"Run: /aidlc workshop Build Sample from discovery/{PROJECT}/handoff/discovery-brief.md"


class DiscoveryChecksTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = build_workspace(Path(self.tmp.name))
        self.brief = self.ws / "discovery" / PROJECT / "handoff" / "discovery-brief.md"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def failed(self) -> set[str]:
        return {c.id for c in checks.check_discovery(self.ws, PROJECT, REFERENCE, TRANSCRIPT) if not c.passed}

    def test_valid_workspace_passes_every_check(self) -> None:
        self.assertEqual(set(), self.failed())
        self.assertEqual(14, len(checks.check_discovery(self.ws, PROJECT, REFERENCE, TRANSCRIPT)))

    def test_parsed_contract_matches_the_handoff_prompt(self) -> None:
        self.assertEqual(12, len(checks.brief_sections()))
        self.assertIn("working-backwards/prd.md", checks.required_artifacts())
        self.assertNotIn("signals/current-product-map.md", checks.required_artifacts())

    def test_missing_prd_fails_required_artifacts(self) -> None:
        (self.ws / "discovery" / PROJECT / "working-backwards" / "prd.md").unlink()
        self.assertIn("D01", self.failed())

    def test_reordered_sections_fail(self) -> None:
        text = self.brief.read_text(encoding="utf-8").replace("## 5. Success metrics", "## 5. Metrics")
        self.brief.write_text(text, encoding="utf-8")
        self.assertIn("D03", self.failed())

    def test_opportunity_id_and_email_leaks_fail(self) -> None:
        with self.brief.open("a", encoding="utf-8") as f:
            f.write("\nOpportunity 006Ab00000XyZ12AAB, owner jane.doe@anycompany.com\n")
        self.assertTrue({"D06", "D07"} <= self.failed())

    def test_reserved_placeholder_email_passes(self) -> None:
        (self.ws / "discovery" / PROJECT / "prototype" / "index.html").write_text(
            '<input placeholder="teammate@example.com"><input placeholder="a@b.example.org">', encoding="utf-8")
        self.assertNotIn("D07", self.failed())
        with self.brief.open("a", encoding="utf-8") as f:
            f.write("\nContact ops@example.com.au\n")
        self.assertIn("D07", self.failed())

    def test_wrong_reference_and_missing_gitignore_fail(self) -> None:
        (self.ws / ".gitignore").unlink()
        failed = {c.id for c in checks.check_discovery(self.ws, PROJECT, "OTHER-9", TRANSCRIPT) if not c.passed}
        self.assertTrue({"D05", "D09"} <= failed)

    def test_started_aidlc_and_missing_command_fail(self) -> None:
        memory = self.ws / "aidlc" / "spaces" / "default" / "memory"
        memory.mkdir(parents=True)
        (memory / "project.md").write_text("# Project\n", encoding="utf-8")
        failed = {c.id for c in checks.check_discovery(self.ws, PROJECT, REFERENCE, "no command") if not c.passed}
        self.assertTrue({"D10", "D13"} <= failed)

    def test_personas_outside_the_space_fail(self) -> None:
        space = self.ws / "aidlc" / "spaces" / "default" / "knowledge"
        space.rename(self.ws / "aidlc" / "knowledge")
        self.assertIn("D08", self.failed())

    def test_data_files_and_scripts_in_the_project_folder_fail(self) -> None:
        signals = self.ws / "discovery" / PROJECT / "signals"
        (self.ws / "discovery" / "data").mkdir(parents=True)
        (self.ws / "discovery" / "data" / "enriched.json").write_text("[]", encoding="utf-8")
        (self.ws / "discovery" / "data" / "enrich.py").write_text("", encoding="utf-8")
        self.assertNotIn("D14", self.failed())
        for name in ("voc-analysis.json", "enrich.py", "Export.XLSX"):
            path = signals / name
            path.write_text("[]", encoding="utf-8")
            self.assertIn("D14", self.failed(), name)
            path.unlink()
        self.assertNotIn("D14", self.failed())

    def test_external_script_in_prototype_fails(self) -> None:
        (self.ws / "discovery" / PROJECT / "prototype" / "index.html").write_text(
            '<script src="https://cdn.example.com/x.js"></script>', encoding="utf-8")
        self.assertIn("D12", self.failed())


class MissingPrdChecksTests(unittest.TestCase):
    def test_refusal_passes_and_a_written_brief_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            self.assertTrue(all(c.passed for c in checks.check_missing_prd(ws, PROJECT, "Missing: PRD")))
            build_workspace(ws)
            self.assertFalse(checks.check_missing_prd(ws, PROJECT, "Missing: PRD")[0].passed)


PERSONAS_KNOWLEDGE = "aidlc/spaces/default/knowledge/aidlc-product-agent/discovery-personas.md"


def stream_json(tool_output: str) -> str:
    """One Claude Code stream-json line carrying a tool result."""
    import json
    return json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": tool_output}]}})


ENGINE_DIRECTIVE = stream_json(
    '{"kind":"run-stage","stage":"requirements-analysis","lead_agent":"aidlc-product-agent","mode":"inline",'
    f'"inline_context_paths":[".claude/agents/aidlc-product-agent.md","{PERSONAS_KNOWLEDGE}"],"gate":true}}')


class AidlcChecksTests(unittest.TestCase):
    def test_record_that_used_the_brief_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = build_workspace(Path(tmp))
            record = ws / "aidlc" / "spaces" / "default" / "intents" / "261001-sample"
            (record / ".aidlc-engine").mkdir(parents=True)
            (record / ".aidlc-engine" / "document-input-path").write_text(
                f"discovery/{PROJECT}/handoff/discovery-brief.md\n", encoding="utf-8")
            (record / "aidlc-state.md").write_text("- **Scope**: classic\n", encoding="utf-8")
            ra = record / "inception" / "requirements-analysis"
            ra.mkdir(parents=True)
            (ra / "requirements-analysis-questions.md").write_text("## Q1. What does Marcus need?\n", encoding="utf-8")
            self.assertEqual([], [c.id for c in checks.check_aidlc(ws, PROJECT, ENGINE_DIRECTIVE) if not c.passed])

            (record / ".aidlc-engine" / "document-input-path").write_text(
                f"{ws / 'discovery' / PROJECT / 'handoff' / 'discovery-brief.md'}\n", encoding="utf-8")
            self.assertEqual([], [c.id for c in checks.check_aidlc(ws, PROJECT, ENGINE_DIRECTIVE) if not c.passed])

            (record / "ideation").mkdir()
            (ra / "requirements-analysis-questions.md").write_text("## Q1. Generic question\n", encoding="utf-8")
            failed = {c.id for c in checks.check_aidlc(ws, PROJECT, ENGINE_DIRECTIVE) if not c.passed}
            self.assertEqual({"A04"}, failed)

    def test_personas_must_be_in_the_requirements_analysis_directive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = build_workspace(Path(tmp))
            record = ws / "aidlc" / "spaces" / "default" / "intents" / "261001-sample"
            record.mkdir(parents=True)
            (record / "aidlc-state.md").write_text("- **Scope**: classic\n", encoding="utf-8")

            def a06(transcript: str = "", log: str = "") -> str:
                return next(c for c in checks.check_aidlc(ws, PROJECT, transcript, log) if c.id == "A06").outcome

            # Transcript fallback: the engine's JSON, or the directive re-printed by the model.
            self.assertEqual("pass", a06(ENGINE_DIRECTIVE))
            reprinted = (f"{{'kind': 'run-stage', 'stage': 'requirements-analysis', "
                         f"'inline_context_paths': ['.claude/agents/aidlc-product-agent.md', '{PERSONAS_KNOWLEDGE}']}}")
            self.assertEqual("pass", a06(stream_json(reprinted)))
            without = stream_json('{"stage":"requirements-analysis","inline_context_paths":[".claude/agents/x.md"]}')
            self.assertEqual("fail", a06(without))
            # No directive anywhere is unverified, not a pass; a mention of the path in the brief is not a directive.
            other_stage = ENGINE_DIRECTIVE.replace("requirements-analysis", "practices-discovery")
            brief_mention = stream_json(f"Full personas are in AI-DLC team knowledge: `{PERSONAS_KNOWLEDGE}`.")
            for transcript in ("", other_stage, brief_mention):
                self.assertEqual("unverified", a06(transcript), transcript[:60])

    def test_orchestrate_log_is_read_first(self) -> None:
        import json
        with tempfile.TemporaryDirectory() as tmp:
            ws = build_workspace(Path(tmp))
            record = ws / "aidlc" / "spaces" / "default" / "intents" / "261001-sample"
            record.mkdir(parents=True)
            (record / "aidlc-state.md").write_text("- **Scope**: classic\n", encoding="utf-8")

            def logged(paths: list[str]) -> str:
                directive = {"kind": "run-stage", "stage": "requirements-analysis", "inline_context_paths": paths}
                report = {"argv": ["engine", "orchestrate", "report"], "exit": 0, "stdout": "State advanced"}
                return "\n".join(json.dumps(e) for e in (
                    report, {"argv": ["engine", "orchestrate", "next"], "exit": 0, "stdout": json.dumps(directive)}))

            def a06(transcript: str = "", log: str = "") -> checks.Check:
                return next(c for c in checks.check_aidlc(ws, PROJECT, transcript, log) if c.id == "A06")

            passed = a06(log=logged([".claude/agents/aidlc-product-agent.md", PERSONAS_KNOWLEDGE]))
            self.assertEqual("pass", passed.outcome)
            self.assertIn("orchestrate log", passed.detail)
            # The log wins over the transcript, so a printed directive cannot hide a wrong one.
            self.assertEqual("fail", a06(ENGINE_DIRECTIVE, logged([".claude/agents/x.md"])).outcome)
            fallback = a06(ENGINE_DIRECTIVE, log="")
            self.assertEqual("pass", fallback.outcome)
            self.assertIn("transcript (fallback)", fallback.detail)

    def test_unverified_is_counted_apart_and_does_not_fail(self) -> None:
        results = [checks.Check("A05", "x", True), checks.Check("A06", "y", False, "no evidence", unverified=True)]
        self.assertEqual({"pass": 1, "fail": 0, "unverified": 1}, checks.count_outcomes(results))
        self.assertIn("⚠️ A06", checks.summarize("aidlc", results))
        self.assertIn("Unverified (not a pass)", checks.summarize_unverified({"aidlc": results}))
        self.assertEqual("", checks.summarize_unverified({"aidlc": results[:1]}))

    def test_learnings_diary_alone_is_not_requirements_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            intents = ws / "aidlc" / "spaces" / "default" / "intents"
            for name in ("261001-sample", "261001-zzz-older"):
                (intents / name / "inception" / "requirements-analysis").mkdir(parents=True)
                (intents / name / "aidlc-state.md").write_text("- **Scope**: classic\n", encoding="utf-8")
            (intents / "active-intent").write_text("261001-sample\n", encoding="utf-8")
            record = checks.active_record(ws)
            self.assertEqual("261001-sample", record.name)
            (record / "inception" / "requirements-analysis" / "memory.md").write_text("# Diary\n", encoding="utf-8")
            self.assertEqual([], checks.requirements_outputs(record))


class RunnerTests(unittest.TestCase):
    def test_aidlc_shim_logs_orchestrate_and_passes_output_through(self) -> None:
        import json
        import os
        import subprocess
        import run_e2e
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            real = out / "real-aidlc"
            real.write_text('#!/bin/sh\necho "{\\"args\\": \\"$*\\"}"\nexit 3\n', encoding="utf-8")
            real.chmod(0o755)
            env = {**os.environ, **run_e2e.install_aidlc_shim(out), "E2E_AIDLC_REAL": str(real)}

            def aidlc(*args: str) -> subprocess.CompletedProcess:
                return subprocess.run(["aidlc", *args], env=env, capture_output=True, text=True)

            next_call = aidlc("engine", "orchestrate", "next")
            self.assertEqual((3, '{"args": "engine orchestrate next"}\n'), (next_call.returncode, next_call.stdout))
            self.assertEqual(3, aidlc("engine", "hook", "stop").returncode)
            lines = (out / "aidlc.orchestrate.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual([["engine", "orchestrate", "next"]], [json.loads(line)["argv"] for line in lines])
            self.assertEqual(next_call.stdout, json.loads(lines[0])["stdout"])

    def test_missing_prd_copy_drops_done_lines_from_project_status(self) -> None:
        import run_e2e
        text = ("# Project\nstatus: \"completed\"\nEngagement: E2E-0001\n| 2. Working Backwards | `prd.md` |\n"
                "| 5. Handoff | Done |\n- **Personas:** 3\n")
        self.assertEqual("# Project\nEngagement: E2E-0001\n- **Personas:** 3\n", run_e2e.without_done_lines(text))

    def test_session_cost_is_the_running_total_not_a_sum(self) -> None:
        import json
        import run_e2e
        events = [{"type": "assistant", "message": {"content": [{"type": "text", "text": "Q1?"}]}},
                  {"type": "result", "result": "first", "session_id": "a", "total_cost_usd": 3.34},
                  {"type": "result", "result": "woken by a subagent", "session_id": "a", "total_cost_usd": 3.38},
                  {"type": "result", "result": "other", "session_id": "b", "total_cost_usd": 0.5}]
        text, costs = run_e2e.stream_text("\n".join(json.dumps(e) for e in events))
        self.assertEqual({"a": 3.38, "b": 0.5}, costs)
        self.assertIn("woken by a subagent", text)


if __name__ == "__main__":
    unittest.main()
