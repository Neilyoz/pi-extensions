# pi-subagent — v2：transport 迁 RpcClient + subagent_steer

> v2 = 让主模型能给 running 的 run 发纠偏消息（steer）。前置是 transport 迁移：
> 现有 `--mode json` 的 stdin 只在启动时读一次，不支持 mid-run 注入，steer 无法
> 在 json transport 上实现，必须迁 RPC。
> v1 已交付 cancel（引擎持 AbortController + `RunHandle.abort(reason)`，终态 stopReason
> `cancelled`）——迁移后引擎侧不变，底层 kill 换 `client.abort()`，第一步的工作不浪费。

## 调研结论（2026-08-16，读 node_modules/@earendil-works/pi-coding-agent 源码确认）

- pi 根导出 `RpcClient`（`--mode rpc` 的程序化接口），原生方法与本需求一一对应：
  - `steer(message)` — "Queue a steering message to interrupt the agent mid-run"，
    连名字都一致
  - `abort()` — 中止当前操作（cancel 的 kill 链路换成它）
  - `followUp(message)` — 当前任务结束后接续下一条消息（本次不做，后续可评估链式
    任务免重开进程）
  - `prompt()` / `onEvent()` / `waitForIdle()` 等完整事件流接口
- RPC 模式限制：**不支持 `@file` 参数**（main.js 显式报错）→ 现有 files/context 渠道
  （靠 @file 注入）必须改为父进程自读文件、按 pi 的 `<file name="...">` 包装内联进 prompt
- 命名沿用 v1 决策：LLM 侧动词用 cancel（呈现词），abort 保留为机制词
  （AbortController / `client.abort()`）——与 finished/succeeded 一样"呈现词 / 机制词"分层

## transport 迁移：spawn.ts → RpcClient

- spawn.ts 从 child_process + `--mode json` 改为 `RpcClient`（根导出直接 import）：
  - `prompt()` 发初始任务；`onEvent()` 喂现有事件解析
  - `cliPath` 沿用 `getPiInvocation` 解析（Windows 兼容保留）
- files/context 渠道改造：@file 不支持 → 父进程读文件内容，`<file name="...">` 包装
  内联；大 context 的 temp-file spill 机制可保留（写临时文件再读回内联，或直接内联，
  实测定）
- cancel 在迁移后简化：engine 侧 AbortController / `abort(reason)` 不变，底层 kill
  换 `client.abort()`

## subagent_steer

- 工具参数 `{ id, message }`；仅 running 的 background run；queued → 提示等 running；
  终态 → 提示用 check；已 collected → 按收件箱语义报错
- 返回 ack（`Steered sub-2 (worker): <preview>…`），不返回结果
- 实现：`run.steer(text)` → `client.steer(text)`
- 观测：注入消息镜像进 activityLog（新 kind `"userMessage"`），check/wait expanded 与
  TUI 可见
- 教克制（文案分层）：description 写机制（发一条纠偏消息给 running 的 run），
  guidelines 写政策——mid-course correction 而非持续监督；一条纠偏消息远比重跑一个
  900–3600s 的 run 便宜；根本性走偏用 cancel

## 动手前 spike 清单（逐项实测，不盲写）

1. RpcClient 事件流字段 vs 现有解析（message_end / tool_execution_start/end /
   message_update）
2. `--tools` / `--append-system-prompt` / `--thinking` 在 RPC 模式是否生效（经 args 透传）
3. 大 prompt（内联 file 后）传输是否有上限
4. steer 在工具执行中到达的表现（排队到 turn 边界 or 立即打断）
5. `abort()` 后进程退出行为与 exitCode

## 不做 / 后续

- `followUp`（链式任务）——steer 落地后评估
- steer 带 images——无场景
- nested run 的 steer（worker 纠偏自己的 explorer）——worker 模型阻塞在 delegate
  调用中，无法发起
- view 面板内选中 run 发 steer 的 UI 入口——模型侧工具先行，用户侧 UI 再评估

## 交付记录（2026-08-23）

计划主体已交付（transport 迁 RPC + subagent_steer + view 面板），commit 003c9a3。
与计划的偏差及理由：

- **未引入 RpcClient**：用裸 spawn + `--mode rpc` 的 JSONL stdin/stdout 直连。
  现有事件解析逻辑原样复用，少一层客户端抽象；代价是 abort 未换
  `client.abort()`，cancel 仍走 SIGTERM→SIGKILL kill 链路（实测可用）。
- **activityLog kind 命名**：计划的 `"userMessage"` 落地为 `"steer"`——feed 里
  它和 thinking/toolCall/text 并列，名字跟机制对齐比跟来源对齐清楚。
- **view 面板从"不做/后续"提前落地**（issue #5）：居中 overlay、标签页切换焦点
  run、连续 append-only 列表、running 条目省略号动画、底部输入框 steer；
  steer 目标跟随焦点 run。
- **计划外发现的关键坑**：RPC 模式是常驻服务（rpc-mode.js 结尾
  `return new Promise(() => {})`），任务完成不会退出——必须在收到 `agent_end`
  后主动关闭父进程侧 stdin，子进程的 onInputEnd 才会触发优雅退出。
- **spike 清单的实测结论**：`--tools`/`--append-system-prompt`/`--thinking`
  经 argv 透传在 RPC 模式全部生效；@file argv 确认不支持（main.js 显式报错），
  files/context 改为父进程读文件后以 `<file name="...">` 内联进初始 prompt，
  spill-to-tmpfile 机制随之删除（stdin 无 argv 长度限制）。

后续可评估：followUp（链式任务）、nested run 的 steer。
