import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    unlinkSync,
    lstatSync,
    statSync,
    copyFileSync,
    symlinkSync,
    readdirSync,
    appendFileSync,
} from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

export const IS_WIN = process.platform === "win32"
export const MAX_PARENT_DEPTH = 10
export const BRANCH_INVALID_CHARS = /[~^:?*[\]\\]/
export const SCHEMA_VERSION = 2

export interface GitResult {
    ok: boolean
    stdout: string
    stderr: string
}

export interface SessionBinding {
    branch: string
    path: string
    repoRoot: string
    title: string
    createdAt: string
    inherited?: boolean
    _state?: WorktreeState
}

export interface WorktreeState {
    schemaVersion?: number
    sessions: Record<string, SessionBinding>
}

export interface SyncConfig {
    copyFiles: string[]
    symlinkDirs: string[]
}

export interface HooksConfig {
    postCreate: string[]
    preDelete: string[]
}

export interface WorktreeConfig {
    branchPrefix: string
    baseBranch: string | null
    worktreeRoot: string | null
    protectedBranches: string[]
    sync: SyncConfig
    hooks: HooksConfig
    stateLocation: "external" | "git-common"
    strictWrites: boolean
    strictGitOps: boolean
    mainWriteWhitelist: string[]
    allowlistTtlMinutes: number
    sessionStartNudge: boolean
}

export interface MutableToolArgs {
    filePath?: string
    path?: string
    command?: string
    workdir?: string
    cwd?: string
    [key: string]: unknown
}

export interface DecisionResult {
    action: "allow" | "rewrite" | "deny"
    newTarget?: string
    reason?: string
    source?: string
}

export interface DecisionContext {
    isWrite: boolean
    toolName: string
    repoRoot: string
    worktreePath: string | null
    strictWrites?: boolean
    strictGitOps?: boolean
    whitelist?: string[]
    protectedBranches?: string[]
    allowlistMatcher?: (p: string) => boolean
}

export interface BashDecisionContext {
    command: string
    currentBranch: string
    protectedBranches: Set<string>
    hasBinding: boolean
    strictGitOps: boolean
}

export interface AllowlistEntry {
    path: string
    reason: string
    bySession?: string
    createdAt: string
    expiresAt?: string
}

export interface SearchPathResult {
    action: "inject" | "rewrite" | "allow"
    newPath?: string
}

export function getDefaultWorktreeRoot(): string {
    return (
        process.env.OC_WT_ROOT ||
        path.join(homedir(), ".local", "share", "opencode", "worktree")
    )
}

export function getStateDir(): string {
    return (
        process.env.OC_WT_STATE_DIR ||
        path.join(homedir(), ".local", "share", "opencode", "worktree-workflow")
    )
}

export function git(args: string[], cwd: string): GitResult {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (r.error) return { ok: false, stdout: "", stderr: String(r.error) }
    if (r.status !== 0) return { ok: false, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
    return { ok: true, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const projectIdCache = new Map<string, string>()

export function computeProjectId(repoRoot: string): string {
    if (projectIdCache.has(repoRoot)) return projectIdCache.get(repoRoot)!
    let id: string | null = null
    const r = git(["rev-list", "--max-parents=0", "--all"], repoRoot)
    if (r.ok) {
        const roots = r.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .sort()
        if (roots.length && /^[a-f0-9]{40}$/i.test(roots[0]!)) id = roots[0]
    }
    if (!id) id = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)
    projectIdCache.set(repoRoot, id)
    return id
}

export function norm(p: string): string {
    // Normalize backslashes to forward slashes BEFORE path.resolve(): on POSIX,
    // path.resolve treats "\" as a literal filename character (not a separator), so a
    // Windows-style path like "\tmp\wt" would be seen as relative and prepended with
    // cwd, then never match its forward-slash counterpart. Converting separators first
    // makes matching case-insensitive and cross-separator on every platform.
    return path.resolve(p.replace(/\\/g, "/")).replace(/\\/g, "/").toLowerCase()
}

export function isInside(p: string, base: string): boolean {
    const np = norm(p)
    const nb = norm(base)
    return np === nb || np.startsWith(nb + "/")
}

export function rewritesToWorktree(filePath: string, repoRoot: string, worktreePath: string): string {
    if (isInside(filePath, worktreePath)) return filePath
    if (!isInside(filePath, repoRoot)) return filePath
    const rel = path.relative(repoRoot, filePath)
    return path.join(worktreePath, rel)
}

export function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function repoRootRegex(repoRoot: string): RegExp {
    const fwd = norm(repoRoot)
    const back = fwd.replace(/\//g, "\\")
    return new RegExp(escapeRegex(fwd) + "|" + escapeRegex(back), "gi")
}

export function matchGlob(target: string, pattern: string): boolean {
    let re = ""
    let i = 0
    while (i < pattern.length) {
        const c = pattern[i]
        if (c === "*") {
            if (pattern[i + 1] === "*") {
                re += ".*"
                i += 2
                if (pattern[i] === "/" || pattern[i] === "\\") i++
            } else {
                re += "[^/\\\\]*"
                i++
            }
        } else if (c === "?") {
            re += "[^/\\\\]"
            i++
        } else if (/[.+^${}()|[\]\\]/.test(c)) {
            re += "\\" + c
            i++
        } else {
            re += c
            i++
        }
    }
    try {
        return new RegExp(`^${re}$`).test(target)
    } catch {
        return false
    }
}

export function matchWhitelist(target: string, repoRoot: string, patterns: string[]): boolean {
    if (!patterns || patterns.length === 0) return false
    const nTarget = norm(target)
    const nRoot = norm(repoRoot)
    for (const p of patterns) {
        const absPattern = path.isAbsolute(p) ? norm(p) : norm(path.join(nRoot, p))
        if (matchGlob(nTarget, absPattern)) return true
    }
    return false
}

export function validateWhitelist(patterns: string[]): { valid: string[]; dangerous: string[] } {
    const dangerous: string[] = []
    const valid: string[] = []
    for (const p of patterns) {
        const trimmed = p.trim()
        const slashStripped = trimmed.replace(/[/\\]/g, "")
        if (["", ".", "/", "*", "**", "./", ".\\"].includes(trimmed) ||
            [".git", "git", ""].includes(slashStripped) ||
            slashStripped === "*") {
            dangerous.push(trimmed)
        } else if (trimmed.includes(".git")) {
            dangerous.push(trimmed)
        } else {
            valid.push(trimmed)
        }
    }
    return { valid, dangerous }
}

export function defaultBaseBranch(repoRoot: string): string | null {
    const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot)
    if (r.ok) {
        const m = r.stdout.trim().match(/^origin\/(.+)$/)
        if (m) return m[1]!
    }
    const head = git(["symbolic-ref", "--short", "HEAD"], repoRoot)
    return head.ok ? head.stdout.trim() : null
}

export function validateBranch(name: string): string {
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

export function slugify(title: string): string {
    return (
        title
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "task"
    )
}

export function loadConfig(repoRoot: string): WorktreeConfig {
    const cfg: WorktreeConfig = {
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
    }
    const p = path.join(repoRoot, ".opencode", "worktree-workflow.json")
    if (!existsSync(p)) return cfg
    try {
        const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<WorktreeConfig>
        const rawWhitelist = Array.isArray(parsed.mainWriteWhitelist) ? parsed.mainWriteWhitelist : []
        const { valid, dangerous } = validateWhitelist(rawWhitelist)
        if (dangerous.length > 0) {
            process.stderr.write(
                `[worktree] WARNING: dropping dangerous mainWriteWhitelist patterns (would disable protection): ${dangerous.join(", ")}\n`,
            )
        }
        const merged: WorktreeConfig = {
            branchPrefix: parsed.branchPrefix ?? cfg.branchPrefix,
            baseBranch: parsed.baseBranch !== undefined ? parsed.baseBranch : cfg.baseBranch,
            worktreeRoot: parsed.worktreeRoot !== undefined ? parsed.worktreeRoot : cfg.worktreeRoot,
            protectedBranches: parsed.protectedBranches ?? cfg.protectedBranches,
            sync: { copyFiles: parsed.sync?.copyFiles ?? cfg.sync.copyFiles, symlinkDirs: parsed.sync?.symlinkDirs ?? cfg.sync.symlinkDirs },
            hooks: { postCreate: parsed.hooks?.postCreate ?? cfg.hooks.postCreate, preDelete: parsed.hooks?.preDelete ?? cfg.hooks.preDelete },
            stateLocation: parsed.stateLocation ?? cfg.stateLocation,
            strictWrites: parsed.strictWrites ?? cfg.strictWrites,
            strictGitOps: parsed.strictGitOps ?? cfg.strictGitOps,
            mainWriteWhitelist: valid,
            allowlistTtlMinutes: parsed.allowlistTtlMinutes ?? cfg.allowlistTtlMinutes,
            sessionStartNudge: parsed.sessionStartNudge ?? cfg.sessionStartNudge,
        }
        return merged
    } catch {
        return cfg
    }
}

export function resolveWorktreeRoot(raw: string | null | undefined, repoRoot: string): string {
    return raw
        ? raw
              .replace(/\$REPO/g, repoRoot)
              .replace(/\$HOME/g, homedir())
              .replace(/^~(?=$|[\\/])/, homedir())
        : getDefaultWorktreeRoot()
}

export function runHookCommands(commands: string[], cwd: string): void {
    for (const cmd of commands) {
        if (IS_WIN) spawnSync("cmd", ["/d", "/c", cmd], { cwd, stdio: "ignore" })
        else spawnSync("bash", ["-c", cmd], { cwd, stdio: "ignore" })
    }
}

export function stateFilePath(projectId: string): string {
    return path.join(getStateDir(), `${projectId}.json`)
}

export function safeReadJson<T>(filePath: string): T | null {
    try {
        if (!existsSync(filePath)) return null
        return JSON.parse(readFileSync(filePath, "utf8")) as T
    } catch {
        return null
    }
}

export function ensureMeta(stateDir: string): void {
    const metaFile = path.join(stateDir, "meta.json")
    const existing = safeReadJson<{ schemaVersion?: number }>(metaFile)
    if (!existing || existing.schemaVersion !== SCHEMA_VERSION) {
        atomicWriteFileSync(
            metaFile,
            JSON.stringify(
                {
                    schemaVersion: SCHEMA_VERSION,
                    updatedAt: new Date().toISOString(),
                },
                null,
                2,
            ),
        )
    }
}

export function loadState(projectId: string): WorktreeState {
    const p = stateFilePath(projectId)
    if (!existsSync(p)) return { sessions: {} }
    try {
        const parsed = JSON.parse(readFileSync(p, "utf8")) as WorktreeState
        if (!parsed.sessions || typeof parsed.sessions !== "object") parsed.sessions = {}
        const expected = SCHEMA_VERSION
        const actual = parsed.schemaVersion
        if (actual === undefined || actual !== expected) {
            process.stderr.write(
                `[worktree] state schema version missing or outdated (current: ${expected}, found: ${actual ?? "missing"}). Will upgrade on next save.\n`,
            )
        }
        return parsed
    } catch {
        return { sessions: {} }
    }
}

export function saveState(projectId: string, state: WorktreeState): void {
    state.schemaVersion = SCHEMA_VERSION
    mkdirSync(getStateDir(), { recursive: true })
    atomicWriteFileSync(stateFilePath(projectId), JSON.stringify(state, null, 2))
}

export function findSessionsForWorktree(
    state: WorktreeState,
    worktreePath: string,
    excludeSessionId?: string,
): string[] {
    const nWt = norm(worktreePath)
    return Object.entries(state.sessions)
        .filter(([sid, b]) => sid !== excludeSessionId && norm(b.path) === nWt)
        .map(([sid]) => sid)
}

export function removeSyncedLinks(worktreePath: string, symlinkDirs: string[]): void {
    for (const d of symlinkDirs || []) {
        const linkPath = path.join(worktreePath, d)
        if (!existsSync(linkPath)) continue
        try {
            const st = lstatSync(linkPath)
            if (st.isSymbolicLink()) {
                unlinkSync(linkPath)
            }
        } catch {
            // 静默：linkPath 不是 symlink 或已不存在，让 git worktree remove 处理
        }
    }
}

export function atomicWriteFileSync(filePath: string, data: string): void {
    const dir = path.dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`)
    writeFileSync(tmp, data, "utf8")
    try {
        renameSync(tmp, filePath)
    } catch {
        try {
            unlinkSync(tmp)
        } catch {}
        writeFileSync(filePath, data, "utf8")
    }
}

export function decidePathAction(target: string, ctx: DecisionContext): DecisionResult {
    if (norm(target).includes("/.git")) {
        return { action: "deny", reason: `[worktree] access to .git paths is blocked: ${target}` }
    }

    const nTarget = norm(target)
    const nRoot = norm(ctx.repoRoot)

    if (ctx.worktreePath) {
        if (isInside(nTarget, ctx.worktreePath)) {
            return { action: "allow", source: "inside-worktree" }
        }
        if (isInside(nTarget, nRoot)) {
            const rel = path.relative(ctx.repoRoot, target)
            return {
                action: "rewrite",
                newTarget: path.join(ctx.worktreePath, rel),
                source: "rewrite",
            }
        }
        return { action: "allow", source: "outside-repo" }
    }

    if (!isInside(nTarget, nRoot)) {
        return { action: "allow", source: "outside-repo" }
    }

    if (ctx.allowlistMatcher?.(target)) {
        return { action: "allow", source: "allowlist" }
    }
    if (ctx.whitelist && ctx.whitelist.length > 0 && matchWhitelist(target, ctx.repoRoot, ctx.whitelist)) {
        return { action: "allow", source: "whitelist" }
    }
    if (ctx.strictWrites && ctx.isWrite) {
        return {
            action: "deny",
            reason:
                `[worktree] no active worktree binding; writing to the main checkout is blocked in strictWrites mode. ` +
                `Prepare a worktree first (worktree_prepare), add the path to mainWriteWhitelist, ` +
                `or use worktree_allow to grant a temporary exemption.`,
        }
    }
    return { action: "allow", source: "no-binding-free" }
}

export function decideSearchPathAction(
    p: string | undefined,
    repoRoot: string,
    worktreePath: string,
): SearchPathResult {
    if (!p) return { action: "inject", newPath: worktreePath }
    if (norm(p).includes("/.git")) {
        return { action: "allow" }
    }
    if (isInside(p, worktreePath)) return { action: "allow" }
    if (isInside(p, repoRoot)) {
        const rel = path.relative(repoRoot, p)
        return { action: "rewrite", newPath: path.join(worktreePath, rel) }
    }
    return { action: "allow" }
}

const GIT_PREFIX = String.raw`\bgit\s+(?:(?:-C|-c)\s+\S+\s+)*`
const GIT_MUTATE_RE = new RegExp(GIT_PREFIX + String.raw`(merge|rebase|pull)\b`, "i")
const GIT_PUSH_PROTECTED_RE = /\bgit\s+push\b.*\b(master|main)\b/i
const GIT_PUSH_DEFAULT_RE = /^\s*git\s+push\s*$/i
const GIT_CHECKOUT_RE = new RegExp(
    GIT_PREFIX + String.raw`(checkout|switch)\s+([^\s;|&"'<>()-][^\s;|&"'<>()]*)`,
    "i",
)
const GIT_DEL_BRANCH_RE = new RegExp(
    String.raw`\bgit\s+branch\s+(-[dD])\s+([^\s;|&"'<>()]+)\b`,
    "i",
)

export function decideBashAction(ctx: BashDecisionContext): DecisionResult {
    if (!ctx.strictGitOps) return { action: "allow", source: "strictGitOps-off" }

    const branchL = ctx.currentBranch.toLowerCase()
    const cmd = ctx.command

    if (GIT_PUSH_PROTECTED_RE.test(cmd) ||
        (GIT_PUSH_DEFAULT_RE.test(cmd) && ctx.protectedBranches.has(branchL))) {
        return {
            action: "deny",
            reason: `[worktree] git push to protected branch (${ctx.currentBranch}) is blocked in strictGitOps mode.`,
        }
    }

    if (GIT_MUTATE_RE.test(cmd) && ctx.protectedBranches.has(branchL)) {
        return {
            action: "deny",
            reason: `[worktree] merge/rebase/pull on protected branch (${ctx.currentBranch}) is blocked in strictGitOps mode.`,
        }
    }

    if (ctx.hasBinding) {
        const m = GIT_CHECKOUT_RE.exec(cmd)
        if (m && ctx.protectedBranches.has(m[2].toLowerCase())) {
            return {
                action: "deny",
                reason: `[worktree] git checkout/switch to protected branch (${m[2]}) is blocked while a worktree is bound.`,
            }
        }
    }

    const delM = GIT_DEL_BRANCH_RE.exec(cmd)
    if (delM) {
        return {
            action: "deny",
            reason: `[worktree] git branch -d/-D is blocked in strictGitOps mode (use worktree_cleanup instead).`,
        }
    }

    return { action: "allow", source: "bash-no-violation" }
}

const branchCache = new Map<string, string>()

export function currentBranch(repoRoot: string): string {
    if (branchCache.has(repoRoot)) return branchCache.get(repoRoot)!
    const r = git(["symbolic-ref", "--short", "HEAD"], repoRoot)
    const branch = r.ok ? r.stdout.trim() : "(detached HEAD)"
    branchCache.set(repoRoot, branch)
    return branch
}

export function applyInterception(
    toolName: string,
    args: MutableToolArgs,
    ctx: DecisionContext,
): void {
    const repoRoot = ctx.repoRoot
    const worktreePath = ctx.worktreePath ?? ""
    switch (toolName) {
        case "write":
        case "edit":
        case "read": {
            const fp = args.filePath
            if (typeof fp !== "string") return
            const result = decidePathAction(fp, ctx)
            if (result.action === "deny") throw new Error(result.reason)
            if (result.action === "rewrite" && result.newTarget) args.filePath = result.newTarget
            return
        }
        case "glob":
        case "grep": {
            const p = args.path
            if (typeof p === "string" && norm(p).includes("/.git")) {
                throw new Error(`[worktree] access to .git paths is blocked: ${p}`)
            }
            if (!worktreePath) return
            const result = decideSearchPathAction(p, repoRoot, worktreePath)
            if (result.action === "inject" && result.newPath) args.path = result.newPath
            else if (result.action === "rewrite" && result.newPath) args.path = result.newPath
            return
        }
        case "bash": {
            if (worktreePath) {
                if (args.workdir === undefined && args.cwd === undefined) {
                    args.workdir = worktreePath
                }
                const cmd = args.command
                if (typeof cmd === "string") {
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
                }
            }
            if (ctx.strictGitOps) {
                const branch = currentBranch(repoRoot)
                const protectedSet = new Set(
                    (ctx.protectedBranches ?? []).map((b) => b.toLowerCase()),
                )
                const bashResult = decideBashAction({
                    command: typeof args.command === "string" ? args.command : "",
                    currentBranch: branch,
                    protectedBranches: protectedSet,
                    hasBinding: !!ctx.worktreePath,
                    strictGitOps: true,
                })
                if (bashResult.action === "deny") throw new Error(bashResult.reason)
            }
            return
        }
        default:
            return
    }
}

export { statSync, copyFileSync, symlinkSync, existsSync, mkdirSync }

export interface StateBackend {
    loadBinding(sessionId: string): SessionBinding | null
    saveBinding(sessionId: string, binding: SessionBinding): void
    clearBinding(sessionId: string): void
    listBindings(): Array<{ sessionId: string; binding: SessionBinding }>
    findSessionsForWorktree(worktreePath: string, excludeSessionId?: string): string[]
    loadAll(): WorktreeState
    loadAllowlist(): AllowlistEntry[]
    saveAllowlist(entries: AllowlistEntry[]): void
    appendAudit(entry: Record<string, unknown>): void
}

export class ExternalStateBackend implements StateBackend {
    private readonly projectId: string

    constructor(repoRoot: string) {
        this.projectId = computeProjectId(repoRoot)
    }

    loadBinding(sessionId: string): SessionBinding | null {
        const s = loadState(this.projectId).sessions[sessionId]
        return s ?? null
    }

    saveBinding(sessionId: string, binding: SessionBinding): void {
        const state = loadState(this.projectId)
        state.sessions[sessionId] = binding
        saveState(this.projectId, state)
    }

    clearBinding(sessionId: string): void {
        const state = loadState(this.projectId)
        if (Object.prototype.hasOwnProperty.call(state.sessions, sessionId)) {
            delete state.sessions[sessionId]
            saveState(this.projectId, state)
        }
    }

    listBindings(): Array<{ sessionId: string; binding: SessionBinding }> {
        return Object.entries(loadState(this.projectId).sessions).map(([sessionId, binding]) => ({
            sessionId,
            binding,
        }))
    }

    findSessionsForWorktree(worktreePath: string, excludeSessionId?: string): string[] {
        return findSessionsForWorktree(loadState(this.projectId), worktreePath, excludeSessionId)
    }

    loadAll(): WorktreeState {
        return loadState(this.projectId)
    }

    private allowlistFile(): string {
        return path.join(getStateDir(), `${this.projectId}.allowlist.json`)
    }

    private auditFile(): string {
        return path.join(getStateDir(), `${this.projectId}.audit.jsonl`)
    }

    loadAllowlist(): AllowlistEntry[] {
        const f = this.allowlistFile()
        if (!existsSync(f)) return []
        try {
            const raw = JSON.parse(readFileSync(f, "utf8")) as { paths?: AllowlistEntry[] }
            const entries = Array.isArray(raw.paths) ? raw.paths : []
            return gcAllowlist(entries, (fresh) => this.saveAllowlist(fresh))
        } catch {
            return []
        }
    }

    saveAllowlist(entries: AllowlistEntry[]): void {
        atomicWriteFileSync(this.allowlistFile(), JSON.stringify({ paths: entries }, null, 2))
    }

    appendAudit(entry: Record<string, unknown>): void {
        mkdirSync(getStateDir(), { recursive: true })
        appendFileSync(this.auditFile(), JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n", "utf8")
    }
}

function safeFileName(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]/g, "-")
}

export class GitCommonStateBackend implements StateBackend {
    private readonly baseDir: string

    constructor(repoRoot: string) {
        const r = git(["rev-parse", "--git-common-dir"], repoRoot)
        if (!r.ok || !r.stdout.trim()) {
            throw new Error(
                `[worktree] Cannot resolve git-common-dir under "${repoRoot}": ${(r.stderr || r.stdout).trim() || "git rev-parse failed"}. ` +
                    `Set "stateLocation": "external" in .opencode/worktree-workflow.json to fall back to the external state directory.`,
            )
        }
        const common = path.resolve(repoRoot, r.stdout.trim())
        this.baseDir = path.join(common, "worktree-isolation")
        ensureMeta(this.baseDir)
    }

    private bindingFile(sessionId: string): string {
        return path.join(this.baseDir, "bindings", `${safeFileName(sessionId)}.json`)
    }

    loadBinding(sessionId: string): SessionBinding | null {
        const f = this.bindingFile(sessionId)
        if (!existsSync(f)) return null
        try {
            return JSON.parse(readFileSync(f, "utf8")) as SessionBinding
        } catch {
            return null
        }
    }

    saveBinding(sessionId: string, binding: SessionBinding): void {
        atomicWriteFileSync(this.bindingFile(sessionId), JSON.stringify(binding, null, 2))
    }

    clearBinding(sessionId: string): void {
        const f = this.bindingFile(sessionId)
        if (existsSync(f)) unlinkSync(f)
    }

    listBindings(): Array<{ sessionId: string; binding: SessionBinding }> {
        const dir = path.join(this.baseDir, "bindings")
        if (!existsSync(dir)) return []
        const result: Array<{ sessionId: string; binding: SessionBinding }> = []
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".json")) continue
            const sessionId = f.replace(/\.json$/, "")
            try {
                const binding = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as SessionBinding
                result.push({ sessionId, binding })
            } catch {
                continue
            }
        }
        return result
    }

    findSessionsForWorktree(worktreePath: string, excludeSessionId?: string): string[] {
        const nWt = norm(worktreePath)
        return this.listBindings()
            .filter(({ sessionId, binding }) => sessionId !== excludeSessionId && norm(binding.path) === nWt)
            .map(({ sessionId }) => sessionId)
    }

    loadAll(): WorktreeState {
        const sessions: Record<string, SessionBinding> = {}
        for (const { sessionId, binding } of this.listBindings()) {
            sessions[sessionId] = binding
        }
        return { sessions }
    }

    private allowlistFile(): string {
        return path.join(this.baseDir, "allowlist.json")
    }

    private auditFile(): string {
        return path.join(this.baseDir, "audit.jsonl")
    }

    loadAllowlist(): AllowlistEntry[] {
        const f = this.allowlistFile()
        if (!existsSync(f)) return []
        try {
            const raw = JSON.parse(readFileSync(f, "utf8")) as { paths?: AllowlistEntry[] }
            const entries = Array.isArray(raw.paths) ? raw.paths : []
            return gcAllowlist(entries, (fresh) => this.saveAllowlist(fresh))
        } catch {
            return []
        }
    }

    saveAllowlist(entries: AllowlistEntry[]): void {
        atomicWriteFileSync(this.allowlistFile(), JSON.stringify({ paths: entries }, null, 2))
    }

    appendAudit(entry: Record<string, unknown>): void {
        mkdirSync(this.baseDir, { recursive: true })
        appendFileSync(this.auditFile(), JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n", "utf8")
    }
}

export function gcAllowlist(
    entries: AllowlistEntry[],
    saveIfChanged: (fresh: AllowlistEntry[]) => void,
): AllowlistEntry[] {
    const now = Date.now()
    const fresh = entries.filter(
        (e) => !e.expiresAt || new Date(e.expiresAt).getTime() >= now,
    )
    if (fresh.length !== entries.length) {
        saveIfChanged(fresh)
    }
    return fresh
}

export function isAllowlisted(
    target: string,
    repoRoot: string,
    entries: AllowlistEntry[],
): boolean {
    if (!entries || entries.length === 0) return false
    const now = Date.now()
    const nTarget = norm(target)
    const nRoot = norm(repoRoot)
    for (const entry of entries) {
        if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) continue
        const ep = entry.path
        const absPattern = path.isAbsolute(ep) ? norm(ep) : norm(path.join(nRoot, ep))
        if (matchGlob(nTarget, absPattern)) return true
    }
    return false
}

export function makeAllowlistMatcher(
    entries: AllowlistEntry[],
    repoRoot: string,
): (p: string) => boolean {
    return (p: string) => isAllowlisted(p, repoRoot, entries)
}

export function createStateBackend(repoRoot: string, cfg: WorktreeConfig): StateBackend {
    if (cfg.stateLocation === "git-common") {
        return new GitCommonStateBackend(repoRoot)
    }
    return new ExternalStateBackend(repoRoot)
}
