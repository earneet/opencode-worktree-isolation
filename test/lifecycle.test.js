import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import WorktreePlugin from "../index.js"
import { git, computeProjectId, loadState } from "../lib.js"

const testRoot = mkdtempSync(path.join(tmpdir(), "ocwt-lifecycle-"))
const repoDir = path.join(testRoot, "repo")
const stateDir = path.join(testRoot, "state")
const wtRoot = path.join(testRoot, "worktrees")

process.env.OC_WT_STATE_DIR = stateDir
process.env.OC_WT_ROOT = wtRoot

const SESSION = "test-session-1"
const mockClient = { session: { get: async () => ({ data: { parentID: null } }) } }
const makeTctx = () => ({ directory: repoDir, sessionID: SESSION, metadata: () => {} })

let plugin
let worktreePath
let branchName

after(() => {
    try {
        rmSync(testRoot, { recursive: true, force: true })
    } catch {}
})

test("setup: create a temp git repo with a base commit", () => {
    mkdirSync(repoDir, { recursive: true })
    assert.ok(git(["init"], repoDir).ok, "git init")
    assert.ok(git(["config", "user.email", "test@test.com"], repoDir).ok)
    assert.ok(git(["config", "user.name", "Test"], repoDir).ok)
    writeFileSync(path.join(repoDir, "README.md"), "# test repo\n")
    assert.ok(git(["add", "README.md"], repoDir).ok)
    assert.ok(git(["commit", "-m", "initial commit"], repoDir).ok)
})

test("plugin loads and exposes the three worktree tools", async () => {
    plugin = await WorktreePlugin({ directory: repoDir, client: mockClient })
    assert.ok(plugin.tool.worktree_prepare, "worktree_prepare present")
    assert.ok(plugin.tool.worktree_cleanup, "worktree_cleanup present")
    assert.ok(plugin.tool.worktree_merge, "worktree_merge present")
    assert.equal(typeof plugin["tool.execute.before"], "function", "before hook present")
})

test("worktree_prepare creates a worktree, branch, and binds the session", async () => {
    const result = await plugin.tool.worktree_prepare.execute({ title: "lifecycle test" }, makeTctx())
    assert.ok(result.startsWith("✅"), `prepare should succeed, got: ${result}`)

    const wtList = git(["worktree", "list"], repoDir).stdout
    assert.ok(wtList.split("\n").length >= 2, "should have main + 1 worktree")

    branchName = "wt/lifecycle-test"
    const branchRes = git(["rev-parse", "--verify", branchName], repoDir)
    assert.ok(branchRes.ok, `branch ${branchName} should exist`)

    const pid = computeProjectId(repoDir)
    const state = loadState(pid)
    assert.ok(state.sessions[SESSION], "session should be bound")
    assert.equal(state.sessions[SESSION].branch, branchName)
    worktreePath = state.sessions[SESSION].path
    assert.ok(existsSync(worktreePath), `worktree dir should exist: ${worktreePath}`)
    assert.ok(worktreePath.startsWith(wtRoot), "worktree should be under OC_WT_ROOT")
})

test("interception hook rewrites a repo-root write path into the worktree", async () => {
    const output = { args: { filePath: path.join(repoDir, "feature.txt") } }
    await plugin["tool.execute.before"](
        { tool: "write", sessionID: SESSION, callID: "c1" },
        output,
    )
    assert.ok(
        output.args.filePath.startsWith(worktreePath),
        `filePath should be rewritten into worktree, got: ${output.args.filePath}`,
    )
})

test("interception hook injects worktree path for glob without path", async () => {
    const output = { args: { pattern: "*.js" } }
    await plugin["tool.execute.before"](
        { tool: "glob", sessionID: SESSION, callID: "c2" },
        output,
    )
    assert.equal(output.args.path, worktreePath)
})

test("interception hook is a no-op for an unbound session", async () => {
    const output = { args: { filePath: path.join(repoDir, "x.txt") } }
    await plugin["tool.execute.before"](
        { tool: "write", sessionID: "unbound-session", callID: "c3" },
        output,
    )
    assert.equal(output.args.filePath, path.join(repoDir, "x.txt"), "unbound session path untouched")
})

test("worktree_merge preview reports the plan without merging", async () => {
    writeFileSync(path.join(worktreePath, "feature.txt"), "feature work\n")
    const result = await plugin.tool.worktree_merge.execute({ action: "preview" }, makeTctx())
    assert.ok(result.includes("Merge preview"), `should be a preview, got: ${result}`)
    assert.ok(!existsSync(path.join(repoDir, "feature.txt")), "preview must not merge yet")
})

test("worktree_merge apply merges work, removes worktree, deletes branch, unbinds", async () => {
    const result = await plugin.tool.worktree_merge.execute({ action: "apply" }, makeTctx())
    assert.ok(result.startsWith("✅"), `merge should succeed, got: ${result}`)

    assert.ok(existsSync(path.join(repoDir, "feature.txt")), "merged file should be in repo root")
    assert.equal(readFileSync(path.join(repoDir, "feature.txt"), "utf8"), "feature work\n")

    assert.ok(!existsSync(worktreePath), "worktree dir should be removed")

    const branchRes = git(["rev-parse", "--verify", branchName], repoDir)
    assert.ok(!branchRes.ok, `branch ${branchName} should be deleted`)

    const pid = computeProjectId(repoDir)
    const state = loadState(pid)
    assert.ok(!state.sessions[SESSION], "session should be unbound")
})

test("worktree_cleanup removes a freshly prepared (unmerged) worktree with force", async () => {
    const prep = await plugin.tool.worktree_prepare.execute({ title: "cleanup test" }, makeTctx())
    assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
    const pid = computeProjectId(repoDir)
    const wtPath = loadState(pid).sessions[SESSION].path
    assert.ok(existsSync(wtPath), "worktree created")

    const result = await plugin.tool.worktree_cleanup.execute(
        { action: "apply", branch: "wt/cleanup-test", force: true },
        makeTctx(),
    )
    assert.ok(result.includes("wt/cleanup-test: removed"), `cleanup should remove, got: ${result}`)
    assert.ok(!existsSync(wtPath), "worktree dir removed after cleanup")
    assert.ok(!loadState(pid).sessions[SESSION], "session unbound after cleanup")
})
