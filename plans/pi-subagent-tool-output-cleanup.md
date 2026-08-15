# pi-subagent — 工具描述与 LLM 侧文本输出整改

> 背景：delegate/wait/check 实测（同步 + 异步三连）+ 代码审查后遗留的问题清单。
> 范围：**给主模型的工具描述与工具返回文本**。TUI 渲染层已统一（`finished`），不涉及。
> 已解决、无需处理：`files`/`context` 参数级描述已补齐；`summary` 字段只进 TUI/history 是设计使然（实测中 `## Summary` 区块是子代理按 role 格式写的，非插件问题）。

## 1. wait/check 状态词不一致（LLM 文本层）

- **现状**：wait 返回 `sub-2: succeeded`（`perId()` 直接输出 `r.state`），check 返回 `sub-2 (explorer): finished`（`formatCheckText`）。两个工具的描述也各自保留原词（wait 写 "succeeded/failed"，check 写 "finished"）。
- **正确**：LLM 文本层统一状态词。wait 的 `perId()` 复用 `terminalResultLine` 的 `succeededText` 机制（与 TUI 同词 `finished`），两个工具描述同步为同一状态词表 `queued / running / finished / failed`。

## 2. check 结果字段未入描述

- **现状**：check 的 finished 文本末尾拼统计行 `--- 1 turn ↑28k ↓1.5k $0.0021 deepseek-v4-flash ---`（轮次/上下行 token/花费/模型），描述只说 "with the full output as the run result"。
- **正确**：check 描述注明结果含统计行（turns/token/花费/所用模型），防止主模型把统计行误当正文。

## 3. delegate 同步路径描述缺失

- **现状**：只有 `background` 参数描述里 "instead of blocking" 的反面暗示，未正面说明默认同步时行为。
- **正确**：主描述或 background 参数描述正面说明：不传 `background` 时阻塞等待，直接返回完整结果（含统计行），不产生 id。

## 4. delegate 描述废话累赘

- **现状**：开头两句 "keep your own context clean and focused" 与 "Prefer this over doing work yourself when a task would generate many tool calls or verbose output" 语义重复，且是写给模型的策略建议而非功能说明。
- **正确**：合并为一句或删除，只留功能说明（隔离上下文、background 语义、参数要点）。

## 5. wait 输出缺 role 名

- **现状**：wait 的 perId 输出 `sub-2: succeeded` 无 role；check 头部 `sub-2 (explorer): finished` 有。等完多个 run 时仅凭 wait 输出无法识别 id 对应哪个 role。
- **正确**：wait 的 perId() 补 role 字段，与 check 头部格式对齐（`sub-2 (explorer): finished`）。
