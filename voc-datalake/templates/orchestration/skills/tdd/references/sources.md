# Sources

Non-obvious claims verified against upstream sources. Checked 2026-10-28.

- Test sizing (small/medium/large by process, I/O, and network boundaries) and
  DAMP ("Descriptive And Meaningful Phrases") over DRY in test code are
  established testing-engineering conventions, documented for example in
  addyosmani/agent-skills `skills/test-driven-development/SKILL.md` (MIT) and
  Google's own testing size definitions.
  https://github.com/addyosmani/agent-skills
- Adapted for the platform's agents (7.56.00): the red-phase proof undoes the
  fix with `write_file` rather than git, because the checkout's git belongs to
  the harness, which turns the working tree into the submitted patch.
