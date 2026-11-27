# Contributing to omp-web

Thanks for your interest in contributing!

## Setup

- Node.js 24 or newer (the server runs on [Bun](https://bun.sh), which `npm install` provides)

```bash
npm install
npm run fetch-omp   # ompweb's omp runner, from the oh-my-pi fork release omp-runner.json pins (SHA-256-checked)
npm run dev   # http://127.0.0.1:30178, Bun hot reload
```

For live sessions the dev server and `ompweb host` need that runner: `npm run fetch-omp` puts it where they find it by
themselves (`OMP_WEB_OMP_BIN` overrides it, e.g. with a runner built from the fork). A stock `omp` does not
speak ompweb's channel. The runner's source is in the fork (`packages/ompweb-runner` of `ompweb-dev/oh-my-pi`), not here.

## Checks (must pass before submitting)

```bash
npm run typecheck                                  # type check
npm run lint                                       # ESLint, zero warnings
npm test                                           # unit tests (bun test --parallel)
```

`npm run build` bundles the browser app into `dist/` and `npm run smoke`
starts the built server and checks it; the dev server never reads `dist/`.

### React tests

Tests use `bun test` with `node:test`-style `test()` calls; no Jest or Vitest configuration is required.
Mock a Node builtin with `mockBuiltin` (`tests/mock-builtin.mjs`, built on `mock.module`) and import the module under test afterwards with a fresh `?fresh=N` query.
For interactive components and hooks, import `tests/setup-dom.mjs` before
`@testing-library/react/pure.js` (both imported dynamically, in that order), and register `cleanup` with `afterEach`.
Use DOM queries and `@testing-library/user-event` for component interactions,
and `renderHook` for hook state and lifecycle tests. Keep the real jsdom
`window` and `document`; mock only the browser or network APIs a scenario needs.

Static HTML tests can continue using `react-dom/server`. Layout, scrolling,
and native browser navigation still require real-browser verification.
The jsdom dependency stays on 29.x for now; moving to a newer major is a separate change.

## Conventions

- **Styling**: use the design tokens in `app/globals.css` (colors, radius,
  shadow, motion) — no hardcoded colors. Shared primitives live in
  `components/ui/` (Dialog/Tooltip/Collapsible/field/toast, built on Base UI);
  icons come from `lucide-react`.
- **i18n**: every user-facing string needs entries in all dictionaries:
  `lib/i18n/locales/{en,zh-CN,zh-TW,ja,cs}.json`.
- **Architecture**: the ompweb server and daemon never import `@oh-my-pi/*` or `@earendil-works/*`
  packages (Bun-only). Live agent features go through the `ompweb-omp` child process
  (built and released by the oh-my-pi fork) over ompweb's channel; see `DESIGN.md` and `AGENTS.md` for the full contract.

## Pull requests

- Keep PRs focused; describe the user-visible change and how you verified it.
- For UI changes, include before/after screenshots in both light and dark
  themes when practical.

## Reporting issues

Please use the issue templates and include your OS, Node version, omp version,
and browser.
