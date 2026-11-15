# Gate pack fixtures

Tiny, fictional repositories written for this sample, one passing and one failing per pack. They are MIT
licensed like the rest of this repository. The quality gate's tests
(`voc-datalake/lambda/engineering/quality_gate/test/`) detect and plan every one of them, and run their test
step for real when the toolchain is installed (`cargo`, `python` with pytest, `mvn`); each failing fixture
differs from its passing twin by one wrong line, which its test catches.

| Fixture | Languages | What fails |
|---|---|---|
| `rust-ts/passing`, `rust-ts/failing` | a Rust crate and a small Node package | `cargo test`: `add` multiplies |
| `python-ts/passing`, `python-ts/failing` | a Python module with pytest tests | `pytest`: `add` subtracts |
| `java/passing`, `java/failing` | a Maven project with JUnit tests | `mvn verify`: `add` subtracts |

Copy a fixture to a temporary directory before running anything in it: builds write `target/` and caches.
