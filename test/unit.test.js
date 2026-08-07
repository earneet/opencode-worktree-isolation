import { test } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import {
    norm,
    isInside,
    rewritesToWorktree,
    validateBranch,
    slugify,
    applyInterception,
    repoRootRegex,
    resolveWorktreeRoot,
    escapeRegex,
} from "../dist/lib.js"

const REPO = "C:/test/repo"
const WT = "C:/test/wt/abc123/wt-task"

test("norm: lowercases and converts backslashes to forward slashes", () => {
    assert.equal(norm("C:/Test/Repo"), "c:/test/repo")
    assert.equal(norm("C:\\Test\\Repo"), "c:/test/repo")
})

test("norm: resolves relative paths to absolute", () => {
    const r = norm("src/foo.ts")
    assert.ok(path.isAbsolute(r.replace(/\//g, path.sep)) || r.startsWith("/"))
})

test("isInside: file inside base returns true", () => {
    assert.equal(isInside("C:/test/repo/src/foo.ts", REPO), true)
})

test("isInside: file equal to base returns true", () => {
    assert.equal(isInside("C:/test/repo", REPO), true)
})

test("isInside: file outside base returns false", () => {
    assert.equal(isInside("C:/other/foo.ts", REPO), false)
})

test("isInside: similar prefix but not inside returns false", () => {
    assert.equal(isInside("C:/test/repo-other/foo.ts", REPO), false)
})

test("isInside: case-insensitive on Windows", () => {
    assert.equal(isInside("C:/TEST/REPO/src/foo.ts", REPO), true)
})

test("rewritesToWorktree: repo-root path rewritten to worktree", () => {
    const fp = "C:/test/repo/src/foo.ts"
    const expected = path.join(WT, path.relative(REPO, fp))
    assert.equal(rewritesToWorktree(fp, REPO, WT), expected)
})

test("rewritesToWorktree: path already in worktree unchanged", () => {
    const fp = path.join(WT, "src/foo.ts")
    assert.equal(rewritesToWorktree(fp, REPO, WT), fp)
})

test("rewritesToWorktree: path outside repo unchanged", () => {
    const fp = "C:/elsewhere/foo.ts"
    assert.equal(rewritesToWorktree(fp, REPO, WT), fp)
})

test("escapeRegex: escapes regex special chars", () => {
    assert.equal(escapeRegex("a.b*c"), "a\\.b\\*c")
})

test("repoRootRegex: matches forward-slash form", () => {
    assert.ok(repoRootRegex(REPO).test("ls c:/test/repo/src"))
})

test("repoRootRegex: matches backslash form case-insensitively", () => {
    assert.ok(repoRootRegex(REPO).test("type C:\\TEST\\REPO\\file.txt"))
})

test("repoRootRegex: does not match unrelated path", () => {
    assert.equal(repoRootRegex(REPO).test("ls c:/other/path"), false)
})

test("validateBranch: valid branch returns name", () => {
    assert.equal(validateBranch("wt/fix-auth"), "wt/fix-auth")
})

test("validateBranch: rejects leading dash (option injection)", () => {
    assert.throws(() => validateBranch("-malicious"), /cannot start with '-'/)
})

test("validateBranch: rejects '..' (path traversal)", () => {
    assert.throws(() => validateBranch("wt/.."), /cannot contain '\.\.'/)
})

test("validateBranch: rejects '@{' (reflog syntax)", () => {
    assert.throws(() => validateBranch("wt/@{1}"), /cannot contain '@\{'/)
})

test("validateBranch: rejects git special chars", () => {
    for (const ch of ["~", "^", ":", "?", "*", "[", "]", "\\"]) {
        assert.throws(() => validateBranch(`wt/bad${ch}name`), /invalid characters/)
    }
})

test("validateBranch: rejects spaces", () => {
    assert.throws(() => validateBranch("wt/has space"), /cannot contain spaces/)
})

test("validateBranch: rejects control characters", () => {
    assert.throws(() => validateBranch("wt/bad\x01name"), /control characters/)
})

test("validateBranch: rejects .lock suffix", () => {
    assert.throws(() => validateBranch("wt/foo.lock"), /cannot end with '\.lock'/)
})

test("validateBranch: rejects empty / non-string", () => {
    assert.throws(() => validateBranch(""), /required/)
    assert.throws(() => validateBranch(null), /required/)
})

test("slugify: converts title to kebab-case slug", () => {
    assert.equal(slugify("Fix Auth Bug"), "fix-auth-bug")
})

test("slugify: collapses special chars to dashes", () => {
    assert.equal(slugify("Hello, World! #2026"), "hello-world-2026")
})

test("slugify: empty/whitespace falls back to 'task'", () => {
    assert.equal(slugify(""), "task")
    assert.equal(slugify("   "), "task")
    assert.equal(slugify("!!!"), "task")
})

test("slugify: truncates to 60 chars", () => {
    const long = "a".repeat(100)
    assert.ok(slugify(long).length <= 60)
})

test("resolveWorktreeRoot: null returns default root", () => {
    const r = resolveWorktreeRoot(null, REPO)
    assert.ok(r.includes("worktree"))
})

test("resolveWorktreeRoot: $REPO placeholder substituted", () => {
    const r = resolveWorktreeRoot("$REPO/.worktrees", REPO)
    assert.ok(r.startsWith(REPO))
})

test("applyInterception: write with repo-root filePath is rewritten", () => {
    const args = { filePath: "C:/test/repo/src/foo.ts" }
    applyInterception("write", args, REPO, WT)
    assert.equal(args.filePath, path.join(WT, path.relative(REPO, "C:/test/repo/src/foo.ts")))
})

test("applyInterception: write with worktree filePath unchanged", () => {
    const fp = path.join(WT, "src/foo.ts")
    const args = { filePath: fp }
    applyInterception("write", args, REPO, WT)
    assert.equal(args.filePath, fp)
})

test("applyInterception: write to .git path throws", () => {
    const args = { filePath: "C:/test/repo/.git/config" }
    assert.throws(() => applyInterception("write", args, REPO, WT), /\.git paths is blocked/)
})

test("applyInterception: edit and read also rewrite filePath", () => {
    for (const toolName of ["edit", "read"]) {
        const args = { filePath: "C:/test/repo/src/bar.ts" }
        applyInterception(toolName, args, REPO, WT)
        assert.equal(args.filePath, path.join(WT, path.relative(REPO, "C:/test/repo/src/bar.ts")))
    }
})

test("applyInterception: glob with missing path gets worktree path", () => {
    const args = {}
    applyInterception("glob", args, REPO, WT)
    assert.equal(args.path, WT)
})

test("applyInterception: grep with repo-root path is rewritten", () => {
    const args = { path: "C:/test/repo/src" }
    applyInterception("grep", args, REPO, WT)
    assert.equal(args.path, path.join(WT, path.relative(REPO, "C:/test/repo/src")))
})

test("applyInterception: glob to .git path throws", () => {
    const args = { path: "C:/test/repo/.git" }
    assert.throws(() => applyInterception("glob", args, REPO, WT), /\.git paths is blocked/)
})

test("applyInterception: bash with no workdir/cwd gets worktree workdir", () => {
    const args = { command: "ls" }
    applyInterception("bash", args, REPO, WT)
    assert.equal(args.workdir, WT)
})

test("applyInterception: bash with existing workdir keeps it", () => {
    const args = { command: "ls", workdir: "C:/custom/dir" }
    applyInterception("bash", args, REPO, WT)
    assert.equal(args.workdir, "C:/custom/dir")
})

test("applyInterception: bash command containing repo root is rewritten", () => {
    const args = { command: "type C:\\test\\repo\\file.txt" }
    applyInterception("bash", args, REPO, WT)
    assert.ok(!repoRootRegex(REPO).test(args.command), "repo root should be gone")
    assert.ok(args.command.includes(WT), "worktree path should be present")
})

test("applyInterception: bash command without repo root unchanged", () => {
    const args = { command: "echo hello" }
    applyInterception("bash", args, REPO, WT)
    assert.equal(args.command, "echo hello")
})

test("applyInterception: unknown tool leaves args untouched", () => {
    const args = { filePath: "C:/test/repo/src/foo.ts", foo: "bar" }
    applyInterception("some_other_tool", args, REPO, WT)
    assert.equal(args.filePath, "C:/test/repo/src/foo.ts")
    assert.equal(args.foo, "bar")
})

test("applyInterception: write with non-string filePath is ignored", () => {
    const args = { filePath: 123 }
    applyInterception("write", args, REPO, WT)
    assert.equal(args.filePath, 123)
})
