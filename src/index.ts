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
    resolveWorktreeRoot,
    defaultBaseBranch,
    runHookCommands,
    loadState,
    saveState,
    applyInterception,
    existsSync,
    mkdirSync,
    copyFileSync,
    statSync,
    symlinkSync,
} from "./lib.js"
import type { MutableToolArgs, SessionBinding, WorktreeState } from "./lib.js"

const z = tool.schema

const WorktreePlugin: Plugin = async (ctx) => {
    const repoRoot = ctx.directory
    const client = ctx.client
    let pidCache: string | null = null
    const getPid = (): string => (pidCache ??= computeProjectId(repoRoot))

    const inheritCache = new Map<string, (SessionBinding & { _state?: WorktreeState }) | null>()

    async function resolveBinding(
        sessionId: string,
    ): Promise<(SessionBinding & { _state?: WorktreeState }) | null> {
        if (!sessionId) return null
        const state = loadState(getPid())
        if (state.sessions[sessionId]) return { ...state.sessions[sessionId]!, _state: state }
        if (inheritCache.has(sessionId)) return inheritCache.get(sessionId)!
        let current = sessionId
        let found: SessionBinding | null = null
        for (let i = 0; i < MAX_PARENT_DEPTH; i++) {
            let parentId: string | undefined
            try {
                const res = await client.session.get({ path: { id: current } })
                parentId = res.data?.parentID ?? undefined
            } catch {
                break
            }
            if (!parentId) break
            if (state.sessions[parentId]) {
                found = state.sessions[parentId]!
                break
            }
            current = parentId
        }
        if (found) {
            const state2 = loadState(getPid())
            state2.sessions[sessionId] = {
                branch: found.branch,
                path: found.path,
                repoRoot: found.repoRoot,
                title: found.title,
                createdAt: new Date().toISOString(),
                inherited: true,
            }
            saveState(getPid(), state2)
            const result = { ...state2.sessions[sessionId]!, _state: state2 }
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
                    const cfg = loadConfig(R)
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
                    const state = loadState(pid)
                    state.sessions[tctx.sessionID] = {
                        branch,
                        path: W,
                        repoRoot: R,
                        title,
                        createdAt: new Date().toISOString(),
                    }
                    saveState(pid, state)
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
                    const pid = computeProjectId(R)
                    const cfg = loadConfig(R)
                    const state = loadState(pid)
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
                        runHookCommands(cfg.hooks.preDelete || [], b.path)
                        git(["add", "-A"], b.path)
                        git(["commit", "-m", "chore(worktree): pre-cleanup snapshot", "--allow-empty"], b.path)
                        const rm = git(["worktree", "remove", "--force", b.path], R)
                        if (!rm.ok) {
                            skipped.push(`  ⚠ ${b.branch}: worktree remove failed - ${(rm.stderr || "").trim()}`)
                            continue
                        }
                        git(["branch", "-D", b.branch], R)
                        delete state.sessions[sid]
                        removed.push(`  ✅ ${b.branch}: removed`)
                    }
                    saveState(pid, state)
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
                    const pid = computeProjectId(R)
                    const state = loadState(pid)

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
                    const dirtyCount = dirty ? dirty.split("\n").length : 0

                    if (args.action === "preview") {
                        return (
                            `Merge preview: "${branch}" → "${target}"\n` +
                            `   worktree: ${W}\n` +
                            `   commits to merge:\n${commits ? commits.split("\n").map((l) => "     " + l).join("\n") : "     (none — already up to date)"}\n` +
                            `   diff stat:\n${diffStat ? diffStat.split("\n").map((l) => "     " + l).join("\n") : "     (no file changes)"}\n` +
                            (dirtyCount
                                ? `   ⚠ ${dirtyCount} uncommitted change(s) in the worktree will be auto-committed before merge.\n`
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
                        const rm = git(["worktree", "remove", "--force", W], R)
                        if (!rm.ok) {
                            return (
                                `⚠ Merged "${branch}" into "${target}", but worktree removal failed: ${rm.stderr.trim()}\n` +
                                `Worktree left at ${W}; branch "${branch}" kept. Remove manually when ready.`
                            )
                        }
                    } else {
                        git(["worktree", "prune"], R)
                    }
                    git(["branch", "-d", branch], R)
                    if (boundSid && state.sessions[boundSid]) {
                        delete state.sessions[boundSid]
                        saveState(pid, state)
                    }
                    return (
                        `✅ Merged "${branch}" into "${target}" and cleaned up.\n` +
                        `   worktree removed: ${W}\n` +
                        `   branch deleted:   ${branch}\n` +
                        `   session unbound — file operations now target the repo root (${R}) again.`
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
            if (!binding) return
            applyInterception(toolName, args, binding.repoRoot, binding.path)
        },

        "experimental.chat.system.transform": async (input, output) => {
            if (!output || !Array.isArray(output.system)) return
            const sessionId = input?.sessionID
            if (!sessionId) return
            const binding = await resolveBinding(sessionId)
            if (!binding) return
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
        },
    }
}

export default WorktreePlugin
