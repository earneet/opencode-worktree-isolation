import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    statSync,
    copyFileSync,
    symlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"
import { tool } from "@opencode-ai/plugin"

const z = tool.schema

const IS_WIN = process.platform === "win32"
const DEFAULT_WORKTREE_ROOT = path.join(homedir(), ".local", "share", "opencode", "worktree")
const STATE_DIR = path.join(homedir(), ".local", "share", "opencode", "worktree-workflow")
const MAX_PARENT_DEPTH = 10
const BRANCH_INVALID_CHARS = /[~^:?*[\]\\]/

function git(args, cwd) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (r.error) return { ok: false, stdout: "", stderr: String(r.error) }
    if (r.status !== 0) return { ok: false, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
    return { ok: true, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const projectIdCache = new Map()
function computeProjectId(repoRoot) {
    if (projectIdCache.has(repoRoot)) return projectIdCache.get(repoRoot)
    let id = null
    const r = git(["rev-list", "--max-parents=0", "--all"], repoRoot)
    if (r.ok) {
        const roots = r.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .sort()
        if (roots.length && /^[a-f0-9]{40}$/i.test(roots[0])) id = roots[0]
    }
    if (!id) id = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)
    projectIdCache.set(repoRoot, id)
    return id
}

function norm(p) {
    return path.resolve(p).replace(/\\/g, "/").toLowerCase()
}
function isInside(p, base) {
    const np = norm(p)
    const nb = norm(base)
    return np === nb || np.startsWith(nb + "/")
}
function rewritesToWorktree(filePath, repoRoot, worktreePath) {
    if (isInside(filePath, worktreePath)) return filePath
    if (!isInside(filePath, repoRoot)) return filePath
    const rel = path.relative(repoRoot, filePath)
    return path.join(worktreePath, rel)
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
function repoRootRegex(repoRoot) {
    const fwd = norm(repoRoot)
    const back = fwd.replace(/\//g, "\\\\")
    return new RegExp(escapeRegex(fwd) + "|" + escapeRegex(back), "gi")
}
function defaultBaseBranch(repoRoot) {
    const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot)
    if (r.ok) {
        const m = r.stdout.trim().match(/^origin\/(.+)$/)
        if (m) return m[1]
    }
    const head = git(["symbolic-ref", "--short", "HEAD"], repoRoot)
    return head.ok ? head.stdout.trim() : null
}
function validateBranch(name) {
    if (!name || typeof name !== "string") throw new Error("branch name is required")
    if (name.length > 255) throw new Error("branch name too long")
    if (name.startsWith("-")) throw new Error("branch cannot start with '-'")
    if (name.startsWith("/") || name.endsWith("/")) throw new Error("branch cannot start or end with '/'")
    if (name.includes("//")) throw new Error("branch cannot contain '//'")
    if (name.includes("..")) throw new Error("branch cannot contain '..'")
    if (name.includes("@{")) throw new Error("branch cannot contain '@{'")
    if (name.endsWith(".lock")) throw new Error("branch cannot end with '.lock'")
    if (BRANCH_INVALID_CHARS.test(name)) throw new Error("branch contains invalid characters")
    if (/[\x00-\x1f\x7f]/.test(name)) throw new Error("branch contains control characters")
    if (name.includes(" ")) throw new Error("branch cannot contain spaces")
    return name
}
function slugify(title) {
    return (
        title
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "task"
    )
}
function loadConfig(repoRoot) {
    const cfg = {
        branchPrefix: "wt/",
        baseBranch: null,
        worktreeRoot: null,
        protectedBranches: [],
        sync: { copyFiles: [], symlinkDirs: [] },
        hooks: { postCreate: [], preDelete: [] },
    }
    const p = path.join(repoRoot, ".opencode", "worktree-workflow.json")
    if (!existsSync(p)) return cfg
    try {
        const parsed = JSON.parse(readFileSync(p, "utf8"))
        return {
            ...cfg,
            ...parsed,
            sync: { ...cfg.sync, ...(parsed.sync || {}) },
            hooks: { ...cfg.hooks, ...(parsed.hooks || {}) },
        }
    } catch {
        return cfg
    }
}
function resolveWorktreeRoot(raw, repoRoot) {
    return raw
        ? raw
              .replace(/\$REPO/g, repoRoot)
              .replace(/\$HOME/g, homedir())
              .replace(/^~(?=$|[\\/])/, homedir())
        : DEFAULT_WORKTREE_ROOT
}
function runHookCommands(commands, cwd) {
    for (const cmd of commands) {
        if (IS_WIN) spawnSync("cmd", ["/d", "/c", cmd], { cwd, stdio: "ignore" })
        else spawnSync("bash", ["-c", cmd], { cwd, stdio: "ignore" })
    }
}
function stateFilePath(projectId) {
    return path.join(STATE_DIR, `${projectId}.json`)
}
function loadState(projectId) {
    const p = stateFilePath(projectId)
    if (!existsSync(p)) return { sessions: {} }
    try {
        const parsed = JSON.parse(readFileSync(p, "utf8"))
        if (!parsed.sessions || typeof parsed.sessions !== "object") parsed.sessions = {}
        return parsed
    } catch {
        return { sessions: {} }
    }
}
function saveState(projectId, state) {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(stateFilePath(projectId), JSON.stringify(state, null, 2))
}

const WorktreePlugin = async (ctx) => {
    const repoRoot = ctx.directory
    const client = ctx.client
    let pidCache = null
    const getPid = () => (pidCache ??= computeProjectId(repoRoot))

    const inheritCache = new Map()
    async function resolveBinding(sessionId) {
        if (!sessionId) return null
        const state = loadState(getPid())
        if (state.sessions[sessionId]) return { ...state.sessions[sessionId], _state: state }
        if (inheritCache.has(sessionId)) return inheritCache.get(sessionId)
        let current = sessionId
        let found = null
        for (let i = 0; i < MAX_PARENT_DEPTH; i++) {
            let parentId
            try {
                const res = await client.session.get({ path: { id: current } })
                parentId = res.data?.parentID
            } catch {
                break
            }
            if (!parentId) break
            if (state.sessions[parentId]) {
                found = state.sessions[parentId]
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
            const result = { ...state2.sessions[sessionId], _state: state2 }
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
                    let branch
                    try {
                        branch = args.branch
                            ? validateBranch(args.branch)
                            : validateBranch((cfg.branchPrefix || "wt/") + slugify(title))
                    } catch (e) {
                        return `❌ ${e.message}`
                    }
                    const base = args.baseBranch || cfg.baseBranch || defaultBaseBranch(R)
                    const wRoot = resolveWorktreeRoot(cfg.worktreeRoot, R)
                    const W = path.join(wRoot, pid, branch.replace(/\//g, path.sep))
                    const existsAlready = git(["rev-parse", "--verify", branch], R).ok
                    const addArgs = existsAlready
                        ? ["worktree", "add", W, branch]
                        : ["worktree", "add", "-b", branch, W, base].filter((x) => x !== null && x !== undefined)
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
                    const removed = []
                    const skipped = []
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
        },

        "tool.execute.before": async (input, output) => {
            const sessionId = input?.sessionID
            const toolName = input?.tool
            if (!sessionId || !output || typeof toolName !== "string") return
            if (toolName.startsWith("worktree_")) return
            const args = output.args
            if (!args || typeof args !== "object") return
            const binding = await resolveBinding(sessionId)
            if (!binding) return
            const R = binding.repoRoot
            const W = binding.path
            try {
                switch (toolName) {
                    case "write":
                    case "edit":
                    case "read": {
                        const fp = args.filePath
                        if (typeof fp !== "string") return
                        if (norm(fp).includes("/.git")) {
                            throw new Error(`[worktree] access to .git paths is blocked: ${fp}`)
                        }
                        const rewritten = rewritesToWorktree(fp, R, W)
                        if (rewritten !== fp) args.filePath = rewritten
                        return
                    }
                    case "glob":
                    case "grep": {
                        const p = args.path
                        if (!p || typeof p !== "string") {
                            args.path = W
                            return
                        }
                        if (norm(p).includes("/.git")) {
                            throw new Error(`[worktree] access to .git paths is blocked: ${p}`)
                        }
                        const rewritten = rewritesToWorktree(p, R, W)
                        if (rewritten !== p) args.path = rewritten
                        return
                    }
                    case "bash": {
                        if (args.workdir === undefined && args.cwd === undefined) {
                            args.workdir = W
                        }
                        const cmd = args.command
                        if (typeof cmd !== "string") return
                        if (repoRootRegex(R).test(cmd)) {
                            args.command = cmd.replace(repoRootRegex(R), () => W)
                            if (repoRootRegex(R).test(args.command)) {
                                throw new Error(
                                    `[worktree] bash command references the repo root in a form that cannot be ` +
                                        `safely rewritten to the worktree. Refactor the command to avoid the ` +
                                        `absolute repo path: ${args.command}`,
                                )
                            }
                        }
                        return
                    }
                    default:
                        return
                }
            } catch (e) {
                throw e
            }
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
