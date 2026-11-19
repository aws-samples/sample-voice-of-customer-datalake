# Sources

Checked 2026-10-28.

- py-spy: "extremely low overhead" claim, runs out-of-process via Rust:
  https://github.com/benfred/py-spy
- scalene: overhead "typically no more than 10-20% (and often less)":
  https://github.com/plasma-umass/scalene
- memray: claims minimal slowdown ("profiling slows the application only slightly") but
  does not claim production-safety; native tracking is the slower path and is opt-in:
  https://github.com/bloomberg/memray
