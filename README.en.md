# blc-plugin-template · BigLazyCat Creator Plugin Template

**简体中文** | [English](README.en.md)

A **ready-to-run** starting point for plugins: backend commands, a browser view, recoverable view state, build configuration, tests and a release workflow are all set up. Clone it, rename a few identifiers, and start implementing your own plugin — no guessing manifest formats from an empty directory.

Repository: <https://github.com/biglazycat-writer/blc-plugin-template>

| Item | Value |
| --- | --- |
| Plugin API | `biglazycat.apiVersion = 1` |
| Runtime | Node `>=22.23.3 <23.0.0` (provided by the host, not bundled in its installer) |
| Backend | TypeScript → `dist/main.js` |
| View | TypeScript + Vite → `dist/ui/index.html` (plain DOM, replaceable with React/Vue) |
| Tests | `node:test` with a mocked `PluginContext`; no running host required |
| SDK | pinned exact version, see `package.json` |
| Example content | 3 commands, 1 view, 2 menu entries, 6 platform declarations |

## Create your project

### Route 1: GitHub template repository (recommended)

This repository is a GitHub **template repository**. Click **Use this template → Create a new repository** to get a fresh repo without this template's commit history, or from the command line:

```bash
gh repo create my-plugin --template biglazycat-writer/blc-plugin-template --private --clone
cd my-plugin
```

### Route 2: clone and switch the remote

```bash
git clone https://github.com/biglazycat-writer/blc-plugin-template.git my-plugin
cd my-plugin
git remote remove origin          # or set-url to your own repository
git remote add origin https://github.com/<your-account>/my-plugin.git
npm install
```

### Route 3: a local-only project

Download and extract the ZIP anywhere, or generate an empty project with the host's `plugin_project_create` MCP tool and copy this template's `src/`, `package.json`, `package-lock.json` etc. into it.

## Must-change checklist

After renaming, run `npm run build && npm test` to confirm everything passes:

| # | Location | Template value | Change to |
| --- | --- | --- | --- |
| 1 | `package.json` → `name` | `blc-plugin-template` | your package name, e.g. `blc-plugin-weather` |
| 2 | `package.json` → `description` / `version` | template blurb / `0.1.0` | your description and version |
| 3 | `biglazycat.displayName` / `description` | Plugin Template · Hello World | how the plugin appears in the host |
| 4 | `biglazycat.contributes.commands[].id` | `template.*` | your own prefix, e.g. `weather.*` |
| 5 | `ctx.commands.register(...)` in `src/main.ts` | the same three ids | **must match the manifest verbatim**, or the host refuses to enable the plugin |
| 6 | `biglazycat.contributes.views` / `menus` | `main`, `template.open` | your view id/title and menu command references |
| 7 | `README.md` title and repo links | this file | your own documentation |

Other conventions:

- Set `aiCallable` / `externalEffect` honestly; only commands that really write to external systems get `externalEffect: true`;
- When adding a command, change **both** the manifest and `src/main.ts`; all commands register during activation;
- The view `entry` points to the build output `dist/ui/index.html` — never to a source path;
- `scripts/package.mjs` and `.github/workflows/release.yml` **need no changes**: package name, version and artifact filenames are read from `package.json`, so they work unchanged after renaming.

## Development commands

```bash
npm ci                # install from the lockfile (SDK pinned at an exact version)
npm run typecheck     # strict typecheck for view and backend tsconfigs
npm run build         # tsc compiles the backend to dist/main.js; Vite bundles the view to dist/ui/
npm test              # node:test; requires dist/main.js, build first
npm run package       # produces dist-package/<name>-<version>.tgz plus SHA-256
```

`dist/` and `node_modules/` stay out of version control; `package-lock.json` must be committed. The host's install-preparation runs `npm ci`, so the first install needs npm registry access.

## Packaging and installation

`npm run package` assembles the `package/` directory from `package.json`'s `files` field, packs it, validates the structure and generates a SHA-256 file into `dist-package/`. **Use this script**: the host strips only the `package/` prefix and reads `package.json` from the archive root — hand-rolled zip/tar archives easily hit the "package.json not found" error.

Install in the desktop app: Plugin center → Install plugin → Plugin package, pick the `.tgz`, and **tick "prepare dependencies, typecheck and build"** (the package contains no `node_modules`).

To publish a Release: bump `version` in `package.json` (optionally add a `CHANGELOG.md` section — the Release notes pick it up automatically), push a `v*` tag, and the workflow builds, tests, packages and creates the Release. The tag must equal `v` + the version. For build validation only, run the Release workflow manually with an empty `tag`.

## What the template demonstrates

**Backend (`src/main.ts`)**: register commands during activation and return a cleanup function; cooperative cancellation via `invocation.signal`; progress reporting; `ctx.views.open()` to open a view with context.

**View (`src/ui/main.ts`)**: `connect()` to the host, `context()` for the view session and restored state; `commands.invoke()` returns a host task, awaited with `waitForTask`; `setState` / `onSave` for state persistence — never put large files or secrets in state. The view uses plain DOM; switching to React/Vue only touches `src/ui` and `vite.config.mjs`.

**Tests (`tests/plugin.test.mjs`)**: a minimal host mock verifying that manifest commands match registrations, plus return values, progress, cancellation and view arguments. No network, no running host. Add a test whenever you add a command.

## Install into the host (development mode)

The full external-AI / MCP workflow lives in the help center under "Plugin Development". In short: configure Node/npm in the host's system settings and enable the MCP plugin tools; after `plugin_install` (development mode), source changes trigger typecheck, build and view refresh; failed builds are visible via `plugin_diagnostics`. Pages open only inside the host — opening `dist/ui/index.html` in a plain browser reports `API_MISMATCH`.

## Going further

Full signatures live in the npm package [blc-plugin-sdk](https://www.npmjs.com/package/blc-plugin-sdk) (`index.d.ts`) and the [SDK repository README](https://github.com/biglazycat-writer/blc-plugin-sdk#readme):

- `ctx.credentials` stores secrets (DPAPI on Windows) — **never** in config files or logs;
- `readDocument` reads an immutable Markdown snapshot (available once you declare `minimumApiRevision: 1`); `ctx.workspace` and `ctx.images` read workspace resources and images;
- `ctx.services` / `ctx.events` / `contributes.schedules` for services, events and scheduled tasks.

A few hard limits to keep in mind: a single command result is **< 1 MiB** and view state caps at 64 KiB, so large payloads need your own chunked transfer (see the official `blc-plugin-publish` plugin); cancellation, exit and timeout can leave `uncertain` external results — never auto-retry side effects; native modules must match OS, architecture and Node ABI.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "command mismatch" when enabling | compare manifest `contributes.commands[].id` with `src/main.ts` registrations verbatim |
| `Cannot find module '../dist/main.js'` | run `npm run build` before testing |
| `API_MISMATCH` | pages open only inside a host plugin view, not a plain browser |
| Build failure | see `npm run typecheck` output and the host's `plugin_diagnostics` |
| `npm ci` engine mismatch | the host enforces `engines.node`: Node `>=22.23.3 <23.0.0` |
| `npm install` cannot find `blc-plugin-sdk` | check npm registry reachability and the dependency declaration |
| View state lost after refresh | confirm `setState` is called and `onSave` writes the state back |

## License

The SDK package [blc-plugin-sdk](https://github.com/biglazycat-writer/blc-plugin-sdk) is MIT. This template's example code may be freely copied, modified and used in your own plugin projects, no attribution required; the repository's overall licensing is up to its maintainer.
