import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync, statSync, symlinkSync, lstatSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
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
    atomicWriteFileSync,
    findSessionsForWorktree,
    decidePathAction,
    decideSearchPathAction,
    decideBashAction,
    matchGlob,
    matchWhitelist,
    validateWhitelist,
    computeProjectId,
    ExternalStateBackend,
    createStateBackend,
    SCHEMA_VERSION,
    ensureMeta,
    removeSyncedLinks,
} from "../dist/lib.js"

// Build fixtures from a resolved absolute path so they are native on every OS
// (e.g. "/tmp/test/repo" on Linux/macOS, "C:\tmp\test\repo" on Windows). The old
// hardcoded "C:/test/repo" literals broke on non-Windows because path.resolve()
// treated "C:" as a relative segment and prepended cwd. See issue #2.
const REPO = path.resolve("/tmp/test/repo")
const WT = path.join(path.dirname(REPO), "wt", "abc123", "wt-task")

// Separator- and case-variants derived from the native path. The production
// helpers are supposed to handle both separators regardless of host OS, which
// is what the cross-form assertions below exercise.
const REPO_FWD = REPO.replace(/\\/g, "/")
const REPO_BACK = REPO.replace(/\//g, "\\")

const INT_CTX = {
    isWrite: true,
    toolName: "write",
    repoRoot: REPO,
    worktreePath: WT,
}

test("norm: lowercases and converts backslashes to forward slashes (Windows)", () => {
    // Backslash is only a path separator on Windows, so the backslash→forward-slash
    // collapse is Windows-only behavior. On case-sensitive filesystems the lowercase
    // fold is equally absent, so the whole assertion is gated on win32.
    if (process.platform !== "win32") return
    assert.equal(norm("C:/Test/Repo"), "c:/test/repo")
    assert.equal(norm("C:\\Test\\Repo"), "c:/test/repo")
})

test("norm: native path normalizes to forward-slash lowercase form", () => {
    // Valid on every OS: the normalized form of the resolved REPO must be absolute,
    // use forward slashes, and equal the lowercase of the forward-slash variant.
    const n = norm(REPO)
    assert.ok(!n.includes("\\"), "normalized path must not contain backslashes")
    assert.equal(n, REPO_FWD.toLowerCase())
})

test("norm: resolves relative paths to absolute", () => {
    const r = norm("src/foo.ts")
    assert.ok(path.isAbsolute(r.replace(/\//g, path.sep)) || r.startsWith("/"))
})

test("isInside: file inside base returns true", () => {
    assert.equal(isInside(REPO_FWD + "/src/foo.ts", REPO), true)
})

test("isInside: file equal to base returns true", () => {
    assert.equal(isInside(REPO_FWD, REPO), true)
})

test("isInside: file outside base returns false", () => {
    assert.equal(isInside(path.resolve("/tmp/other/foo.ts"), REPO), false)
})

test("isInside: similar prefix but not inside returns false", () => {
    assert.equal(isInside(REPO_FWD + "-other/foo.ts", REPO), false)
})

test("isInside: case-insensitive (norm lowercases on every OS)", () => {
    // norm() always lowercases both operands, so case differences are folded
    // away regardless of whether the underlying filesystem is case-sensitive.
    assert.equal(isInside(REPO_FWD.toUpperCase() + "/src/foo.ts", REPO), true)
})

test("rewritesToWorktree: repo-root path rewritten to worktree", () => {
    const fp = REPO_FWD + "/src/foo.ts"
    const expected = path.join(WT, path.relative(REPO, fp))
    assert.equal(rewritesToWorktree(fp, REPO, WT), expected)
})

test("rewritesToWorktree: path already in worktree unchanged", () => {
    const fp = path.join(WT, "src/foo.ts")
    assert.equal(rewritesToWorktree(fp, REPO, WT), fp)
})

test("rewritesToWorktree: path outside repo unchanged", () => {
    const fp = path.resolve("/tmp/elsewhere/foo.ts")
    assert.equal(rewritesToWorktree(fp, REPO, WT), fp)
})

test("escapeRegex: escapes regex special chars", () => {
    assert.equal(escapeRegex("a.b*c"), "a\\.b\\*c")
})

test("repoRootRegex: matches forward-slash form", () => {
    assert.ok(repoRootRegex(REPO).test("ls " + REPO_FWD.toLowerCase() + "/src"))
})

test("repoRootRegex: matches backslash form case-insensitively", () => {
    assert.ok(repoRootRegex(REPO).test("type " + REPO_BACK.toUpperCase() + "\\file.txt"))
})

test("repoRootRegex: does not match unrelated path", () => {
    assert.equal(repoRootRegex(REPO).test("ls " + path.resolve("/tmp/other/path").replace(/\\/g, "/")), false)
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
    const fp = REPO_FWD + "/src/foo.ts"
    const args = { filePath: fp }
    applyInterception("write", args, INT_CTX)
    assert.equal(args.filePath, path.join(WT, path.relative(REPO, fp)))
})

test("applyInterception: write with worktree filePath unchanged", () => {
    const fp = path.join(WT, "src/foo.ts")
    const args = { filePath: fp }
    applyInterception("write", args, INT_CTX)
    assert.equal(args.filePath, fp)
})

test("applyInterception: write to .git path throws", () => {
    const args = { filePath: REPO_FWD + "/.git/config" }
    assert.throws(() => applyInterception("write", args, INT_CTX), /\.git paths is blocked/)
})

test("applyInterception: edit and read also rewrite filePath", () => {
    for (const toolName of ["edit", "read"]) {
        const fp = REPO_FWD + "/src/bar.ts"
        const args = { filePath: fp }
        applyInterception(toolName, args, INT_CTX)
        assert.equal(args.filePath, path.join(WT, path.relative(REPO, fp)))
    }
})

test("applyInterception: glob with missing path gets worktree path", () => {
    const args = {}
    applyInterception("glob", args, INT_CTX)
    assert.equal(args.path, WT)
})

test("applyInterception: grep with repo-root path is rewritten", () => {
    const fp = REPO_FWD + "/src"
    const args = { path: fp }
    applyInterception("grep", args, INT_CTX)
    assert.equal(args.path, path.join(WT, path.relative(REPO, fp)))
})

test("applyInterception: glob to .git path throws", () => {
    const args = { path: REPO_FWD + "/.git" }
    assert.throws(() => applyInterception("glob", args, INT_CTX), /\.git paths is blocked/)
})

test("applyInterception: bash with no workdir/cwd gets worktree workdir", () => {
    const args = { command: "ls" }
    applyInterception("bash", args, INT_CTX)
    assert.equal(args.workdir, WT)
})

test("applyInterception: bash with existing workdir keeps it", () => {
    const custom = path.resolve("/tmp/custom/dir")
    const args = { command: "ls", workdir: custom }
    applyInterception("bash", args, INT_CTX)
    assert.equal(args.workdir, custom)
})

test("applyInterception: bash command containing repo root is rewritten", () => {
    const args = { command: "cat " + REPO_FWD + "/file.txt" }
    applyInterception("bash", args, INT_CTX)
    assert.ok(!repoRootRegex(REPO).test(args.command), "repo root should be gone")
    assert.ok(args.command.includes(WT), "worktree path should be present")
})

test("applyInterception: bash command without repo root unchanged", () => {
    const args = { command: "echo hello" }
    applyInterception("bash", args, INT_CTX)
    assert.equal(args.command, "echo hello")
})

test("applyInterception: unknown tool leaves args untouched", () => {
    const fp = REPO_FWD + "/src/foo.ts"
    const args = { filePath: fp, foo: "bar" }
    applyInterception("some_other_tool", args, INT_CTX)
    assert.equal(args.filePath, fp)
    assert.equal(args.foo, "bar")
})

test("applyInterception: write with non-string filePath is ignored", () => {
    const args = { filePath: 123 }
    applyInterception("write", args, INT_CTX)
    assert.equal(args.filePath, 123)
})

describe("atomicWriteFileSync", () => {
    test("writes file correctly", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "awf-"))
        try {
            const fp = path.join(dir, "state.json")
            const payload = JSON.stringify({ hello: "world", n: 42 }, null, 2)
            atomicWriteFileSync(fp, payload)
            assert.ok(existsSync(fp), "target file should exist")
            assert.equal(readFileSync(fp, "utf8"), payload, "content must match exactly")
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("concurrent writes do not corrupt", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "awf-concurrent-"))
        try {
            const target = path.join(dir, "shared.json")
            const libUrl = new URL("../dist/lib.js", import.meta.url).href

            const workerScript = [
                "import { atomicWriteFileSync } from " + JSON.stringify(libUrl),
                "const target = process.argv[1]",
                "const payload = process.argv[2]",
                "const iters = Number(process.argv[3] || 20)",
                "for (let i = 0; i < iters; i++) {",
                "    try { atomicWriteFileSync(target, JSON.stringify({ id: payload, padding: payload.repeat(2000), i })) } catch {}",
                "}",
            ].join("\n")

            writeFileSync(target, JSON.stringify({ id: "init", padding: "" }), "utf8")

            const worker = (payload, iters) => {
                return new Promise((resolve) => {
                    const child = spawn(process.execPath, ["--input-type=module", "-e", workerScript, target, payload, String(iters)], {
                        stdio: ["ignore", "pipe", "pipe"],
                    })
                    child.on("close", () => resolve())
                    child.on("error", () => resolve())
                })
            }

            return Promise.all([
                worker("A", 20),
                worker("B", 20),
            ]).then(() => {
                assert.ok(existsSync(target), "target file must exist after concurrent writes")
                const final = readFileSync(target, "utf8")
                assert.ok(final.length > 0, "final content must not be empty")
                assert.doesNotThrow(() => JSON.parse(final), "final content must be valid JSON (not a torn write)")
                const parsed = JSON.parse(final)
                assert.ok(
                    parsed.id === "A" || parsed.id === "B",
                    `final payload must be one of A/B (atomic — never a mix), got: ${parsed.id}`,
                )
            })
        } finally {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
    })
})

describe("findSessionsForWorktree", () => {
    const WT_PATH = path.resolve("/tmp/test/wt/wt-task-a")
    const WT_PATH_B = path.resolve("/tmp/test/wt/wt-task-b")
    const mkState = (sessions) => ({ sessions })
    const mkBinding = (p) => ({
        branch: "wt/x",
        path: p,
        repoRoot: path.resolve("/tmp/test/repo"),
        title: "t",
        createdAt: "2026-01-01T00:00:00.000Z",
    })

    test("returns session ids that bind the given worktree path", () => {
        const state = mkState({
            "sess-1": mkBinding(WT_PATH),
            "sess-2": mkBinding(WT_PATH),
            "sess-3": mkBinding(WT_PATH_B),
        })
        const result = findSessionsForWorktree(state, WT_PATH)
        assert.deepEqual(result.sort(), ["sess-1", "sess-2"])
    })

    test("excludes the excludeSessionId from results", () => {
        const state = mkState({
            "sess-1": mkBinding(WT_PATH),
            "sess-2": mkBinding(WT_PATH),
        })
        const result = findSessionsForWorktree(state, WT_PATH, "sess-1")
        assert.deepEqual(result, ["sess-2"])
    })

    test("returns empty array when no other session binds the worktree", () => {
        const state = mkState({
            "sess-1": mkBinding(WT_PATH),
            "sess-2": mkBinding(WT_PATH_B),
        })
        const result = findSessionsForWorktree(state, WT_PATH, "sess-1")
        assert.deepEqual(result, [])
    })

    test("matches paths case-insensitively and across separators", () => {
        const state = mkState({
            "sess-1": mkBinding(WT_PATH),
            "sess-2": mkBinding(WT_PATH.replace(/\//g, "\\")),
        })
        const result = findSessionsForWorktree(state, WT_PATH, "sess-1")
        assert.deepEqual(result, ["sess-2"])
    })

    test("returns empty array when state has no sessions", () => {
        const result = findSessionsForWorktree({ sessions: {} }, WT_PATH)
        assert.deepEqual(result, [])
    })
})

describe("decidePathAction", () => {
    const REPO_P = path.resolve("/tmp/decide/repo")
    const WT_P = path.join(path.dirname(REPO_P), "wt", "task")
    const mkCtx = (overrides) => ({
        isWrite: true,
        toolName: "write",
        repoRoot: REPO_P,
        worktreePath: WT_P,
        ...(overrides || {}),
    })

    test("deny: target inside .git", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/.git/config"
        const r = decidePathAction(target, mkCtx())
        assert.equal(r.action, "deny")
        assert.ok(r.reason && r.reason.includes(".git"), "deny reason must mention .git")
        assert.ok(r.reason && r.reason.includes(target), "deny reason must include the offending path")
    })

    test("allow: target inside worktree", () => {
        const target = path.join(WT_P, "src", "foo.ts")
        const r = decidePathAction(target, mkCtx())
        assert.equal(r.action, "allow")
        assert.equal(r.source, "inside-worktree")
        assert.equal(r.newTarget, undefined)
    })

    test("rewrite: target inside repo root but outside worktree", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/src/foo.ts"
        const r = decidePathAction(target, mkCtx())
        assert.equal(r.action, "rewrite")
        assert.equal(r.newTarget, path.join(WT_P, path.relative(REPO_P, target)))
        assert.equal(r.source, "rewrite")
    })

    test("allow: target outside repo", () => {
        const target = path.resolve("/tmp/elsewhere/foo.ts")
        const r = decidePathAction(target, mkCtx())
        assert.equal(r.action, "allow")
        assert.equal(r.source, "outside-repo")
        assert.equal(r.newTarget, undefined)
    })

    test("case-insensitive matching (Windows-style paths)", () => {
        const target = REPO_P.replace(/\\/g, "/").toUpperCase() + "/Src/Foo.ts"
        const r = decidePathAction(target, mkCtx())
        assert.equal(r.action, "rewrite", "uppercase repo path must still match as inside repo")
        assert.ok(r.newTarget, "rewrite result must have newTarget")
    })

    test("read tool marks isWrite=false but path logic is identical", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/src/read.ts"
        const r = decidePathAction(target, mkCtx({ isWrite: false, toolName: "read" }))
        assert.equal(r.action, "rewrite")
        assert.equal(r.newTarget, path.join(WT_P, path.relative(REPO_P, target)))
    })

    test(".git detection works with backslash separators", () => {
        const target = REPO_P.replace(/\//g, "\\") + "\\.git\\config"
        const r = decidePathAction(target, mkCtx())
        assert.equal(r.action, "deny")
    })

    test("strictWrites=true, no binding, write → deny", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/src/foo.ts"
        const r = decidePathAction(target, mkCtx({ worktreePath: null, strictWrites: true, isWrite: true }))
        assert.equal(r.action, "deny")
        assert.ok(r.reason && r.reason.includes("strictWrites"), "deny reason must mention strictWrites")
    })

    test("strictWrites=true, no binding, read → allow", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/src/foo.ts"
        const r = decidePathAction(target, mkCtx({
            worktreePath: null,
            strictWrites: true,
            isWrite: false,
            toolName: "read",
        }))
        assert.equal(r.action, "allow")
        assert.equal(r.source, "no-binding-free")
    })

    test("strictWrites=false, no binding, write → allow (default behavior)", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/src/foo.ts"
        const r = decidePathAction(target, mkCtx({ worktreePath: null, strictWrites: false, isWrite: true }))
        assert.equal(r.action, "allow")
        assert.equal(r.source, "no-binding-free")
    })

    test("strictWrites=true, has binding, write → rewrite (binding wins over strictWrites)", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/src/foo.ts"
        const r = decidePathAction(target, mkCtx({ worktreePath: WT_P, strictWrites: true, isWrite: true }))
        assert.equal(r.action, "rewrite")
        assert.ok(r.newTarget, "rewrite must produce a newTarget")
    })

    test("whitelist hit → allow", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/AGENTS.md"
        const r = decidePathAction(target, mkCtx({
            worktreePath: null,
            strictWrites: true,
            isWrite: true,
            whitelist: ["AGENTS.md"],
        }))
        assert.equal(r.action, "allow")
        assert.equal(r.source, "whitelist")
    })

    test("allowlistMatcher hit → allow", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/CI.md"
        const r = decidePathAction(target, mkCtx({
            worktreePath: null,
            strictWrites: true,
            isWrite: true,
            allowlistMatcher: (p) => p.endsWith("CI.md"),
        }))
        assert.equal(r.action, "allow")
        assert.equal(r.source, "allowlist")
    })

    test("allowlistMatcher takes precedence over whitelist", () => {
        const target = REPO_P.replace(/\\/g, "/") + "/X.md"
        const r = decidePathAction(target, mkCtx({
            worktreePath: null,
            strictWrites: true,
            isWrite: true,
            whitelist: ["WILL-NOT-MATCH.md"],
            allowlistMatcher: () => true,
        }))
        assert.equal(r.action, "allow")
        assert.equal(r.source, "allowlist")
    })
})

describe("decideSearchPathAction", () => {
    const REPO_S = path.resolve("/tmp/decide-search/repo")
    const WT_S = path.join(path.dirname(REPO_S), "wt", "task")

    test("inject: missing path (undefined)", () => {
        const r = decideSearchPathAction(undefined, REPO_S, WT_S)
        assert.equal(r.action, "inject")
        assert.equal(r.newPath, WT_S)
    })

    test("inject: empty string path", () => {
        const r = decideSearchPathAction("", REPO_S, WT_S)
        assert.equal(r.action, "inject")
        assert.equal(r.newPath, WT_S)
    })

    test("allow: path inside worktree", () => {
        const p = path.join(WT_S, "src")
        const r = decideSearchPathAction(p, REPO_S, WT_S)
        assert.equal(r.action, "allow")
        assert.equal(r.newPath, undefined)
    })

    test("rewrite: path inside repo root", () => {
        const p = REPO_S.replace(/\\/g, "/") + "/src"
        const r = decideSearchPathAction(p, REPO_S, WT_S)
        assert.equal(r.action, "rewrite")
        assert.equal(r.newPath, path.join(WT_S, path.relative(REPO_S, p)))
    })

    test("allow: path outside repo", () => {
        const p = path.resolve("/tmp/elsewhere")
        const r = decideSearchPathAction(p, REPO_S, WT_S)
        assert.equal(r.action, "allow")
        assert.equal(r.newPath, undefined)
    })

    test(".git path returns allow (caller responsible for throwing)", () => {
        const p = REPO_S.replace(/\\/g, "/") + "/.git"
        const r = decideSearchPathAction(p, REPO_S, WT_S)
        assert.equal(r.action, "allow")
        assert.equal(r.newPath, undefined)
    })
})

describe("decideBashAction", () => {
    const PROTECTED = new Set(["master", "main"])
    const mkCtx = (overrides) => ({
        command: "git status",
        currentBranch: "master",
        protectedBranches: PROTECTED,
        hasBinding: false,
        strictGitOps: true,
        ...(overrides || {}),
    })

    test("strictGitOps=false → always allow", () => {
        const r = decideBashAction(mkCtx({
            strictGitOps: false,
            command: "git push origin master",
        }))
        assert.equal(r.action, "allow")
        assert.equal(r.source, "strictGitOps-off")
    })

    test("git push origin master → deny", () => {
        const r = decideBashAction(mkCtx({ command: "git push origin master" }))
        assert.equal(r.action, "deny")
        assert.match(r.reason || "", /push to protected branch/)
    })

    test("git push (default, on master) → deny", () => {
        const r = decideBashAction(mkCtx({ command: "git push" }))
        assert.equal(r.action, "deny")
    })

    test("git push origin feature → allow (target not protected)", () => {
        const r = decideBashAction(mkCtx({
            command: "git push origin feature",
            currentBranch: "feature",
        }))
        assert.equal(r.action, "allow")
    })

    test("git merge feature on master → deny", () => {
        const r = decideBashAction(mkCtx({ command: "git merge feature" }))
        assert.equal(r.action, "deny")
        assert.match(r.reason || "", /merge\/rebase\/pull on protected branch/)
    })

    test("git merge master on feature → allow (current branch not protected)", () => {
        const r = decideBashAction(mkCtx({
            command: "git merge master",
            currentBranch: "feature",
        }))
        assert.equal(r.action, "allow")
    })

    test("git checkout master with binding → deny", () => {
        const r = decideBashAction(mkCtx({
            command: "git checkout master",
            hasBinding: true,
        }))
        assert.equal(r.action, "deny")
        assert.match(r.reason || "", /checkout\/switch to protected branch/)
    })

    test("git checkout master without binding → allow", () => {
        const r = decideBashAction(mkCtx({
            command: "git checkout master",
            hasBinding: false,
        }))
        assert.equal(r.action, "allow")
    })

    test("git branch -d wt/fix → deny", () => {
        const r = decideBashAction(mkCtx({ command: "git branch -d wt/fix" }))
        assert.equal(r.action, "deny")
        assert.match(r.reason || "", /git branch -d\/-D is blocked/)
    })

    test("git branch -D wt/fix → deny", () => {
        const r = decideBashAction(mkCtx({ command: "git branch -D wt/fix" }))
        assert.equal(r.action, "deny")
    })

    test("git status → allow", () => {
        const r = decideBashAction(mkCtx({ command: "git status" }))
        assert.equal(r.action, "allow")
    })

    test("non-git command → allow", () => {
        const r = decideBashAction(mkCtx({ command: "ls -la" }))
        assert.equal(r.action, "allow")
    })

    test("compound 'cd x && git merge y' on non-protected branch → allow (matches zcode non-protected semantics)", () => {
        const r = decideBashAction(mkCtx({
            command: "cd x && git merge y",
            currentBranch: "feature",
        }))
        assert.equal(r.action, "allow", "current branch not in protected set → merge is allowed even though regex matches")
    })
})

describe("matchGlob", () => {
    test("** matches across directory boundaries", () => {
        assert.equal(matchGlob("a/b/c/d.ts", "a/**/*.ts"), true)
    })

    test("* matches a single path segment (no slashes)", () => {
        assert.equal(matchGlob("a/foo.ts", "a/*.ts"), true)
        assert.equal(matchGlob("a/sub/foo.ts", "a/*.ts"), false, "* must not cross '/'")
    })

    test("? matches exactly one character", () => {
        assert.equal(matchGlob("a.ts", "?.ts"), true)
        assert.equal(matchGlob("ab.ts", "?.ts"), false)
    })

    test("literal pattern matches identical string", () => {
        assert.equal(matchGlob("AGENTS.md", "AGENTS.md"), true)
    })

    test("non-matching literal returns false", () => {
        assert.equal(matchGlob("README.md", "AGENTS.md"), false)
    })

    test("** at end matches everything underneath", () => {
        assert.equal(matchGlob("docs/deep/x.md", "docs/**"), true)
        assert.equal(matchGlob("src/x.md", "docs/**"), false)
    })
})

describe("matchWhitelist", () => {
    const ROOT = path.resolve("/tmp/wl/repo")

    test("relative pattern resolves under root", () => {
        const target = path.join(ROOT, "AGENTS.md")
        assert.equal(matchWhitelist(target, ROOT, ["AGENTS.md"]), true)
    })

    test("absolute pattern matches directly", () => {
        const target = path.join(ROOT, "src", "foo.ts")
        const absPattern = path.join(ROOT.replace(/\\/g, "/"), "src", "*.ts")
        assert.equal(matchWhitelist(target, ROOT, [absPattern]), true)
    })

    test("miss returns false", () => {
        const target = path.join(ROOT, "secret.env")
        assert.equal(matchWhitelist(target, ROOT, ["AGENTS.md"]), false)
    })

    test("glob ** matches nested paths under root", () => {
        const target = path.join(ROOT, "docs", "deep", "x.md")
        assert.equal(matchWhitelist(target, ROOT, ["docs/**/*.md"]), true)
    })

    test("empty pattern list returns false", () => {
        assert.equal(matchWhitelist(path.join(ROOT, "x"), ROOT, []), false)
    })
})

describe("validateWhitelist", () => {
    test("drops bare *", () => {
        const r = validateWhitelist(["*"])
        assert.deepEqual(r.valid, [])
        assert.deepEqual(r.dangerous, ["*"])
    })

    test("drops /", () => {
        const r = validateWhitelist(["/"])
        assert.deepEqual(r.valid, [])
        assert.deepEqual(r.dangerous, ["/"])
    })

    test("drops .", () => {
        const r = validateWhitelist(["."])
        assert.deepEqual(r.dangerous, ["."])
        assert.deepEqual(r.valid, [])
    })

    test("drops .git and .git/** patterns", () => {
        const r = validateWhitelist([".git", ".git/hooks.sh"])
        assert.deepEqual(r.valid, [])
        assert.deepEqual(r.dangerous, [".git", ".git/hooks.sh"])
    })

    test("drops ** (would allow everything)", () => {
        const r = validateWhitelist(["**"])
        assert.deepEqual(r.dangerous, ["**"])
    })

    test("keeps safe concrete patterns", () => {
        const r = validateWhitelist(["AGENTS.md", "docs/*.md", "package.json"])
        assert.deepEqual(r.valid, ["AGENTS.md", "docs/*.md", "package.json"])
        assert.deepEqual(r.dangerous, [])
    })

    test("mixed input splits correctly", () => {
        const r = validateWhitelist(["AGENTS.md", "*", ".git", "README.md"])
        assert.deepEqual(r.valid, ["AGENTS.md", "README.md"])
        assert.deepEqual(r.dangerous, ["*", ".git"])
    })
})

describe("ExternalStateBackend", () => {
    const repoRoot = path.resolve("/tmp/statebackend/repo")
    const WT_PATH = path.resolve("/tmp/statebackend/wt/task-a")
    const WT_PATH_B = path.resolve("/tmp/statebackend/wt/task-b")
    let stateDir
    let prevEnv

    const mkBinding = (p) => ({
        branch: "wt/test",
        path: p || WT_PATH,
        repoRoot,
        title: "t",
        createdAt: "2026-01-01T00:00:00.000Z",
    })

    before(() => {
        stateDir = mkdtempSync(path.join(tmpdir(), "ocstate-ext-"))
        prevEnv = process.env.OC_WT_STATE_DIR
        process.env.OC_WT_STATE_DIR = stateDir
    })

    after(() => {
        if (prevEnv === undefined) delete process.env.OC_WT_STATE_DIR
        else process.env.OC_WT_STATE_DIR = prevEnv
        try {
            rmSync(stateDir, { recursive: true, force: true })
        } catch {}
    })

    beforeEach(() => {
        const pid = computeProjectId(repoRoot)
        try {
            unlinkSync(path.join(stateDir, `${pid}.json`))
        } catch {}
    })

    test("loadBinding returns null for missing session", () => {
        const backend = new ExternalStateBackend(repoRoot)
        assert.equal(backend.loadBinding("never-exists"), null)
    })

    test("saveBinding + loadBinding round-trip preserves the binding", () => {
        const backend = new ExternalStateBackend(repoRoot)
        const b = mkBinding()
        backend.saveBinding("rt-1", b)
        const loaded = backend.loadBinding("rt-1")
        assert.deepEqual(loaded, b)
    })

    test("saveBinding preserves concurrent sessions in the same project state", () => {
        const backend = new ExternalStateBackend(repoRoot)
        backend.saveBinding("conc-a", mkBinding(WT_PATH))
        backend.saveBinding("conc-b", mkBinding(WT_PATH_B))
        assert.ok(backend.loadBinding("conc-a"), "conc-a must still be present after conc-b written")
        assert.ok(backend.loadBinding("conc-b"), "conc-b must be present")
    })

    test("clearBinding removes the session binding", () => {
        const backend = new ExternalStateBackend(repoRoot)
        backend.saveBinding("clr-1", mkBinding())
        assert.ok(backend.loadBinding("clr-1"), "preload must be present before clear")
        backend.clearBinding("clr-1")
        assert.equal(backend.loadBinding("clr-1"), null, "must be null after clear")
    })

    test("clearBinding is a no-op for a missing session", () => {
        const backend = new ExternalStateBackend(repoRoot)
        assert.doesNotThrow(() => backend.clearBinding("never-exists"))
    })

    test("listBindings returns every saved binding", () => {
        const backend = new ExternalStateBackend(repoRoot)
        backend.saveBinding("lb-1", mkBinding(WT_PATH))
        backend.saveBinding("lb-2", mkBinding(WT_PATH_B))
        const all = backend.listBindings()
        const ids = all.map((x) => x.sessionId).sort()
        assert.deepEqual(ids, ["lb-1", "lb-2"])
        const byId = Object.fromEntries(all.map((x) => [x.sessionId, x.binding]))
        assert.equal(byId["lb-1"].path, WT_PATH)
        assert.equal(byId["lb-2"].path, WT_PATH_B)
    })

    test("listBindings returns empty array when no sessions exist", () => {
        const backend = new ExternalStateBackend(repoRoot)
        assert.deepEqual(backend.listBindings(), [])
    })

    test("findSessionsForWorktree detects cross-session reference", () => {
        const backend = new ExternalStateBackend(repoRoot)
        backend.saveBinding("xref-1", mkBinding(WT_PATH))
        backend.saveBinding("xref-2", mkBinding(WT_PATH))
        backend.saveBinding("xref-3", mkBinding(WT_PATH_B))
        const others = backend.findSessionsForWorktree(WT_PATH, "xref-1").sort()
        assert.deepEqual(others, ["xref-2"])
    })

    test("findSessionsForWorktree returns empty when only self binds the worktree", () => {
        const backend = new ExternalStateBackend(repoRoot)
        backend.saveBinding("selfonly", mkBinding(WT_PATH))
        const others = backend.findSessionsForWorktree(WT_PATH, "selfonly")
        assert.deepEqual(others, [])
    })

    test("loadAll returns WorktreeState shape with saved sessions", () => {
        const backend = new ExternalStateBackend(repoRoot)
        backend.saveBinding("la-1", mkBinding(WT_PATH))
        const state = backend.loadAll()
        assert.ok(state && typeof state === "object", "state must be an object")
        assert.ok(state.sessions && typeof state.sessions === "object", "state.sessions must be an object")
        assert.ok(state.sessions["la-1"], "saved session must appear in loadAll result")
        assert.equal(state.sessions["la-1"].path, WT_PATH)
    })

    test("loadAll on empty state returns { sessions: {} }", () => {
        const backend = new ExternalStateBackend(repoRoot)
        const state = backend.loadAll()
        assert.deepEqual(state, { sessions: {} })
    })

    test("behavior is equivalent to direct loadState/saveState on the same projectId", () => {
        const backend = new ExternalStateBackend(repoRoot)
        const b = mkBinding()
        backend.saveBinding("eq-1", b)
        const pid = computeProjectId(repoRoot)
        const raw = JSON.parse(readFileSync(path.join(stateDir, `${pid}.json`), "utf8"))
        assert.deepEqual(raw.sessions["eq-1"], b, "backend must produce identical on-disk representation")
    })
})

describe("createStateBackend factory", () => {
    test("returns ExternalStateBackend when stateLocation is 'external'", () => {
        const repoRoot = path.resolve("/tmp/statebackend/factory-ext")
        const backend = createStateBackend(repoRoot, {
            branchPrefix: "wt/",
            baseBranch: null,
            worktreeRoot: null,
            protectedBranches: [],
            sync: { copyFiles: [], symlinkDirs: [] },
            hooks: { postCreate: [], preDelete: [] },
            stateLocation: "external",
            strictWrites: false,
            strictGitOps: false,
            mainWriteWhitelist: [],
            allowlistTtlMinutes: 60,
            sessionStartNudge: false,
        })
        assert.equal(backend.constructor.name, "ExternalStateBackend")
    })

    test("returns ExternalStateBackend when stateLocation is omitted-equivalent (default)", () => {
        const repoRoot = path.resolve("/tmp/statebackend/factory-default")
        const backend = createStateBackend(repoRoot, {
            branchPrefix: "wt/",
            baseBranch: null,
            worktreeRoot: null,
            protectedBranches: [],
            sync: { copyFiles: [], symlinkDirs: [] },
            hooks: { postCreate: [], preDelete: [] },
            stateLocation: "external",
            strictWrites: false,
            strictGitOps: false,
            mainWriteWhitelist: [],
            allowlistTtlMinutes: 60,
            sessionStartNudge: false,
        })
        assert.equal(backend.constructor.name, "ExternalStateBackend")
    })
})

describe("ensureMeta", () => {
    test("creates meta.json with current SCHEMA_VERSION when missing", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "meta-create-"))
        try {
            ensureMeta(dir)
            const metaFile = path.join(dir, "meta.json")
            assert.ok(existsSync(metaFile), "meta.json must be created")
            const parsed = JSON.parse(readFileSync(metaFile, "utf8"))
            assert.equal(parsed.schemaVersion, SCHEMA_VERSION, "schemaVersion must match SCHEMA_VERSION")
            assert.ok(typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0, "updatedAt must be a non-empty string")
            const ts = new Date(parsed.updatedAt).getTime()
            assert.ok(!Number.isNaN(ts) && ts > 0, "updatedAt must be a valid ISO-8601 timestamp")
        } finally {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
    })

    test("updates meta.json when schema version is outdated", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "meta-update-"))
        try {
            const metaFile = path.join(dir, "meta.json")
            const staleUpdatedAt = "2020-01-01T00:00:00.000Z"
            writeFileSync(
                metaFile,
                JSON.stringify({ schemaVersion: 1, updatedAt: staleUpdatedAt }),
                "utf8",
            )

            ensureMeta(dir)

            const parsed = JSON.parse(readFileSync(metaFile, "utf8"))
            assert.equal(parsed.schemaVersion, SCHEMA_VERSION, "schemaVersion must be upgraded to current")
            assert.notEqual(parsed.updatedAt, staleUpdatedAt, "updatedAt must be refreshed")
            const ts = new Date(parsed.updatedAt).getTime()
            assert.ok(ts > new Date(staleUpdatedAt).getTime(), "new updatedAt must be more recent than stale")
        } finally {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
    })

    test("no-op when schema version matches (file unchanged)", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "meta-noop-"))
        try {
            ensureMeta(dir)
            const metaFile = path.join(dir, "meta.json")
            const firstContent = readFileSync(metaFile, "utf8")
            const firstMtime = statSync(metaFile).mtimeMs

            ensureMeta(dir)

            const secondContent = readFileSync(metaFile, "utf8")
            const secondMtime = statSync(metaFile).mtimeMs
            assert.equal(secondContent, firstContent, "file content must be identical (no rewrite)")
            assert.equal(secondMtime, firstMtime, "file mtime must be unchanged (no rewrite occurred)")
            const firstParsed = JSON.parse(firstContent)
            const secondParsed = JSON.parse(secondContent)
            assert.equal(secondParsed.updatedAt, firstParsed.updatedAt, "updatedAt must not change on no-op")
        } finally {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
    })
})

describe("removeSyncedLinks", () => {
    test("removes symlinks/junctions inside worktree but preserves their targets", () => {
        const root = mkdtempSync(path.join(tmpdir(), "rsl-"))
        const mainDir = path.join(root, "main")
        const wtDir = path.join(root, "wt")
        const mainNodeModules = path.join(mainDir, "node_modules")
        const wtNodeModules = path.join(wtDir, "node_modules")
        try {
            mkdirSync(mainNodeModules, { recursive: true })
            mkdirSync(wtDir, { recursive: true })
            writeFileSync(path.join(mainNodeModules, "marker.txt"), "main-repo-content")
            try {
                symlinkSync(mainNodeModules, wtNodeModules, process.platform === "win32" ? "junction" : "dir")
            } catch (e) {
                if (process.platform === "win32") {
                    try { symlinkSync(mainNodeModules, wtNodeModules, "dir") } catch { return }
                } else {
                    return
                }
            }

            assert.ok(existsSync(wtNodeModules), "precondition: symlink/junction exists in worktree")
            assert.ok(lstatSync(wtNodeModules).isSymbolicLink(), "precondition: it is a symbolic link")

            removeSyncedLinks(wtDir, ["node_modules"])

            assert.ok(!existsSync(wtNodeModules), "symlink must be removed from worktree")
            assert.ok(existsSync(path.join(mainNodeModules, "marker.txt")), "target file in main repo must NOT be deleted")
            const content = readFileSync(path.join(mainNodeModules, "marker.txt"), "utf8")
            assert.equal(content, "main-repo-content", "target file content must be intact")
        } finally {
            try { rmSync(root, { recursive: true, force: true }) } catch {}
        }
    })

    test("is a no-op when symlinkDirs is empty", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "rsl-empty-"))
        try {
            mkdirSync(path.join(dir, "subdir"), { recursive: true })
            writeFileSync(path.join(dir, "subdir", "file.txt"), "content")

            removeSyncedLinks(dir, [])

            assert.ok(existsSync(path.join(dir, "subdir", "file.txt")), "non-symlink entries must be untouched")
        } finally {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
    })

    test("is a no-op when the symlink path does not exist", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "rsl-missing-"))
        try {
            removeSyncedLinks(dir, ["node_modules", "build"])

            assert.ok(!existsSync(path.join(dir, "node_modules")))
            assert.ok(!existsSync(path.join(dir, "build")))
        } finally {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
    })

    test("leaves regular directories alone (only unlinks symbolic links)", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "rsl-regular-"))
        try {
            mkdirSync(path.join(dir, "node_modules"), { recursive: true })
            writeFileSync(path.join(dir, "node_modules", "pkg.json"), "{}")

            removeSyncedLinks(dir, ["node_modules"])

            assert.ok(existsSync(path.join(dir, "node_modules", "pkg.json")), "regular directory must not be deleted")
        } finally {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
    })
})
