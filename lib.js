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

export const IS_WIN = process.platform === "win32"
export const MAX_PARENT_DEPTH = 10
export const BRANCH_INVALID_CHARS = /[~^:?*[\]\\]/

export function getDefaultWorktreeRoot() {
    return (
        process.env.OC_WT_ROOT ||
        path.join(homedir(), ".local", "share", "opencode", "worktree")
    )
}
export function getStateDir() {
    return (
        process.env.OC_WT_STATE_DIR ||
        path.join(homedir(), ".local", "share", "opencode", "worktree-workflow")
    )
}

export function git(args, cwd) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (r.error) return { ok: false, stdout: "", stderr: String(r.error) }
    if (r.status !== 0) return { ok: false, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
    return { ok: true, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const projectIdCache = new Map()
export function computeProjectId(repoRoot) {
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

export function norm(p) {
    return path.resolve(p).replace(/\\/g, "/").toLowerCase()
}
export function isInside(p, base) {
    const np = norm(p)
    const nb = norm(base)
    return np === nb || np.startsWith(nb + "/")
}
export function rewritesToWorktree(filePath, repoRoot, worktreePath) {
    if (isInside(filePath, worktreePath)) return filePath
    if (!isInside(filePath, repoRoot)) return filePath
    const rel = path.relative(repoRoot, filePath)
    return path.join(worktreePath, rel)
}
export function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
export function repoRootRegex(repoRoot) {
    const fwd = norm(repoRoot)
    const back = fwd.replace(/\//g, "\\")
    return new RegExp(escapeRegex(fwd) + "|" + escapeRegex(back), "gi")
}
export function defaultBaseBranch(repoRoot) {
    const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot)
    if (r.ok) {
        const m = r.stdout.trim().match(/^origin\/(.+)$/)
        if (m) return m[1]
    }
    const head = git(["symbolic-ref", "--short", "HEAD"], repoRoot)
    return head.ok ? head.stdout.trim() : null
}
export function validateBranch(name) {
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
export function slugify(title) {
    return (
        title
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "task"
    )
}
export function loadConfig(repoRoot) {
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
export function resolveWorktreeRoot(raw, repoRoot) {
    return raw
        ? raw
              .replace(/\$REPO/g, repoRoot)
              .replace(/\$HOME/g, homedir())
              .replace(/^~(?=$|[\\/])/, homedir())
        : getDefaultWorktreeRoot()
}
export function runHookCommands(commands, cwd) {
    for (const cmd of commands) {
        if (IS_WIN) spawnSync("cmd", ["/d", "/c", cmd], { cwd, stdio: "ignore" })
        else spawnSync("bash", ["-c", cmd], { cwd, stdio: "ignore" })
    }
}
export function stateFilePath(projectId) {
    return path.join(getStateDir(), `${projectId}.json`)
}
export function loadState(projectId) {
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
export function saveState(projectId, state) {
    mkdirSync(getStateDir(), { recursive: true })
    writeFileSync(stateFilePath(projectId), JSON.stringify(state, null, 2))
}

export function applyInterception(toolName, args, repoRoot, worktreePath) {
    switch (toolName) {
        case "write":
        case "edit":
        case "read": {
            const fp = args.filePath
            if (typeof fp !== "string") return
            if (norm(fp).includes("/.git")) {
                throw new Error(`[worktree] access to .git paths is blocked: ${fp}`)
            }
            const rewritten = rewritesToWorktree(fp, repoRoot, worktreePath)
            if (rewritten !== fp) args.filePath = rewritten
            return
        }
        case "glob":
        case "grep": {
            const p = args.path
            if (!p || typeof p !== "string") {
                args.path = worktreePath
                return
            }
            if (norm(p).includes("/.git")) {
                throw new Error(`[worktree] access to .git paths is blocked: ${p}`)
            }
            const rewritten = rewritesToWorktree(p, repoRoot, worktreePath)
            if (rewritten !== p) args.path = rewritten
            return
        }
        case "bash": {
            if (args.workdir === undefined && args.cwd === undefined) {
                args.workdir = worktreePath
            }
            const cmd = args.command
            if (typeof cmd !== "string") return
            if (repoRootRegex(repoRoot).test(cmd)) {
                args.command = cmd.replace(repoRootRegex(repoRoot), () => worktreePath)
                if (repoRootRegex(repoRoot).test(args.command)) {
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
}

export { statSync, copyFileSync, symlinkSync, existsSync, mkdirSync }
