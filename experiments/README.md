# Experiments

Scratch work that is not part of the test run: long parameter sweeps, screenshot probes, timing
experiments. Nothing here is a regression test, and the directory is excluded from the normal
`test`, `typecheck` and `lint` commands. Shared GPU helpers stay in `tests/`.

Run one file with `npx vitest run --silent=false --config experiments/vite.config.ts <file>`.

- `shot.test.ts` is the screenshot tool behind `npm run shot -- <effect>` (see `scripts/shot.mjs`).

Maintained measurements live elsewhere: `npm run study -- --epic <n>` writes `docs/studies/`.
