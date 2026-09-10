import * as path from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"
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
} from "./lib.js"
import type { DecisionContext, MutableToolArgs, SessionBinding, WorktreeState } from "./lib.js"

const z = tool.schema

const WorktreePlugin: Plugin = async (ctx) => {
    const repoRoot = ctx.directory
    const client = ctx.client
    let pidCache: string | null = null
    const getPid = (): string => (pidCache ??= computeProjectId(repoRoot))

    const cfg = loadConfig(repoRoot)
    const stateBackend = createStateBackend(repoRoot, cfg)

    const inheritCache = new Map<string, (SessionBinding & { _state?: WorktreeState }) | null>()

    // A binding whose worktree directory no longer exists (external deletion,
    // interrupted cleanup) is a zombie: honoring it would rewrite every
    // read/write/edit into a dead path. Expire it instead.
    const materializeBinding = (
        b: SessionBinding,
        ownerSid: string,
    ): (SessionBinding & { _state?: WorktreeState }) | null => {
        if (existsSync(b.path)) return { ...b, _state: stateBackend.loadAll() }
        stateBackend.clearBinding(ownerSid)
        stateBackend.appendAudit({
            type: "binding_expired",
            sessionId: ownerSid,
            branch: b.branch,
            reason: `worktree directory no longer exists: ${b.path}`,
        })
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
                const res = await client.session.get({ path: { id: current } })
                parentId = res.data?.parentID ?? undefined
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

    return {
        tool: {
            worktree_prepare: tool({
                description:
                    "Create an isolated git worktree for the current task and bind this session to it. " +
                    "After binding, all repository file operations (write/edit/read/glob/grep/bash) in this session " +
                    "are automatically routed into the worktree, preventing path drift. Call this at the start of " +
                    "an isolated task; call worktree_cleanup when done.",
                args: {
                    title: z.string().min(1).describe("Human-readable task title; used to derive the branch name"),
                    branch: z
                        .string()
                        .optional()
                        .describe("Explicit branch name; defaults to <branchPrefix><slug-of-title>"),
                    baseBranch: z
                        .string()
                        .optional()
                        .describe("Base branch to create from; defaults to config baseBranch or repo default"),
                },
                async execute(args, tctx) {
                    const R = tctx.directory
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
                    stateBackend.saveBinding(tctx.sessionID, {
                        branch,
                        path: W,
                        repoRoot: R,
                        title,
                        createdAt: new Date().toISOString(),
                    })
                    stateBackend.appendAudit({
                        type: "prepare",
                        sessionId: tctx.sessionID,
                        branch,
                        path: W,
                    })
                    try {
                        tctx.metadata({
                            title: `🌿 ${branch}`,
                            metadata: { worktreeBranch: branch, worktreePath: W },
                        })
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
                },
            }),

            worktree_cleanup: tool({
                description:
                    "Preview or apply cleanup of worktrees created by worktree_prepare. " +
                    "preview: list managed worktrees with merge/dirty status. " +
                    "apply: remove a specific branch's worktree (or all merged ones), delete the branch, and unbind.",
                args: {
                    action: z.enum(["preview", "apply"]).describe("preview = list only; apply = remove"),
                    branch: z
                        .string()
                        .optional()
                        .describe("For apply: limit to this branch; omit to process all merged worktrees"),
                    force: z
                        .boolean()
                        .optional()
                        .describe("For apply: remove even if the branch is not merged into the base"),
                },
                async execute(args, tctx) {
                    const R = tctx.directory
                    const state = stateBackend.loadAll()
                    const entries = Object.entries(state.sessions)
                    if (!entries.length) return "No worktrees are currently bound to this project."
                    const base = cfg.baseBranch || defaultBaseBranch(R)
                    if (args.action === "preview") {
                        const mergedSet = base
                            ? new Set(
                                  git(["branch", "--merged", base], R).stdout
                                      .split("\n")
                                      .map((s) => s.trim().replace(/^\*/, "").trim()),
                              )
                            : null
                        const lines = entries.map(([sid, b]) => {
                            const merged = mergedSet ? mergedSet.has(b.branch) : null
                            const dirty = git(["status", "--porcelain"], b.path).stdout.trim() ? "dirty" : "clean"
                            const present = existsSync(b.path) ? "present" : "missing"
                            const flag = cfg.protectedBranches.includes(b.branch) ? " 🔒protected" : ""
                            return `  ${b.branch.padEnd(28)} ${(merged === true ? "merged" : merged === false ? "unmerged" : "unknown").padEnd(10)} ${dirty.padEnd(7)} ${present}${flag}  "${b.title || ""}"`
                        })
                        return (
                            `Managed worktrees (base: ${base || "?"}):\n` +
                            lines.join("\n") +
                            `\n\nTo remove: worktree_cleanup(action=apply, branch=<name>). ` +
                            `Only merged branches are removed unless force=true.`
                        )
                    }
                    const removed: string[] = []
                    const skipped: string[] = []
                    for (const [sid, b] of entries) {
                        if (cfg.protectedBranches.includes(b.branch)) {
                            skipped.push(`  🔒 ${b.branch}: protected`)
                            continue
                        }
                        if (args.branch && b.branch !== args.branch) continue
                        const mergedSet = base
                            ? new Set(
                                  git(["branch", "--merged", base], R).stdout
                                      .split("\n")
                                      .map((s) => s.trim().replace(/^\*/, "").trim()),
                              )
                            : null
                        const isMerged = mergedSet ? mergedSet.has(b.branch) : true
                        if (!isMerged && !args.force) {
                            skipped.push(`  ⏭  ${b.branch}: unmerged (use force=true to remove)`)
                            continue
                        }
                        const otherSessions = stateBackend.findSessionsForWorktree(b.path, sid)
                        if (otherSessions.length > 0) {
                            skipped.push(`  ⚠ ${b.branch}: 仍被其他会话绑定 (${otherSessions.join(", ")})，跳过删除`)
                            continue
                        }
                        runHookCommands(cfg.hooks.preDelete || [], b.path)
                        removeSyncedLinks(b.path, cfg.sync.symlinkDirs || [])
                        if (existsSync(b.path)) {
                            git(["add", "-A"], b.path)
                            git(["commit", "-m", "chore(worktree): pre-cleanup snapshot", "--allow-empty"], b.path)
                            const rm = git(["worktree", "remove", "--force", b.path], R)
                            if (!rm.ok) {
                                const fb = removeWorktreeDir(b.path)
                                if (!fb.ok) {
                                    skipped.push(
                                        `  ⚠ ${b.branch}: worktree remove failed - ${(rm.stderr || "").trim()} ` +
                                            `(fallback ${fb.method} failed: ${fb.err ?? "unknown error"})`,
                                    )
                                    continue
                                }
                                git(["worktree", "prune"], R)
                            }
                        } else {
                            git(["worktree", "prune"], R)
                        }
                        git(["branch", "-D", b.branch], R)
                        stateBackend.clearBinding(sid)
                        stateBackend.appendAudit({
                            type: "cleanup",
                            sessionId: sid,
                            branch: b.branch,
                            reason: args.force ? "force" : "merged",
                        })
                        removed.push(`  ✅ ${b.branch}: removed`)
                    }
                    return (
                        `Cleanup apply complete.\n` +
                        (removed.length ? `Removed:\n${removed.join("\n")}\n` : "Removed: (none)\n") +
                        (skipped.length ? `Skipped:\n${skipped.join("\n")}` : "")
                    )
                },
            }),

            worktree_merge: tool({
                description:
                    "Merge a worktree's branch back into the main checkout, then clean up. " +
                    "preview: show the merge plan (target branch, commits, diff stat, uncommitted changes) without merging. " +
                    "apply: auto-commit any uncommitted worktree changes, merge the branch into the main checkout's current branch, " +
                    "then remove the worktree, delete the branch, and unbind the session. " +
                    "Use this to integrate finished worktree work. Aborts safely on merge conflicts.",
                args: {
                    action: z.enum(["preview", "apply"]).describe("preview = show merge plan only; apply = merge + cleanup + unbind"),
                    branch: z
                        .string()
                        .optional()
                        .describe("Worktree branch to merge; defaults to this session's bound worktree branch"),
                },
                async execute(args, tctx) {
                    const R = tctx.directory
                    const state = stateBackend.loadAll()

                    let branch = args.branch
                    let boundSid: string | null = null
                    if (!branch) {
                        const binding = state.sessions[tctx.sessionID]
                        if (!binding)
                            return "❌ No worktree is bound to this session. Pass branch=<name> to merge a specific worktree."
                        branch = binding.branch
                        boundSid = tctx.sessionID
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
                    if (boundSid) {
                        const otherSessions = stateBackend.findSessionsForWorktree(W, boundSid)
                        if (otherSessions.length > 0) {
                            return (
                                `❌ Worktree "${branch}" 仍被其他会话绑定 (${otherSessions.join(", ")})。\n` +
                                `请让那些会话先退出（worktree_cleanup 仅清理本会话绑定），或手动确认后用 force。`
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
                    }
                    stateBackend.appendAudit({
                        type: "merge",
                        sessionId: boundSid ?? tctx.sessionID,
                        branch,
                        target,
                    })
                    return (
                        `✅ Merged "${branch}" into "${target}" and cleaned up.\n` +
                        `   worktree removed: ${W}\n` +
                        `   branch deleted:   ${branch}\n` +
                        `   session unbound — file operations now target the repo root (${R}) again.`
                    )
                },
            }),

            worktree_allow: tool({
                description:
                    "Temporarily allow writing to specific paths in the main checkout without a worktree binding. " +
                    "Use for repo-level config/docs (e.g., AGENTS.md, CI configs). Entries have a TTL and are audited. " +
                    "Requires strictWrites=true to be meaningful (otherwise all writes are allowed by default).",
                args: {
                    action: z
                        .enum(["add", "list", "clear"])
                        .describe("add = add a path; list = show current entries; clear = remove all entries"),
                    path: z
                        .string()
                        .optional()
                        .describe("For add: repo-relative path or glob pattern"),
                    reason: z
                        .string()
                        .optional()
                        .describe("For add: why this path needs main-checkout write"),
                    ttlMinutes: z
                        .number()
                        .optional()
                        .describe("TTL in minutes (default: 60, configurable via allowlistTtlMinutes)"),
                },
                async execute(args, tctx) {
                    const R = tctx.directory
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
                            sessionId: tctx.sessionID,
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
                        bySession: tctx.sessionID,
                        createdAt: new Date().toISOString(),
                        expiresAt,
                    }
                    const entries = stateBackend.loadAllowlist()
                    entries.push(entry)
                    stateBackend.saveAllowlist(entries)
                    stateBackend.appendAudit({
                        type: "allow_add",
                        sessionId: tctx.sessionID,
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
                },
            }),
        },

        "tool.execute.before": async (input, output) => {
            const sessionId = input?.sessionID
            const toolName = input?.tool
            if (!sessionId || !output || typeof toolName !== "string") return
            if (toolName.startsWith("worktree_")) return
            const args = output.args as MutableToolArgs
            if (!args || typeof args !== "object") return
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
                applyInterception(toolName, args, ctx)
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
        },

        "experimental.chat.system.transform": async (input, output) => {
            if (!output || !Array.isArray(output.system)) return
            const sessionId = input?.sessionID
            if (!sessionId) return
            const binding = await resolveBinding(sessionId)
            if (binding) {
                output.system.push(
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
                        `For glob/grep, use the worktree path as the search root.`,
                )
                return
            }
            if (cfg.strictWrites || cfg.strictGitOps || cfg.sessionStartNudge) {
                const protectedList =
                    cfg.protectedBranches.length > 0 ? cfg.protectedBranches.join(", ") : "master, main"
                output.system.push(
                    `## WORKTREE-GUARD ACTIVE\n` +
                        `This repo enforces worktree discipline (strictWrites=${cfg.strictWrites}, strictGitOps=${cfg.strictGitOps}).\n` +
                        `- Before writing code, call worktree_prepare to create an isolated worktree.\n` +
                        `- Writes to the main checkout without a binding will be BLOCKED (if strictWrites=true).\n` +
                        `- Dangerous git operations on protected branches (${protectedList}) will be BLOCKED (if strictGitOps=true).\n` +
                        `- For repo-level config/docs, use worktree_allow or add paths to mainWriteWhitelist.\n`,
                )
            }
        },
    }
}

export default WorktreePlugin
