# Worktree Workflow Plugin 设计文档

> **任务来源**: 用户希望以 sven1103-agent/opencode-worktree-plugin 的"工具层拦截"设计为蓝图，自建一个 opencode worktree 插件，彻底解决路径漂移问题；放弃此前试用的 @ykaratkou/opencode-worktree（单 commit 快照、不维护、启动报 ERROR）。
> **任务内容**: 设计并实现一个 opencode 插件，提供 worktree 创建/清理工具，并通过 `tool.execute.before` hook 在工具层强制将会话的仓库写操作路由到绑定的 worktree，从机制上消除路径漂移。
> **参考文档**:
> - `https://github.com/sven1103-agent/opencode-worktree-plugin` — 拦截设计蓝图（但其发布版本因运行时契约错误而功能失效，见 issue #62 / PR #66）
> - `https://github.com/kdcokenny/opencode-worktree` — worktree 生命周期、projectId、文件同步、延迟清理等已验证设计（698⭐，活跃）
> - `sst/opencode` v1.18.14 源码 `packages/opencode/src/plugin/index.ts` — trigger 实现，证明 hook 契约
> - `@opencode-ai/plugin` dist/index.d.ts + tool.d.ts — Hooks 类型签名、ToolDefinition 形状
> **生成日期**: 2026-08-06

## 1. 目标 / 非目标

**目标**
- 彻底消除路径漂移：在工具层硬路由，会话↔worktree 绑定，agent 无需也无法手动 cd
- Windows 优先（用户环境为 win32 / PowerShell 5.1）
- 自有代码、可锁定、可审计；依赖仅 `@opencode-ai/plugin`（opencode 宿主 API）+ `zod`（成熟库）
- 用**正确的运行时契约**实现拦截，绕过 sven1103 撞过的墙

**非目标（v1）**
- 不做跨平台终端启动（拦截模式下不开新终端，当前会话原地路由）
- 不做多仓库 workspace（NeverMore93 那套）
- 不做 CLI 回退 / slash 命令 / skill（sven1103 的附加面）
- 不发布到 npm（本地包即可）

## 2. 契约证据（已实测验证）

| # | 契约 | 证据 |
|---|---|---|
| C1 | `tool.execute.before` 中**原地修改 `output.args`** 生效 | 探针实验：write 工具的 `filePath` 被改写后，文件实际落地到改写后的路径；agent 报告"写入原名"却毫不知情 |
| C2 | hook 内 `throw` 会**阻断工具调用**并把错误回传给 agent | 探针实验：`echo PROBE_BLOCK` 被拦截，bash 工具返回我们的 Error 文本 |
| C3 | opencode 的 trigger **丢弃 hook 返回值**，只承认对 `output` 的原地修改 | sst/opencode v1.18.14 `plugin/index.ts` 的 `trigger` 实现：`await fn(input, output); return output` |
| C4 | sven1103 失败的根因 = 用了"返回新对象"而非原地修改 | 其 PR #66 描述："mutate hook payloads **in place** ... instead of relying on replaced `output.args`"；该 PR 未合并，仓库失联 |
| C5 | 所需 hook 全部存在于当前 `@opencode-ai/plugin` | `tool.execute.before`、`tool.execute.after`、`experimental.chat.system.transform`、`command.execute.before`、`event` 均在 index.d.ts 中 |
| C6 | 工具 context 直接提供 `sessionID` / `directory`(仓库根) / `worktree` | `tool.d.ts` 的 `ToolContext` 类型；无需额外查询 API |
| C7 | 本地文件插件可用 `tool()` 工厂 + zod，前提是本地 node_modules 提供 `@opencode-ai/plugin` + `zod` | 探针2 实验：裸 import 在无 node_modules 时静默失败；在 probe/ 装 `@opencode-ai/plugin@1.17.4` + `zod` 后，`probe2_hello` 工具成功注册 |

## 3. 架构总览

单入口 ESM 插件 `plugin/index.js`，导出一个 `Plugin` 函数（opencode legacy 加载器调用），返回 `{ tool, "tool.execute.before", "experimental.chat.system.transform", event }` 钩子。

```
worktree_prepare(title, branch?, baseBranch?)
        │
        ├─ git worktree add → 创建独立工作目录 + 分支
        ├─ 文件同步 (copyFiles / symlinkDirs-junction)
        ├─ postCreate hooks (win32: cmd /d /c ; 否则 bash -c)
        └─ 写入 state: sessions[sessionID] = { branch, path, repoRoot, title, createdAt }

tool.execute.before(input, output)   ← 每次 tool 调用都触发
        │
        ├─ 若 input.tool 以 worktree_ 开头 → 直接放行（不拦截自己的工具）
        ├─ binding = resolveBinding(sessionID)  // 直接绑定 or 懒继承祖先链
        ├─ 无 binding → 直接放行（普通会话不受影响）
        └─ 按 input.tool 路由：
             write/edit/read  → filePath 前缀改写 R→W；.git 路径拦截
             glob/grep        → 缺 path 注入 W；path∈R 改写为 W
             bash             → 缺 workdir 注入 W；命令串含 R 则字符串替换为 W
             task             → 放行（子会话由懒继承覆盖）
             其他             → 放行

experimental.chat.system.transform(input, output)
        └─ 若 sessionID 已绑定 → output.system.push(工作区上下文块)

event({ event })
        └─ session.idle 事件：处理 pendingDelete（preDelete hooks + git 快照提交 + worktree 移除）

worktree_cleanup(action, branch?)
        ├─ preview: 列出所有插件管理的 worktree + 合并/脏状态
        └─ apply: 仅删已合并分支（protectedBranches 永不动；未合并需 force）
```

## 4. 分发形态（关键决策）

**结论**：本地小包 + 本地 node_modules，相对路径注册。

- `plugin/package.json` 声明依赖：`@opencode-ai/plugin@1.17.4`、`zod@^3.23.8`（均为成熟库，版本锁定可审计）
- `opencode.json`：`"plugin": ["./plugin/index.js"]`
- 用真正的 `tool()` 工厂 + `tool.schema`(=zod)，opencode 的 zod→JSON Schema 转换器必然兼容

**为何放弃"纯零依赖单文件"**：契约 C7 证明，本地文件插件的 bare import 需要 node_modules 提供解析；`ToolDefinition.args` 必须是真正的 zod `ZodRawShape`（opencode 用 zod 内部元数据生成 JSON Schema 给模型），伪造不现实。"零第三方 npm 包"和"供应链安全"是两回事——我们拥有全部业务代码，依赖仅这两个被广泛使用、可锁定的库，风险面极小，远优于依赖一个失联作者的单 commit 快照。

## 5. 状态管理

**位置**：`~/.local/share/opencode/worktree-workflow/{projectId}.json`（projectId 见下）

**结构**：
```json
{
  "sessions": {
    "<sessionId>": {
      "branch": "wt/fix-auth",
      "path": "C:/Users/.../worktree/<projectId>/wt/fix-auth",
      "repoRoot": "F:/workspace_2/oc-plugin",
      "title": "修复登录",
      "createdAt": "2026-08-06T..."
    }
  },
  "pendingDelete": { "branch": "...", "path": "..." }
}
```

**projectId**（继承 kdcokenny 的稳定设计）：根提交哈希 `git rev-list --max-parents=0 --all`（取排序后第一个），失败回退 `sha256(repoRoot).slice(0,16)`。同一仓库的所有 worktree 共享 id。

**并发**：v1 接受 last-write-wins（绑定写入频率极低：仅 prepare/cleanup 时）。

## 6. 工具定义

### worktree_prepare
- **args**（zod）：`title: string`、`branch?: string`、`baseBranch?: string`
- **流程**：
  1. 校验 title/branch（手写分支名校验：禁控制字符、禁 `-` 开头、禁 `..`/`@{`/`.lock`、禁 git 特殊字符 `[~^:?*[\]\\;&|\`$()]`）
  2. 解析 baseBranch（参数 > 配置 > HEAD）
  3. `worktreePath = worktreeRoot/{projectId}/{branch}`（默认 root = `~/.local/share/opencode/worktree`）
  4. `git worktree add [-b branch] worktreePath [base]`（数组 argv，不进 shell）
  5. 文件同步：copyFiles（复制）、symlinkDirs（win32 优先 junction，回退 symlink）
  6. postCreate hooks：win32 用 `cmd /d /c "<cmd>"`，否则 `bash -c "<cmd>"`
  7. 写入 state：`sessions[ctx.sessionID] = {...}`
  8. 返回结构化文本（worktree_path、branch、repoRoot）
- **context 来源**：`execute(args, ctx)` 的 `ctx.sessionID`、`ctx.directory`(=repoRoot)

### worktree_cleanup
- **args**：`action: "preview" | "apply"`、`branch?: string`（apply 时指定；省略则处理所有已合并）
- **preview**：遍历 state.sessions，对每条记录查 `git worktree list`、`git branch --merged <base>`、`git status --porcelain`，输出表格
- **apply**：对每条匹配（已合并且非 protected）：
  1. preDelete hooks
  2. `git worktree remove --force <path>`
  3. `git branch -d <branch>`（仅已合并；force 时用 `-D`）
  4. 从 state 移除记录
- **protectedBranches**（配置）永不删除

## 7. 拦截规则（核心）

### 路径归一化（Windows 感知）
- 比较前统一 `path.resolve` + 大小写不敏感（win32）+ 分隔符归一
- `isInside(p, base)`：`resolve(p).toLowerCase()` 以 `base.toLowerCase() + sep` 为前缀
- **`R/.git` 永不改写**（命中即 throw 拦截）

### 规则表（仅对已绑定会话生效）
| input.tool | 缺省参数 | 已含仓库根路径 |
|---|---|---|
| write / edit / read | —（这些工具要求绝对路径） | `filePath` 前缀 R→W 改写；命中 R/.git 则 throw |
| glob / grep | 注入 `path = W` | `path == R` 或 `path ∈ R` → 改写为 W |
| bash | 注入 `workdir = W` | 命令串中所有 R 的出现（含正反斜杠两种形态）→ 字符串替换为 W；替换后仍残留 R（大小写不敏感）→ throw |
| task | 放行（子会话靠懒继承） | — |
| worktree_* / 其他 | 放行 | — |

### 懒继承（子 agent 防漂移）
`resolveBinding(sessionID)`：
1. 直接查 `state.sessions[sessionID]` → 命中返回
2. 未命中：经 `ctx.client.session.get` 沿 `parentID` 链上溯（深度 ≤ 10，结果按 sessionID 缓存到内存 Map）
3. 祖先有绑定 → 把绑定**复制**到当前 sessionID（持久化到 state）→ 返回
4. 都没有 → 返回 null（放行）

这样从已绑定会话经 `task` 派生的子会话，首次工具调用时自动继承绑定，工具调用被正确路由到 worktree——sven1103 都没做到这一步。

## 8. system prompt 注入

`experimental.chat.system.transform(input, output)`（output.system 是 `string[]`）：
- 若 `resolveBinding(input.sessionID)` 命中 → `output.system.push(context块)`：
  ```
  ## Active worktree workspace
  You are operating in git worktree <W> (branch <B>), bound to repo <R>.
  All repository file operations are automatically routed to <W>. Do not
  manually cd elsewhere; do not edit files under <R> directly.
  ```
- 这是"软提醒"，配合工具层"硬路由"双保险

## 9. 配置（sidecar）

仓库根 `.opencode/worktree-workflow.json`（纯 JSON，不引 jsonc-parser）：
```json
{
  "branchPrefix": "wt/",
  "baseBranch": null,
  "worktreeRoot": null,
  "protectedBranches": [],
  "sync": { "copyFiles": [], "symlinkDirs": [] },
  "hooks": { "postCreate": [], "preDelete": [] }
}
```
`worktreeRoot` 支持 `$REPO`/`$HOME` 占位符；缺省 `~/.local/share/opencode/worktree`。

## 10. Windows 专项

- 所有路径比较：`resolve` + 大小写不敏感 + 分隔符归一
- `symlinkDirs`：win32 优先 junction（`fs.symlinkSync(target, path, 'junction')`，无需管理员权限），失败回退 dir symlink
- hooks 执行：win32 `cmd /d /c`，其余 `bash -c`
- **完全不涉及终端启动**（拦截模式无需）
- 长路径：worktreeRoot 在用户目录下，深度安全

## 11. 文件布局

```
F:\workspace_2\oc-plugin\
├── DESIGN.md                  ← 本文档
├── opencode.json              ← "plugin": ["./plugin/index.js"]
├── plugin/
│   ├── package.json           ← deps: @opencode-ai/plugin@1.17.4, zod
│   ├── index.js               ← 插件主入口（导出 Plugin 函数）
│   └── lib/                   ← （可选拆分）projectId / state / intercept / git-util
├── probe/                     ← 契约证据（保留供未来 opencode 升级时复测）
│   ├── probe-plugin.js        ← C1/C2 证据
│   ├── probe2-plugin.js       ← C7 证据
│   └── package.json
└── .gitignore                 ← node_modules/ 等
```

## 12. 验证计划

1. **注册检查**：一次性 run，工具列表含 worktree_prepare/worktree_cleanup，无 ERROR
2. **复现 issue #62**（核心）：prepare → write 文件 → **文件应落在 worktree 而非仓库根**（sven1103 在此失败）
3. **子 agent 继承**：prepare → task 子 agent 写文件 → 落在 worktree
4. **bash 路由**：prepare → bash `echo x > f.txt`（不带 workdir）→ 落在 worktree
5. **未绑定会话不受影响**：新会话不 prepare → 写文件正常落仓库根
6. **清理**：cleanup preview/apply → worktree 移除、分支删除、state 清空
7. **Windows 路径**：反斜杠路径、大小写混合、含 `.git` 的路径被拦截

## 13. 已知风险 / 未来工作

**风险**
- `tool.execute.before` 在热路径（每次工具调用都触发）：未绑定会话 = 1 次 Map 查找即返回；绑定会话才走分支逻辑——可接受
- bash 命令串字符串替换 R→W：若命令里把仓库根路径当普通文本引用（如 echo 消息含路径），也会被替换——符合"别碰主仓库"的意图，可接受
- zod 版本与 opencode 内部转换器的兼容：锁定 1.17.4（与 oh-my-openagent 同栈，已验证可加载）；opencode 升级时需用 probe/ 复测

**未来工作**
- slash 命令（/wt-new、/wt-clean）作为 prompt shim
- skill（教 agent 何时该隔离）
- 并发写入用文件锁替代 last-write-wins（若多 worktree 同时 cleanup 出现竞争）

## 14. 自审记录（按 AGENTS.md 创造性任务流程）

- **能否达成目标**：是。所有核心机制均已实测（C1-C7），设计把 sven1103 的意图映射到正确契约；子 agent 漂移用懒继承覆盖，比蓝图更完整。
- **副作用/破坏性**：拦截仅对已绑定会话生效（普通会话零影响）；`.git` 路径永不改写；cleanup 默认 preview、apply 只删已合并分支——安全。
- **更简单的替代**：考虑过"内存态 state、跳过懒继承"——均被否决（前者重启丢绑定；后者子 agent 漂移是真实漏洞，用户最恨漂移）。
- **遗漏**：`task` 子 agent 路径已用懒继承处理；bash 串替换的边角（8.3 短名、混合大小写）记为 v1 已知限制。
