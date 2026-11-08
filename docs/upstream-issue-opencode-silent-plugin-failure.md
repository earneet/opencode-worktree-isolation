# Upstream issue draft: opencode silently drops plugins that fail to install or load

> Draft for filing against the opencode core repository. Evidence collected on
> Windows 10, opencode 1.18.31 (desktop app + `opencode-ai@1.18.31` CLI), with
> plugin package `opencode-worktree-isolation@0.4.3` (`main: dist/index.js`,
> built via `prepare: tsc`).

## Summary

A plugin installed from a git URL can fail **completely silently**. The only
symptom is that the plugin's tools are missing from the session. Nothing is
logged, nothing is shown in the TUI, and there is no way to distinguish
"plugin loaded" from "plugin never loaded" without outside tooling.

## Reproduction

`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-worktree-isolation@git+https://github.com/earneet/opencode-worktree-isolation.git"]
}
```

The embedded Bun installer materializes the plugin under
`~/.cache/opencode/packages/<spec>/` as a shim package. Bun does not execute
lifecycle scripts of dependencies (trustedDependencies mechanism), so
`prepare: tsc` never runs; devDependencies (typescript) are not installed
either. The installed tree therefore has no `dist/`, and the `main` entry
(`dist/index.js`) does not exist.

Control experiment with the same shim structure:

| installer | `dist/` present | typescript | result |
|---|---|---|---|
| npm 24.21 | yes | yes (runs `prepare` for git deps) | plugin works |
| Bun (embedded, same version family) | no | no (`Blocked 1 postinstall`) | silent failure |

## Four silent failure points

All observed on 1.18.31:

1. **Install time — no entry validation.** After installing a plugin package,
   its `main`/entry file is not checked. A package whose entry point is missing
   is accepted silently.
2. **Load time — no error surface.** A plugin that fails to import or whose
   `Plugin` function throws produces **zero log lines** (verified: the only
   plugin-adjacent lines in `~/.local/share/opencode/log/opencode.log` are the
   per-config-file `message=loading path=...` INFO lines) and no TUI
   indication. The session simply starts without the plugin's tools.
3. **Load time — no positive heartbeat.** Successful plugin loads are not
   logged either, so "plugin active" vs "plugin dead" are indistinguishable
   from the log.
4. **Plugin console output is not captured.** `console.log` / `console.error` /
   `process.stdout.write` / `process.stderr.write` from plugin code are passed
   through to the process console (visible with `opencode run`, useless in the
   desktop app / TUI) and never written to the opencode log. A plugin has no
   supported way to leave a trace in the log.

Related, lower severity:

5. **Plugin spec forms are inconsistently accepted.** Tested with a probe
   plugin on 1.18.31: a bare absolute path (`C:\...\plugin.js`) works,
   `file:///C:/...` works, but `["./plugin.js", {opts}]` (relative path in
   tuple form, both documented shapes combined) is **silently ignored** — no
   load, no error, no log.
6. **Config is not hot-reloaded and startup ordering is invisible.** A desktop
   app instance that started minutes before the plugin entry was added to the
   global config keeps running without the plugin, with no indication that its
   config snapshot is stale. (This one bit a real user today.)

## Requested changes

1. After installing a plugin package, validate that its entry file exists; on
   failure log ERROR and surface in the TUI.
2. Log plugin load failures at ERROR (import errors, exceptions from the
   `Plugin` function, missing exports) and surface them in the TUI.
3. Log one INFO heartbeat per successfully loaded plugin, e.g.
   `plugin loaded <name>@<version> (N tools, M hooks)` — this gives users a
   positive signal that protection-style plugins are actually active.
4. Optionally capture plugin stdout/stderr into the opencode log with a
   `[plugin <name>]` prefix.
5. Consistently accept or reject plugin spec forms; at minimum log when a
   `plugin: [...]` entry resolves to nothing.

## Workarounds used meanwhile (for other plugin authors)

- Ship prebuilt artifacts (commit `dist/` or publish to the npm registry) so
  installation never depends on lifecycle scripts.
- Emit a heartbeat via `console.log` at plugin load (visible in headless/CI).
- Register a `*_doctor` tool that self-reports health, including querying
  `client.tool.ids()` to verify the host actually registered the plugin's
  tools — this catches "loaded but hooks silently not wired" cases.
