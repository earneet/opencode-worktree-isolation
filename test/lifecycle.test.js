import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import pluginEntry from "../dist/index.js"
import { git, computeProjectId, loadState, saveState, GitCommonStateBackend, SCHEMA_VERSION, ensureMeta } from "../dist/lib.js"

const testRoot = mkdtempSync(path.join(tmpdir(), "ocwt-lifecycle-"))
const wtRoot = path.join(testRoot, "worktrees")

process.env.OC_WT_STATE_DIR = path.join(testRoot, "state")
process.env.OC_WT_ROOT = wtRoot

function makePushableStream() {
    const queue = []
    const waiters = []
    let done = false
    const end = () => {
        done = true
        while (waiters.length) waiters.shift()(undefined)
    }
    const push = (ev) => {
        if (done) return
        if (waiters.length) waiters.shift()(ev)
        else queue.push(ev)
    }
    const stream = {
        [Symbol.asyncIterator]: () => ({
            next: () => {
                if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
                if (done) return Promise.resolve({ done: true })
                return new Promise((resolve) => waiters.push(resolve)).then((v) =>
                    v === undefined ? { done: true } : { value: v, done: false },
                )
            },
        }),
    }
    return { push, end, stream }
}

// Both harnesses expose the same surface so every lifecycle test below runs
// unchanged against the V1 entry (.server, V1 hook shapes) and the V2 entry
// (.setup with a mocked plugin context, V2 hook/event shapes).
function makeV1Harness(repoDir, SESSION) {
    let hooks = null
    const updates = []
    const mockClient = { session: { get: async () => ({ data: { parentID: null } }) } }
    const makeTctx = (sid) => ({
        directory: repoDir,
        sessionID: sid,
        metadata: (m) => {
            updates.push(m)
        },
    })
    return {
        kind: "v1",
        updates,
        async init() {
            hooks = await pluginEntry.server({ directory: repoDir, client: mockClient })
            return hooks
        },
        get toolNames() {
            return Object.keys(hooks.tool)
        },
        prepare: (args, sid = SESSION) => hooks.tool.worktree_prepare.execute(args, makeTctx(sid)),
        cleanupWorktrees: (args, sid = SESSION) => hooks.tool.worktree_cleanup.execute(args, makeTctx(sid)),
        merge: (args, sid = SESSION) => hooks.tool.worktree_merge.execute(args, makeTctx(sid)),
        allow: (args, sid = SESSION) => hooks.tool.worktree_allow.execute(args, makeTctx(sid)),
        async intercept(tool, args, sid = SESSION) {
            await hooks["tool.execute.before"]({ tool, sessionID: sid, callID: "c" }, { args })
        },
        async systemPrompt(sid = SESSION) {
            const output = { system: [] }
            await hooks["experimental.chat.system.transform"]({ sessionID: sid }, output)
            return output.system.map((p) => (typeof p === "string" ? p : p.text))
        },
        async emit(type, payload) {
            const properties = type === "session.deleted" ? { info: { id: payload.sessionID } } : payload
            await hooks.event({ event: { type, properties } })
        },
        async dispose() {},
    }
}

function makeV2Harness(repoDir, SESSION) {
    const tools = new Map()
    const toolHooks = new Map()
    const sessionHooks = new Map()
    const updates = []
    const pushable = makePushableStream()
    const callCtx = (sid) => ({ sessionID: sid, agent: "build", messageID: "msg_1", id: "call_1" })
    const ctx = {
        location: { directory: repoDir, project: { id: "test-project" } },
        session: {
            get: async ({ sessionID }) => ({ id: sessionID, parentID: null }),
            update: async (input) => {
                updates.push(input)
            },
            hook: async (name, cb) => {
                sessionHooks.set(name, cb)
                return { dispose: async () => {} }
            },
        },
        tool: {
            transform: async (cb) => {
                cb({
                    add: (t) => {
                        tools.set(t.name, t)
                    },
                })
                return { dispose: async () => {} }
            },
            hook: async (name, cb) => {
                toolHooks.set(name, cb)
                return { dispose: async () => {} }
            },
        },
        event: {
            subscribe: ({ signal }) => {
                if (signal?.addEventListener) signal.addEventListener("abort", () => pushable.end())
                return pushable.stream
            },
        },
    }
    // V2 tool executors return Tool.Result ({ content }); the harness normalizes
    // to the plain string both generations share.
    const unwrap = (promise) =>
        promise.then((result) => (result && typeof result.content === "string" ? result.content : result))
    const harness = {
        kind: "v2",
        updates,
        async init() {
            const cleanup = await pluginEntry.setup(ctx)
            harness.dispose = async () => {
                await cleanup()
            }
            return cleanup
        },
        get toolNames() {
            return [...tools.keys()]
        },
        prepare: (args, sid = SESSION) => unwrap(tools.get("worktree_prepare").execute(args, callCtx(sid))),
        cleanupWorktrees: (args, sid = SESSION) => unwrap(tools.get("worktree_cleanup").execute(args, callCtx(sid))),
        merge: (args, sid = SESSION) => unwrap(tools.get("worktree_merge").execute(args, callCtx(sid))),
        allow: (args, sid = SESSION) => unwrap(tools.get("worktree_allow").execute(args, callCtx(sid))),
        async intercept(tool, args, sid = SESSION) {
            await toolHooks.get("execute.before")({ tool, ...callCtx(sid), input: args })
        },
        async systemPrompt(sid = SESSION) {
            const event = {
                sessionID: sid,
                agent: "build",
                model: { providerID: "test", id: "model" },
                system: [],
                messages: [],
                options: {},
                tools: {},
            }
            await sessionHooks.get("context")(event)
            return event.system.map((p) => p.text)
        },
        async emit(type, payload, locationDirectory = repoDir) {
            pushable.push({ type, data: payload, location: { directory: locationDirectory } })
            await new Promise((resolve) => setImmediate(resolve))
        },
        async dispose() {},
    }
    return harness
}

const harnessMakers = [
    ["v1", makeV1Harness],
    ["v2", makeV2Harness],
]

for (const [label, makeHarness] of harnessMakers) {
    describe(`full lifecycle (${label} entry)`, () => {
        const repoDir = path.join(testRoot, `repo-${label}`)
        const SESSION = `test-session-${label}`
        let h
        let worktreePath
        let branchName

        before(async () => {
            mkdirSync(repoDir, { recursive: true })
            assert.ok(git(["init"], repoDir).ok, "git init")
            assert.ok(git(["config", "user.email", "test@test.com"], repoDir).ok)
            assert.ok(git(["config", "user.name", "Test"], repoDir).ok)
            assert.ok(git(["config", "core.autocrlf", "false"], repoDir).ok)
            writeFileSync(path.join(repoDir, "README.md"), "# test repo\n")
            assert.ok(git(["add", "README.md"], repoDir).ok)
            assert.ok(git(["commit", "-m", "initial commit"], repoDir).ok)
            h = makeHarness(repoDir, SESSION)
            await h.init()
        })

        test(`loads and exposes the four worktree tools (${label})`, () => {
            assert.deepEqual(
                [...h.toolNames].sort(),
                ["worktree_allow", "worktree_cleanup", "worktree_merge", "worktree_prepare"],
            )
        })

        test(`worktree_prepare creates a worktree, branch, and binds the session (${label})`, async () => {
            const result = await h.prepare({ title: "lifecycle test" })
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

        test(`interception hook rewrites a repo-root write path into the worktree (${label})`, async () => {
            const fileField = h.kind === "v1" ? "filePath" : "path"
            const args = { [fileField]: path.join(repoDir, "feature.txt") }
            await h.intercept("write", args)
            assert.ok(
                args[fileField].startsWith(worktreePath),
                `${fileField} should be rewritten into worktree, got: ${args[fileField]}`,
            )
        })

        test(`interception hook injects worktree path for glob without path (${label})`, async () => {
            const args = { pattern: "*.js" }
            await h.intercept("glob", args)
            assert.equal(args.path, worktreePath)
        })

        test(`interception hook is a no-op for an unbound session (${label})`, async () => {
            const fileField = h.kind === "v1" ? "filePath" : "path"
            const args = { [fileField]: path.join(repoDir, "x.txt") }
            await h.intercept("write", args, "unbound-session")
            assert.equal(args[fileField], path.join(repoDir, "x.txt"), "unbound session path untouched")
        })

        test(`interception hook denies patch while a worktree is bound (${label})`, async () => {
            const args = { patchText: "*** Update File: src/foo.ts\n@@" }
            await assert.rejects(() => h.intercept("patch", args), /patch tool cannot be redirected/)
        })

        test(`system prompt announces the active worktree (${label})`, async () => {
            const parts = await h.systemPrompt(SESSION)
            assert.ok(parts.length > 0, "bound session must receive a system prompt part")
            const text = parts.join("\n")
            assert.ok(text.includes("ACTIVE WORKTREE"), `prompt must announce the worktree, got: ${text}`)
            assert.ok(text.includes(worktreePath), "prompt must contain the worktree path")
            assert.ok(text.includes(branchName), "prompt must contain the branch name")

            const unbound = await h.systemPrompt("never-bound-session")
            assert.equal(unbound.length, 0, "unbound session must get no prompt when nudges are off")
        })

        test(`worktree_merge preview reports the plan without merging (${label})`, async () => {
            writeFileSync(path.join(worktreePath, "feature.txt"), "feature work\n")
            const result = await h.merge({ action: "preview" })
            assert.ok(result.includes("Merge preview"), `should be a preview, got: ${result}`)
            assert.ok(!existsSync(path.join(repoDir, "feature.txt")), "preview must not merge yet")
        })

        test(`worktree_merge apply merges work, removes worktree, deletes branch, unbinds (${label})`, async () => {
            const result = await h.merge({ action: "apply" })
            assert.ok(result.startsWith("✅"), `merge should succeed, got: ${result}`)

            assert.ok(existsSync(path.join(repoDir, "feature.txt")), "merged file should be in repo root")
            assert.equal(readFileSync(path.join(repoDir, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "feature work\n")

            assert.ok(!existsSync(worktreePath), "worktree dir should be removed")

            const branchRes = git(["rev-parse", "--verify", branchName], repoDir)
            assert.ok(!branchRes.ok, `branch ${branchName} should be deleted`)

            const pid = computeProjectId(repoDir)
            const state = loadState(pid)
            assert.ok(!state.sessions[SESSION], "session should be unbound")
        })

        test(`worktree_cleanup removes a freshly prepared (unmerged) worktree with force (${label})`, async () => {
            const prep = await h.prepare({ title: "cleanup test" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const wtPath = loadState(pid).sessions[SESSION].path
            assert.ok(existsSync(wtPath), "worktree created")

            const result = await h.cleanupWorktrees({ action: "apply", branch: "wt/cleanup-test", force: true })
            assert.ok(result.includes("wt/cleanup-test: removed"), `cleanup should remove, got: ${result}`)
            assert.ok(!existsSync(wtPath), "worktree dir removed after cleanup")
            assert.ok(!loadState(pid).sessions[SESSION], "session unbound after cleanup")
        })

        test(`worktree_cleanup refuses to remove worktree still bound by another session (${label})`, async () => {
            const prep = await h.prepare({ title: "double bound" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)

            const pid = computeProjectId(repoDir)
            const state = loadState(pid)
            const original = state.sessions[SESSION]
            assert.ok(original, "original session binding must exist")

            state.sessions["other-session-2"] = { ...original }
            saveState(pid, state)

            const wtPath = state.sessions[SESSION].path
            assert.ok(existsSync(wtPath), "worktree still present")

            const result = await h.cleanupWorktrees({ action: "apply", branch: "wt/double-bound", force: true })
            assert.ok(
                result.includes("仍被其他独立会话绑定") && result.includes("other-session-2"),
                `cleanup should refuse with dangling-session message, got: ${result}`,
            )
            assert.ok(existsSync(wtPath), "worktree must NOT be removed when other session is bound")

            const blockedState = loadState(pid)
            assert.ok(blockedState.sessions[SESSION], "original session binding preserved")
            assert.ok(blockedState.sessions["other-session-2"], "other session binding preserved")

            delete blockedState.sessions["other-session-2"]
            saveState(pid, blockedState)

            const cleanup = await h.cleanupWorktrees({ action: "apply", branch: "wt/double-bound", force: true })
            assert.ok(cleanup.includes("wt/double-bound: removed"), `cleanup after removing other binding should succeed, got: ${cleanup}`)
        })

        test(`worktree_merge refuses to merge worktree still bound by another session (${label})`, async () => {
            const prep = await h.prepare({ title: "merge guard" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)

            const pid = computeProjectId(repoDir)
            const state = loadState(pid)
            const original = state.sessions[SESSION]
            assert.ok(original, "original session binding must exist")

            state.sessions["other-session-3"] = { ...original }
            saveState(pid, state)

            const wtPath = state.sessions[SESSION].path
            writeFileSync(path.join(wtPath, "guarded.txt"), "work\n")

            const result = await h.merge({ action: "apply" })
            assert.ok(
                result.startsWith("❌") && result.includes("仍被其他独立会话绑定") && result.includes("other-session-3"),
                `merge should refuse with dangling-session error, got: ${result}`,
            )
            assert.ok(existsSync(wtPath), "worktree must NOT be removed when other session is bound")
            assert.ok(!existsSync(path.join(repoDir, "guarded.txt")), "merge must not have happened")

            const finalState = loadState(pid)
            assert.ok(finalState.sessions[SESSION], "original session binding preserved")
            assert.ok(finalState.sessions["other-session-3"], "other session binding preserved")

            delete finalState.sessions["other-session-3"]
            saveState(pid, finalState)

            const mergeOk = await h.merge({ action: "apply" })
            assert.ok(mergeOk.startsWith("✅"), `merge after removing other binding should succeed, got: ${mergeOk}`)
        })

        test(`merge preview lists the files that will be auto-committed (${label})`, async () => {
            const prep = await h.prepare({ title: "preview list" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const wtPath = loadState(pid).sessions[SESSION].path
            writeFileSync(path.join(wtPath, "uncommitted-a.txt"), "a\n")
            writeFileSync(path.join(wtPath, "uncommitted-b.txt"), "b\n")

            const result = await h.merge({ action: "preview" })
            assert.ok(result.includes("uncommitted-a.txt"), `preview must list uncommitted-a.txt, got:\n${result}`)
            assert.ok(result.includes("uncommitted-b.txt"), `preview must list uncommitted-b.txt, got:\n${result}`)

            const cleanup = await h.cleanupWorktrees({ action: "apply", branch: "wt/preview-list", force: true })
            assert.ok(cleanup.includes("wt/preview-list: removed"), `cleanup should succeed, got: ${cleanup}`)
        })

        test(`zombie binding: externally deleted worktree dir no longer rewrites paths (issue #7) (${label})`, async () => {
            const prep = await h.prepare({ title: "zombie binding" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const wtPath = loadState(pid).sessions[SESSION].path
            assert.ok(existsSync(wtPath), "worktree created")

            rmSync(wtPath, { recursive: true, force: true })
            assert.ok(!existsSync(wtPath), "worktree dir externally deleted")

            const fileField = h.kind === "v1" ? "filePath" : "path"
            const args = { [fileField]: path.join(repoDir, "main-checkout.txt") }
            await h.intercept("read", args)
            assert.equal(
                args[fileField],
                path.join(repoDir, "main-checkout.txt"),
                `ghost binding must NOT rewrite paths (got ${args[fileField]})`,
            )
            assert.ok(!loadState(pid).sessions[SESSION], "zombie binding must be auto-cleared")
        })

        test(`worktree_cleanup prunes and unbinds when the worktree dir is already missing (issue #7) (${label})`, async () => {
            const prep = await h.prepare({ title: "missing dir" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const wtPath = loadState(pid).sessions[SESSION].path
            rmSync(wtPath, { recursive: true, force: true })
            assert.ok(!existsSync(wtPath), "worktree dir externally deleted")

            const result = await h.cleanupWorktrees({ action: "apply", branch: "wt/missing-dir", force: true })
            assert.ok(result.includes("wt/missing-dir: removed"), `cleanup must handle missing dir, got: ${result}`)
            assert.ok(!loadState(pid).sessions[SESSION], "session unbound after missing-dir cleanup")
        })

        test(`merge apply survives a path-length deletion failure via fallback deletion (issue #7) (${label})`, async () => {
            const prep = await h.prepare({ title: "long path" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const wtPath = loadState(pid).sessions[SESSION].path
            writeFileSync(path.join(wtPath, "feature.txt"), "long path feature\n")

            // Build a directory nest deeper than Windows MAX_PATH (260). Node's fs handles
            // long paths fine when creating them, but `git worktree remove` does not.
            const seg = "0123456789"
            let deep = wtPath
            for (let i = 0; i < 30; i++) deep = path.join(deep, `d-${seg}`)
            mkdirSync(deep, { recursive: true })
            writeFileSync(path.join(deep, "leaf.txt"), "deep\n")
            assert.ok(deep.length > 300, `test requires a >300-char path, got ${deep.length}`)

            const result = await h.merge({ action: "apply" })
            assert.ok(result.startsWith("✅"), `merge must succeed even when removal needs the fallback, got:\n${result}`)
            assert.ok(!existsSync(wtPath), "worktree dir must be removed by the fallback")
            assert.ok(existsSync(path.join(repoDir, "feature.txt")), "merge result must land in repo root")
            assert.ok(!loadState(pid).sessions[SESSION], "session must be unbound after fallback cleanup")
        })

        test(`inherited (sub-agent) zombie bindings do not block merge apply and are cascade-cleared (issue #7 follow-up) (${label})`, async () => {
            const prep = await h.prepare({ title: "inherited merge" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const state = loadState(pid)
            const owner = state.sessions[SESSION]
            assert.ok(owner, "owner binding must exist")
            const wtPath = owner.path
            for (const sid of ["task-child-1", "task-child-2"]) {
                state.sessions[sid] = { ...owner, inherited: true }
            }
            saveState(pid, state)
            writeFileSync(path.join(wtPath, "inh-merge.txt"), "inherited merge work\n")

            const result = await h.merge({ action: "apply" })
            assert.ok(
                result.startsWith("✅"),
                `merge must not be blocked by inherited zombie bindings, got:\n${result}`,
            )
            assert.ok(existsSync(path.join(repoDir, "inh-merge.txt")), "merged file must land in repo root")
            assert.ok(!existsSync(wtPath), "worktree dir must be removed")
            assert.ok(!git(["rev-parse", "--verify", "wt/inherited-merge"], repoDir).ok, "branch must be deleted")

            const after = loadState(pid)
            assert.ok(!after.sessions[SESSION], "owner binding must be cleared")
            assert.ok(!after.sessions["task-child-1"], "inherited binding 1 must be cascade-cleared")
            assert.ok(!after.sessions["task-child-2"], "inherited binding 2 must be cascade-cleared")
        })

        test(`inherited (sub-agent) zombie bindings do not block cleanup apply (issue #7 follow-up) (${label})`, async () => {
            const prep = await h.prepare({ title: "inherited cleanup" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const state = loadState(pid)
            const owner = state.sessions[SESSION]
            assert.ok(owner, "owner binding must exist")
            for (const sid of ["task-child-3", "task-child-4"]) {
                state.sessions[sid] = { ...owner, inherited: true }
            }
            saveState(pid, state)

            const result = await h.cleanupWorktrees({ action: "apply", branch: "wt/inherited-cleanup", force: true })
            assert.ok(
                result.includes("wt/inherited-cleanup: removed"),
                `cleanup must not be blocked by inherited zombie bindings, got:\n${result}`,
            )
            assert.equal(
                result.split("wt/inherited-cleanup: removed").length - 1,
                1,
                `the worktree must be processed exactly once (deduped), got:\n${result}`,
            )
            assert.ok(!existsSync(owner.path), "worktree dir must be removed")

            const after = loadState(pid)
            assert.ok(!after.sessions[SESSION], "owner binding must be cleared")
            assert.ok(!after.sessions["task-child-3"], "inherited binding 1 must be cleared")
            assert.ok(!after.sessions["task-child-4"], "inherited binding 2 must be cleared")
        })

        test(`session.idle event releases inherited bindings but keeps the owner binding (issue #7 follow-up) (${label})`, async () => {
            const prep = await h.prepare({ title: "idle release" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const state = loadState(pid)
            const owner = state.sessions[SESSION]
            state.sessions["task-child-idle"] = { ...owner, inherited: true }
            saveState(pid, state)

            await h.emit("session.idle", { sessionID: "task-child-idle" })
            let after = loadState(pid)
            assert.ok(!after.sessions["task-child-idle"], "inherited binding must be released on session.idle")
            assert.ok(after.sessions[SESSION], "owner binding must survive session.idle")
            assert.ok(existsSync(owner.path), "worktree must be untouched")

            await h.emit("session.idle", { sessionID: SESSION })
            after = loadState(pid)
            assert.ok(after.sessions[SESSION], "owner going idle must NOT release its own (direct) binding")

            const cleanup = await h.cleanupWorktrees({ action: "apply", branch: "wt/idle-release", force: true })
            assert.ok(cleanup.includes("wt/idle-release: removed"), `cleanup should succeed, got: ${cleanup}`)
        })

        test(`session.deleted event releases any binding including the owner's (issue #7 follow-up) (${label})`, async () => {
            const prep = await h.prepare({ title: "deleted release" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const wtPath = loadState(pid).sessions[SESSION].path
            assert.ok(loadState(pid).sessions[SESSION], "owner binding must exist")

            await h.emit("session.deleted", { sessionID: SESSION })
            assert.ok(!loadState(pid).sessions[SESSION], "owner binding must be released on session.deleted")

            await h.emit("session.deleted", { sessionID: "never-bound" })
            assert.ok(true, "event for an unbound session must be a no-op")

            rmSync(wtPath, { recursive: true, force: true })
            git(["worktree", "prune"], repoDir)
            git(["branch", "-D", "wt/deleted-release"], repoDir)
        })

        test(`cleanup preview aggregates all bindings of one worktree into a single line (issue #7 follow-up) (${label})`, async () => {
            const prep = await h.prepare({ title: "dedup preview" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const state = loadState(pid)
            const owner = state.sessions[SESSION]
            for (const sid of ["task-child-5", "task-child-6"]) {
                state.sessions[sid] = { ...owner, inherited: true }
            }
            saveState(pid, state)

            const result = await h.cleanupWorktrees({ action: "preview" })
            const occurrences = result.split("wt/dedup-preview").length - 1
            assert.equal(occurrences, 1, `worktree must appear exactly once in preview, got ${occurrences}:\n${result}`)
            assert.ok(result.includes("sessions=3"), `preview must show the binding count, got:\n${result}`)

            const cleanup = await h.cleanupWorktrees({ action: "apply", branch: "wt/dedup-preview", force: true })
            assert.ok(cleanup.includes("wt/dedup-preview: removed"), `cleanup should succeed, got: ${cleanup}`)
        })

        test(`branch merged into base is detected as merged despite the linked-worktree '+' marker (issue #7 follow-up) (${label})`, async () => {
            const prep = await h.prepare({ title: "plus prefix" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const wtPath = loadState(pid).sessions[SESSION].path
            writeFileSync(path.join(wtPath, "plus.txt"), "plus prefix work\n")
            assert.ok(git(["add", "-A"], wtPath).ok)
            assert.ok(git(["commit", "-m", "work"], wtPath).ok)
            // Merge the branch from the MAIN checkout while the worktree still exists:
            // the branch stays checked out in a linked worktree, so `git branch --merged`
            // lists it with a '+' marker.
            assert.ok(git(["merge", "--no-ff", "-m", "merge plus", "wt/plus-prefix"], repoDir).ok)

            const preview = await h.cleanupWorktrees({ action: "preview" })
            const line = preview.split("\n").find((l) => l.includes("wt/plus-prefix"))
            assert.ok(line, `preview must list wt/plus-prefix, got:\n${preview}`)
            assert.match(line, /\bmerged\b/, `merged branch must be labeled merged, got line: ${line}`)
            assert.doesNotMatch(line, /unmerged/, `merged branch must NOT be labeled unmerged, got line: ${line}`)

            const result = await h.cleanupWorktrees({ action: "apply", branch: "wt/plus-prefix" })
            assert.ok(
                result.includes("wt/plus-prefix: removed"),
                `cleanup apply WITHOUT force must remove a merged worktree, got:\n${result}`,
            )
            assert.ok(!existsSync(wtPath), "worktree dir must be removed")
            assert.ok(!git(["rev-parse", "--verify", "wt/plus-prefix"], repoDir).ok, "branch must be deleted")
            assert.ok(!loadState(pid).sessions[SESSION], "binding must be cleared")
        })

        test(`cleanup apply without force still refuses an unmerged worktree (regression guard) (${label})`, async () => {
            const prep = await h.prepare({ title: "unmerged keep" })
            assert.ok(prep.startsWith("✅"), `prepare should succeed: ${prep}`)
            const pid = computeProjectId(repoDir)
            const wtPath = loadState(pid).sessions[SESSION].path
            writeFileSync(path.join(wtPath, "unmerged.txt"), "not merged yet\n")
            assert.ok(git(["add", "-A"], wtPath).ok)
            assert.ok(git(["commit", "-m", "wip"], wtPath).ok)

            const result = await h.cleanupWorktrees({ action: "apply", branch: "wt/unmerged-keep" })
            assert.ok(
                result.includes("unmerged") && !result.includes("wt/unmerged-keep: removed"),
                `unmerged worktree must be skipped without force, got:\n${result}`,
            )
            assert.ok(existsSync(wtPath), "worktree must still exist")

            const cleanup = await h.cleanupWorktrees({ action: "apply", branch: "wt/unmerged-keep", force: true })
            assert.ok(cleanup.includes("wt/unmerged-keep: removed"), `force cleanup should succeed, got: ${cleanup}`)
        })
    })
}

describe("v2 entry specifics", () => {
    const repoDir = path.join(testRoot, "repo-v2-specific")
    const SESSION = "v2-specific-session"
    let h

    before(async () => {
        mkdirSync(repoDir, { recursive: true })
        assert.ok(git(["init"], repoDir).ok, "git init")
        assert.ok(git(["config", "user.email", "test@test.com"], repoDir).ok)
        assert.ok(git(["config", "user.name", "Test"], repoDir).ok)
        assert.ok(git(["config", "core.autocrlf", "false"], repoDir).ok)
        writeFileSync(path.join(repoDir, "README.md"), "# test repo\n")
        assert.ok(git(["add", "README.md"], repoDir).ok)
        assert.ok(git(["commit", "-m", "initial commit"], repoDir).ok)
        h = makeV2Harness(repoDir, SESSION)
        await h.init()
    })

    test("prepare sets the session title via ctx.session.update", async () => {
        const result = await h.prepare({ title: "title update" })
        assert.ok(result.startsWith("✅"), `prepare should succeed, got: ${result}`)
        const pid = computeProjectId(repoDir)
        assert.ok(loadState(pid).sessions[SESSION], "binding must exist")
        const titleUpdate = h.updates.find((u) => typeof u.title === "string" && u.title.includes("wt/title-update"))
        assert.ok(
            titleUpdate,
            `session.update must be called with the branch title, got: ${JSON.stringify(h.updates)}`,
        )
        assert.equal(titleUpdate.sessionID, SESSION)
    })

    test("events from a different location directory are ignored", async () => {
        const pid = computeProjectId(repoDir)
        const state = loadState(pid)
        const owner = state.sessions[SESSION]
        state.sessions["v2-child-foreign"] = { ...owner, inherited: true }
        saveState(pid, state)

        await h.emit("session.idle", { sessionID: "v2-child-foreign" }, path.resolve("/tmp/other-location"))
        const after = loadState(pid)
        assert.ok(
            after.sessions["v2-child-foreign"],
            "idle event from another location must NOT release the inherited binding",
        )

        delete after.sessions["v2-child-foreign"]
        saveState(pid, after)
    })

    test("setup cleanup stops the event subscription", async () => {
        const pid = computeProjectId(repoDir)
        const state = loadState(pid)
        const owner = state.sessions[SESSION]
        state.sessions["v2-child-after-dispose"] = { ...owner, inherited: true }
        saveState(pid, state)

        await h.dispose()
        await h.emit("session.idle", { sessionID: "v2-child-after-dispose" })
        const after = loadState(pid)
        assert.ok(
            after.sessions["v2-child-after-dispose"],
            "idle event after cleanup must not be processed (subscription aborted)",
        )

        const cleanup = await h.cleanupWorktrees({ action: "apply", branch: "wt/title-update", force: true })
        assert.ok(cleanup.includes("wt/title-update: removed"), `final cleanup should succeed, got: ${cleanup}`)
    })
})

describe("git-common state backend", () => {
    const gcTestRoot = mkdtempSync(path.join(tmpdir(), "ocwt-git-common-"))
    const gcRepoDir = path.join(gcTestRoot, "repo")
    const GC_SESSION = "gc-session-1"
    const GC_SESSION_2 = "gc-session-2"
    const mockClientGc = { session: { get: async () => ({ data: { parentID: null } }) } }
    const makeGcTctx = () => ({ directory: gcRepoDir, sessionID: GC_SESSION, metadata: () => {} })
    const makeGcTctx2 = () => ({ directory: gcRepoDir, sessionID: GC_SESSION_2, metadata: () => {} })

    let gcPlugin
    let gcCommonDir
    let gcWorktreePath

    before(() => {
        mkdirSync(gcRepoDir, { recursive: true })
        assert.ok(git(["init"], gcRepoDir).ok, "git init for gc repo")
        assert.ok(git(["config", "user.email", "test@test.com"], gcRepoDir).ok)
        assert.ok(git(["config", "user.name", "Test"], gcRepoDir).ok)
        assert.ok(git(["config", "core.autocrlf", "false"], gcRepoDir).ok)
        const sidecarDir = path.join(gcRepoDir, ".opencode")
        mkdirSync(sidecarDir, { recursive: true })
        writeFileSync(
            path.join(sidecarDir, "worktree-workflow.json"),
            JSON.stringify({ stateLocation: "git-common" }),
            "utf8",
        )
        writeFileSync(path.join(gcRepoDir, "README.md"), "# gc test repo\n")
        assert.ok(git(["add", "README.md"], gcRepoDir).ok)
        assert.ok(git(["commit", "-m", "initial commit"], gcRepoDir).ok)
        const commonRes = git(["rev-parse", "--git-common-dir"], gcRepoDir)
        assert.ok(commonRes.ok, "git rev-parse --git-common-dir should succeed in fresh repo")
        gcCommonDir = path.resolve(gcRepoDir, commonRes.stdout.trim())
    })

    after(() => {
        try {
            rmSync(gcTestRoot, { recursive: true, force: true })
        } catch {}
    })

    test("git-common mode: plugin loads with sidecar stateLocation=git-common", async () => {
        gcPlugin = await pluginEntry.server({ directory: gcRepoDir, client: mockClientGc })
        assert.ok(gcPlugin.tool.worktree_prepare, "worktree_prepare present in git-common mode")
        assert.ok(gcPlugin["tool.execute.before"], "before hook present in git-common mode")
    })

    test("git-common mode: prepare writes binding file under <git-common-dir>/worktree-isolation/bindings/", async () => {
        const result = await gcPlugin.tool.worktree_prepare.execute({ title: "gc first" }, makeGcTctx())
        assert.ok(result.startsWith("✅"), `prepare should succeed in git-common mode, got: ${result}`)
        const bindingFile = path.join(gcCommonDir, "worktree-isolation", "bindings", `${GC_SESSION}.json`)
        assert.ok(existsSync(bindingFile), `expected binding file at ${bindingFile}`)
        const parsed = JSON.parse(readFileSync(bindingFile, "utf8"))
        assert.equal(parsed.branch, "wt/gc-first")
        assert.equal(parsed.repoRoot, gcRepoDir)
        gcWorktreePath = parsed.path
        assert.ok(existsSync(gcWorktreePath), "worktree directory must exist")
    })

    test("git-common mode: external state file is NOT written (state isolated under git-common-dir)", () => {
        const pid = computeProjectId(gcRepoDir)
        const externalFile = path.join(
            (process.env.OC_WT_STATE_DIR || path.join(tmpdir(), "fallback-state")),
            `${pid}.json`,
        )
        if (existsSync(externalFile)) {
            const parsed = JSON.parse(readFileSync(externalFile, "utf8"))
            assert.ok(
                !parsed.sessions || !parsed.sessions[GC_SESSION],
                "external state file must NOT contain the git-common session binding",
            )
        }
    })

    test("git-common mode: meta.json is auto-created with current schema version after prepare", () => {
        const metaFile = path.join(gcCommonDir, "worktree-isolation", "meta.json")
        assert.ok(existsSync(metaFile), `meta.json must exist under git-common-dir: ${metaFile}`)
        const parsed = JSON.parse(readFileSync(metaFile, "utf8"))
        assert.equal(parsed.schemaVersion, SCHEMA_VERSION, "meta.json schemaVersion must match SCHEMA_VERSION (2)")
        assert.ok(typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0, "updatedAt must be a non-empty ISO string")
        const ts = new Date(parsed.updatedAt).getTime()
        assert.ok(!Number.isNaN(ts) && ts > 0, "updatedAt must parse to a valid timestamp")
    })

    test("git-common mode: loadAll aggregates bindings into WorktreeState shape", async () => {
        const backend = new GitCommonStateBackend(gcRepoDir)
        const state = backend.loadAll()
        assert.ok(state && typeof state === "object")
        assert.ok(state.sessions && typeof state.sessions === "object")
        assert.ok(state.sessions[GC_SESSION], "GC_SESSION binding must appear in loadAll")
        assert.equal(state.sessions[GC_SESSION].branch, "wt/gc-first")
    })

    test("git-common mode: multiple sessions get independent binding files", async () => {
        const result = await gcPlugin.tool.worktree_prepare.execute({ title: "gc second" }, makeGcTctx2())
        assert.ok(result.startsWith("✅"), `prepare for session 2 should succeed, got: ${result}`)
        const f1 = path.join(gcCommonDir, "worktree-isolation", "bindings", `${GC_SESSION}.json`)
        const f2 = path.join(gcCommonDir, "worktree-isolation", "bindings", `${GC_SESSION_2}.json`)
        assert.ok(existsSync(f1), "session 1 binding file must still exist")
        assert.ok(existsSync(f2), "session 2 binding file must exist independently")
        const b1 = JSON.parse(readFileSync(f1, "utf8"))
        const b2 = JSON.parse(readFileSync(f2, "utf8"))
        assert.equal(b1.branch, "wt/gc-first")
        assert.equal(b2.branch, "wt/gc-second")
        assert.notEqual(b1.path, b2.path, "the two sessions must bind distinct worktree paths")
    })

    test("git-common mode: findSessionsForWorktree detects cross-session reference", async () => {
        const backend = new GitCommonStateBackend(gcRepoDir)
        const b1 = backend.loadBinding(GC_SESSION)
        const b2 = backend.loadBinding(GC_SESSION_2)
        assert.ok(b1 && b2, "both bindings must load")
        const others = backend.findSessionsForWorktree(b1.path, GC_SESSION)
        assert.deepEqual(others, [], "session 1's worktree is not bound by any other session")
        const others2 = backend.findSessionsForWorktree(b2.path, GC_SESSION_2)
        assert.deepEqual(others2, [], "session 2's worktree is not bound by any other session")

        backend.saveBinding(GC_SESSION_2, { ...b2, path: b1.path })
        const cross = backend.findSessionsForWorktree(b1.path, GC_SESSION).sort()
        assert.deepEqual(cross, [GC_SESSION_2], "after re-pointing session 2 at session 1's worktree, the cross-reference must be detected")

        backend.saveBinding(GC_SESSION_2, b2)
    })

    test("git-common mode: listBindings reads every binding file in the bindings directory", () => {
        const backend = new GitCommonStateBackend(gcRepoDir)
        const all = backend.listBindings()
        const ids = all.map((x) => x.sessionId).sort()
        assert.deepEqual(ids, [GC_SESSION, GC_SESSION_2])
    })

    test("git-common mode: clearBinding removes only the targeted session file", () => {
        const backend = new GitCommonStateBackend(gcRepoDir)
        const f1 = path.join(gcCommonDir, "worktree-isolation", "bindings", `${GC_SESSION}.json`)
        const f2 = path.join(gcCommonDir, "worktree-isolation", "bindings", `${GC_SESSION_2}.json`)
        assert.ok(existsSync(f1) && existsSync(f2), "both files present before clear")
        backend.clearBinding(GC_SESSION)
        assert.ok(!existsSync(f1), "session 1 file must be removed by clearBinding")
        assert.ok(existsSync(f2), "session 2 file must remain untouched")
        assert.equal(backend.loadBinding(GC_SESSION), null, "loadBinding must return null after clear")
        assert.ok(backend.loadBinding(GC_SESSION_2), "session 2 binding still loadable")
    })

    test("git-common mode: cleanup removes binding file and worktree", async () => {
        const f2 = path.join(gcCommonDir, "worktree-isolation", "bindings", `${GC_SESSION_2}.json`)
        assert.ok(existsSync(f2), "session 2 file present before cleanup")
        const backend = new GitCommonStateBackend(gcRepoDir)
        const b2 = backend.loadBinding(GC_SESSION_2)
        assert.ok(b2, "session 2 binding must load before cleanup")
        const result = await gcPlugin.tool.worktree_cleanup.execute(
            { action: "apply", branch: "wt/gc-second", force: true },
            makeGcTctx2(),
        )
        assert.ok(result.includes("wt/gc-second: removed"), `cleanup should succeed, got: ${result}`)
        assert.ok(!existsSync(f2), "session 2 binding file must be removed by cleanup")
        assert.ok(!existsSync(b2.path), "session 2 worktree dir must be removed")
        assert.equal(backend.loadBinding(GC_SESSION_2), null, "session 2 must be unbound after cleanup")
    })

    test("git-common mode: constructor throws clear error when git-common-dir is unavailable", () => {
        const bogusRoot = mkdtempSync(path.join(tmpdir(), "ocwt-bare-"))
        try {
            assert.throws(
                () => new GitCommonStateBackend(bogusRoot),
                /Cannot resolve git-common-dir/,
                "constructor should throw with a helpful message when git rev-parse fails",
            )
        } finally {
            try { rmSync(bogusRoot, { recursive: true, force: true }) } catch {}
        }
    })
})

describe("strict modes + worktree_allow", () => {
    const strictRoot = mkdtempSync(path.join(tmpdir(), "ocwt-strict-"))
    const strictRepo = path.join(strictRoot, "repo")
    const strictState = path.join(strictRoot, "state")
    const strictWtRoot = path.join(strictRoot, "worktrees")
    const STRICT_SESSION = "strict-sess"
    const STRICT_SESSION_2 = "strict-sess-2"
    const mockClientS = { session: { get: async () => ({ data: { parentID: null } }) } }
    const makeStTctx = (sid) => ({
        directory: strictRepo,
        sessionID: sid || STRICT_SESSION,
        metadata: () => {},
    })

    let strictPlugin
    let prevEnvState
    let prevEnvRoot

    before(() => {
        prevEnvState = process.env.OC_WT_STATE_DIR
        prevEnvRoot = process.env.OC_WT_ROOT
        process.env.OC_WT_STATE_DIR = strictState
        process.env.OC_WT_ROOT = strictWtRoot

        mkdirSync(strictRepo, { recursive: true })
        assert.ok(git(["init", "--initial-branch=master"], strictRepo).ok, "git init for strict repo")
        assert.ok(git(["config", "user.email", "test@test.com"], strictRepo).ok)
        assert.ok(git(["config", "user.name", "Test"], strictRepo).ok)
        assert.ok(git(["config", "core.autocrlf", "false"], strictRepo).ok)
        const sidecarDir = path.join(strictRepo, ".opencode")
        mkdirSync(sidecarDir, { recursive: true })
        writeFileSync(
            path.join(sidecarDir, "worktree-workflow.json"),
            JSON.stringify({
                strictWrites: true,
                strictGitOps: true,
                protectedBranches: ["master", "main"],
            }),
            "utf8",
        )
        writeFileSync(path.join(strictRepo, "README.md"), "# strict repo\n")
        assert.ok(git(["add", "README.md"], strictRepo).ok)
        assert.ok(git(["commit", "-m", "initial commit"], strictRepo).ok)
    })

    after(() => {
        if (prevEnvState === undefined) delete process.env.OC_WT_STATE_DIR
        else process.env.OC_WT_STATE_DIR = prevEnvState
        if (prevEnvRoot === undefined) delete process.env.OC_WT_ROOT
        else process.env.OC_WT_ROOT = prevEnvRoot
        try { rmSync(strictRoot, { recursive: true, force: true }) } catch {}
    })

    test("strict plugin loads with strictWrites=true + strictGitOps=true and exposes worktree_allow", async () => {
        strictPlugin = await pluginEntry.server({ directory: strictRepo, client: mockClientS })
        assert.ok(strictPlugin.tool.worktree_allow, "worktree_allow must be present")
        assert.ok(strictPlugin["tool.execute.before"], "before hook present")
    })

    test("strictWrites mode: write without binding throws", async () => {
        const output = { args: { filePath: path.join(strictRepo, "leak.txt") } }
        let threw = false
        try {
            await strictPlugin["tool.execute.before"](
                { tool: "write", sessionID: STRICT_SESSION, callID: "sw1" },
                output,
            )
        } catch (e) {
            threw = true
            assert.match(e.message, /strictWrites/, `error must mention strictWrites, got: ${e.message}`)
        }
        assert.ok(threw, "write without binding should throw in strictWrites mode")
    })

    test("strictWrites mode: read without binding is allowed", async () => {
        const output = { args: { filePath: path.join(strictRepo, "README.md") } }
        await strictPlugin["tool.execute.before"](
            { tool: "read", sessionID: STRICT_SESSION, callID: "sr1" },
            output,
        )
        assert.equal(output.args.filePath, path.join(strictRepo, "README.md"), "read should be allowed and path unchanged")
    })

    test("strictGitOps mode: git push origin master throws", async () => {
        const output = { args: { command: "git push origin master" } }
        let threw = false
        try {
            await strictPlugin["tool.execute.before"](
                { tool: "bash", sessionID: STRICT_SESSION, callID: "sg1" },
                output,
            )
        } catch (e) {
            threw = true
            assert.match(e.message, /push to protected branch/, `error must mention protected branch, got: ${e.message}`)
        }
        assert.ok(threw, "git push origin master should throw in strictGitOps mode")
    })

    test("strictGitOps mode: git push origin feature is allowed (target not in protected set)", async () => {
        const output = { args: { command: "git push origin feature-xyz" } }
        await strictPlugin["tool.execute.before"](
            { tool: "bash", sessionID: STRICT_SESSION, callID: "sg2" },
            output,
        )
        assert.equal(output.args.command, "git push origin feature-xyz", "command should pass through unchanged")
    })

    test("worktree_allow add creates an allowlist entry with TTL", async () => {
        const result = await strictPlugin.tool.worktree_allow.execute({
            action: "add",
            path: "AGENTS.md",
            reason: "edit repo config",
            ttlMinutes: 30,
        }, makeStTctx())
        assert.ok(result.startsWith("✅"), `add should succeed, got: ${result}`)
        const pid = computeProjectId(strictRepo)
        const alFile = path.join(strictState, `${pid}.allowlist.json`)
        assert.ok(existsSync(alFile), "allowlist file must be created")
        const parsed = JSON.parse(readFileSync(alFile, "utf8"))
        assert.ok(parsed.paths && parsed.paths.length === 1, "exactly one entry expected")
        assert.equal(parsed.paths[0].path, "AGENTS.md")
        assert.equal(parsed.paths[0].reason, "edit repo config")
        assert.ok(parsed.paths[0].expiresAt, "entry must have expiresAt")
        const ttlMs = new Date(parsed.paths[0].expiresAt).getTime() - Date.now()
        assert.ok(ttlMs > 0 && ttlMs <= 30 * 60000 + 5000, `TTL should be ~30 min, got ${ttlMs}ms`)
    })

    test("worktree_allow add rejects dangerous paths (.git, root, *)", async () => {
        for (const dangerousPath of [".", "/", ".git", "*", "**"]) {
            const result = await strictPlugin.tool.worktree_allow.execute({
                action: "add",
                path: dangerousPath,
                reason: "test",
            }, makeStTctx())
            assert.ok(result.startsWith("❌"), `dangerous path '${dangerousPath}' should be rejected, got: ${result}`)
            assert.match(result, /dangerous path|\.git-related/, `error for '${dangerousPath}' must explain rejection`)
        }
    })

    test("worktree_allow add accepts .github paths (not .git-related)", async () => {
        const result = await strictPlugin.tool.worktree_allow.execute({
            action: "add",
            path: ".github/workflows/ci.yml",
            reason: "update CI",
            ttlMinutes: 30,
        }, makeStTctx())
        assert.ok(result.startsWith("✅"), `.github path must be accepted, got: ${result}`)
    })

    test("worktree_allow add writes an audit log entry", async () => {
        const pid = computeProjectId(strictRepo)
        const auditFile = path.join(strictState, `${pid}.audit.jsonl`)
        const beforeSize = existsSync(auditFile)
            ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean).length
            : 0
        const result = await strictPlugin.tool.worktree_allow.execute({
            action: "add",
            path: "docs/PLAN.md",
            reason: "audit test",
        }, makeStTctx())
        assert.ok(result.startsWith("✅"), `add should succeed, got: ${result}`)
        const lines = readFileSync(auditFile, "utf8").trim().split("\n")
        assert.equal(lines.length, beforeSize + 1, "audit log must grow by exactly 1 line")
        const lastEntry = JSON.parse(lines[lines.length - 1])
        assert.equal(lastEntry.type, "allow_add")
        assert.equal(lastEntry.path, "docs/PLAN.md")
        assert.equal(lastEntry.reason, "audit test")
        assert.equal(lastEntry.sessionId, STRICT_SESSION)
        assert.ok(lastEntry.ts, "audit entry must include ts")
    })

    test("worktree_allow list shows current entries", async () => {
        const result = await strictPlugin.tool.worktree_allow.execute({
            action: "list",
        }, makeStTctx())
        assert.ok(result.includes("Allowlist"), `list output should describe entries, got: ${result}`)
        assert.ok(result.includes("AGENTS.md"), "list must include AGENTS.md")
        assert.ok(result.includes("docs/PLAN.md"), "list must include docs/PLAN.md")
    })

    test("strictWrites mode: write to allowlisted path bypasses deny (cross-session)", async () => {
        const target = path.join(strictRepo, "AGENTS.md")
        const output = { args: { filePath: target } }
        await strictPlugin["tool.execute.before"](
            { tool: "write", sessionID: STRICT_SESSION_2, callID: "swl1" },
            output,
        )
        assert.equal(output.args.filePath, target, "filePath must be unchanged (allowed via project-wide allowlist)")
    })

    test("worktree_allow clear removes all entries", async () => {
        const result = await strictPlugin.tool.worktree_allow.execute({
            action: "clear",
        }, makeStTctx())
        assert.ok(result.startsWith("✅"), `clear should succeed, got: ${result}`)
        const listResult = await strictPlugin.tool.worktree_allow.execute({
            action: "list",
        }, makeStTctx())
        assert.ok(listResult.includes("empty"), `list after clear should be empty, got: ${listResult}`)
    })

    test("expired allowlist entries are lazily GC'd on load", async () => {
        const pid = computeProjectId(strictRepo)
        const alFile = path.join(strictState, `${pid}.allowlist.json`)
        const staleEntry = {
            path: "STALE.md",
            reason: "old",
            bySession: "old-session",
            createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
            expiresAt: new Date(Date.now() - 86400000).toISOString(),
        }
        const freshEntry = {
            path: "FRESH.md",
            reason: "current",
            bySession: "current-session",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }
        writeFileSync(alFile, JSON.stringify({ paths: [staleEntry, freshEntry] }, null, 2), "utf8")

        const result = await strictPlugin.tool.worktree_allow.execute({
            action: "list",
        }, makeStTctx())
        assert.ok(result.includes("FRESH.md"), "fresh entry must still be listed")
        assert.ok(!result.includes("STALE.md"), "stale entry must be GC'd and not listed")

        const parsed = JSON.parse(readFileSync(alFile, "utf8"))
        assert.equal(parsed.paths.length, 1, "stale entry must be removed from disk on load")
        assert.equal(parsed.paths[0].path, "FRESH.md")
    })
})

describe("schema version management (T3.1)", () => {
    const schemaRoot = mkdtempSync(path.join(tmpdir(), "ocwt-schema-"))
    const schemaRepo = path.join(schemaRoot, "repo")
    const schemaState = path.join(schemaRoot, "state")
    const SCHEMA_SESSION = "schema-sess"
    const mockClientSchema = { session: { get: async () => ({ data: { parentID: null } }) } }
    const makeSchemaTctx = () => ({
        directory: schemaRepo,
        sessionID: SCHEMA_SESSION,
        metadata: () => {},
    })

    let prevEnvState

    before(() => {
        prevEnvState = process.env.OC_WT_STATE_DIR
        process.env.OC_WT_STATE_DIR = schemaState

        mkdirSync(schemaRepo, { recursive: true })
        assert.ok(git(["init"], schemaRepo).ok, "git init for schema repo")
        assert.ok(git(["config", "user.email", "test@test.com"], schemaRepo).ok)
        assert.ok(git(["config", "user.name", "Test"], schemaRepo).ok)
        assert.ok(git(["config", "core.autocrlf", "false"], schemaRepo).ok)
        writeFileSync(path.join(schemaRepo, "README.md"), "# schema test\n")
        assert.ok(git(["add", "README.md"], schemaRepo).ok)
        assert.ok(git(["commit", "-m", "initial commit"], schemaRepo).ok)
    })

    after(() => {
        if (prevEnvState === undefined) delete process.env.OC_WT_STATE_DIR
        else process.env.OC_WT_STATE_DIR = prevEnvState
        try { rmSync(schemaRoot, { recursive: true, force: true }) } catch {}
    })

    test("loadState reads v1 (no schemaVersion) JSON, warns on stderr, preserves data", () => {
        const pid = computeProjectId(schemaRepo)
        const stateFile = path.join(schemaState, `${pid}.json`)
        mkdirSync(schemaState, { recursive: true })
        writeFileSync(stateFile, JSON.stringify({ sessions: {} }), "utf8")

        const originalWrite = process.stderr.write
        let captured = ""
        process.stderr.write = (chunk) => {
            captured += chunk.toString()
            return true
        }
        let loaded
        try {
            loaded = loadState(pid)
        } finally {
            process.stderr.write = originalWrite
        }

        assert.deepEqual(loaded, { sessions: {} }, "v1 data must be preserved without loss")
        assert.ok(
            captured.includes("state schema version missing or outdated"),
            `stderr must contain schema-version warning, got: ${captured}`,
        )
        assert.ok(
            captured.includes("current: 2") && captured.includes("found: missing"),
            `warning must show current=2, found=missing, got: ${captured}`,
        )
    })

    test("saveState upgrades v1 data with schemaVersion, silencing the warning on re-read", () => {
        const pid = computeProjectId(schemaRepo)

        const originalWarn = process.stderr.write
        process.stderr.write = () => true
        const loaded = loadState(pid)
        process.stderr.write = originalWarn

        saveState(pid, loaded)

        const capturedRe = (() => {
            let buf = ""
            const orig = process.stderr.write
            process.stderr.write = (chunk) => { buf += chunk.toString(); return true }
            try {
                const reloaded = loadState(pid)
                assert.equal(reloaded.schemaVersion, SCHEMA_VERSION, "upgraded state must have schemaVersion=2")
                assert.ok(reloaded.sessions, "sessions object must still be present after upgrade")
            } finally {
                process.stderr.write = orig
            }
            return buf
        })()
        assert.equal(capturedRe, "", "no stderr warning after saveState upgrade")
    })

    test("ensureMeta is idempotent: second call does not change updatedAt", () => {
        const dir = mkdtempSync(path.join(schemaRoot, "meta-idempotent-"))
        try {
            ensureMeta(dir)
            const metaFile = path.join(dir, "meta.json")
            const firstContent = readFileSync(metaFile, "utf8")

            ensureMeta(dir)

            const secondContent = readFileSync(metaFile, "utf8")
            assert.equal(secondContent, firstContent, "meta.json content must be byte-identical on second ensureMeta call")
            const firstParsed = JSON.parse(firstContent)
            const secondParsed = JSON.parse(secondContent)
            assert.equal(secondParsed.updatedAt, firstParsed.updatedAt, "updatedAt must not change on idempotent call")
        } finally {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
    })
})

describe("audit log (T3.2)", () => {
    const auditRoot = mkdtempSync(path.join(tmpdir(), "ocwt-audit-"))
    const auditRepo = path.join(auditRoot, "repo")
    const auditState = path.join(auditRoot, "state")
    const auditWtRoot = path.join(auditRoot, "worktrees")
    const AUDIT_SESSION = "audit-sess"
    const DENY_SESSION = "deny-sess"
    const mockClientA = { session: { get: async () => ({ data: { parentID: null } }) } }
    const makeAuditTctx = (sid) => ({
        directory: auditRepo,
        sessionID: sid || AUDIT_SESSION,
        metadata: () => {},
    })

    let auditPlugin
    let prevEnvState
    let prevEnvRoot

    before(() => {
        prevEnvState = process.env.OC_WT_STATE_DIR
        prevEnvRoot = process.env.OC_WT_ROOT
        process.env.OC_WT_STATE_DIR = auditState
        process.env.OC_WT_ROOT = auditWtRoot

        mkdirSync(auditRepo, { recursive: true })
        assert.ok(git(["init", "--initial-branch=master"], auditRepo).ok, "git init for audit repo")
        assert.ok(git(["config", "user.email", "test@test.com"], auditRepo).ok)
        assert.ok(git(["config", "user.name", "Test"], auditRepo).ok)
        assert.ok(git(["config", "core.autocrlf", "false"], auditRepo).ok)
        const sidecarDir = path.join(auditRepo, ".opencode")
        mkdirSync(sidecarDir, { recursive: true })
        writeFileSync(
            path.join(sidecarDir, "worktree-workflow.json"),
            JSON.stringify({
                strictWrites: true,
                strictGitOps: true,
                protectedBranches: ["master", "main"],
            }),
            "utf8",
        )
        writeFileSync(path.join(auditRepo, "README.md"), "# audit test\n")
        assert.ok(git(["add", "README.md"], auditRepo).ok)
        assert.ok(git(["commit", "-m", "initial commit"], auditRepo).ok)
    })

    after(() => {
        if (prevEnvState === undefined) delete process.env.OC_WT_STATE_DIR
        else process.env.OC_WT_STATE_DIR = prevEnvState
        if (prevEnvRoot === undefined) delete process.env.OC_WT_ROOT
        else process.env.OC_WT_ROOT = prevEnvRoot
        try { rmSync(auditRoot, { recursive: true, force: true }) } catch {}
    })

    const auditFilePath = () => {
        const pid = computeProjectId(auditRepo)
        return path.join(auditState, `${pid}.audit.jsonl`)
    }
    const clearAudit = () => {
        try { unlinkSync(auditFilePath()) } catch {}
    }
    const readAuditLines = () => {
        const f = auditFilePath()
        if (!existsSync(f)) return []
        return readFileSync(f, "utf8").split("\n").filter(Boolean)
    }

    test("audit plugin loads with strict modes and exposes tools", async () => {
        auditPlugin = await pluginEntry.server({ directory: auditRepo, client: mockClientA })
        assert.ok(auditPlugin.tool.worktree_prepare, "worktree_prepare present")
        assert.ok(auditPlugin.tool.worktree_allow, "worktree_allow present")
        assert.ok(auditPlugin["tool.execute.before"], "before hook present")
    })

    test("QA1 prepare: audit entry has type=prepare, matching session/branch, recent ts", async () => {
        clearAudit()
        const result = await auditPlugin.tool.worktree_prepare.execute(
            { title: "audit-prepare" },
            makeAuditTctx(),
        )
        assert.ok(result.startsWith("✅"), `prepare should succeed, got: ${result}`)

        const lines = readAuditLines()
        assert.equal(lines.length, 1, "exactly one audit line after prepare")
        const parsed = JSON.parse(lines[0])
        assert.equal(parsed.type, "prepare")
        assert.equal(parsed.sessionId, AUDIT_SESSION)
        assert.equal(parsed.branch, "wt/audit-prepare")
        assert.ok(typeof parsed.path === "string" && parsed.path.length > 0, "path must be a non-empty string")
        assert.ok(parsed.ts, "ts must be present")
        const tsMs = new Date(parsed.ts).getTime()
        assert.ok(!Number.isNaN(tsMs) && tsMs > Date.now() - 1000, `ts must be within past 1 second, got ${parsed.ts}`)
    })

    test("QA2 strict deny: audit entry has type=deny, reason contains 'strictWrites'", async () => {
        clearAudit()
        const output = { args: { filePath: path.join(auditRepo, "blocked.txt") } }
        let threw = false
        try {
            await auditPlugin["tool.execute.before"](
                { tool: "write", sessionID: DENY_SESSION, callID: "ad1" },
                output,
            )
        } catch (e) {
            threw = true
            assert.match(e.message, /strictWrites/, `error must mention strictWrites, got: ${e.message}`)
        }
        assert.ok(threw, "write without binding must throw in strictWrites mode")

        const lines = readAuditLines()
        assert.equal(lines.length, 1, "exactly one audit line after deny")
        const parsed = JSON.parse(lines[0])
        assert.equal(parsed.type, "deny")
        assert.ok(parsed.reason && parsed.reason.includes("strictWrites"), "deny reason must mention strictWrites")
        assert.equal(parsed.toolName, "write")
        assert.equal(parsed.sessionId, DENY_SESSION)
    })

    test("QA3 append-only: existing entries preserved, new entry appended (grow by exactly 1)", async () => {
        clearAudit()
        for (let i = 0; i < 3; i++) {
            await auditPlugin.tool.worktree_allow.execute(
                { action: "add", path: `APPEND_${i}.md`, reason: "append test" },
                makeAuditTctx(),
            )
        }
        const linesBefore = readAuditLines()
        assert.equal(linesBefore.length, 3, "precondition: exactly 3 audit lines")
        const snapshot = linesBefore.slice()

        await auditPlugin.tool.worktree_allow.execute(
            { action: "add", path: "APPEND_NEW.md", reason: "new entry" },
            makeAuditTctx(),
        )

        const linesAfter = readAuditLines()
        assert.equal(linesAfter.length, 4, "audit must grow by exactly 1 line (append-only, not overwrite)")
        assert.deepEqual(linesAfter.slice(0, 3), snapshot, "first 3 lines must be byte-identical (append-only)")
    })

    test("QA4 jsonl format: prepare + allow_add + deny events all produce parseable JSON lines", async () => {
        clearAudit()
        await auditPlugin.tool.worktree_prepare.execute(
            { title: "jsonl-test" },
            makeAuditTctx(),
        )
        await auditPlugin.tool.worktree_allow.execute(
            { action: "add", path: "JSONL.md", reason: "parse test" },
            makeAuditTctx(),
        )
        try {
            await auditPlugin["tool.execute.before"](
                { tool: "write", sessionID: DENY_SESSION, callID: "ad2" },
                { args: { filePath: path.join(auditRepo, "denied.txt") } },
            )
        } catch {}

        const lines = readAuditLines()
        assert.equal(lines.length, 3, "exactly 3 audit lines from prepare + allow_add + deny")
        for (const line of lines) {
            assert.doesNotThrow(() => JSON.parse(line), `every line must be valid JSON, got: ${line}`)
        }
        const types = lines.map((l) => JSON.parse(l).type)
        assert.ok(types.includes("prepare"), "must include a prepare entry")
        assert.ok(types.includes("allow_add"), "must include an allow_add entry")
        assert.ok(types.includes("deny"), "must include a deny entry")
    })

    test("QA5 PII: paths are recorded verbatim (no redaction of username-bearing segments)", async () => {
        clearAudit()
        const result = await auditPlugin.tool.worktree_prepare.execute(
            { title: "pii-test" },
            makeAuditTctx(),
        )
        assert.ok(result.startsWith("✅"), `prepare should succeed, got: ${result}`)

        const lines = readAuditLines()
        assert.equal(lines.length, 1, "exactly one audit line")
        const parsed = JSON.parse(lines[0])
        assert.equal(parsed.type, "prepare")

        const pid = computeProjectId(auditRepo)
        const state = loadState(pid)
        const actualPath = state.sessions[AUDIT_SESSION].path
        assert.ok(actualPath, "worktree path must exist in state")
        assert.equal(
            parsed.path,
            actualPath,
            "audit path must equal the actual worktree path verbatim (no PII redaction)",
        )
    })
})

describe("SessionStart discipline injection (T3.3)", () => {
    const ssRoot = mkdtempSync(path.join(tmpdir(), "ocwt-session-start-"))
    const defaultRepo = path.join(ssRoot, "default-repo")
    const strictRepo = path.join(ssRoot, "strict-repo")
    const ssState = path.join(ssRoot, "state")
    const ssWtRoot = path.join(ssRoot, "worktrees")
    const SS_SESSION = "ss-sess"
    const mockClientSS = { session: { get: async () => ({ data: { parentID: null } }) } }
    const makeSsTctx = (repo, sid) => ({
        directory: repo || strictRepo,
        sessionID: sid || SS_SESSION,
        metadata: () => {},
    })

    let prevEnvState
    let prevEnvRoot

    before(() => {
        prevEnvState = process.env.OC_WT_STATE_DIR
        prevEnvRoot = process.env.OC_WT_ROOT
        process.env.OC_WT_STATE_DIR = ssState
        process.env.OC_WT_ROOT = ssWtRoot

        for (const repo of [defaultRepo, strictRepo]) {
            mkdirSync(repo, { recursive: true })
            assert.ok(git(["init", "--initial-branch=master"], repo).ok, `git init for ${repo}`)
            assert.ok(git(["config", "user.email", "test@test.com"], repo).ok)
            assert.ok(git(["config", "user.name", "Test"], repo).ok)
            assert.ok(git(["config", "core.autocrlf", "false"], repo).ok)
            writeFileSync(path.join(repo, "README.md"), `# ${path.basename(repo)}\n`)
            assert.ok(git(["add", "README.md"], repo).ok)
            assert.ok(git(["commit", "-m", "initial commit"], repo).ok)
        }

        const sidecarDir = path.join(strictRepo, ".opencode")
        mkdirSync(sidecarDir, { recursive: true })
        writeFileSync(
            path.join(sidecarDir, "worktree-workflow.json"),
            JSON.stringify({ strictWrites: true, strictGitOps: true }),
            "utf8",
        )
    })

    after(() => {
        if (prevEnvState === undefined) delete process.env.OC_WT_STATE_DIR
        else process.env.OC_WT_STATE_DIR = prevEnvState
        if (prevEnvRoot === undefined) delete process.env.OC_WT_ROOT
        else process.env.OC_WT_ROOT = prevEnvRoot
        try { rmSync(ssRoot, { recursive: true, force: true }) } catch {}
    })

    test("non-strict mode (default config) does not inject discipline prompt", async () => {
        const plugin = await pluginEntry.server({ directory: defaultRepo, client: mockClientSS })
        const system = ["existing system prompt"]
        await plugin["experimental.chat.system.transform"](
            { sessionID: SS_SESSION },
            { system },
        )
        assert.equal(system.length, 1, "system array must be unchanged (no injection in default mode)")
        assert.equal(system[0], "existing system prompt", "existing prompt must be untouched")
    })

    test("strictWrites mode injects discipline prompt when no binding", async () => {
        const plugin = await pluginEntry.server({ directory: strictRepo, client: mockClientSS })
        const system = ["existing system prompt"]
        await plugin["experimental.chat.system.transform"](
            { sessionID: SS_SESSION },
            { system },
        )
        assert.equal(system.length, 2, "system array must grow by exactly 1")
        assert.ok(
            system[1].includes("WORKTREE-GUARD ACTIVE"),
            `injected prompt must contain 'WORKTREE-GUARD ACTIVE', got: ${system[1]}`,
        )
        assert.ok(system[1].includes("strictWrites=true"), "prompt must mention strictWrites=true")
        assert.ok(system[1].includes("strictGitOps=true"), "prompt must mention strictGitOps=true")
        assert.ok(
            !system[1].includes(defaultRepo) && !system[1].includes(strictRepo),
            "prompt must NOT leak any absolute file paths",
        )
    })

    test("binding present always injects ACTIVE WORKTREE prompt (Tier 1 behavior preserved)", async () => {
        const plugin = await pluginEntry.server({ directory: strictRepo, client: mockClientSS })
        const result = await plugin.tool.worktree_prepare.execute(
            { title: "ss-binding-test" },
            makeSsTctx(strictRepo, SS_SESSION),
        )
        assert.ok(result.startsWith("✅"), `prepare should succeed, got: ${result}`)

        const system = ["existing system prompt"]
        await plugin["experimental.chat.system.transform"](
            { sessionID: SS_SESSION },
            { system },
        )
        assert.equal(system.length, 2, "system array must grow by exactly 1")
        assert.ok(
            system[1].includes("ACTIVE WORKTREE"),
            `injected prompt must contain 'ACTIVE WORKTREE' (binding takes precedence over discipline prompt), got: ${system[1]}`,
        )
        assert.ok(
            !system[1].includes("WORKTREE-GUARD ACTIVE"),
            "discipline prompt must NOT be injected when a binding exists",
        )
    })
})

after(() => {
    try {
        rmSync(testRoot, { recursive: true, force: true })
    } catch {}
})
