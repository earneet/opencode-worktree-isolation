# 实施计划：借鉴 zcode-worktree-guard 强化 opencode-worktree-isolation

> **任务来源**: 用户审查 opencode-worktree-isolation 后决定借鉴 zcode-worktree-guard 的多 session 安全机制、strict 模式、逃生口等设计，分三个 Tier 实施（详见决策记录）。本计划为实施前置交付物，需经 Momus 审查通过后方可进入编码。
> **任务内容**: 把对比文档（`docs/comparison-with-zcode.md`）中第 9 节的改造清单细化为可执行的 spec，覆盖 Tier 1/2/3 全部改动，包含每文件/函数/数据结构/配置项/测试/验证标准的精确定义。
> **参考文档**:
> - `F:\workspace_2\opencode-worktree-guard\docs\comparison-with-zcode.md` — 双项目对比与改造决策依据
> - `F:\workspace_2\opencode-worktree-guard\docs\design.md` — opencode 项目原始设计文档
> - `F:\workspace_2\zcode-worktree-plugin\plugins\zcode-worktree-guard\scripts\common.mjs` — zcode 状态管理参考实现
> - `F:\workspace_2\zcode-worktree-plugin\plugins\zcode-worktree-guard\scripts\guard_hook.mjs` — zcode 决策表参考实现
> **生成日期**: 2026-08-11
> **状态**: 待 Momus 审查

---

## 0. 决策记录

| 决策项 | 选择 | 理由 |
|---|---|---|
| 决策1：状态目录模式 | **A** — external 为默认，git-common 作为 opt-in | 不破坏现有用户行为；测试机制保持不变；重度并行用户可选 git-common |
| 决策2：strict 模式形态 | **B** — 分项配置（strictWrites / strictGitOps） | 用户可能只想要部分保护；单一开关颗粒度太粗阻碍采纳 |
| 决策3：改造范围 | **C** — Tier 1 + Tier 2 + Tier 3 全量 | 完整对齐 zcode 的多 session 安全机制 |

---

## 1. 设计原则

1. **向后兼容优先**：所有新行为默认关闭或保持现状，新增能力通过配置 opt-in
2. **渐进式抽象**：Tier 1 不引入新抽象，最小改动修 bug；Tier 2 再引入 `StateBackend` 抽象支持双模式
3. **TypeScript strict 不放松**：禁止 `as any` / `@ts-ignore`（项目硬约束）
4. **测试驱动**：每个改动必须有对应测试 case；lifecycle.test.js 端到端覆盖新功能
5. **配置 schema 单点定义**：所有新配置项集中在 `WorktreeConfig` interface，sidecar JSON 同步
6. **不重写、不优化无关代码**：仅改动可追溯到本计划的代码（外科手术式修改）

---

## 2. 数据结构变更总览

### 2.1 配置 schema 扩展（src/lib.ts）

```ts
export interface WorktreeConfig {
    // 现有字段（保持不变）
    branchPrefix: string
    baseBranch: string | null
    worktreeRoot: string | null
    protectedBranches: string[]
    sync: SyncConfig
    hooks: HooksConfig

    // 新增字段（全部带默认值，向后兼容）
    stateLocation: "external" | "git-common"          // 默认 "external"
    strictWrites: boolean                              // 默认 false
    strictGitOps: boolean                              // 默认 false
    mainWriteWhitelist: string[]                       // 默认 []
    allowlistTtlMinutes: number                        // 默认 60
    sessionStartNudge: boolean                         // 默认 false（仅 strict 模式启用时建议 true）
}
```

### 2.2 状态文件结构

**external 模式**（保持现状 + 加 schemaVersion）：
```json
{
    "schemaVersion": 2,
    "sessions": {
        "<sessionId>": { "branch", "path", "repoRoot", "title", "createdAt", "inherited" }
    }
}
```

**git-common 模式**（新增）：
```
<git-common-dir>/worktree-isolation/
    bindings/<sessionId>.json     每会话独立文件，内容 = SessionBinding + resolvedAt
    meta.json                     { "schemaVersion": 2, "updatedAt": "..." }
    allowlist.json                { "paths": [{ "path", "reason", "bySession", "createdAt", "expiresAt" }] }
    audit.jsonl                   每行一个 JSON（appendOnly）
```

### 2.3 新增接口与类型

```ts
// src/lib.ts 新增
export interface DecisionResult {
    action: "allow" | "rewrite" | "deny"
    newTarget?: string
    reason?: string
    source?: string
}

export interface AllowlistEntry {
    path: string
    reason: string
    bySession?: string
    createdAt: string
    expiresAt?: string
}

export const SCHEMA_VERSION = 2
```

---

## 3. Tier 1：纯 bugfix（必做，零破坏）

### T1.1 原子写状态文件

**目标**：消除 JS 异步事件交叉执行导致的 read-modify-write 竞态。

**改动文件**：`src/lib.ts`

**新增函数**：
```ts
export function atomicWriteFileSync(filePath: string, data: string): void {
    const dir = path.dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`)
    writeFileSync(tmp, data, "utf8")
    try {
        fs.renameSync(tmp, filePath)  // POSIX 原子；Windows 同卷基本原子
    } catch {
        try { fs.unlinkSync(tmp) } catch {}
        writeFileSync(filePath, data, "utf8")  // fallback（非原子但可用）
    }
}
```

**修改函数**：`saveState`（L229-232）
```ts
export function saveState(projectId: string, state: WorktreeState): void {
    if (!state.schemaVersion) state.schemaVersion = SCHEMA_VERSION
    atomicWriteFileSync(stateFilePath(projectId), JSON.stringify(state, null, 2))
}
```

**新增依赖**：在 lib.ts 顶部 import `renameSync`、`unlinkSync`（来自 `node:fs`）。

**测试**（`test/unit.test.js`）：
- `atomicWriteFileSync: writes file correctly`
- `atomicWriteFileSync: concurrent writes do not corrupt`（spawn 2 个子进程并发写，验证最终内容是其中一个完整版本，不是混合）

**验证标准**：
- npm test 通过
- `atomicWriteFileSync` 单元测试覆盖并发场景
- `saveState` 行为对调用方完全透明（函数签名不变）

---

### T1.2 多 session 悬空检查

**目标**：避免 cleanup/merge 误删仍被其他 session 引用的 worktree。

**改动文件**：`src/lib.ts`

**新增函数**：
```ts
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
```

**改动文件**：`src/index.ts`

**修改函数**：`worktree_cleanup` apply 分支（L222-259）

在每条匹配的 worktree 删除前插入悬空检查：
```ts
for (const [sid, b] of entries) {
    // ... 现有的 protected / branch filter / merged 检查 ...

    // 新增：悬空检查
    const otherSessions = findSessionsForWorktree(state, b.path, sid)
    if (otherSessions.length > 0) {
        skipped.push(`  ⚠ ${b.branch}: 仍被其他会话绑定 (${otherSessions.join(", ")})，跳过删除`)
        continue
    }

    runHookCommands(cfg.hooks.preDelete || [], b.path)
    // ... 现有的删除逻辑 ...
}
```

**修改函数**：`worktree_merge` apply 分支（L326-376）

在 `git worktree remove --force` 前插入悬空检查：
```ts
// 新增：悬空检查（merge 之前）
if (boundSid) {
    const otherSessions = findSessionsForWorktree(state, W, boundSid)
    if (otherSessions.length > 0) {
        return `❌ Worktree "${branch}" 仍被其他会话绑定 (${otherSessions.join(", ")})。\n` +
               `请让那些会话先退出（worktree_cleanup 仅清理本会话绑定），或手动确认后用 force。`
    }
}
```

**测试**（`test/lifecycle.test.js`）：
- 新增 case：`worktree_cleanup refuses to remove worktree still bound by another session`
- 新增 case：`worktree_merge refuses to merge worktree still bound by another session`
- 测试构造：prepare 一个 worktree，把 state.sessions 复制一份到另一个 sessionId，验证 cleanup/merge 拒绝执行

**验证标准**：
- 多 session 引用场景下 cleanup/merge 返回明确的错误信息
- 单 session 场景行为不变（向后兼容）
- 测试覆盖拒绝路径

---

### T1.3 决策表纯函数重构

**目标**：把 `applyInterception` 拆成纯决策 + 副作用应用两层，提升可测试性。

**改动文件**：`src/lib.ts`

**新增纯函数**：
```ts
export interface DecisionContext {
    isWrite: boolean
    toolName: string
    repoRoot: string
    worktreePath: string
}

export function decidePathAction(
    target: string,
    ctx: DecisionContext,
): DecisionResult {
    // 1. .git 保护（硬规则）
    if (norm(target).includes("/.git")) {
        return { action: "deny", reason: `[worktree] access to .git paths is blocked: ${target}` }
    }
    // 2. target 已在 worktree 内 → 放行
    if (isInside(target, ctx.worktreePath)) {
        return { action: "allow", source: "inside-worktree" }
    }
    // 3. target 在 repoRoot 内 → 重写到 worktree
    if (isInside(target, ctx.repoRoot)) {
        const rel = path.relative(ctx.repoRoot, target)
        return {
            action: "rewrite",
            newTarget: path.join(ctx.worktreePath, rel),
            source: "rewrite",
        }
    }
    // 4. target 在仓库外 → 放行
    return { action: "allow", source: "outside-repo" }
}

export function decideSearchPathAction(
    p: string | undefined,
    repoRoot: string,
    worktreePath: string,
): { action: "inject" | "rewrite" | "allow"; newPath?: string } {
    if (!p) return { action: "inject", newPath: worktreePath }
    if (norm(p).includes("/.git")) {
        // 沿用现有 throw 行为，本函数返回 deny 标记，由调用方 throw
        return { action: "allow" }  // 实际由调用方处理 .git 拦截
    }
    if (isInside(p, worktreePath)) return { action: "allow" }
    if (isInside(p, repoRoot)) {
        const rel = path.relative(repoRoot, p)
        return { action: "rewrite", newPath: path.join(worktreePath, rel) }
    }
    return { action: "allow" }
}
```

**重构函数**：`applyInterception`（L234-288）

```ts
export function applyInterception(
    toolName: string,
    args: MutableToolArgs,
    repoRoot: string,
    worktreePath: string,
): void {
    switch (toolName) {
        case "write":
        case "edit":
        case "read": {
            const fp = args.filePath
            if (typeof fp !== "string") return
            const result = decidePathAction(fp, { isWrite: toolName !== "read", toolName, repoRoot, worktreePath })
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
            const result = decideSearchPathAction(p, repoRoot, worktreePath)
            if (result.action === "inject" && result.newPath) args.path = result.newPath
            else if (result.action === "rewrite" && result.newPath) args.path = result.newPath
            return
        }
        case "bash": {
            // 保持现有逻辑不变（bash 决策涉及命令串字符串替换，T2.3 再扩展）
            // ...
        }
    }
}
```

**测试**（`test/unit.test.js`）：

新增一组决策表 case，每条规则独立：
```ts
describe("decidePathAction", () => {
    test("deny: target inside .git")
    test("allow: target inside worktree")
    test("rewrite: target inside repo root but outside worktree")
    test("allow: target outside repo")
    test("case-insensitive matching (Windows)")
})

describe("decideSearchPathAction", () => {
    test("inject: missing path")
    test("allow: path inside worktree")
    test("rewrite: path inside repo root")
    test("allow: path outside repo")
})
```

**验证标准**：
- `decidePathAction` / `decideSearchPathAction` 是纯函数（无 IO、无副作用）
- 现有 `applyInterception` 测试全部通过（行为不变）
- 新增决策表 case 覆盖每条规则

---

## 4. Tier 2：能力增强（opt-in）

### T2.1 状态目录可选 git-common 模式

**目标**：支持 `<git-common-dir>/worktree-isolation/` 作为状态目录，提供更天然的多 session 并行支持。

**改动文件**：`src/lib.ts`

**新增 `StateBackend` 接口与两个实现**：

```ts
export interface StateBackend {
    loadBinding(sessionId: string): SessionBinding | null
    saveBinding(sessionId: string, binding: SessionBinding): void
    clearBinding(sessionId: string): void
    listBindings(): Array<{ sessionId: string; binding: SessionBinding }>
    findSessionsForWorktree(worktreePath: string, excludeSessionId?: string): string[]
    loadAll(): WorktreeState  // 兼容旧调用方（preview 等）
}

export function createStateBackend(repoRoot: string, cfg: WorktreeConfig): StateBackend {
    if (cfg.stateLocation === "git-common") {
        return new GitCommonStateBackend(repoRoot)
    }
    return new ExternalStateBackend(repoRoot)
}
```

**ExternalStateBackend**：封装现有 `loadState` / `saveState` 逻辑（单文件模式），用 `atomicWriteFileSync` + `findSessionsForWorktree`（T1.1/T1.2 已加）。

**GitCommonStateBackend**：每session一文件模式
```ts
class GitCommonStateBackend implements StateBackend {
    private readonly baseDir: string  // <git-common-dir>/worktree-isolation/

    constructor(repoRoot: string) {
        const r = git(["rev-parse", "--git-common-dir"], repoRoot)
        if (!r.ok) throw new Error(`Cannot resolve git-common-dir: ${r.stderr}`)
        const common = path.resolve(repoRoot, r.stdout.trim())
        this.baseDir = path.join(common, "worktree-isolation")
    }

    private bindingFile(sessionId: string): string {
        const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-")
        return path.join(this.baseDir, "bindings", `${safe}.json`)
    }

    loadBinding(sessionId: string): SessionBinding | null {
        const f = this.bindingFile(sessionId)
        if (!existsSync(f)) return null
        try { return JSON.parse(readFileSync(f, "utf8")) } catch { return null }
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
        return readdirSync(dir)
            .filter(f => f.endsWith(".json"))
            .map(f => {
                const sessionId = f.replace(/\.json$/, "")
                const binding = this.loadBinding(sessionId)
                return binding ? { sessionId, binding } : null
            })
            .filter((x): x is { sessionId: string; binding: SessionBinding } => x !== null)
    }

    findSessionsForWorktree(worktreePath: string, excludeSessionId?: string): string[] {
        const nWt = norm(worktreePath)
        return this.listBindings()
            .filter(({ sessionId, binding }) =>
                sessionId !== excludeSessionId && norm(binding.path) === nWt)
            .map(({ sessionId }) => sessionId)
    }

    loadAll(): WorktreeState {
        // 把所有 bindings 合并成 WorktreeState 形态，兼容 preview 等调用方
        const sessions: Record<string, SessionBinding> = {}
        for (const { sessionId, binding } of this.listBindings()) {
            sessions[sessionId] = binding
        }
        return { schemaVersion: SCHEMA_VERSION, sessions }
    }
}
```

**改动文件**：`src/index.ts`

**重构点**：所有 `loadState(pid) / saveState(pid, state)` 调用改为通过 `stateBackend`。

在 `WorktreePlugin` 函数顶部创建 backend：
```ts
const WorktreePlugin: Plugin = async (ctx) => {
    const repoRoot = ctx.directory
    const client = ctx.client
    let pidCache: string | null = null
    const getPid = (): string => (pidCache ??= computeProjectId(repoRoot))

    // 新增：状态后端
    const cfg = loadConfig(repoRoot)
    const stateBackend = createStateBackend(repoRoot, cfg)

    // resolveBinding 改为通过 backend
    async function resolveBinding(sessionId: string) {
        if (!sessionId) return null
        const direct = stateBackend.loadBinding(sessionId)
        if (direct) return { ...direct, _state: stateBackend.loadAll() }
        // ... 现有 parent-chain 逻辑，但 saveBinding 改为 stateBackend.saveBinding
    }
    // ...
}
```

**注意**：external 模式下 `loadState(getPid())` 的调用全部替换为 `stateBackend.loadAll()`。`getPid()` 仅在 ExternalStateBackend 内部使用。

**测试**（`test/lifecycle.test.js`）：

新增 describe block "git-common state backend"：
- `git-common mode: prepare writes binding file under <git-common-dir>`
- `git-common mode: cleanup removes binding file`
- `git-common mode: multiple sessions get independent binding files`
- `git-common mode: findSessionsForWorktree detects cross-session reference`
- 通过 sidecar 配置 `stateLocation: "git-common"` 切换模式

**验证标准**：
- 默认 external 模式行为完全不变（lifecycle 现有 9 个 case 全过）
- git-common 模式新增 4+ case 通过
- 配置切换零代码改动（仅 sidecar JSON）

---

### T2.2 主分支写保护（strictWrites）

**目标**：opt-in 模式下，无 binding 时 Write/Edit 主 checkout → 拦截；Read 放行。

**改动文件**：`src/lib.ts`

**扩展 `decidePathAction`**：增加 `binding: SessionBinding | null` 和 `strictWrites: boolean` 入参

```ts
export interface DecisionContext {
    isWrite: boolean
    toolName: string
    repoRoot: string
    worktreePath: string | null  // 改为 nullable（无 binding 时为 null）
    strictWrites: boolean         // 新增
    whitelist?: string[]          // 新增（T2.4 用）
    allowlistMatcher?: (p: string) => boolean  // 新增（T2.4 用）
}

export function decidePathAction(target: string, ctx: DecisionContext): DecisionResult {
    // 1. .git 保护
    if (norm(target).includes("/.git")) {
        return { action: "deny", reason: `[worktree] access to .git paths is blocked: ${target}` }
    }

    const nTarget = norm(target)
    const nRoot = norm(ctx.repoRoot)

    // 2. 仓库外放行
    if (!isInside(nTarget, nRoot)) {
        return { action: "allow", source: "outside-repo" }
    }

    // 3. 有 binding 的情况
    if (ctx.worktreePath) {
        const nWt = norm(ctx.worktreePath)
        if (isInside(nTarget, nWt)) {
            return { action: "allow", source: "inside-worktree" }
        }
        // 重写到 worktree
        const rel = path.relative(ctx.repoRoot, target)
        return {
            action: "rewrite",
            newTarget: path.join(ctx.worktreePath, rel),
            source: "rewrite",
        }
    }

    // 4. 无 binding 的情况
    // 4a. 白名单放行（T2.4 引入后生效）
    if (ctx.allowlistMatcher?.(target)) {
        return { action: "allow", source: "allowlist" }
    }
    // 4b. strictWrites 模式 → Write/Edit deny, Read allow
    if (ctx.strictWrites && ctx.isWrite) {
        return {
            action: "deny",
            reason: `[worktree] no active worktree binding; writing to main checkout is blocked in strictWrites mode. ` +
                    `Prepare a worktree first (worktree_prepare), or add the path to mainWriteWhitelist.`,
        }
    }
    // 4c. 自由模式 → 放行
    return { action: "allow", source: "no-binding-free" }
}
```

**改动文件**：`src/index.ts`

**修改 `tool.execute.before` hook**（L380-390）：把决策上下文传入

```ts
"tool.execute.before": async (input, output) => {
    const sessionId = input?.sessionID
    const toolName = input?.tool
    if (!sessionId || !output || typeof toolName !== "string") return
    if (toolName.startsWith("worktree_")) return
    const args = output.args as MutableToolArgs
    if (!args || typeof args !== "object") return

    const binding = await resolveBinding(sessionId)
    const cfg = loadConfig(repoRoot)

    // 把 cfg.strictWrites / cfg.mainWriteWhitelist / allowlistMatcher 传入决策
    const ctx: DecisionContext = {
        isWrite: toolName === "write" || toolName === "edit",
        toolName,
        repoRoot: binding?.repoRoot ?? repoRoot,
        worktreePath: binding?.path ?? null,
        strictWrites: cfg.strictWrites,
        allowlistMatcher: makeAllowlistMatcher(repoRoot),  // T2.4 实现
    }
    applyInterception(toolName, args, ctx)
},
```

**测试**（`test/unit.test.js`）：在 `decidePathAction` describe 中新增：
- `strictWrites=true, no binding, write to repo root → deny`
- `strictWrites=true, no binding, read from repo root → allow`
- `strictWrites=false, no binding, write to repo root → allow (default behavior)`
- `strictWrites=true, has binding, write → rewrite`

**测试**（`test/lifecycle.test.js`）：
- 新增 case：`strictWrites mode blocks write without binding`
- 新增 case：`strictWrites mode allows read without binding`

**验证标准**：
- strictWrites 默认 false，所有现有测试不变
- strictWrites=true 时无 binding 写操作被拦截
- 错误消息明确告知用户如何修复（prepare 或加白名单）

---

### T2.3 危险 git 操作拦截（strictGitOps）

**目标**：opt-in 模式下识别 git push/merge/rebase/checkout 到受保护分支，拦截。

**改动文件**：`src/lib.ts`

**新增函数**：
```ts
const GIT_PREFIX = String.raw`\bgit\s+(?:(?:-C|-c)\s+\S+\s+)*`
const GIT_MUTATE_RE = new RegExp(GIT_PREFIX + String.raw`(merge|rebase|pull)\b`, "i")
const GIT_MERGE_TARGET_RE = new RegExp(
    GIT_PREFIX + String.raw`(merge|rebase)\s+([^\s;|&"'<>()]+)\b`, "i
)
const GIT_PUSH_PROTECTED_RE = /\bgit\s+push\b.*\b(master|main)\b/i
const GIT_PUSH_DEFAULT_RE = /^\s*git\s+push\s*$/i
const GIT_CHECKOUT_RE = new RegExp(
    GIT_PREFIX + String.raw`(checkout|switch)\s+([^\s;|&"'<>()-][^\s;|&"'<>()]*)`, "i"
)
const GIT_DEL_BRANCH_RE = new RegExp(
    String.raw`\bgit\s+branch\s+(-[dD])\s+([^\s;|&"'<>()]+)\b`, "i
)

export interface BashDecisionContext {
    command: string
    currentBranch: string
    protectedBranches: Set<string>  // 已小写化
    hasBinding: boolean
    strictGitOps: boolean
}

export function decideBashAction(ctx: BashDecisionContext): DecisionResult {
    if (!ctx.strictGitOps) return { action: "allow", source: "strictGitOps-off" }

    const branchL = ctx.currentBranch.toLowerCase()
    const cmd = ctx.command

    // 1. push 到受保护分支
    if (GIT_PUSH_PROTECTED_RE.test(cmd) ||
        (GIT_PUSH_DEFAULT_RE.test(cmd) && ctx.protectedBranches.has(branchL))) {
        return { action: "deny", reason: `[worktree] git push to protected branch (${ctx.currentBranch}) is blocked in strictGitOps mode.` }
    }

    // 2. 在受保护分支上 merge/rebase/pull
    if (GIT_MUTATE_RE.test(cmd) && ctx.protectedBranches.has(branchL)) {
        return { action: "deny", reason: `[worktree] merge/rebase/pull on protected branch (${ctx.currentBranch}) requires user authorization.` }
    }

    // 3. 副本内 checkout 到受保护分支
    if (ctx.hasBinding) {
        const m = GIT_CHECKOUT_RE.exec(cmd)
        if (m && ctx.protectedBranches.has(m[2].toLowerCase())) {
            return { action: "deny", reason: `[worktree] git checkout/switch to protected branch (${m[2]}) is blocked while worktree is bound.` }
        }
    }

    // 4. 删除分支
    const delM = GIT_DEL_BRANCH_RE.exec(cmd)
    if (delM) {
        return { action: "deny", reason: `[worktree] git branch -d/-D is blocked in strictGitOps mode (use worktree_cleanup instead).` }
    }

    return { action: "allow", source: "bash-no-violation" }
}
```

**改动文件**：`src/index.ts`

**修改 bash 分支的 `applyInterception`**（先做路径重写，再叠加 git 操作检查）：
```ts
case "bash": {
    // 现有的 workdir 注入和路径字符串替换保持不变
    // ...

    // 新增：strictGitOps 检查（在路径替换之后，避免路径替换影响 git 命令识别）
    if (ctx.strictGitOps) {
        const branch = currentBranchCached(repoRoot)  // 新增辅助：从 repoRoot 查当前分支
        const bashResult = decideBashAction({
            command: args.command,
            currentBranch: branch,
            protectedBranches: new Set(cfg.protectedBranches.map(b => b.toLowerCase())),
            hasBinding: !!ctx.worktreePath,
            strictGitOps: true,
        })
        if (bashResult.action === "deny") throw new Error(bashResult.reason)
    }
    return
}
```

**辅助函数** `currentBranchCached`：在 lib.ts 新增，带进程内存缓存（避免每次 bash 调用都 spawn git）。

**测试**（`test/unit.test.js`）：
```ts
describe("decideBashAction", () => {
    test("strictGitOps=false → always allow")
    test("git push origin master → deny")
    test("git push (default, on master) → deny")
    test("git push origin feature → allow")
    test("git merge feature on master → deny")
    test("git merge master on feature → allow")
    test("git checkout master with binding → deny")
    test("git checkout master without binding → allow")
    test("git branch -d wt/fix → deny")
    test("git status → allow")
    test("complex command: 'cd x && git merge y' → allow (known limitation, matches zcode)")
})
```

**测试**（`test/lifecycle.test.js`）：
- 新增 case：`strictGitOps mode blocks git push to master`
- 新增 case：`strictGitOps mode allows git push to feature branch`

**已知限制**（写入 design.md 和 comparison-with-zcode.md，已记录）：
- 同 zcode，只识别 `git` 直接开头的简单命令
- `cd x && git merge` 类组合可能绕过
- 这是"提高门槛"语义，不是"绝对防御"

**验证标准**：
- strictGitOps 默认 false，所有现有测试不变
- strictGitOps=true 时受保护分支的 push/merge 被拦截
- 受保护分支列表可通过 sidecar 配置扩展

---

### T2.4 逃生口（allowlist + whitelist）

**目标**：提供两套互补的逃生口（声明式白名单 + 临时 allow）。

#### T2.4a 声明式白名单（mainWriteWhitelist）

**改动文件**：`src/lib.ts`

**新增函数**：
```ts
export function matchWhitelist(target: string, repoRoot: string, patterns: string[]): boolean {
    if (!patterns.length) return false
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
            ["git", ""].includes(slashStripped) || slashStripped === "*") {
            dangerous.push(trimmed)
        } else if (trimmed.includes(".git")) {
            dangerous.push(trimmed)
        } else {
            valid.push(trimmed)
        }
    }
    return { valid, dangerous }
}

export function matchGlob(target: string, pattern: string): boolean {
    // 手写 glob（** 跨目录，* 单段，? 单字符），避免引依赖
    // 参考 zcode common.mjs L380-414
    // ...
}
```

**改动**：`loadConfig` 在加载时调用 `validateWhitelist`，过滤危险模式并打印警告到 stderr。

**改动**：`decidePathAction` 第 4a 步检查白名单：
```ts
if (ctx.whitelist?.length && matchWhitelist(target, ctx.repoRoot, ctx.whitelist)) {
    return { action: "allow", source: "whitelist" }
}
```

#### T2.4b 临时 allow（worktree_allow 工具）

**改动文件**：`src/index.ts`

**新增工具**：
```ts
worktree_allow: tool({
    description:
        "Temporarily allow writing to specific paths in the main checkout without a worktree binding. " +
        "Use for repo-level config/docs (e.g., AGENTS.md, CI configs). Entries have TTL and are audited.",
    args: {
        action: z.enum(["add", "list", "clear"]).describe("add = add path; list = show current; clear = remove all"),
        path: z.string().optional().describe("For add: repo-relative path or glob pattern"),
        reason: z.string().optional().describe("For add: why this path needs main-checkout write"),
        ttlMinutes: z.number().optional().describe("TTL in minutes (default 60)"),
    },
    async execute(args, tctx) {
        // 实现：stateBackend.loadAllowlist() / saveAllowlist() / 校验危险路径 / 写 audit.jsonl
    },
}),
```

**改动文件**：`src/lib.ts`

**StateBackend 接口扩展**：
```ts
export interface StateBackend {
    // ... 现有方法
    loadAllowlist(): AllowlistEntry[]
    saveAllowlist(entries: AllowlistEntry[]): void
    appendAudit(entry: Record<string, unknown>): void
}
```

**ExternalStateBackend 实现**：allowlist 存在 `<state-dir>/<projectId>.allowlist.json`，audit 存在 `<state-dir>/<projectId>.audit.jsonl`。

**GitCommonStateBackend 实现**：allowlist 存在 `<baseDir>/allowlist.json`，audit 存在 `<baseDir>/audit.jsonl`。

**改动 `tool.execute.before`**：传入 `allowlistMatcher`：
```ts
const allowlist = stateBackend.loadAllowlist()
const allowlistMatcher = (p: string) => isAllowlisted(p, repoRoot, allowlist)
```

**测试**（`test/lifecycle.test.js`）：
- `worktree_allow add creates allowlist entry with TTL`
- `worktree_allow add rejects dangerous paths (.git, root, *)`
- `worktree_allow add writes audit log entry`
- `worktree_allow list shows current entries`
- `worktree_allow clear removes all entries`
- `expired allowlist entries are lazily GC'd on load`
- `whitelist config allows writes without explicit allow`

**验证标准**：
- 危险路径（`.git`、`/`、`*`）被 `validateWhitelist` 剔除并 stderr 警告
- TTL 过期条目在下次 loadAllowlist 时被清理
- 每次 allow add 写一条 audit 日志
- 白名单配置放行对应路径（不需要每次 allow）

---

## 5. Tier 3：辅助增强（低优先级）

### T3.1 schema 版本管理

**目标**：升级时识别老数据，平滑迁移。

**改动文件**：`src/lib.ts`

**新增**：
```ts
export const SCHEMA_VERSION = 2

export function ensureMeta(stateDir: string): void {
    const metaFile = path.join(stateDir, "meta.json")
    const existing = existsSync(metaFile) ? safeReadJson(metaFile) : null
    if (!existing || existing.schemaVersion !== SCHEMA_VERSION) {
        atomicWriteFileSync(metaFile, JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            updatedAt: new Date().toISOString(),
        }, null, 2))
    }
}
```

**改动**：`loadState` 检测 schema 版本不匹配时打印 stderr 警告（不强制迁移，向后兼容）。

**GitCommonStateBackend** 自动调用 `ensureMeta(this.baseDir)`。

**测试**（`test/unit.test.js`）：
- `ensureMeta: creates meta.json with current SCHEMA_VERSION when missing`
- `ensureMeta: updates meta.json when schema version is outdated`
- `ensureMeta: no-op when schema version matches`

**测试**（`test/lifecycle.test.js`）：
- `loadState reads v1 (no schemaVersion) JSON and warns on stderr`
- `git-common mode auto-creates meta.json on first binding write`

**验证标准（具体 QA 场景）**：

1. **v1 兼容读取场景**：
   - 前置：用 `writeFileSync(stateFilePath, JSON.stringify({ sessions: {} }))` 写一个**无 schemaVersion 字段**的 JSON 文件（模拟 v1 数据）
   - 调用 `loadState(pid)` → 返回值应为 `{ sessions: {} }`（不抛错、不丢数据）
   - 调用过程中 stderr 应包含字符串 `"state schema version missing or outdated (current: 2)"`（用 `process.stderr.write` 捕获或 mockconsole.error 验证）
   - 调用后 `saveState(pid, loaded)` 应**回写时附加** `schemaVersion: 2`（下次读取不再警告）

2. **git-common 模式 meta.json 创建场景**：
   - 前置：清空 `<git-common-dir>/worktree-isolation/` 目录
   - 切换到 `stateLocation: "git-common"` 模式
   - 调用 `worktree_prepare` 创建一个 binding
   - 期望 `<git-common-dir>/worktree-isolation/meta.json` **存在**，内容为 `{ "schemaVersion": 2, "updatedAt": "<ISO-8601>" }`
   - JSON.parse 后 `schemaVersion === 2`，`updatedAt` 能被 `new Date(parsed.updatedAt).getTime()` 解析为有效时间戳

3. **idempotent 场景**：连续两次 `ensureMeta(dir)` 第二次不应改 `updatedAt`（用 mtime 比较验证）

---

### T3.2 审计日志

**目标**：记录 allow 调用与 strict 模式拦截事件，便于排查。

**改动文件**：`src/lib.ts`

**已在 T2.4b 引入 `appendAudit`**。Tier 3 扩展使用范围：

**扩展记录点**：
- `worktree_prepare` 调用（创建记录）
- `worktree_cleanup apply`（删除记录）
- `worktree_merge apply`（合并记录）
- strictWrites/strictGitOps 拦截事件（deny 时记一条）

**审计条目格式**：
```json
{
    "type": "allow_add" | "prepare" | "cleanup" | "merge" | "deny",
    "sessionId": "...",
    "ts": "2026-08-11T...",
    "branch": "...",
    "path": "...",
    "reason": "..."
}
```

**测试**（`test/lifecycle.test.js`）：
- `prepare writes audit entry`
- `strict deny writes audit entry`
- `audit log is append-only (jsonl)`

**验证标准（具体 QA 场景）**：

1. **prepare 审计场景**：
   - 前置：清空 audit.jsonl
   - 调用 `worktree_prepare(title="audit-test")` 成功
   - 期望 `audit.jsonl` 末行满足：`tail -n 1 audit.jsonl | jq -e '.type == "prepare"'` 返回 exit 0
   - 完整断言：`jq -e '.sessionId == "<test-session>" and .branch == "wt/audit-test" and (.ts | fromdateiso8601 > now-1000)'`（sessionId/branch 匹配、ts 在过去 1 秒内）

2. **strict deny 审计场景**：
   - 前置：清空 audit.jsonl，开启 `strictWrites: true`，无 binding
   - 调用 `write` 工具写主 checkout 路径（被 hook 拦截 throw）
   - 期望 `audit.jsonl` 末行满足：`jq -e '.type == "deny" and .reason | contains("strictWrites")'`
   - 同时验证：write 工具返回错误（agent 看到拦截消息）

3. **append-only 场景**：
   - 前置：audit.jsonl 已有 3 行
   - 触发一次 prepare → audit.jsonl 应变为 4 行（不覆盖）
   - 断言：行数 = 之前 + 1；前 3 行内容未被修改（用 hash 比较或前 3 行内容一致性）

4. **jsonl 格式可解析场景**：
   - 前置：触发 prepare / allow add / strict deny 三种事件后
   - 执行 `jq -e '.' audit.jsonl > /dev/null`（每行都是有效 JSON）→ exit 0
   - 执行 `jq -s 'length' audit.jsonl` → 返回 "3"（每行独立可解析）

5. **PII redaction 场景**（隐私保护）：
   - 路径中含用户名时（如 `C:/Users/jane/...`）审计条目原样记录（不做 redaction，因为 opencode 单用户场景）
   - 文档（README）注明：审计日志可能含本地用户名，共享前请手动脱敏

---

### T3.3 SessionStart 纪律注入（仅 strict 模式）

**目标**：strict 模式启用时，会话启动即注入 worktree 纪律。

**改动文件**：`src/index.ts`

**新增 hook**（使用 opencode 的 `experimental.chat.system.transform` 或类似入口；如不适用，则用 `event` hook 监听 `session.start`）：

```ts
"experimental.chat.system.transform": async (input, output) => {
    if (!output || !Array.isArray(output.system)) return
    const sessionId = input?.sessionID
    if (!sessionId) return

    const cfg = loadConfig(repoRoot)
    if (!cfg.sessionStartNudge && !cfg.strictWrites && !cfg.strictGitOps) return  // 仅 strict 或显式开启时注入

    const binding = await resolveBinding(sessionId)

    if (binding) {
        // 沿用现有的 ACTIVE WORKTREE 提示（保持不变）
        output.system.push(/* 现有内容 */)
    } else if (cfg.strictWrites || cfg.strictGitOps) {
        // 新增：strict 模式下无 binding 的纪律提示
        output.system.push(
            `## WORKTREE-GUARD ACTIVE\n` +
            `This repo enforces worktree discipline (strictWrites=${cfg.strictWrites}, strictGitOps=${cfg.strictGitOps}).\n` +
            `- Before writing code, call worktree_prepare to create an isolated worktree.\n` +
            `- Writes to the main checkout without a binding will be BLOCKED.\n` +
            `- Dangerous git operations on protected branches (${cfg.protectedBranches.join(", ") || "master, main"}) will be BLOCKED.\n` +
            `- For repo-level config/docs, use worktree_allow or add paths to mainWriteWhitelist.\n`
        )
    }
},
```

**测试**（`test/lifecycle.test.js`）：
- `strict mode injects discipline prompt when no binding`
- `non-strict mode does not inject discipline prompt`
- `binding present always injects ACTIVE WORKTREE prompt (existing behavior)`

**验证标准**：
- 默认（strict 全 false）行为完全不变
- strict 模式下新会话启动时 system prompt 包含纪律提示
- 已绑定会话行为不变

---

## 6. 实施顺序与里程碑

```
阶段 1：Tier 1（bugfix，1-2 个工作单位）
├─ T1.1 atomicWriteFileSync + saveState 改造
├─ T1.2 findSessionsForWorktree + cleanup/merge 悬空检查
└─ T1.3 decidePathAction / decideSearchPathAction 纯函数 + applyInterception 重构

→ 验证：现有测试全过 + 新增 bugfix 测试通过 + 无行为变化

阶段 2：Tier 2（能力增强，3-4 个工作单位）
├─ T2.1 StateBackend 抽象 + GitCommonStateBackend + 配置 stateLocation
├─ T2.2 strictWrites（依赖 T2.1 决策上下文扩展）
├─ T2.3 strictGitOps（独立，仅 bash 分支）
└─ T2.4 allowlist + whitelist（依赖 T2.1 StateBackend 扩展）

→ 验证：external 模式行为不变 + git-common 模式工作 + strict 模式按预期拦截

阶段 3：Tier 3（辅助增强，1-2 个工作单位）
├─ T3.1 meta.json schema 版本
├─ T3.2 审计日志扩展
└─ T3.3 SessionStart 纪律注入（仅 strict）

→ 验证：所有上述行为 + 审计/迁移提示正确

阶段 4：文档与发布
├─ 更新 README.md（新增配置项、strict 模式说明）
├─ 更新 docs/design.md（增补章节 v0.4：借鉴 zcode）
├─ 版本号升级（建议 0.3.1 → 0.4.0，因新增功能）
└─ CHANGELOG（如有）
```

---

## 7. 验收清单

### 7.1 功能验收

- [ ] Tier 1：原子写、悬空检查、决策表重构 — 全部测试通过
- [ ] Tier 2：git-common 模式、strictWrites、strictGitOps、逃生口 — 全部测试通过
- [ ] Tier 3：schema 版本、审计、SessionStart — 全部测试通过
- [ ] 默认配置下（无 sidecar）：所有现有测试 100% 通过（零破坏）
- [ ] strictWrites=true 时：无 binding 的 write 被拦截
- [ ] strictGitOps=true 时：受保护分支的 push/merge 被拦截
- [ ] git-common 模式：bindings 文件在 `<git-common-dir>/worktree-isolation/` 下
- [ ] allowlist TTL 过期条目被懒清理

### 7.2 质量验收

- [ ] `npm run typecheck` 零错误
- [ ] `npm test` 全绿
- [ ] 无 `as any` / `@ts-ignore` / `@ts-expect-error`
- [ ] 无未清理的 import / 死代码
- [ ] 新增函数均有 TSDoc 注释（仅"为什么"，不写"做什么"）
- [ ] 决策表函数（decidePathAction / decideBashAction）是纯函数

### 7.3 文档验收

- [ ] README.md 新增配置表覆盖所有新字段
- [ ] docs/design.md 增补 v0.4 章节，注明借鉴来源
- [ ] docs/comparison-with-zcode.md 已与作者交流并按反馈更新
- [ ] package.json version 升级到 0.4.0

---

## 8. 风险与回滚

### 8.1 风险识别

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| StateBackend 抽象引入回归 | 中 | 高（破坏现有功能） | 渐进式重构：ExternalStateBackend 先完全模拟现有行为，再扩展 |
| git-common 模式在 bare repo / submodule 下解析失败 | 中 | 中 | `git rev-parse --git-common-dir` 失败时 throw 清晰错误，建议用户切回 external |
| strictGitOps 正则绕过 | 高（已知限制） | 低（仅"提高门槛"语义） | 文档明确说明限制，不宣称"绝对防御" |
| allowlist 滥用（用户加 `*` 卸保护） | 低 | 高 | `validateWhitelist` 强制剔除危险模式 |
| 决策表重构破坏现有 applyInterception 行为 | 中 | 高 | 重构后所有现有 unit.test.js / lifecycle.test.js 必须全过 |
| git-common 写入触发用户/工具告警 | 中 | 低 | 文档说明 + 默认 external + opt-in |

### 8.2 回滚策略

- 每个 Tier 完成后打 git tag（`v0.4.0-tier1` / `v0.4.0-tier2` / `v0.4.0-tier3`），便于回退
- 任何 Tier 引入回归 → 立即 revert 该 Tier 的 commit，回到上一 Tier tag
- 关键设计错误（如 StateBackend 抽象不当）→ 废弃抽象，回退到 Tier 1 函数式实现

### 8.3 紧急回滚开关

sidecar 配置 `"emergencyDisable": true` → 完全禁用所有 hook（仅保留 worktree_prepare / cleanup / merge 工具的基础功能，不做任何拦截）。

> 仅作为最后保险，不在常规文档中宣传。

---

## 9. 不在范围内（明确排除）

按对比文档第 9.5 节决策，以下不实施：

- ❌ 直读 SQLite 做子代理继承（保留 client API）
- ❌ 一键 merge 改三步授权（保留 opencode 一键流程）
- ❌ Bash cd 命令解析（opencode bash 有 workdir 字段，不需要）
- ❌ 把 git-common 改为默认模式（保持 external 默认）
- ❌ 把每session一文件作为唯一方案（external 模式保持单文件）
- ❌ Slash 命令（design.md §13 已记为未来工作，不在本计划）

---

## 10. 待 Momus 审查的重点问题

请 Momus 重点审查以下方面：

1. **StateBackend 抽象时机**：Tier 1 是否应该先引入抽象（避免 Tier 2 大规模重构），还是延后到 Tier 2（保持 Tier 1 最小改动）？
2. **决策表函数签名**：`decidePathAction` 入参从 `(target, repoRoot, worktreePath)` 扩展为 `(target, DecisionContext)` 是否合理？是否应该拆成多个独立函数（如 `decideWithBinding` / `decideWithoutBinding`）？
3. **git-common 模式的 bare repo 处理**：`git rev-parse --git-common-dir` 在 bare repo 返回 `.`，此时 baseDir 会是 `<repo>/.` 还是 `<repo>`？需要测试覆盖。
4. **strictGitOps 与现有 protectedBranches 的关系**：现有 protectedBranches 仅用于 cleanup 强制不删，T2.3 扩展为 push/merge 拦截目标——是否应该用独立配置项避免歧义？
5. **审计日志的隐私**：audit.jsonl 是否可能记录敏感信息（如文件路径含用户名）？是否需要 redaction？
6. **测试覆盖度**：现有 9 个 lifecycle case + 43 个 unit case，本计划新增约 30+ case。是否足够？还需要哪些场景？
7. **阶段顺序的依赖关系**：T2.2 依赖 T2.1（决策上下文扩展），T2.4 依赖 T2.1（StateBackend 接口扩展）——是否应该调整顺序避免并行实施冲突？

---

**文档版本**: v1.0
**待审查状态**: 等待 Momus 评审
