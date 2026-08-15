# pi-subagent — 控制闭环：subagent_cancel 与 subagent_steer

> 目标：background 委派目前只有观察手段（wait / check / /subagent:status），没有干预手段。
> 主模型发现 run 走偏时只能眼睁睁等它烧完时间与预算。补两个工具闭环：
> **cancel** 放弃不再需要的 run，**steer** 给 running 的 run 发纠偏消息。

## 调研结论（2026-08-16，读 node_modules/@earendil-works/pi-coding-agent 源码确认）

- pi 根导出 `RpcClient`（`--mode rpc` 的程序化接口），原生方法与本需求一一对应：
  - `steer(message)` — "Queue a steering message to interrupt the agent mid-run"，连名字都一致
  - `abort()` — 中止当前操作
  - `followUp(message)` — 当前任务结束后接续下一条消息（本次不做，后续可评估链式任务免重开进程）
  - `prompt()` / `onEvent()` / `waitForIdle()` 等完整事件流接口
- RPC 模式限制：**不支持 `@file` 参数**（main.js 显式报错）→ 现有 files/context 渠道
  （靠 @file 注入）必须改为父进程自读文件、按 pi 的 `<file name="...">` 包装内联进 prompt
- 当前 transport `--mode json` 的 stdin 只在启动时读一次（piped 初始内容），不支持 mid-run
  注入 → **steer 无法在 json transport 上实现，必须迁 RPC**

## 决策

- **命名 `subagent_cancel`**：LLM 侧动词用 cancel（wait 描述已有先例 "Cancelling the wait
  never cancels the runs"）；abort 保留为机制词（AbortController / killProc("abort")）。
  与 finished/succeeded 一样"呈现词 / 机制词"分层——pi 自己的 RPC 也是机制名 abort()。
- **steer 必要，但要教克制**：一条纠偏消息远比重跑一个 900–3600s 的 run 便宜；描述需
  写明 mid-course correction 而非持续监督，根本性走偏用 cancel。
- **分两步交付**，每步独立可实测（遵循 PROVIDER.md 的实测方法论）。

## 第一步：subagent_cancel（现有 json transport，不依赖迁移）

- 引擎：`startSubagentRun` 内部持有 AbortController；foreground 的工具 signal 与
  `run.cancel()` 任一触发即中止——现有 gate.abort / spawn kill 链路原样复用
- `RunHandle` 增加 `cancel(): void`（幂等）
- 终态语义：state `failed`、`stopReason: "cancelled"`（`isFailedResult` 词表加入）、
  errorMessage "Cancelled via subagent_cancel"；partial output / activity 保留，check 仍可取回
- 边界：
  - 只作用于 top-level registry 的 background run（foreground 的主模型阻塞在自己调用里，无法 cancel）
  - 对已终态的 run 返回当前状态（`sub-1 (worker): finished — nothing to cancel`），无副作用
  - queued 的 run 也能 cancel（gate.acquire 的 abort 路径已支持）
- wait 联动：被 cancel 的 run promise resolve（failed），等待中的 wait 正常返回
- TUI：⏹ cancelled（warning 色——模型主动行为，不配 error 红 ✗）；实测定稿
- 工具参数 `{ id }`；description / guidelines / README（背景工具表加行）同步

## 第二步：transport 迁移 RpcClient + subagent_steer

- spawn.ts 从 child_process + `--mode json` 改为 `RpcClient`（根导出直接 import）：
  - `prompt()` 发初始任务；`onEvent()` 喂现有事件解析
  - `cliPath` 沿用 `getPiInvocation` 解析（Windows 兼容保留）
- files/context 渠道改造：@file 不支持 → 父进程读文件内容，`<file name="...">` 包装内联；
  大 context 的 temp-file spill 机制可保留（写临时文件再读回内联，或直接内联，实测定）
- subagent_steer 工具：
  - `{ id, message }`；仅 running 的 background run；queued → 提示等 running；终态 → 提示用 check
  - 返回 ack（`Steered sub-2 (worker): <preview>…`），不返回结果
  - 实现：`run.steer(text)` → `client.steer(text)`
  - 观测：注入消息镜像进 activityLog（新 kind `"userMessage"`），check/wait expanded 与 TUI 可见
- cancel 在迁移后简化：engine 侧 AbortController / `cancel()` 不变，底层 kill 换 `client.abort()`
  （第一步的引擎工作不浪费）
- **动手前 spike 清单（逐项实测，不盲写）**：
  1. RpcClient 事件流字段 vs 现有解析（message_end / tool_execution_start/end / message_update）
  2. `--tools` / `--append-system-prompt` / `--thinking` 在 RPC 模式是否生效（经 args 透传）
  3. 大 prompt（内联 file 后）传输是否有上限
  4. steer 在工具执行中到达的表现（排队到 turn 边界 or 立即打断）
  5. `abort()` 后进程退出行为与 exitCode

## 不做 / 后续

- `followUp`（链式任务）——steer 落地后评估
- steer 带 images——无场景
- nested run 的 steer（worker 纠偏自己的 explorer）——worker 模型阻塞在 delegate 调用中，无法发起
