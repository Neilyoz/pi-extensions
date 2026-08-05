# pi-web-search 设计记录（调研结论，未实施）

> 状态：调研完成，暂不实施。pi-web-access 足够好用，本设计留作备选方案，日后想自研时照此执行。
>
> 调研日期：2026-08。调研对象：pi-web-access v0.18.0（本地安装于 `~/.pi/agent/npm/node_modules/pi-web-access`）。

## 背景

用户想自研一个 web search 插件替代 pi-web-access。经调研确认 pi-web-access 功能完整够用，**结论是暂不自研**。本文档记录调研结论与设计草案，作为日后自研的依据。

## pi-web-access 架构拆解（2.2 万行 TS）

```
index.ts        3243 行  核心编排：4 个工具注册 + 多 provider 调度 + curator
curator-page.ts 3471 行  浏览器 UI 面板（本地 HTTP server + 页面）
extract.ts      1012 行  内容提取管线
*-extract.ts    ~10 个   PDF/GitHub/YouTube/视频/RSC/图片 特殊提取
19 个 provider 适配器   每个 ~200-250 行
ssrf-protection.ts  513 行
credential-source.ts    API key 解析（配置文件/环境变量/交互询问）
```

### 核心机制

1. **注册 4 个工具**：`web_search`（多 provider 搜索 + AI 合成答案）、`source_check`（结构化证据核查）、`fetch_content`（抓取正文）、`get_search_content`（读缓存内容）
2. **Provider 适配器模式**：每个 provider 独立小文件，统一输出 `{ answer, results }`。流程：读 key（`~/.pi/web-search.json` 或环境变量）→ 拼 URL → fetch（30s 超时 + AbortSignal）→ JSON 解析 → 域过滤 → 拼 answer 文本
3. **AI 摘要（关键洞察）**：合成答案不是搜索 API 给的，是调 `@earendil-works/pi-ai/compat` 的 `complete()` 用**用户已配置的模型**对结果做综合——零额外 API 成本
4. **内容提取**：fetch → linkedom 解析 → `@mozilla/readability` 提取正文 → turndown 转 markdown

### 复杂度分布（决定自研成本）

| 部分 | 行数 | 必需度 |
|------|------|--------|
| provider 适配器 ×1 | ~200 | 必需（搜索本体） |
| 工具注册 + 编排 | ~150 | 必需 |
| AI 摘要 | ~30 | 必需（调用 `complete()`） |
| 内容提取 | ~150（3 个库） | 可选 |
| curator 浏览器 UI | 4000+ | 可选（锦上添花） |
| 19 个 provider | 4000+ | 可选 |

**结论：搜索本身极便宜**——一个 HTTP 调用 + 200 行适配器 + 150 行注册，约 400 行可跑通核心（搜索 + 摘要 + 来源引用）。摘要复用 pi 已有模型，无新增 API 成本。

## API 调研（2026-08 查证）

### Brave Search API

```
GET https://api.search.brave.com/res/v1/web/search
Header: X-Subscription-Token: <key>
```

返回 `{ web: { results: [{ title, url, description, age, extra_snippets, profile }], total_count } }`。

- **只有 snippet（~100-200 字），无正文**
- 域过滤靠拼 `site:` / `NOT site:` 进查询串
- **⚠️ 2026 年起免费额度已取消**：所有套餐绑信用卡，$5/月 ≈ 1000 次，无免费档

### Exa Search API

```
POST https://api.exa.ai/search
Header: x-api-key: <key>
Body: { query, type: "auto", numResults, contents: { text: true, highlights: true }, startPublishedDate, includeDomains, excludeDomains }
```

返回 `{ results: [{ title, url, publishedDate, author, text, highlights, score }] }`。

- **搜索即抓取**：`contents.text: true` 直接返回正文（pi-web-access 的 exa.ts 实际用法）
- **免费额度：$20 新户 + 每月 $10**（≈1400 次搜索 / 1 万次 contents）
- 域过滤用 includeDomains/excludeDomains 参数
- 另有免 key 的 MCP 公共端点（mcp.exa.ai），429 限流

### 能否直接返回原始 API 响应作为 tool call 返回值？

**不能直接，必须加工**：
- 原始 JSON 字段冗余 + Exa 的 text 可能数千字符，直接塞会撑爆 context
- pi-web-access 的做法：每个结果拼成 `{snippet/正文片段}\nSource: {title} ({url})`，多结果空行分隔——这是给 LLM 读的最优格式（`answer` 字段）

## 设计草案（用户已确认的决策）

### 决策记录

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 实现方式 | 从零写最小插件 | 用户明确选择 |
| Provider | Brave + Exa 双 provider，**默认只用 Exa** | Brave 免费额度已取消；Exa 每月 $10 免费 + 自带正文 |
| 功能范围 | 搜索 + 抓取正文 | 研究类任务需要 |
| 插件名 | `@d3ara1n/pi-web-search` | 配置字段 `webSearch`，目录 `packages/pi-web-search` |
| 工具名 | `web_search` + `web_fetch` | 避免与 pi-web-access 的 `fetch_content` 冲突（两插件共存） |

### 包结构

```
packages/pi-web-search/
├── package.json          @d3ara1n/pi-web-search
├── README.md
└── src/
    ├── index.ts      扩展入口：注册 web_search + web_fetch 两个工具
    ├── config.ts     读 settings.json 的 "webSearch" 字段
    ├── brave.ts      Brave 适配器（~180 行）
    ├── exa.ts        Exa 适配器（~150 行）
    ├── search.ts     fallback 链编排
    └── fetch.ts      web_fetch：readability + turndown 转 markdown
```

### 配置格式（settings.json）

```jsonc
{
  "webSearch": {
    "providers": ["exa", "brave"],   // 数组顺序 = 优先级；只配置了 key 的才进链
    "apiKeys": { "exa": "...", "brave": "..." }   // 或环境变量 EXA_API_KEY / BRAVE_API_KEY
  }
}
```

### Fallback 链语义

1. 按 `providers` 顺序过滤出有 key 的 provider → 形成调用链
2. 依次调用，第一个成功即返回；失败记下原因，fallback 到下一个
3. 全失败 → 返回各 provider 的失败原因汇总
4. 一个 key 都没配 → 明确报错并给出注册指引

### 工具签名（对齐 pi-web-access，模型零学习成本）

- `web_search(query/queries, numResults, recencyFilter, domainFilter, provider?)` → `{ answer, results }`
- `web_fetch(urls)` → 各 URL 正文 markdown

### 实施注意

- AI 摘要用 `complete()` 复用当前模型，不额外调 API
- 配置读取遵循本仓库约定：project 整块替换 global，缺失字段 `DEFAULT_CONFIG` 兜底
- 依赖：`@mozilla/readability`、`linkedom`、`turndown`（提取管线）；跨包依赖用 `"*"`
- README 必须含 `## Installation` 和 `## Dependencies`
