# Smell Baseline

Twelve design smells from Fowler, *Refactoring* (2nd ed.), ch. 3, reduced to diff-review
form. Applies during Step 4 of the `code-review` skill even when the repo documents no standards.

## Two Binding Rules

1. **The repo overrides.** `STANDARDS.md`, the repository's notes for contributors (`CONTRIBUTING.md` and the like)
   win.
   Where the repo endorses a pattern this list would flag, suppress the finding and cite the
   overriding rule in the report.
2. **Always a heuristic.** Report as "possible Feature Envy", never as a violation. Severity
   caps at NIT unless the smell also breaks a documented standard or causes a real defect.

Skip anything a linter already enforces. Duplicated tool output and baseline findings on the
same line count as one finding.

## The Twelve

| Smell | Signal in the diff | Direction | Common false positive |
|---|---|---|---|
| Mysterious Name | Name hides what it does or holds | Rename. No honest name means the design is murky | Domain jargon the team uses daily |
| Duplicated Code | Same logic shape in two hunks or files | Extract, call from both | Coincidental similarity across bounded contexts |
| Feature Envy | Method uses another object's data more than its own | Move the method to the data | Deliberate mapper, serializer, or DTO assembler |
| Data Clumps | Same fields travel together through several signatures | Bundle into one type | Framework-imposed signatures |
| Primitive Obsession | String or int stands in for a domain concept | Give the concept a small type | Boundary code where the wire format is the contract |
| Repeated Switches | Same type discriminator cascade in several places | Polymorphism, or one map both sites share | Exhaustive match the type checker verifies |
| Shotgun Surgery | One logical change forced edits across many files | Gather what changes together | Rename propagating mechanically |
| Divergent Change | One module edited for unrelated reasons | Split by reason to change | Entry point or wiring module |
| Speculative Generality | Abstraction or hook the spec does not need | Delete. Inline until a real need appears | Layer boundary port with a real test double |
| Message Chains | Long `a.b().c().d()` navigation at the caller | Hide the walk behind one method | Fluent builder API by design |
| Middle Man | Class or function that mostly forwards | Call the real target | Adapter that exists to invert a dependency |
| Refused Bequest | Subclass ignores most of what it inherits | Composition instead | Framework base class with optional hooks |

## Relationship to Other Checks

| Concern | Owner |
|---|---|
| Pre-write prevention of the same failures | the `use-the-sdk` skill |
| Numeric thresholds (length, nesting, complexity) | the `code-review` skill, Step 8 |
| AI-generated code patterns | the `anti-slop` skill |
| Layering and dependency rule for Python | the `python-engineer` skill's architecture-patterns reference |

Do not report the same root cause twice across these skills. Cite the closest owner.
