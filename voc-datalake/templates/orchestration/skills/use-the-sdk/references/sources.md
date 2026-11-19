# Sources

Non-obvious claims verified against upstream sources. Checked 2026-10-28.

- TC39 `Temporal` is not stable in any shipped Node.js version. Node 25.9.0
  still gates it behind the V8 flag `--harmony-temporal`
  (`node --v8-options | grep -i temporal`; `typeof Temporal` is `undefined`
  unflagged). The earlier claim of "Node 26+" general availability was
  unverified. Verify with `typeof Temporal` before depending on it.
  https://nodejs.org/en/blog/release/v24.4.0
