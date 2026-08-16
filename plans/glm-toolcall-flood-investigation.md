# GLM-5.3 toolcall 洪水事故调查（2026-08-16）

> **用途**：send_to 注入后 agent 喷出大量 "Operation aborted" toolcall 刷屏事故的完整调查记录。再遇到同类现象（工具格洪水/全部 abort/不落盘）直接按本文档的排除树和证据模式走，不用重新翻源码。
> **现场**：Polymerium 项目，session `2026-08-16T14-04-17-626Z_01a00ae3-355a-787f-9b32-6608fb8b2685.jsonl` idx 98（已 /tree 回退但 append-only 未覆盖）。模型 GLM-5.3，provider `zai-coding-cn`（pi 官方内置，openai-completions API，compat 带 `zaiToolStream: true` / `thinkingFormat: "zai"`）。

---

## 1. 现象（用户一手观察）

- 触发条件：其他 agent 经 pi-chat-room `send_to` 发来大段工作汇报（`[From: AzureReed]`，约 60 行），本 agent 正在执行跨文件批量 edit 任务的中途。两次复现均在消息注入后；第三次 /tree fork 重发同消息则全程正常（概率性触发）。
- 表现：assistant 开始吐 toolcall，**一秒 3-4 个、逐个出现、一出现就是红色 "Operation aborted"**，持续刷屏约 84 秒，直到用户按 ESC。内容前段是真实任务的延续（edit 各个不同文件、grep、bash 构建、send_to 回复），后段彻底无章法：`subagent_check {"id":"nonexistent"}`、`web_search "noop"`、`fetch_content example.com`、`ocr_image /nonexistent.png`、`ffind noop`、`mcpScript {"code":"noop"}`……把词表里剩余工具全部枚举一遍，参数全是占位符。全程无 thinking 展示。
- **这些 aborted toolcall 全部不落盘**：session 里没有任何对应的 toolResult，只有一条 `stopReason: "aborted"` 的 assistant 消息本体（内容含 32 个 toolCall 块）。

## 2. 排除项（都已查证，勿重查）

| 假说 | 排除依据 |
|------|----------|
| file-mutation-queue 死锁（多文件 edit 挂起） | pi 的 `withFileMutationQueue` 是 per-file 队列且 `finally` 必然 release；不同文件并行，无全局锁（`pi-coding-agent/dist/core/tools/file-mutation-queue.js`） |
| hashline-edit 自身 bug | 洪水包含全部工具种类（list_skills、mcp、web_search…），与 edit 实现无关 |
| LLM 高频多轮调用 + 每轮被 abort | **证伪**：那会落盘大量 isError toolResult + 多条 assistant 消息；实际只有**一条** assistant + **零** toolResult |
| pi retry 机制反复起新 run | `isRetryableAssistantError` 只认 `stopReason==="error"`，aborted 不可重试（`pi-ai/dist/utils/retry.js:166`）；且 `_checkCompaction` 对 aborted 直接跳过 |
| abort signal 意外提前 abort 但 LLM 流未死 | zai 走 openai-completions，signal 全程接入 fetch 与 provider-retry（`retryProviderRequest` 对 abort 处理干净）；若 signal 死则 LLM 流也会死、runLoop 会退出，与"84 秒连续生成"矛盾 |
| 本仓库扩展调 `ctx.abort()` | 全仓库审计：唯一同步 invalidate 是 pi-hashline-edit 的 render 双渲染 bug（已修，e20590f），与 abort 无关；pi-subagent 只在 setInterval 里异步 invalidate（安全模式）；无扩展调 abort |
| 主题 pending 色混淆（pending 被看成红） | light/dark 两主题 `toolPendingBg` 均为蓝灰（#e8e8f0/#282832），`toolErrorBg` 才是红调（#f0e8e8/#3c2828） |
| /tree 回退覆盖了事故记录 | `branch()`/`resetLeaf()` 只改内存 leaf 指针，session 文件 append-only，证据保留 |

## 3. 关键证据（session idx 98 解剖）

```
[0]  THINKING  17455 ch —— 完好无损
[1]  TEXT       233 ch（任务总结）
[2..33] 32 个 toolCall，84 秒内吐完（thinking 结束后 emission 阶段约 1 秒 3-4 个）
```

- **thinking 三段抽读全部正常**：头段准确理解 AzureReed 汇报；中段是精确的 edit 重做计划（文件+行号级）；尾段决策清晰（"不该我授权他们的提交……做完 edits 后发一个 send_to ack"），最后一句 "Let me execute edits now."
- **前 13 个调用忠实执行该计划**：7 edit（与 thinking 清单精确对应）→ grep → 3 bash（构建验证）→ send_to。**第 14 个起才是垃圾**（nonexistent/noop/dummy/example.com 字面量）。
- **发射中段出现物理性损坏**：edit 参数 `{"edits":[{}]}`、`"hash”: ":"line": 220"`（中文弯引号混进 JSON key）。正常写 JSON 的模型不会把弯引号写进 key——**解码器故障会**。
- 垃圾段形态 = 工具词表枚举 + 占位符填充，且无任何 thinking 夹在中间。

## 4. 结论

**问题在模型（zai 服务端）的 toolcall 发射阶段，不是 pi、不是 hashline-edit、不是 send_to。**

- 推理完好 + emission 崩溃 + 弯引号 JSON 损坏 + 词表枚举 → 教科书级的**解码/生成故障**，不是"模型想歪了"。GLM 的 `tool_stream: true`（toolcall 参数流式增量传输）直接涉嫌——超长 thinking（17K）之后的 tool 流式发射是最可疑的故障窗口。
- send_to 注入只是**触发概率放大器**：长任务中途、6 个 toolResult 之后插入异质长文本，两次复现都撞上它，第三次没有。chat-room 的 steer 投递本身机制正常（排队不打断、不 abort）。
- 模型**从未收到任何工具结果**（0 执行 0 回传）——"调用→失败→看到失败→再调用"的回路不成立；"逐步崩塌的推理感"实际是开头 84 秒 thinking 的折叠渲染。
- 用户按 ESC 前，32 个调用一个都没执行；红色 "Operation aborted" 是 pi 的 abort 批量填充（`interactive-mode.js` message_end 处理：对全部 pendingTools 统一 `updateResult({text:"Operation aborted", isError})`）。**若不按 ESC**：流自然结束后 stopReason=toolUse，32 个调用会全部真实执行（4 个真 edit 写盘 + 28 个垃圾调用返回错误）——ESC 是正确操作。

## 5. 未解之谜

"格子一出现就是红色、且在按 ESC 之前"——按 pi 源码，流式期间新建格子只有 pending 蓝灰一条路，变红只发生在 message_end 批量填充（或真实执行出错，已排除）。**源码解释不了这个一手观察**。不影响主结论（0 执行是落盘数据）。再复现时截图或 `/debug` 是唯一能钉死它的手段。

## 6. 再遇到时的应对与排查清单

1. **立即 ESC**——掐掉执行比什么都重要（不按 = 垃圾调用全部真实执行）。
2. 找证据：session jsonl append-only，/tree 回退不丢。搜索模式：`stopReason:"aborted"` 的 assistant 消息 + 数其 toolCall 块数 + 确认其后有无 toolResult。**搜 toolResult 里的 abort 文本是错误方向**（执行从未发生）。
3. 区分两种洪水：
   - 单条 assistant 巨量 toolCall + 0 toolResult → 本文档情形（模型 emission 崩溃）；
   - 多条 assistant 夹 isError toolResult → 真执行失败回路（另查）。
4. 概率性触发：同消息重发可能正常，不代表已修复。

## 7. 待办（未提交）

- [ ] 给智谱提 issue：附本文档 §3 特征（reasoning 完好 + emission 崩溃 + 弯引号 JSON + 词表枚举 + tool_stream 涉嫌）。
- [ ] 给 pi 上游提 issue：① 单条 assistant 消息 toolCall 数量上限（超阈值拒绝执行要求重发）；② 退化签名检测（字面量 noop/dummy、JSON 参数损坏率、工具名词表枚举）——两道闸任一都能把事故截在执行前。
- [ ] （低优先级、效果存疑）hashline-edit README 加一句：单条响应内并行 edit 保持个位数；`one edit with multiple ops` 是同一文件内的批量化，不是鼓励跨文件大并行。
