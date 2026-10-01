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
        self.assertEqual(13, len(checks.check_discovery(self.ws, PROJECT, REFERENCE, TRANSCRIPT)))

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
            self.assertEqual([], [c.id for c in checks.check_aidlc(ws, PROJECT) if not c.passed])

            (record / "ideation").mkdir()
            (ra / "requirements-analysis-questions.md").write_text("## Q1. Generic question\n", encoding="utf-8")
            failed = {c.id for c in checks.check_aidlc(ws, PROJECT) if not c.passed}
            self.assertEqual({"A04", "A06"}, failed)


if __name__ == "__main__":
    unittest.main()
