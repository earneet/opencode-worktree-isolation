# opencode-worktree-isolation × zcode-worktree-guard 对比与交流

> **任务来源**: 用户审查 opencode-worktree-isolation 项目是否支持多 session 多 worktree 并行工作，并对比 zcode-worktree-guard 的可借鉴点。完成审查后，用户希望将对比结论（含实现取舍）整理为文档，作为与 zcode-worktree-guard 作者的技术交流材料。
> **任务内容**: 客观对比两个项目的运行时模型、状态管理、拦截策略、继承机制、合并工作流、测试覆盖度，分析每个设计决策背后的取舍原因，并标注双向借鉴的方向（不仅 opencode 学 zcode，也指出 zcode 可从 opencode 学的点）。
> **参考文档**:
> - `F:\workspace_2\opencode-worktree-guard\docs\design.md` — opencode-worktree-isolation 完整设计文档
> - `F:\workspace_2\zcode-worktree-plugin\docs\design.md` — zcode-worktree-guard 完整设计文档
> - `F:\workspace_2\opencode-worktree-guard\src\{index.ts, lib.ts}` — opencode 项目实现
> - `F:\workspace_2\zcode-worktree-plugin\plugins\zcode-worktree-guard\scripts\{common.mjs, wt.mjs, guard_hook.mjs, session_start.mjs}` — zcode 项目实现
> - `F:\workspace_2\opencode-worktree-guard\test\{unit.test.js, lifecycle.test.js}` — opencode 测试套件
> - `F:\workspace_2\zcode-worktree-plugin\tests\v2.test.mjs` — zcode 测试套件
> **生成日期**: 2026-08-11
> **交流对象**: zcode-worktree-guard 项目作者（earneet）

---

## 0. TL;DR（一页结论）

两个项目解决同一个问题（AI agent 在 git worktree 工作流下的路径漂移与遵循度），但运行时模型根本不同：

| 维度 | opencode-worktree-isolation | zcode-worktree-guard |
|---|---|---|
| 宿主 | opencode（长驻 JS 插件进程） | ZCode（每次 hook spawn 新 node 进程） |
| 哲学 | **可选** worktree（自由进出） | **强制** worktree（无 binding 写主分支拦截） |
| 状态位置 | 外部目录 `~/.local/share/opencode/...` + projectId | `<git-common-dir>/worktree-guard/` |
| 并行模型 | 单进程异步事件 + 文件 IO | 多进程 + 文件系统协调 |
| 子代理继承 | opencode client API（`session.get(id).parentID`） | 直读 SQLite DB（`session.parent_id`） |
| 合并工作流 | 一键 `worktree_merge(action=apply)` | 三步 `authorize-main` → `git merge` → `revoke-main` |
| 多 session 安全 | 当前不足（非原子写、无悬空检查） | 完备（原子写、每session一文件、悬空检查） |
| 危险 git 操作拦截 | 无 | 有（push/merge/checkout 受保护分支） |
| 测试方法论 | 端到端集成测试为主 | 单元/决策表测试为主 |

**两个项目的设计选择不是"谁更先进"，而是被各自的运行时模型和宿主契约塑造的合理结果。** 本文目的不是评判高下，而是把双方的取舍讲清楚，便于：

1. opencode 项目作者（本文读者）从 zcode 借鉴多 session 安全机制
2. zcode 项目作者（交流对象）从 opencode 借鉴 client API 继承、配置丰富度、集成测试覆盖
3. 双方在状态目录位置、strict 模式标准化等开放问题上交换意见

---

## 1. 项目定位与设计哲学

### 1.1 共同目标

- 消除 AI agent 在 git worktree 工作流下的**路径漂移**（agent 以为写到了 worktree，实际写到了主 checkout，或反之）
- 通过**工具层透明重写**而非"靠 agent 记得 cd"来实现隔离
- 都采用 dual-layer defense：系统提示词（软）+ 工具层路径重写（硬）

### 1.2 哲学差异

**opencode-worktree-isolation**：
- 把 worktree 视为**可选的隔离层**——agent 可以选择进入，也可以不进入
- 无 binding 时完全不拦截（普通会话零影响）
- 系统提示词的措辞是"ACTIVE WORKTREE — Your Working Directory Has Changed"
- 定位是"为想用 worktree 的用户提供机制保障"

**zcode-worktree-guard**：
- 把 worktree 视为**强制的开发纪律**——所有开发必须在隔离副本进行
- 无 binding 时 Write/Edit 主 checkout **硬拦截**（fail-closed），Read 放行
- SessionStart hook 在每个会话启动时就注入"worktree 强制工作流"纪律
- 定位是"机制层消除遵循度问题，让违规在物理上不可能发生"

**评价**：两种哲学都自洽。opencode 的方式更"自由"，适合 worktree 可选的工作流；zcode 的方式更"严格"，适合团队规范要求所有改动走 worktree 的场景。**哲学本身没有高下，但选择哲学后会决定后续所有设计**。

---

## 2. 运行时模型对比（最根本的差异）

这是所有其他差异的根因。

### 2.1 模型对比

| 维度 | opencode-worktree-isolation | zcode-worktree-guard |
|---|---|---|
| 进程模型 | 单进程长驻（opencode 加载插件模块） | 每次 hook spawn 新 node 进程 |
| 状态共享 | 进程内存 Map + 文件 | 纯文件系统协调 |
| hook 触发 | 同进程异步事件 | 进程启动 + 文件 IO |
| 进程启动开销 | 零（已加载） | 每次 hook ~50-200ms |
| 进程间通信 | 不需要（单进程） | 文件 + stdout/stderr + exit code |
| fail 策略 | `throw` 阻断工具 | `exit 2` + stderr |
| hook 数据传递 | 函数参数（`input/output`） | stdin JSON / stdout JSON |

### 2.2 模型推论：为什么双方的设计选择都合理

**zcode 的多进程模型逼出来的设计**：

1. **必然的并发**——每次 hook 是新进程，多 session 并行 hook 时必然多进程并发。所以 zcode **必须**：
   - 每session一文件（`bindings/<sid>.json`）避免跨 session 争用
   - tmp+rename 原子写避免读到半写 JSON
   - `<git-common-dir>` 作为状态目录（无进程内存共享，文件是唯一协调机制）

2. **必然的直读 SQLite**——spawn 的进程没有 client API 可调，只能直读宿主 DB 拿 `parent_id`。这是被运行时模型逼的，不是设计高明。

3. **必然的三步合并**——zcode hook 是静态扫描（同一 Bash 命令执行前扫一遍），`authorize-main` 和 `git merge` 写在同一命令里，authorize 还没落盘 merge 就被拦。所以**必须**分三次独立 Bash 调用。这是 spawn + 静态扫描模型的限制。

**opencode 的单进程模型带来的优势**：

1. **进程内存缓存**——`inheritCache: Map<string, SessionBinding>` 可以缓存 parent-chain 解析结果，避免重复查 API
2. **client API 直调**——`client.session.get(id)` 异步获取 parentID，不耦合宿主 DB schema
3. **一键合并**——merge 在工具 execute 内部调用 `git()` helper，不经过 bash 工具的 hook 拦截，所以可以 preview+apply 一次性完成
4. **零进程启动开销**——hook 是函数调用，不是进程 spawn

**opencode 的单进程模型带来的劣势**：

1. **JS 异步竞态依然存在**——虽然单进程，但 `loadState` → 遍历 → `saveState` 是异步的"读-改-写"交叉执行。两个并发的 `worktree_cleanup` 会互相覆盖。
2. **状态文件 IO 没有跨进程协调**——如果用户在多个 opencode 实例打开同一仓库（多窗口编辑同一项目），仍然有多进程并发问题。
3. **状态丢失风险**——如果 opencode 进程崩溃在 saveState 中途，state 文件可能半写。

**关键洞察**：opencode 单进程模型**掩盖**了并发问题，但**没有消除**它。zcode 多进程模型**显式暴露**了并发问题，所以**更早**做了正确的并发安全设计。这是 opencode 项目应该向 zcode 学习的核心点。

---

## 3. 状态管理设计对比

### 3.1 位置选择

| 项目 | 位置 | 隔离机制 |
|---|---|---|
| opencode | `~/.local/share/opencode/worktree-workflow/<projectId>.json` | projectId（首提交哈希或 sha256(repoRoot)） |
| zcode | `<git-common-dir>/worktree-guard/{state.json, bindings/, ...}` | 路径即身份（git common dir 天然唯一） |

**opencode 选外部目录的理由**（design.md §5）：
- 跟随 opencode 宿主约定（`~/.local/share/opencode/`）
- 不污染 `.git` 区域（避免用户敏感）
- 多仓库天然分流（projectId 隔离）
- 测试隔离简单（`OC_WT_STATE_DIR` env 变量）

**zcode 选 git common dir 的理由**（design.md §6）：
- 跟随仓库（复制/迁移不丢）
- 所有 linked worktree 天然共享（git common dir 是 git 内置的共享元数据目录）
- 重启自动恢复（任何 cwd 都能通过 `git rev-parse --git-common-dir` 定位）
- 无需 projectId 抽象层

**两种方案的代价**：

| 维度 | external（opencode） | git-common（zcode） |
|---|---|---|
| `.git` 写入心理障碍 | 无 | 有（部分用户/工具敏感） |
| 路径稳定性 | 稳定（仅取决于 HOME） | 不稳定（bare/submodule/worktree-of-worktree 边界多） |
| 仓库迁移 | 状态留下（projectId 不变，但路径变了 → fallback sha256） | 状态跟随 |
| 多实例打开同仓库 | 多个 opencode 进程的 `~/.local/...` 是同一路径，仍并发 | 多个 zcode 客户端的 git-common-dir 是同一路径，仍并发 |
| 测试隔离 | env 变量改目录即可 | 每个测试 case 需要独立临时 git repo |
| 备份语义 | 仓库删除状态残留 | 仓库删除状态清除（`rm -rf .git` 一并清） |
| 仓库多 worktree 共享 | 通过 projectId 间接共享（同 commit hash 的仓库共享同一 state 文件） | 通过 git common dir 直接共享（物理同一目录） |

**opencode 的一个微妙问题**：projectId 用首提交哈希意味着 clone 同一仓库到不同路径会**共享 state**。例如 `/pathA/myrepo` 和 `/pathB/myrepo` 是同一仓库的两个 clone，它们在 `~/.local/.../worktree-workflow/<same-hash>.json` 是同一文件——A 仓库 prepare 的 worktree 会出现在 B 仓库的 status 里。这不是用户预期。fallback 到 sha256(repoRoot) 后才能区分，但首提交哈希成功时就用不上 fallback。

zcode 的 git-common-dir 模式**没有这个问题**——每个仓库的 `.git` 是物理独立的目录。

### 3.2 文件结构

**opencode**（单文件）：
```json
{
  "sessions": {
    "<sessionId>": { "branch", "path", "repoRoot", "title", "createdAt", "inherited" }
  }
}
```

**zcode v0.2**（多文件）：
```
<git-common-dir>/worktree-guard/
  bindings/<sessionId>.json   每会话一文件，绑定快照
  state.json                  v0.1 兜底（仓库级单活动，降级真源）
  bases.json                  worktree 分支 → base 分支映射
  meta.json                   schema 版本（升级检测）
  allowlist.json              临时放行路径列表
  audit.jsonl                 审计日志
```

**取舍**：

| 维度 | 单文件（opencode） | 多文件（zcode） |
|---|---|---|
| 实现复杂度 | 低（一次 read/write） | 中（路径管理 + 多文件原子性） |
| 跨 session 并发 | 单文件的读-改-写必然争用 | 每 session 独立文件，无争用 |
| 查询所有绑定 | 一次 read 拿全部 | 需要 readdir + 多次 read |
| 单 session 失败影响 | 整个 state 文件可能损坏 | 单文件损坏不影响他人 |
| schema 演进 | 单文件迁移 | 多文件分别迁移（更复杂但更可控） |

**结论**：单进程下 opencode 单文件尚可工作（加原子写即可），但**多 session 高并发场景下多文件结构明显更优**。

### 3.3 并发安全

**opencode 现状**（`src/lib.ts` L229-232）：
```ts
export function saveState(projectId, state) {
    mkdirSync(getStateDir(), { recursive: true })
    writeFileSync(stateFilePath(projectId), JSON.stringify(state, null, 2))  // 非原子
}
```
design.md §13 L229 作者已承认："并发写入用文件锁替代 last-write-wins（若多 worktree 同时 cleanup 出现竞争）"——v1 未修。

**zcode 现状**（`scripts/common.mjs` L203-217）：
```js
function writeJson(f, data) {
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
  try { fs.renameSync(tmp, f) }  // POSIX rename 原子；Windows 同卷 rename 基本原子
  catch {
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8")  // fallback
  }
}
```

**对 opencode 的启示**：必须补 tmp+rename 模式。即使单进程异步，JS 事件循环也会让两个 `loadState → modify → saveState` 交叉执行（await 点切换）。这不是"借鉴"，是"补 bug"。

### 3.4 多 session 悬空检查

**opencode 现状**：完全缺失。`worktree_cleanup` apply 分支（`src/index.ts` L222-259）循环删除，**不检查**该 worktree 是否被其他 session 引用。

**问题场景**：
- session A 绑了 `wt/fix-auth`
- session B 通过 `worktree_merge branch=wt/fix-auth` 或子代理继承也用了它
- B 执行 `worktree_cleanup` → 直接删 worktree
- A 的下一次工具调用命中 `existsSync(W) === false`，行为未定义

**zcode 现状**（`scripts/wt.mjs` L141-150）：
```js
const otherSessions = C.findBindingsForWorktree(common, wtPath).filter(s => s !== sessionId)
if (otherSessions.length > 0) {
  if (action === "remove") return fail(`仍被其他会话绑定: ${otherSessions.join(",")}`)
  lines.push(`⚠️ 该 worktree 仍被其他会话绑定...`)
}
```
exit(remove) 前查所有绑定，仍被引用则拒绝删除。

**对 opencode 的启示**：cleanup 和 merge apply 前必须扫一遍 `state.sessions`，找其他引用该 worktree 的 session。

---

## 4. 拦截策略对比

### 4.1 决策表

| 场景 | opencode | zcode |
|---|---|---|
| 有 binding，写主 checkout 路径 | 重写到 worktree | 重写到 worktree |
| 有 binding，写副本内路径 | 放行 | 放行 |
| 有 binding，Glob/Grep 无 path | 注入 path=worktree | 注入 path=worktree |
| 有 binding，写其他副本 | **不识别**（直接重写到自己 worktree，可能错误） | **拦截**（识别其他副本并 deny） |
| 写 `.git` 路径 | throw 拦截 | deny |
| 无 binding，Write/Edit 主 checkout | **放行** | **deny（写保护）** |
| 无 binding，Read 主 checkout | 放行 | 放行 |
| master/main 上 `git merge/rebase/pull` | **放行**（不识别 git 语义） | **deny（需授权）** |
| `git push` 到 master/main | **放行** | **deny（需授权）** |
| 副本内 `git checkout master/main` | **放行** | **deny** |
| 删除 worktree 分支 | **放行** | **deny** |
| 仓库外路径、非 git 目录 | 放行 | 放行 |
| 逃生口（临时写主目录某文件） | **无机制** | allowlist + whitelist 双套 |

### 4.2 跨副本写入检测

zcode 在 `decideWrite()` 决策表第 7 条（`scripts/guard_hook.mjs` L97-108）专门检查目标路径是否落在**另一个已注册 worktree** 内：

```js
if (C.isInside(nTarget, nRoot)) {
  for (const wt of C.registeredWorktrees(ctx.root)) {
    const nOther = C.norm(wt.path)
    if (nOther === nRoot) continue
    if (nOther === nWt) continue
    if (C.isInside(nTarget, nOther)) {
      return { action: "deny", reason: "目标路径在其他 worktree 副本内，不允许跨副本写入。" }
    }
  }
  // ...正常重写
}
```

opencode 没有这层检查。如果 agent 生成路径恰好落在另一个 worktree 内（例如 agent 习惯性写了 `.worktrees/worktree-X/src/app.js`），opencode 会把它**再次重写**到自己绑定的 worktree 路径下（`.worktrees/worktree-Y/.worktrees/worktree-X/src/app.js`），产生奇怪结果。

实际上 opencode 的 worktree 默认放在仓库外（`~/.local/share/opencode/worktree/<pid>/<branch>`），所以这种情况罕见；但若用户配置 `worktreeRoot: "$REPO/.worktrees"`（仿 zcode 模式），就会触发。

### 4.3 危险 git 操作识别

**opencode**：完全不识别 git 子命令语义，bash 钩子只做路径字符串替换 + `.git` 路径拦截。

**zcode**（`scripts/guard_hook.mjs` L14-26, L163-204）：用一组正则识别：
```js
const GIT_MUTATE_RE = /\bgit\s+(merge|rebase|pull)\b/i
const GIT_PUSH_PROTECTED_RE = /\bgit\s+push\b.*\b(master|main)\b/i
const GIT_DEL_WORKTREE_RE = /\bgit\s+branch\s+(-[dD])\s+(worktree-...)\b/i
const GIT_CHECKOUT_RE = /\bgit\s+(checkout|switch)\s+([^\s;|&..."<>()-]...)/i
```

**zcode 的限制**（design.md §7 已承认）：
- 只匹配 `git` 直接开头的简单命令
- `cd x && git merge` 类组合可能绕过
- 与 kimi（参考项目）一致的已知限制

**对 opencode 的启示**：strict 模式下应引入这组正则，但要明确边界——这只是"提高门槛"不是"绝对防御"。

### 4.4 逃生口（allow + whitelist）

**zcode 双套逃生口**：

1. **声明式白名单**（`main_write_whitelist`，永久、sidecar 配置）：
   ```json
   { "main_write_whitelist": ["AGENTS.md", "docs/**/*.md"] }
   ```
   命中白名单的路径永远写主目录，不重写不拦截。`validateWhitelist()` 函数（`common.mjs` L555-569）专门剔除危险裸根模式（`*`、`/`、`.`、`**`），防误配置卸保护。

2. **临时 allow**（`wt.mjs allow`，TTL + 审计 + 注入防护）：
   ```bash
   echo '{"action":"add","path":"README.md","reason":"临时改文档","ttl_minutes":60}' | node wt.mjs allow
   ```
   - TTL 默认 60 分钟
   - 拒绝危险路径（`.git`、根、`*`）
   - 每次调用写 `audit.jsonl`
   - 仓库级单文件（不按 session 分，理由：wt.mjs 的 session 来源和 hook 的 session 来源不一致，按 session 分文件会错配）

**opencode 当前无逃生口**——临时改 `AGENTS.md` 这类仓库级文档只能整个 session 不绑 worktree。这是真实痛点。

**设计取舍**：zcode 把 allowlist 设计为"仓库级单文件"而不是"每 session 一文件"是个值得讨论的决策。理由是 wt.mjs（agent 通过 Bash 调用）和 hook（宿主 spawn）的 session_id 来源不同（一个来自 `ZCODE_SESSION_ID` env，一个来自 hook stdin），按 session 分文件会错配。**opencode 单进程下不存在这个问题**——所有调用都在同进程，sessionID 一致。所以 opencode 引入逃生口时可以做成"每 session 一文件"，更符合最小权限原则。

---

## 5. 继承机制对比

### 5.1 实现差异

**opencode**（`src/index.ts` L42-58）：
```ts
async function resolveBinding(sessionId) {
    if (!sessionId) return null
    const state = loadState(getPid())
    if (state.sessions[sessionId]) return { ...state.sessions[sessionId]!, _state: state }
    if (inheritCache.has(sessionId)) return inheritCache.get(sessionId)!
    let current = sessionId
    let found = null
    for (let i = 0; i < MAX_PARENT_DEPTH; i++) {
        const res = await client.session.get({ path: { id: current } })
        const parentId = res.data?.parentID
        if (!parentId) break
        if (state.sessions[parentId]) { found = state.sessions[parentId]!; break }
        current = parentId
    }
    if (found) {
        // 快照到自身 binding（持久化）
        state2.sessions[sessionId] = { ...found, inherited: true }
        saveState(getPid(), state2)
    }
}
```

**zcode**（`scripts/common.mjs` L481-531）：
```js
export function resolveBinding(common, sessionId) {
  // ① 自身直绑
  const selfBinding = loadBinding(common, sessionId)
  if (selfBinding && selfBinding.worktree) return { ...selfBinding, source: "self" }
  // ② DB parent 链继承（仅对子代理 session_id 尝试）
  if (sessionId && sessionId.startsWith("sess_subagent_")) {
    const inherited = resolveInherited(common, sessionId)
    if (inherited) {
      saveBinding(common, sessionId, { ...inherited, source: "inherited" })
      return { ...inherited, source: "inherited" }
    }
  }
  // ③ state.json 兜底（v0.1 仓库级单活动）
  const state = loadStateByCommon(common)
  if (state) return { worktree: state.path, branch: state.branch, base: state.base, source: "fallback-state" }
  return null
}
```

### 5.2 关键差异

| 维度 | opencode | zcode |
|---|---|---|
| parent 来源 | client API（`session.get(id).parentID`） | SQLite DB（`SELECT parent_id FROM session WHERE id=?`） |
| 调用方式 | 异步 await | 同步 execFileSync（实际上用 node:sqlite DatabaseSync） |
| 兼容性 | 跨 opencode 版本（API 稳定） | 耦合 zcode DB schema（升级风险） |
| 错误处理 | try-catch break | try-catch return null（fail-soft） |
| 缓存 | 进程内存 Map | 文件快照（持久化到 binding 文件） |
| 触发条件 | 任何 session | 仅 `sess_subagent_*` 前缀的 session |
| 兜底 | 无（祖先都没绑定就返回 null） | state.json（v0.1 兼容） |

### 5.3 评价

**opencode 的方式更稳健**：
- client API 是 opencode 官方契约，跨版本兼容
- 异步不阻塞事件循环
- 不耦合宿主内部实现细节

**zcode 的方式有特殊价值**：
- 同步调用避免异步竞态
- 直读 DB 不依赖网络/API（spawn 进程没有 API 可用）
- 但 schema 耦合是真实风险（zcode 升级改 session 表结构会破坏继承）

**结论**：这是**运行时模型决定的差异**，不应该互相借鉴。opencode 保留 client API；zcode 保留 SQLite。但 zcode 的"仅在 `sess_subagent_*` 前缀触发继承"的优化值得 opencode 学习——避免对每个 session 都查 parent（虽然 opencode 已有内存缓存，但首次解析仍可优化）。

---

## 6. 合并工作流对比

### 6.1 opencode：一键 preview/apply

```
worktree_merge(action="preview")   →  展示合并计划（目标分支、提交、diff、未提交变更数）
worktree_merge(action="apply")     →  自动提交未提交变更 → git merge --no-ff → 删 worktree → 删分支 → 解绑
```

**优点**：
- agent 可独立完成合并（用户只需说"合并它"）
- preview 明确展示影响范围
- 冲突安全回滚（`git merge --abort`）
- 主检出未提交已跟踪变更时拒绝合并（避免冲突）

**缺点**：
- 没有"用户明确授权"关——agent 看到 task 完成，可能主动调 merge 而不等用户确认
- 合并目标固定为主检出当前分支（不能指定 target）

### 6.2 zcode：三步授权流

```
echo '{"reason":"用户授权合并 worktree-X"}' | node wt.mjs authorize-main
git merge worktree-X
echo '{}' | node wt.mjs revoke-main
```

**优点**：
- 强制人工授权关（agent 无法自行合并）
- 授权期间全放行，结束后立即 revoke
- 审计日志记录授权原因

**缺点**：
- 必须分三次独立 Bash 调用（同命令内 authorize 还没生效 merge 就被静态扫描拦截）
- agent 无法独立完成合并，必须等用户介入
- 步骤多，易出错（用户/agent 忘记 revoke）

### 6.3 取舍

这是**哲学差异的直接体现**，不是技术问题：

- opencode "可选 worktree" → 合并是"完成 task 的最后一步"，agent 自主完成
- zcode "强制 worktree" → 合并是"对主分支的入侵操作"，必须人工授权

**互相借鉴**：
- opencode 可借鉴"授权关"作为 opt-in：`mergeRequiresAuth: true` 模式下，merge apply 前要求用户通过单独工具（`worktree_authorize`）授权
- zcode 可借鉴"一键合并"的便利性：在 authorize-main 已落盘的前提下，允许 agent 调用 `wt.mjs merge` 工具完成合并 + 自动 revoke（而不是手动 git merge）

---

## 7. 测试覆盖度对比

### 7.1 测试方法论差异

**opencode**（合计 16KB，52 个 test case）：
- `unit.test.js`：43 个纯函数单元测试（norm、isInside、rewritesToWorktree、validateBranch、slugify、applyInterception 各工具的决策路径）
- `lifecycle.test.js`：9 个端到端集成测试（真实临时 git repo，跑 prepare → 拦截 → merge preview/apply → cleanup 全链路）

**zcode**（60KB，14 个 describe block）：
- A. decideWrite 决策表（Write/Edit/Read 所有规则分支）
- A2. fail-closed（无绑定写保护）
- B. Glob/Grep 搜索路径重写
- C. Bash 危险操作拦截
- D. resolveBinding 三层降级
- E. allowlist 临时放行
- F. whitelist 声明式白名单
- F2. validateWhitelist 危险模式检测
- G. authorize-main / revoke-main
- H. wt.mjs 生命周期子命令
- I. SessionStart hook 4 分支
- J. matchGlob 纯函数
- K. 鲁棒性 / 边界
- L. 代码审查修复验证

### 7.2 取舍

| 维度 | opencode | zcode |
|---|---|---|
| 测试维度数 | ~10 个分类 | 14 个 describe |
| 端到端集成 | 9 个真实链路 | 主要是单元 |
| 决策表覆盖 | applyInterception 各工具一次 | 每条规则独立 case |
| 鲁棒性测试 | 较少 | 专门一节 |
| 代码审查修复验证 | 无 | 专门一节（说明经历过审查-修复循环） |
| 测试体量 | 16KB | 60KB |

**评价**：

- zcode 测试**广度更优**——每条决策规则都有独立 case，新增功能易回归
- opencode 测试**深度更优**——端到端跑真实 git，验证全链路正确性
- 两种方法论互补，**双方都应该向对方学习**：
  - opencode 应增加决策表独立 case（特别是 strict 模式新增规则后）
  - zcode 应增加端到端集成测试（验证 hook 真实管道行为）

---

## 8. 功能矩阵总览

| 功能 | opencode | zcode | 备注 |
|---|---|---|---|
| 工具层路径重写 | ✅ | ✅ | 核心机制，双方都有 |
| 系统提示词软引导 | ✅（绑定时注入） | ✅（SessionStart 注入） | zcode 更早注入 |
| 主分支写保护 | ❌ | ✅ | 哲学差异 |
| 危险 git 操作拦截 | ❌ | ✅ | zcode 独有 |
| 跨副本写入检测 | ❌ | ✅ | zcode 独有 |
| 逃生口（allow） | ❌ | ✅ | zcode 独有 |
| 声明式白名单 | ❌ | ✅ | zcode 独有 |
| 授权合并工作流 | 自动 | 强制三步 | 哲学差异 |
| 多 session 并行 | ✅ 基本支持 | ✅ 完善支持 | opencode 安全机制不足 |
| 原子写状态 | ❌ | ✅ | opencode 待补 |
| 多 session 悬空检查 | ❌ | ✅ | opencode 待补 |
| 子代理继承 | ✅ client API | ✅ SQLite | 各有优势 |
| worktree 路径配置 | 外部目录（默认） | 仓库内 `.worktrees/` | 设计取舍 |
| 文件同步（copyFiles） | ✅ | ❌ | opencode 独有 |
| 目录软链（symlinkDirs） | ✅ | ❌ | opencode 独有 |
| 钩子（postCreate/preDelete） | ✅ | ❌ | opencode 独有 |
| 配置占位符（$REPO/$HOME） | ✅ | ❌ | opencode 独有 |
| Windows junction 支持 | ✅ | ❌ | opencode 独有 |
| schema 版本管理 | ❌ | ✅ | zcode 独有 |
| 审计日志 | ❌ | ✅ | zcode 独有 |
| Bash cd 命令解析 | ❌ | ✅ | opencode 不需要（有 workdir） |
| protected branches | 配置项（仅 cleanup 用） | 配置项 + 拦截用 | zcode 用得更深 |
| 集成测试 | 9 个端到端 | 0 个（仅单元） | opencode 独有优势 |
| 决策表单元测试 | 部分 | 完整 | zcode 独有优势 |

---

## 9. opencode 项目即将实施的改造（决策记录）

基于上述对比，opencode-worktree-isolation 计划实施以下改造。记录决策理由供交流参考。

### 9.1 改造哲学

- **保持"可选 worktree"为默认**——不破坏现有用户行为
- **新增"strict 模式"作为 opt-in**——学 zcode 的强制工作流
- **多 session 安全机制默认开启**——这是 bugfix 不是 feature
- **配置分项而非单一开关**——给用户细粒度控制

### 9.2 Tier 1：纯 bugfix（零破坏，必做）

| # | 改造 | 借鉴自 | 理由 |
|---|---|---|---|
| 1 | 原子写 state 文件（tmp+rename） | zcode `writeJson()` | 单进程异步竞态真实存在 |
| 2 | 多 session 悬空检查（cleanup/merge 前） | zcode `findBindingsForWorktree()` | 并行误删是 bug |
| 3 | 决策表纯函数重构 | zcode `decideWrite()` | 可测试性提升 |

### 9.3 Tier 2：能力增强（opt-in，不破坏默认）

| # | 改造 | 配置形态 | 借鉴自 |
|---|---|---|---|
| 4 | 状态目录可选 git-common 模式 | `stateLocation: "external" \| "git-common"` | zcode 整体方案 |
| 5 | 主分支写保护 | `strictWrites: true` | zcode fail-closed 决策第 9 条 |
| 6 | 危险 git 操作拦截 | `strictGitOps: true` + `protectedBranches: []` | zcode 正则组 |
| 7 | 逃生口（allow + whitelist） | `mainWriteWhitelist` 配置 + `worktree_allow` 工具 | zcode 双套机制 |

**关于状态目录模式的决策**：保持 external 为默认，新增 git-common 作为 opt-in。理由：
- 不破坏现有用户行为（向后兼容）
- 给多 session 重度并行用户更好的选项
- 测试机制保持不变（OC_WT_STATE_DIR env 仍可用）
- 如果一段时间后用户反馈 git-common 稳定，可考虑改默认

**关于 strict 模式的决策**：分项配置而非单一开关。理由：
- 用户可能只想要"写保护"但不想要"git 操作拦截"（信任 agent 的 merge）
- 用户可能只想要"git 操作拦截"但不想要"写保护"（仍在自由模式但禁止危险操作）
- 单一开关颗粒度太粗，反而阻碍采纳

### 9.4 Tier 3：辅助增强（低优先级）

| # | 改造 | 借鉴自 |
|---|---|---|
| 8 | schema 版本管理（meta.json） | zcode SCHEMA_VERSION |
| 9 | 审计日志（audit.jsonl） | zcode appendAudit |
| 10 | SessionStart 纪律注入（仅 strict 模式） | zcode session_start.mjs |

### 9.5 不借鉴的点

| ❌ | 理由 |
|---|---|
| 直读 SQLite 做子代理继承 | opencode client API 更稳定，不耦合宿主 schema |
| 一键 merge 改三步授权 | opencode 一键流程是优势（agent 可独立完成）；授权关作为 opt-in 即可 |
| Bash cd 命令解析 | opencode bash 工具有 workdir 字段，直接注入，不需要解析命令串 |
| 把状态目录默认改为 git-common | 保持向后兼容；git-common 作为 opt-in |
| 每session一文件作为唯一方案 | external 模式下用单文件 + 原子写 + 悬空检查即可；git-common 模式下再用每session一文件 |

---

## 10. 反向借鉴：zcode 可从 opencode 学的点

这是双向交流，不是单方向。zcode 项目同样可以从 opencode 借鉴：

### 10.1 client API 继承机制（强烈推荐）

zcode 当前直读 SQLite DB 查 `session.parent_id`，耦合宿主内部 schema。如果 ZCode 未来暴露 hook 上下文中的 `parent_session_id`（即使只是 stdin 字段），可以避免 DB 耦合。

**建议**：向 ZCode 团队提 feature request，要求 PreToolUse stdin 增加 `parent_session_id` 字段。

### 10.2 worktree 路径在仓库外（推荐）

zcode 默认把 worktree 放在 `.worktrees/`，需要写 `.git/info/exclude` 防止污染。opencode 默认放 `~/.local/share/opencode/worktree/<pid>/<branch>`，主仓库 `.gitignore` 完全无需改动。

**建议**：zcode 增加 `worktreeParent` 配置支持外部目录（实际上 v0.2 已有此配置项，但默认仍是仓库内）。

### 10.3 配置丰富度（推荐）

opencode 的 `copyFiles` / `symlinkDirs` / `hooks.postCreate` / `hooks.preDelete` / `$REPO`/`$HOME` 占位符，zcode 都没有。这些对真实项目（特别是 node_modules 复用、构建钩子）很实用。

**建议**：zcode 引入这套配置模型。

### 10.4 Windows junction 支持（推荐）

opencode 在 Windows 上优先用 junction（`fs.symlinkSync(target, path, 'junction')`，无需管理员权限），失败回退 dir symlink。zcode 的 symlinkDirs 完全缺失，Windows 用户无法复用 node_modules。

**建议**：zcode 引入 Windows junction 支持。

### 10.5 集成测试（强烈推荐）

zcode 60KB 测试全是单元测试，没有任何端到端集成测试验证真实 hook 管道行为。opencode 的 `lifecycle.test.js` 用真实临时 git repo 跑全链路，能发现单元测试发现不了的问题。

**建议**：zcode 增加 lifecycle 集成测试（验证 hook 真实触发、跨进程协调、文件实际落地）。

### 10.6 一键合并（讨论）

zcode 的三步合并工作流虽然安全，但 agent 无法独立完成合并。可以考虑在 `authorize-main` 已落盘的前提下，提供 `wt.mjs merge` 工具完成合并 + 自动 revoke（合并的"apply 模式"），既保留授权关，又提升便利性。

---

## 11. 开放讨论问题（邀请 zcode 作者反馈）

以下问题没有标准答案，欢迎讨论：

### 11.1 状态目录是否有第三种选择？

external 和 git-common 各有利弊。是否有更优方案？例如：
- **混合模式**：sessions 字典放 external，但每个 session 的 binding 详情放 git-common（取长补短）
- **opencode 插件数据目录**：opencode 有 `~/.local/share/opencode/plugins/<plugin-name>/` 约定，可能比当前的 `worktree-workflow/` 更规范
- **XDG Base Directory 规范**：是否应该用 `XDG_DATA_HOME` 替代硬编码 `~/.local/share/`

### 11.2 strict 模式是否应该标准化？

如果两个项目都支持 strict 模式，是否应该统一配置 schema？例如：

```json
{
  "strict": {
    "writes": true,
    "gitOps": true,
    "protectedBranches": ["master", "main"],
    "sessionStartPrompt": true
  }
}
```

这样用户在 opencode 和 zcode 之间切换时，配置可以无缝迁移。

### 11.3 跨插件兼容性

如果用户在同一仓库同时启用 opencode-worktree-isolation 和 zcode-worktree-guard（理论上不会，但...），状态文件会冲突。是否应该约定互斥检测？

### 11.4 多 session 引用计数的语义

zcode 的悬空检查是"仍有其他 session 绑定就拒绝删除"。但 session 可能是僵尸（用户关了客户端但 binding 文件残留）。是否应该：
- 加 session 心跳/最后活动时间戳？
- 自动清理超过 N 天未活动的 binding？
- 还是接受"用户手动清理"？

### 11.5 Bash 命令拦截的强度

zcode 的 Bash 拦截正则只识别 `git` 直接开头的命令，`cd x && git merge` 会绕过。是否应该：
- 用 shell parser（如 `shell-quote`）拆分命令再分析？
- 还是接受"提高门槛即可"的语义？

### 11.6 授权合并的撤销窗口

zcode 的 `authorize-main` → `git merge` → `revoke-main` 三步流，如果用户/agent 在 authorize 后忘记 revoke，主分支写保护就持续失效。是否应该：
- authorize 自带 TTL（默认 60 秒后自动 revoke）？
- 还是依赖 SKILL 提醒和审计日志？

---

## 12. 总结

两个项目从不同运行时模型出发，走出了不同但都自洽的设计路径：

- **opencode-worktree-isolation** 把 worktree 作为可选隔离层，强调 agent 自由和用户体验
- **zcode-worktree-guard** 把 worktree 作为强制开发纪律，强调安全和遵循度

两个项目都解决了路径漂移问题，但在多 session 并行安全、强制 worktree、危险操作防御上有明显差异。**这些差异不是技术高下，而是哲学选择**。

opencode 项目计划借鉴 zcode 的多 session 安全机制、strict 模式、逃生口；同时保留自己的 client API 继承、配置丰富度、一键合并、集成测试优势。最终目标是支持双模式（自由 + 强制），让用户按需选择。

zcode 项目同样可以从 opencode 借鉴 client API 继承的稳定性、配置丰富度、Windows junction、集成测试。这是双向交流。

欢迎就第 11 节的开放问题交换意见。

---

**文档版本**: v1.0
**生成工具**: opencode-worktree-isolation 审查会话
**反馈渠道**: 请通过 GitHub issue 或直接联系作者交流
