// OpenCode v2 resolves a local plugin DIRECTORY entry to `<dir>/server.*` or
// `<dir>/index.*` only — package.json "main" is not consulted (ESM resolution).
// This shim exposes the compiled entry so a dev checkout can be referenced as
// `"plugins": ["<path>/opencode-worktree-isolation"]` or dropped into
// `.opencode/plugins/`. npm-installed packages are unaffected (they resolve by
// name through the normal exports/main machinery).
export { default } from "./dist/index.js"
