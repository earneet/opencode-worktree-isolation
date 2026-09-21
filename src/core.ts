import * as path from "node:path"
import {
    IS_WIN,
    MAX_PARENT_DEPTH,
    git,
    computeProjectId,
    validateBranch,
    slugify,
    loadConfig,
    createStateBackend,
    resolveWorktreeRoot,
    defaultBaseBranch,
    runHookCommands,
    removeSyncedLinks,
    applyInterception,
    isDotGitPath,
    removeWorktreeDir,
    isAllowlisted,
    existsSync,
    mkdirSync,
    copyFileSync,
    statSync,
    symlinkSync,
    norm,
    findSessionsForWorktree,
    mergedBranchSet,
} from "./lib.js"
import type { DecisionContext, MutableToolArgs, SessionBinding, WorktreeState } from "./lib.js"

export const DESCRIPTIONS = {
    prepare:
        "Create an isolated git worktree for the current task and bind this session to it. " +
        "After binding, all repository file operations (write/edit/read/glob/grep/bash) in this session " +
        "are automatically routed into the worktree, preventing path drift. Call this at the start of " +
        "an isolated task; call worktree_cleanup when done.",
    cleanup:
        "Preview or apply cleanup of worktrees created by worktree_prepare. " +
        "preview: list managed worktrees with merge/dirty status. " +
        "apply: remove a specific branch's worktree (or all merged ones), delete the branch, and unbind.",
    merge:
        "Merge a worktree's branch back into the main checkout, then clean up. " +
        "preview: show the merge plan (target branch, commits, diff stat, uncommitted changes) without merging. " +
        "apply: auto-commit any uncommitted worktree changes, merge the branch into the main checkout's current branch, " +
        "then remove the worktree, delete the branch, and unbind the session. " +
        "Use this to integrate finished worktree work. Aborts safely on merge conflicts.",
    allow:
        "Temporarily allow writing to specific paths in the main checkout without a worktree binding. " +
        "Use for repo-level config/docs (e.g., AGENTS.md, CI configs). Entries have a TTL and are audited. " +
        "Requires strictWrites=true to be meaningful (otherwise all writes are allowed by default).",
} as const

export const ARG_DESCRIPTIONS = {
    prepare: {
        title: "Human-readable task title; used to derive the branch name",
        branch: "Explicit branch name; defaults to <branchPrefix><slug-of-title>",
        baseBranch: "Base branch to create from; defaults to config baseBranch or repo default",
    },
    cleanup: {
        action: "preview = list only; apply = remove",
        branch: "For apply: limit to this branch; omit to process all merged worktrees",
        force: "For apply: remove even if the branch is not merged into the base",
    },
    merge: {
        action: "preview = show merge plan only; apply = merge + cleanup + unbind",
        branch: "Worktree branch to merge; defaults to this session's bound worktree branch",
    },
    allow: {
        action: "add = add a path; list = show current entries; clear = remove all entries",
        path: "For add: repo-relative path or glob pattern",
        reason: "For add: why this path needs main-checkout write",
        ttlMinutes: "TTL in minutes (default: 60, configurable via allowlistTtlMinutes)",
    },
} as const

export interface PrepareArgs {
    title: string
    branch?: string
    baseBranch?: string
}

export interface CleanupArgs {
    action: "preview" | "apply"
    branch?: string
    force?: boolean
}

export interface MergeArgs {
    action: "preview" | "apply"
    branch?: string
}

export interface AllowArgs {
    action: "add" | "list" | "clear"
    path?: string
    reason?: string
    ttlMinutes?: number
}

// Per-call context handed to the shared tool bodies. V1 fills `directory` from
// each tool invocation's context; V2 has no per-call directory and falls back
// to the location captured at plugin setup.
export interface CoreCall {
    sessionId: string
    directory: string
    setSessionTitle?: (title: string, metadata?: Record<string, unknown>) => void
}

export interface CoreOptions {
    repoRoot: string
    // Must normalize lookup failures to undefined so parent-chain traversal
    // stops exactly like V1's `catch { break }` did.
    getParentId: (sessionId: string) => Promise<string | undefined>
}

export interface WorktreeCore {
    prepare(args: PrepareArgs, call: CoreCall): Promise<string>
    cleanup(args: CleanupArgs, call: CoreCall): Promise<string>
    merge(args: MergeArgs, call: CoreCall): Promise<string>
    allow(args: AllowArgs, call: CoreCall): Promise<string>
    intercept(toolName: unknown, sessionId: unknown, args: unknown): Promise<void>
    systemPromptText(sessionId: string | undefined | null): Promise<string | null>
    onSessionIdle(sessionId: string): void
    onSessionDeleted(sessionId: string): void
}

export function createCore(opts: CoreOptions): WorktreeCore {
    const repoRoot = opts.repoRoot
    const getParentId = opts.getParentId

    const cfg = loadConfig(repoRoot)
    const stateBackend = createStateBackend(repoRoot, cfg)

    const inheritCache = new Map<string, (SessionBinding & { _state?: WorktreeState }) | null>()

    const releaseBinding = (sid: string, reason: string, auditType: "binding_released" | "binding_expired") => {
        stateBackend.clearBinding(sid)
        inheritCache.delete(sid)
        stateBackend.appendAudit({ type: auditType, sessionId: sid, reason })
    }

    // Inherited bindings belong to sub-agent sessions that are, by construction,
    // descendants of the owner session. They ride along with the worktree: when
    // the owner merges or cleans up, they are released instead of blocking.
    const releaseInheritedForWorktree = (
        state: WorktreeState,
        worktreePath: string,
        excludeSid: string,
        reason: string,
    ): string[] => {
        const released: string[] = []
        for (const sid of findSessionsForWorktree(state, worktreePath, excludeSid)) {
            if (state.sessions[sid]?.inherited) {
                releaseBinding(sid, reason, "binding_released")
                released.push(sid)
            }
        }
        return released
    }

    const clearAllForWorktree = (worktreePath: string, reason: string) => {
        const nWt = norm(worktreePath)
        for (const { sessionId, binding } of stateBackend.listBindings()) {
            if (norm(binding.path) === nWt) {
                releaseBinding(sessionId, reason, "binding_released")
            }
        }
    }

    const reapMissingDirs = (): string[] => {
        const cleared: string[] = []
        for (const { sessionId, binding } of stateBackend.listBindings()) {
            if (!existsSync(binding.path)) {
                releaseBinding(
                    sessionId,
                    `worktree directory no longer exists: ${binding.path}`,
                    "binding_expired",
                )
                cleared.push(sessionId)
            }
        }
        return cleared
    }

    // A binding whose worktree directory no longer exists (external deletion,
    // interrupted cleanup) is a zombie: honoring it would rewrite every
    // read/write/edit into a dead path. Expire it instead — and every other
    // binding for the same path with it, since they are all zombies too.
    const materializeBinding = (
        b: SessionBinding,
        ownerSid: string,
    ): (SessionBinding & { _state?: WorktreeState }) | null => {
        if (existsSync(b.path)) return { ...b, _state: stateBackend.loadAll() }
        const reason = `worktree directory no longer exists: ${b.path}`
        stateBackend.appendAudit({ type: "binding_expired", sessionId: ownerSid, branch: b.branch, reason })
        stateBackend.clearBinding(ownerSid)
        inheritCache.delete(ownerSid)
        const nWt = norm(b.path)
        for (const { sessionId, binding } of stateBackend.listBindings()) {
            if (sessionId !== ownerSid && norm(binding.path) === nWt) {
                releaseBinding(sessionId, reason, "binding_expired")
            }
        }
        console.warn(
            `[worktree] binding expired: worktree directory ${b.path} no longer exists. ` +
                `Session ${ownerSid} unbound; file operations now target the repo root.`,
        )
        return null
    }

    async function resolveBinding(
        sessionId: string,
    ): Promise<(SessionBinding & { _state?: WorktreeState }) | null> {
        if (!sessionId) return null
        const direct = stateBackend.loadBinding(sessionId)
        if (direct) return materializeBinding(direct, sessionId)
        if (inheritCache.has(sessionId)) return inheritCache.get(sessionId)!
        let current = sessionId
        let found: SessionBinding | null = null
        let ownerSid: string | null = null
        for (let i = 0; i < MAX_PARENT_DEPTH; i++) {
            let parentId: string | undefined
            try {
                parentId = await getParentId(current)
            } catch {
                break
            }
            if (!parentId) break
            const inherited = stateBackend.loadBinding(parentId)
            if (inherited) {
                found = inherited
                ownerSid = parentId
                break
            }
            current = parentId
        }
        if (found && ownerSid !== null) {
            const live = materializeBinding(found, ownerSid)
            if (!live) {
                inheritCache.set(sessionId, null)
                return null
            }
            const snapshot: SessionBinding = {
                branch: live.branch,
                path: live.path,
                repoRoot: live.repoRoot,
                title: live.title,
                createdAt: new Date().toISOString(),
                inherited: true,
            }
            stateBackend.saveBinding(sessionId, snapshot)
            const result = { ...snapshot, _state: stateBackend.loadAll() }
            inheritCache.set(sessionId, result)
            return result
        }
        inheritCache.set(sessionId, null)
        return null
    }

    async function prepare(args: PrepareArgs, call: CoreCall): Promise<string> {
        const R = call.directory
        const pid = computeProjectId(R)
        const title = (args.title || "").trim()
        let branch: string
        try {
            branch = args.branch
                ? validateBranch(args.branch)
                : validateBranch((cfg.branchPrefix || "wt/") + slugify(title))
        } catch (e) {
            return `❌ ${(e as Error).message}`
        }
        const base = args.baseBranch || cfg.baseBranch || defaultBaseBranch(R)
        const wRoot = resolveWorktreeRoot(cfg.worktreeRoot, R)
        const W = path.join(wRoot, pid, branch.replace(/\//g, path.sep))
        const existsAlready = git(["rev-parse", "--verify", branch], R).ok
        const addArgs = existsAlready
            ? ["worktree", "add", W, branch]
            : ["worktree", "add", "-b", branch, W, base].filter(
                  (x): x is string => x !== null && x !== undefined,
              )
        mkdirSync(path.dirname(W), { recursive: true })
        const addResult = git(addArgs, R)
        if (!addResult.ok) {
            return `❌ git worktree add failed: ${(addResult.stderr || addResult.stdout).trim()}`
        }
        for (const f of cfg.sync.copyFiles || []) {
            const src = path.join(R, f)
            const dst = path.join(W, f)
            if (existsSync(src)) {
                mkdirSync(path.dirname(dst), { recursive: true })
                try {
                    copyFileSync(src, dst)
                } catch {}
            }
        }
        for (const d of cfg.sync.symlinkDirs || []) {
            const src = path.join(R, d)
            const dst = path.join(W, d)
            if (existsSync(src) && statSync(src).isDirectory()) {
                try {
                    mkdirSync(path.dirname(dst), { recursive: true })
                    symlinkSync(src, dst, IS_WIN ? "junction" : "dir")
                } catch {
                    try {
                        symlinkSync(src, dst, "dir")
                    } catch {}
                }
            }
        }
        runHookCommands(cfg.hooks.postCreate || [], W)
        stateBackend.saveBinding(call.sessionId, {
            branch,
            path: W,
            repoRoot: R,
            title,
            createdAt: new Date().toISOString(),
        })
        stateBackend.appendAudit({
            type: "prepare",
            sessionId: call.sessionId,
            branch,
            path: W,
        })
        try {
            call.setSessionTitle?.(`🌿 ${branch}`, { worktreeBranch: branch, worktreePath: W })
        } catch {}
        return (
            `✅ Worktree prepared and session bound.\n` +
            `   branch:     ${branch}\n` +
            `   worktree:   ${W}\n` +
            `   base:       ${base || "(HEAD)"}\n` +
            `   repo root:  ${R}\n\n` +
            `All repo file operations in this session are now routed into the worktree. ` +
            `Do not manually cd; just use file tools normally.`
        )
    }

    async function cleanup(args: CleanupArgs, call: CoreCall): Promise<string> {
        const R = call.directory
        const base = cfg.baseBranch || defaultBaseBranch(R)
        if (args.action === "preview") {
            const reaped = reapMissingDirs()
            const state = stateBackend.loadAll()
            const entries = Object.entries(state.sessions)
            if (!entries.length) {
                return (
                    "No worktrees are currently bound to this project." +
                    (reaped.length ? `\n(released ${reaped.length} expired binding(s) whose worktree directories are gone)` : "")
                )
            }
            const mergedSet = mergedBranchSet(R, base)
            const byPath = new Map<string, { binding: SessionBinding; sessions: number }>()
            for (const [, b] of entries) {
                const key = norm(b.path)
                const existing = byPath.get(key)
                if (!existing) {
                    byPath.set(key, { binding: b, sessions: 1 })
                } else {
                    existing.sessions += 1
                    if (!b.inherited) existing.binding = b
                }
            }
            const lines = [...byPath.values()].map(({ binding: b, sessions }) => {
                const merged = mergedSet ? mergedSet.has(b.branch) : null
                const dirty = git(["status", "--porcelain"], b.path).stdout.trim() ? "dirty" : "clean"
                const present = existsSync(b.path) ? "present" : "missing"
                const flag = cfg.protectedBranches.includes(b.branch) ? " 🔒protected" : ""
                return `  ${b.branch.padEnd(28)} ${(merged === true ? "merged" : merged === false ? "unmerged" : "unknown").padEnd(10)} ${dirty.padEnd(7)} ${present}  sessions=${sessions}${flag}  "${b.title || ""}"`
            })
            return (
                `Managed worktrees (base: ${base || "?"}):\n` +
                lines.join("\n") +
                (reaped.length
                    ? `\n\n(released ${reaped.length} expired binding(s) whose worktree directories are gone)`
                    : "") +
                `\n\nTo remove: worktree_cleanup(action=apply, branch=<name>). ` +
                `Only merged branches are removed unless force=true.`
            )
        }
        const removed: string[] = []
        const skipped: string[] = []
        const mergedSet = mergedBranchSet(R, base)
        const state = stateBackend.loadAll()
        const entries = Object.entries(state.sessions)
        const processedPaths = new Set<string>()
        for (const [sid, b] of entries) {
            const nPath = norm(b.path)
            if (processedPaths.has(nPath)) continue
            processedPaths.add(nPath)
            // Multiple sessions may bind one worktree (owner + inherited
            // sub-agents); process each worktree exactly once, driven by
            // its direct (non-inherited) binding when one exists.
            const rep = entries.find(([, b2]) => norm(b2.path) === nPath && !b2.inherited)
            const repSid = rep ? rep[0] : sid
            const repBinding = rep ? rep[1] : b
            if (cfg.protectedBranches.includes(repBinding.branch)) {
                skipped.push(`  🔒 ${repBinding.branch}: protected`)
                continue
            }
            if (args.branch && repBinding.branch !== args.branch) continue
            const isMerged = mergedSet ? mergedSet.has(repBinding.branch) : true
            if (!isMerged && !args.force) {
                skipped.push(`  ⏭  ${repBinding.branch}: unmerged (use force=true to remove)`)
                continue
            }
            const liveState = stateBackend.loadAll()
            const released = releaseInheritedForWorktree(
                liveState,
                repBinding.path,
                repSid,
                "released with worktree cleanup (inherited sub-agent binding)",
            )
            const otherSessions = findSessionsForWorktree(liveState, repBinding.path, repSid)
            const blocking = otherSessions.filter((s) => !liveState.sessions[s]?.inherited)
            if (blocking.length > 0) {
                skipped.push(
                    `  ⚠ ${repBinding.branch}: 仍被其他独立会话绑定 (${blocking.join(", ")})，跳过删除` +
                        (released.length ? `（已自动释放 ${released.length} 个 inherited 子会话绑定）` : ""),
                )
                continue
            }
            runHookCommands(cfg.hooks.preDelete || [], repBinding.path)
            removeSyncedLinks(repBinding.path, cfg.sync.symlinkDirs || [])
            if (existsSync(repBinding.path)) {
                git(["add", "-A"], repBinding.path)
                git(["commit", "-m", "chore(worktree): pre-cleanup snapshot", "--allow-empty"], repBinding.path)
                const rm = git(["worktree", "remove", "--force", repBinding.path], R)
                if (!rm.ok) {
                    const fb = removeWorktreeDir(repBinding.path)
                    if (!fb.ok) {
                        skipped.push(
                            `  ⚠ ${repBinding.branch}: worktree remove failed - ${(rm.stderr || "").trim()} ` +
                                `(fallback ${fb.method} failed: ${fb.err ?? "unknown error"})`,
                        )
                        continue
                    }
                    git(["worktree", "prune"], R)
                }
            } else {
                git(["worktree", "prune"], R)
            }
            git(["branch", "-D", repBinding.branch], R)
            stateBackend.clearBinding(repSid)
            clearAllForWorktree(repBinding.path, "released with worktree cleanup")
            stateBackend.appendAudit({
                type: "cleanup",
                sessionId: repSid,
                branch: repBinding.branch,
                reason: args.force ? "force" : "merged",
            })
            removed.push(
                `  ✅ ${repBinding.branch}: removed` +
                    (released.length ? ` (released ${released.length} inherited binding(s))` : ""),
            )
        }
        return (
            `Cleanup apply complete.\n` +
            (removed.length ? `Removed:\n${removed.join("\n")}\n` : "Removed: (none)\n") +
            (skipped.length ? `Skipped:\n${skipped.join("\n")}` : "")
        )
    }

    async function merge(args: MergeArgs, call: CoreCall): Promise<string> {
        const R = call.directory
        const state = stateBackend.loadAll()

        let branch = args.branch
        let boundSid: string | null = null
        if (!branch) {
            const binding = state.sessions[call.sessionId]
            if (!binding)
                return "❌ No worktree is bound to this session. Pass branch=<name> to merge a specific worktree."
            branch = binding.branch
            boundSid = call.sessionId
        } else {
            const entry = Object.entries(state.sessions).find(([, b]) => b.branch === branch)
            boundSid = entry ? entry[0] : null
        }
        const binding = boundSid ? state.sessions[boundSid] : null
        if (!binding) return `❌ No managed worktree found for branch "${branch}".`
        const W = binding.path

        const targetRes = git(["symbolic-ref", "--short", "HEAD"], R)
        if (!targetRes.ok)
            return `❌ Cannot determine the current branch of ${R}: ${targetRes.stderr.trim()}`
        const target = targetRes.stdout.trim()
        if (target === branch) return `❌ The main checkout is already on "${branch}" — nothing to merge.`

        const logRes = git(["log", `${target}..${branch}`, "--oneline"], R)
        const commits = logRes.ok ? logRes.stdout.trim() : ""
        const diffRes = git(["diff", `${target}...${branch}`, "--stat"], R)
        const diffStat = diffRes.ok ? diffRes.stdout.trim() : ""
        const dirtyRes = git(["status", "--porcelain"], W)
        const dirty = dirtyRes.ok ? dirtyRes.stdout.trim() : ""
        const dirtyFiles = dirty ? dirty.split("\n").map((l) => l.trim()).filter(Boolean) : []
        const dirtyCount = dirtyFiles.length

        if (args.action === "preview") {
            return (
                `Merge preview: "${branch}" → "${target}"\n` +
                `   worktree: ${W}\n` +
                `   commits to merge:\n${commits ? commits.split("\n").map((l) => "     " + l).join("\n") : "     (none — already up to date)"}\n` +
                `   diff stat:\n${diffStat ? diffStat.split("\n").map((l) => "     " + l).join("\n") : "     (no file changes)"}\n` +
                (dirtyCount
                    ? `   ⚠ ${dirtyCount} uncommitted change(s) will be auto-committed before merge:\n` +
                      dirtyFiles.slice(0, 20).map((l) => `     ${l}`).join("\n") +
                      (dirtyCount > 20 ? `\n     … and ${dirtyCount - 20} more` : "") +
                      "\n"
                    : "") +
                `\nApply with: worktree_merge(action="apply"${args.branch ? `, branch="${branch}"` : ""}). ` +
                `The merge aborts safely if conflicts arise.`
            )
        }

        const rDirty = git(["status", "--porcelain"], R)
        const trackedChanges = rDirty.ok
            ? rDirty.stdout
                  .split("\n")
                  .filter((l) => l.trim() && !l.startsWith("??"))
                  .join("\n")
                  .trim()
            : ""
        if (trackedChanges) {
            return (
                `❌ The main checkout ${R} has uncommitted tracked changes. Commit or stash them before merging:\n` +
                trackedChanges
            )
        }
        let inheritedReleased = 0
        if (boundSid) {
            const otherSessions = findSessionsForWorktree(state, W, boundSid)
            inheritedReleased = releaseInheritedForWorktree(
                state,
                W,
                boundSid,
                "released with worktree merge (inherited sub-agent binding)",
            ).length
            const blocking = otherSessions.filter((s) => !state.sessions[s]?.inherited)
            if (blocking.length > 0) {
                return (
                    `❌ Worktree "${branch}" 仍被其他独立会话绑定 (${blocking.join(", ")})。\n` +
                    (inheritedReleased
                        ? `已自动释放 ${inheritedReleased} 个 inherited 子会话绑定。\n`
                        : "") +
                    `请让绑定该 worktree 的独立会话先退出/解绑，然后重试。`
                )
            }
        }
        if (dirtyCount) {
            git(["add", "-A"], W)
            const c = git(["commit", "-m", "chore(worktree): pre-merge snapshot", "--allow-empty"], W)
            if (!c.ok) return `❌ Failed to commit worktree changes before merge: ${c.stderr.trim()}`
        }
        const mergeRes = git(["merge", "--no-ff", "-m", `Merge worktree '${branch}'`, branch], R)
        if (!mergeRes.ok) {
            git(["merge", "--abort"], R)
            return (
                `❌ Merge of "${branch}" into "${target}" failed (likely conflicts). The merge was aborted; the repo is left clean.\n` +
                `${(mergeRes.stderr || mergeRes.stdout).trim()}\n` +
                `Resolve conflicts manually (or rebase "${branch}" onto "${target}") and retry.`
            )
        }
        if (existsSync(W)) {
            removeSyncedLinks(W, cfg.sync.symlinkDirs || [])
            const rm = git(["worktree", "remove", "--force", W], R)
            if (!rm.ok) {
                const fb = removeWorktreeDir(W)
                if (!fb.ok) {
                    return (
                        `⚠ Merged "${branch}" into "${target}", but worktree removal failed: ${rm.stderr.trim()}\n` +
                        `⚠ Fallback deletion (${fb.method}) also failed: ${fb.err ?? "unknown error"}\n` +
                        `This session is STILL BOUND to ${W} — read/write/edit keep targeting it. ` +
                        `The binding expires automatically once the directory is deleted, e.g.:\n` +
                        `   robocopy <empty-dir> ${W} /MIR\n` +
                        `   rmdir /s /q <empty-dir>\n` +
                        `   git worktree prune`
                    )
                }
                git(["worktree", "prune"], R)
            }
        } else {
            git(["worktree", "prune"], R)
        }
        git(["branch", "-d", branch], R)
        if (boundSid) {
            stateBackend.clearBinding(boundSid)
            inheritCache.delete(boundSid)
        }
        clearAllForWorktree(W, "released with worktree merge")
        stateBackend.appendAudit({
            type: "merge",
            sessionId: boundSid ?? call.sessionId,
            branch,
            target,
        })
        return (
            `✅ Merged "${branch}" into "${target}" and cleaned up.\n` +
            `   worktree removed: ${W}\n` +
            `   branch deleted:   ${branch}\n` +
            (inheritedReleased
                ? `   inherited bindings released: ${inheritedReleased}\n`
                : "") +
            `   session unbound — file operations now target the repo root (${R}) again.`
        )
    }

    async function allow(args: AllowArgs, call: CoreCall): Promise<string> {
        const R = call.directory
        if (args.action === "list") {
            const entries = stateBackend.loadAllowlist()
            if (entries.length === 0) return "Allowlist is empty."
            const lines = entries.map(
                (e) =>
                    `  ${e.path.padEnd(40)} expires=${e.expiresAt ?? "(never)"} by=${e.bySession ?? "?"} reason="${e.reason ?? ""}"`,
            )
            return `Allowlist (${entries.length} entry):\n${lines.join("\n")}`
        }
        if (args.action === "clear") {
            const before = stateBackend.loadAllowlist().length
            stateBackend.saveAllowlist([])
            stateBackend.appendAudit({
                type: "allow_clear",
                sessionId: call.sessionId,
                removed: before,
            })
            return `✅ Allowlist cleared (removed ${before} entr${before === 1 ? "y" : "ies"}).`
        }
        const targetPath = (args.path || "").trim()
        if (!targetPath) {
            return `❌ path is required for action="add". Example: worktree_allow(action="add", path="AGENTS.md", reason="...").`
        }
        const dangerous = ["", ".", "/", ".git", "*", "**", "./", ".\\"]
        const slashStripped = targetPath.replace(/[/\\]/g, "")
        if (
            dangerous.includes(targetPath) ||
            [".git", "git"].includes(slashStripped) ||
            slashStripped === "*"
        ) {
            return (
                `❌ Refused to allow dangerous path: '${targetPath}'. ` +
                `Bare-root or wildcard patterns would disable worktree protection. ` +
                `Specify a concrete file or directory path.`
            )
        }
        if (isDotGitPath(targetPath)) {
            return `❌ Refused to allow .git-related path: '${targetPath}'. The .git directory is always blocked.`
        }
        const ttl = args.ttlMinutes ?? cfg.allowlistTtlMinutes
        const expiresAt = new Date(Date.now() + ttl * 60000).toISOString()
        const reason = (args.reason || "").trim()
        const entry = {
            path: targetPath,
            reason,
            bySession: call.sessionId,
            createdAt: new Date().toISOString(),
            expiresAt,
        }
        const entries = stateBackend.loadAllowlist()
        entries.push(entry)
        stateBackend.saveAllowlist(entries)
        stateBackend.appendAudit({
            type: "allow_add",
            sessionId: call.sessionId,
            path: targetPath,
            reason,
            expiresAt,
        })
        return (
            `✅ Allowlist entry added.\n` +
            `   path:     ${targetPath}\n` +
            `   expires:  ${expiresAt} (in ${ttl} min)\n` +
            `   reason:   ${reason || "(none)"}\n` +
            `   audit:    logged.`
        )
    }

    async function intercept(toolName: unknown, sessionId: unknown, args: unknown): Promise<void> {
        if (typeof toolName !== "string" || typeof sessionId !== "string" || !sessionId) return
        if (toolName.startsWith("worktree_")) return
        const toolArgs = args as MutableToolArgs
        if (!toolArgs || typeof toolArgs !== "object") return
        const binding = await resolveBinding(sessionId)
        const effectiveRoot = binding?.repoRoot ?? repoRoot
        const allowlist = stateBackend.loadAllowlist()
        const ctx: DecisionContext = {
            isWrite: toolName === "write" || toolName === "edit",
            toolName,
            repoRoot: effectiveRoot,
            worktreePath: binding?.path ?? null,
            strictWrites: cfg.strictWrites,
            strictGitOps: cfg.strictGitOps,
            whitelist: cfg.mainWriteWhitelist,
            protectedBranches: cfg.protectedBranches,
            allowlistMatcher: (p: string) => isAllowlisted(p, effectiveRoot, allowlist),
        }
        try {
            applyInterception(toolName, toolArgs, ctx)
        } catch (e) {
            const reason = (e as Error).message
            if (reason.includes("strictWrites") || reason.includes("strictGitOps")) {
                stateBackend.appendAudit({
                    type: "deny",
                    sessionId,
                    toolName,
                    reason,
                })
            }
            throw e
        }
    }

    async function systemPromptText(sessionId: string | undefined | null): Promise<string | null> {
        if (!sessionId) return null
        const binding = await resolveBinding(sessionId)
        if (binding) {
            return (
                `## ACTIVE WORKTREE — Your Working Directory Has Changed\n` +
                `Your working directory is now the git worktree:\n` +
                `  ${binding.path}\n` +
                `Branch: ${binding.branch}\n\n` +
                `The repository root (${binding.repoRoot}) is NOT your working directory.\n` +
                `Do NOT generate file paths starting with ${binding.repoRoot}.\n\n` +
                `When using write/edit/read tools, the filePath MUST be under the worktree:\n` +
                `  CORRECT: filePath starting with "${binding.path}"\n` +
                `  WRONG:   filePath starting with "${binding.repoRoot}"\n\n` +
                `For bash, your working directory is already the worktree.\n` +
                `For glob/grep, use the worktree path as the search root.`
            )
        }
        if (cfg.strictWrites || cfg.strictGitOps || cfg.sessionStartNudge) {
            const protectedList =
                cfg.protectedBranches.length > 0 ? cfg.protectedBranches.join(", ") : "master, main"
            return (
                `## WORKTREE-GUARD ACTIVE\n` +
                `This repo enforces worktree discipline (strictWrites=${cfg.strictWrites}, strictGitOps=${cfg.strictGitOps}).\n` +
                `- Before writing code, call worktree_prepare to create an isolated worktree.\n` +
                `- Writes to the main checkout without a binding will be BLOCKED (if strictWrites=true).\n` +
                `- Dangerous git operations on protected branches (${protectedList}) will be BLOCKED (if strictGitOps=true).\n` +
                `- For repo-level config/docs, use worktree_allow or add paths to mainWriteWhitelist.\n`
            )
        }
        return null
    }

    function onSessionIdle(sessionId: string): void {
        // A finished sub-agent session never calls tools again, so nothing
        // else would ever expire its inherited binding (issue #7). Releasing
        // here is safe: lazy parent-chain inheritance re-binds the session
        // transparently if it resumes work later.
        const b = stateBackend.loadBinding(sessionId)
        if (b?.inherited) {
            releaseBinding(sessionId, "sub-agent session finished (idle)", "binding_released")
        }
    }

    function onSessionDeleted(sessionId: string): void {
        if (sessionId && stateBackend.loadBinding(sessionId)) {
            releaseBinding(sessionId, "session deleted", "binding_released")
        }
    }

    return {
        prepare,
        cleanup,
        merge,
        allow,
        intercept,
        systemPromptText,
        onSessionIdle,
        onSessionDeleted,
    }
}
