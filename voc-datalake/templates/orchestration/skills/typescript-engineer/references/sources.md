# Sources

Non-obvious claims verified against upstream docs. Checked 2026-10-28.

- Zod v4 deprecates method-chain string formats (`z.string().email()`,
  `.url()`, `.uuid()`) in favor of top-level functions (`z.email()`,
  `z.url()`, `z.uuid()`). Error flattening moves from `error.flatten()` to
  `z.flattenError(error)`. https://zod.dev/v4/changelog,
  https://zod.dev/error-formatting
- Biome's documented speed claim is "~35x faster than Prettier" for
  formatting, not 100x. https://biomejs.dev/
- `knip --no-exit-code` is a real, current CLI flag ("exit with code zero
  even when there are lint issues"). https://knip.dev/reference/cli
