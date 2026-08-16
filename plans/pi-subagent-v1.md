# pi-subagent — v1 收尾：subagent_cancel 与 /subagent:view

> v1 范围 = 最小干预 + 观测闭环补全：**cancel** 放弃不再需要的 run（干预），
> **view** 用户围观面板（观测）。
> 收件箱 reminder 与 check 收集（阅后即焚）已上线——cancel 产生的终态直接融入现有语义，
> 不需要任何配套改动。
> steer 与 transport 迁 RpcClient 归 v2（`plans/pi-subagent-v2.md`）。

## subagent_cancel — 现有 json transport，不依赖迁移

背景：background 委派目前只有观察手段（wait / check / `/subagent:status` / reminder），
没有干预手段。主模型发现 run 走偏时只能眼睁睁等它烧完时间与预算。

- 引擎：`startSubagentRun` 内部持有 AbortController；foreground 的工具 signal 与
  `run.cancel()` 任一触发即中止——现有 gate.abort / spawn kill 链路原样复用
- `RunHandle` 增加 `cancel(): void`（幂等）
- 终态语义：state `failed`、`stopReason: "cancelled"`（`isFailedResult` 词表加入）、
  errorMessage `"Cancelled via subagent_cancel"`；partial output / activity 保留，
  check 仍可取回
- 边界：
  - 只作用于 top-level registry 的 background run（foreground 的主模型阻塞在自己
    调用里，无法 cancel）
  - 对已终态 run 返回当前状态（`sub-1 (worker): finished — nothing to cancel`），
    无副作用；对已 collected 的 id 按收件箱语义报 already collected
  - queued 的 run 也能 cancel（gate.acquire 的 abort 路径已支持）
- wait 联动：被 cancel 的 run promise resolve（failed），等待中的 wait 正常返回
- **收件箱联动**（零改动自然生效）：cancelled 是终态 → 留在收件箱（failed 行带
  cancelled 原因），直到模型 check 收集；reminder 的字节稳定规则不变
- TUI：`⏹ cancelled`（warning 色——模型主动行为，不配 error 红 ✗）；实测定稿
- 工具参数 `{ id }`；description / guidelines / README（背景工具表加行）同步——
  遵循 AGENTS.md 文案分层契约（cancel 的"何时用"归 guidelines，机制归 description）

## /subagent:view — 用户发起的动态观察面板

现状：`/subagent:status` 是静态 notify 快照，`subagent_wait` 的实时视图只有 agent
（发起 wait 调用）能看到。用户想围观"agent 们在干什么"时没有入口——要么反复敲
status 看断片，要么看 wait 的工具行（那是 agent 的行为，用户不能要求）。

### 定位

- **用户侧纯观测**，零 LLM 影响：不动工具、不动 description/guidelines、不动 reminder
- 观测体系三层各归其位：
  - 模型侧：inbox reminder（每轮 LLM 调用，已上线）
  - 用户侧静态：`/subagent:status`（notify 快照，含 collected 历史）
  - 用户侧动态：`/subagent:view`（本篇）

### 行为

- `pi.registerCommand("subagent:view", ...)`，打开全屏 overlay（`ctx.ui.custom` +
  `overlay: true`）
  - 全屏而非底部面板：用户主动进入的"观看模式"，参考会话选择器的模态性质；Esc
    退出即回聊天区。底部 `overlay: false` 槽位留给需要边看聊天边操作的交互面板
    （AGENTS.md 经验区），观察场景无此需求
- 无 active run 时不开空面板：notify "No background runs."（与 status 空态同文案）
- RPC 模式降级：`ctx.ui.custom` 不可用时回退到 status 的静态输出并提示 view 需要 TUI

### 数据与生命周期

- 数据源 = `backgroundRuns`（active only）。collected 是墓碑、无 live 语义，不入
  面板——底部一行 dim 提示 `N collected (see /subagent:status)` 即可
- **面板打开期间 registry 变化的镜像**（view 相对 status 的核心价值）：
  - 新 delegate → 面板多一行
  - run 终态 → 该行切终态渲染
  - 模型 check 收集 / cancel → 该行消失（面板即收件箱的可视化，和 reminder 同一语义）
- 刷新机制：
  - 事件驱动：throttle（复用 `createThrottler`）聚合所有 run 的 `subscribe()` 通知
    触发重绘；每次重绘时 diff registry keys vs 已订阅集合，补订新增 run（打开后才
    delegate 的也能进来）
  - 时钟驱动：1s ticker 重绘——running 行的 elapsed/budget 计时不依赖事件到达
    （沿用 45a1378「计时器按秒实时刷新」的既有做法）
- 退出清理：unsubscribe 全部 + 清 ticker + 取消 trailing throttle（沿用 delegate 的
  progressThrottle.cancel 模式，防 TUI 状态腐坏）

### 渲染

- 复用 wait 视图的行渲染：从 render-async.ts 导出 `waitStatusLine` /
  `waitEntryCollapsedText` / `waitEntryExpandedContainer`（改 export，或包一层
  `buildRunEntryView(entry, { expanded })`），view 面板与 wait 工具行共享同一套视觉
- 布局：每 run 一个块（collapsed 摘要 + 最近 5 条活动），上下键选中、Enter/Tab 展开
  （展开 = 全活动流 + usage + 终态 result 行）、Esc/q 关闭
- 键盘处理参考 pi-ask-user 的 `AskUserPanel`（`ctx.ui.custom` 组件工厂内接管焦点的
  成熟模式）

## 不做（归 v2 或后续）

- steer / followUp / nested run 纠偏 → v2
- view 面板内的操作（选中 run 按 c 取消等 UI 入口）→ cancel 工具先给模型；用户侧
  UI 入口等 v2 一起评估
