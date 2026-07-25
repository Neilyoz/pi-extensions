# pi-hashline-edit 设计

> 用「行级内容 hash + 行号」双重锚替代 pi 内置 `oldText/newText` 精确匹配编辑，从根上消除 string-not-found 死循环与空白战争。架构目标是**质量可控、可测试、可演进**——不是复刻 oh-my-pi 的功能清单，而是选一个更自洽的基底，让 oh-my-pi 80% 的补丁复杂度从根上不必要。

## 1. 定位与差异化

| 维度 | oh-my-pi | RimuruW 移植 | 本包 |
|------|----------|-------------|------|
| 锚定 | 文件级 tag + 行号 | 行级 hash + 行号 | **行级 hash + 行号** |
| 容错 | 焊死在 apply（~1300 行） | 内建容错 | **严格核心 + 可插拔中间件** |
| 架构 | 核心与 agent 耦合 | core/ 子目录 + 适配层 | **core/ 纯库 + pi/ 适配层（单包内）** |
| 测试 | 重 | vitest | **node:test 全覆盖** |
| 复杂度根源 | boundary repair 补偿行号漂移 | — | **行级 hash 天然抗漂移，无需 boundary repair** |

核心论点：oh-my-pi 的复杂度来自「文件级 tag + 纯行号 → 行号漂移 → 被迫 boundary repair → 引入不可预测性 → 堆更多规则」。改用**行级 hash + 行号双重锚**：行号给人可读性，hash 给机器可靠性，漂移时按 hash 重定位，逻辑简单一个数量级。

## 2. 关键设计决策（已定）

- **锚定**：行级 hash + 行号。read 每行带短 hash；edit 引用 `行号#hash`。
- **容错**：严格核心 + 可插拔 transform 流水线。核心 `parse → apply` 零猜测；容错（边界修复、漂移重定位、块解析）做成独立开关的中间件。**不包含旧格式归一化**——oldText/newText 无 hash 信息无法转成 hashline 锚，接入层一律明确拒绝。
- **包结构**：单包 `@d3ara1n/pi-hashline-edit`，内部 `core/`（纯库，零 pi 依赖，可单测）+ `pi/`（接入层）。不分 npm 包。
- **集成**：override 内置 `edit`/`read`。edit **不兼容**旧 `oldText/newText`——发现旧格式明确报错（让开发者知道模型没用新方案，而非静默降级）；容错仅限不影响结果的格式归一化。

## 3. 包结构

```
packages/pi-hashline-edit/
  src/
    core/                      # 纯 hashline 库，零 pi 依赖，可独立 node --test
      hash.ts                  # 行级 context-aware hash + 碰撞处理
      types.ts                 # Edit / Line / FileSnapshot / ApplyResult
      parse.ts                 # 严格解析器：input(string) → Edit[]
      apply.ts                 # 纯函数：apply(text, edits, snapshot) → ApplyResult
      snapshot.ts              # 行 hash 索引（path → Map<lineNo, hash>）
      diff.ts                  # 应用后生成 unified diff 预览
      index.ts                 # 库公共 API
      *.test.ts                # 每模块单元测试
    transforms/                # 可插拔容错中间件，各自独立可测、可开关
      normalize-legacy.ts      # 旧 oldText/newText → hashline（默认开）
      relocate-by-hash.ts      # 过期行号按 hash 重定位（默认开）
      repair-boundary.ts       # 边界重复剥离（默认关）
      resolve-blocks.ts        # tree-sitter 块解析（默认关，Phase 4）
      noop-guard.ts            # 连续空操作防护（默认开）
      index.ts                 # pipeline 组装
    pi/                        # pi 接入层
      edit-tool.ts             # override edit（只接受 hashline input，旧格式明确拒绝）
      read-tool.ts             # override read（输出锚格式 + 记录 snapshot）
      render.ts                # TUI 渲染（复用内置 renderer 槽位）
      state.ts                 # globalThis 单例 snapshot store
      config.ts                # hashLineEdit 配置加载
      prompt.ts                # promptSnippet / promptGuidelines
    index.ts                   # 插件入口
  README.md
  package.json
```

## 4. 协议规范

### 4.1 read 输出格式

```
src/foo.ts · 24 lines
   1#aF3│import { compute } from "./util"
   2#7Qk│
   3#mP0│export function foo(x: number) {
   4#kLp│  if (x < 0) return 0
   5#xY9│  return compute(x)
   6#b2H│}
```

- 行号右对齐 + `#` + hash + `│` + 内容。hash 默认 **4 字符**（base32，20 bits ≈ 100 万值），可配置。
- hash 为 **context-aware**：`hash(prevLine + curLine + nextLine)`——内容相同的行（空行、`}`、`return`）因邻居不同而 hash 不同，文件内碰撞实际接近 0。这比单纯加长 hash 有效得多。
- 单文件内残余碰撞（极少）→ 该行自动扩展到 5/6 字符直至唯一（per-file 无碰撞保证）。

**为何默认 4 而非更长**：hash 的作用是「可验证的抗漂移锚」，配合行号双保险 + per-file 隔离，不需要全局唯一。context-aware 已消除绝大多数碰撞，4 字符对千行级文件碰撞概率≈0；6 字符碰撞收益边际递减，却让每次 read 每行多 ~2 token（大文件累计可观）。碰撞由 per-file 自动扩展兜底，而非靠加长默认值。
- 非文本文件（图片等）→ 透传给内置 `createReadTool`，不附锚。

### 4.2 edit 操作

edit 工具接收结构化 JSON `edits` 数组（与 pi 原生风格一致，schema 强约束）。每个 op：

| op | anchor | end | body | 含义 |
|----|--------|-----|------|------|
| `replace` | 必须 | 可选（range） | 必须 | 替换 anchor（..end）行 |
| `delete` | 必须 | 可选 | 无 | 删 anchor（..end）行 |
| `insert_after` | 必须 | — | 必须 | anchor 行后插入 |
| `insert_before` | 必须 | — | 必须 | anchor 行前插入 |
| `append` | — | — | 必须 | 追加到文件末尾 |
| `prepend` | — | — | 必须 | 插到文件开头 |

`anchor`/`end` = `{line, hash}`（行号 + read 输出的 hash）。`body` = string[]（新内容行）。

> 放弃 oh-my-pi 的字符串 DSL——那是它整体抠 token 的妥协（boundary repair / 文件级 tag 等缺陷迫使它省 token），本设计更干净，不需要。schema 强约束让旧 oldText/newText 在 `op` discriminator 处直接被拒（可见失败，不静默降级）。

**锚的双重校验**：行号给人读，hash 给机器校验。apply 时：
1. hash 在文件中唯一存在且行号匹配 → 直接应用
2. hash 唯一但行号不符（漂移）→ relocate 中间件按 hash 重定位
3. hash 不在文件 / 多处碰撞 → **拒绝**，报错引导重读

### 4.3 示例

```jsonc
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "replace", "anchor": { "line": 4, "hash": "kLp" }, "body": ["  return x + 1"] },
    { "op": "insert_after", "anchor": { "line": 6, "hash": "b2H" }, "body": ["", "export const bar = foo"] },
    { "op": "delete", "anchor": { "line": 2, "hash": "7Qk" } }
  ]
}
```

多文件用多次 edit 调用。

## 5. 核心库模块接口

### `core/hash.ts`
```ts
// context-aware 行 hash
export function computeLineHash(
  prev: string, cur: string, next: string, len?: number
): string;

// 给整个文件算每行 hash，处理文件内碰撞（碰撞行自动扩展）
export function hashFileLines(lines: string[], opts?: { len?: number }): string[];  // len 默认 4
```

### `core/types.ts`
```ts
export type Anchor = { line: number; hash: string };
export type Edit =
  | { op: "replace"; start: Anchor; end?: Anchor; body: string[] }
  | { op: "delete";  start: Anchor; end?: Anchor }
  | { op: "insert_after";  anchor: Anchor; body: string[] }
  | { op: "insert_before"; anchor: Anchor; body: string[] }
  | { op: "append" | "prepend"; body: string[] };

export type ApplyResult =
  | { ok: true; text: string; diff: string; newSnapshot: FileSnapshot }
  | { ok: false; error: ApplyError };
```

### `core/parse.ts`
```ts
// 严格解析，零猜测。非法输入直接抛 ParseError。
export function parsePatch(input: string): ParsedPatch;  // { file, edits[] }
```

### `core/apply.ts`
```ts
// 纯函数。不做任何容错——锚对不上就 ok:false。
export function applyEdits(
  text: string, edits: Edit[], snapshot: FileSnapshot
): ApplyResult;
```

### `core/snapshot.ts`
```ts
export type FileSnapshot = { path: string; lineHashes: string[]; text: string };
// 记录 read 时的行 hash 索引，供 apply 校验 + relocate 用
```

## 6. 可插拔容错中间件

流水线（按配置开关，每个是纯函数、可单测）：

```
rawInput
  → [normalize-legacy]     // 旧 oldText/newText → replace 操作（默认开）
  → parse                   // 严格
  → [relocate-by-hash]      // 行号漂移按 hash 重定位（默认开）
  → [resolve-blocks]        // tree-sitter .blk 展开（默认关，Phase 4）
  → [repair-boundary]       // 边界重复剥离（默认关）
  → apply                   // 严格
  → [noop-guard]            // 连续空操作拦截（默认开）
```

设计原则：**默认开启的中间件只做"无歧义、可预测"的容错**（旧格式归一化、hash 重定位）；**有歧义的容错（boundary repair）默认关闭**，需要时显式开启。这让默认行为严格可预测，复杂度按需引入。

## 7. pi 接入层

### override edit
```ts
const builtin = createEditTool(cwd);  // 基底（保留 result 类型契约）
pi.registerTool({
  name: "edit",
  parameters: hashlineEditSchema,      // path + input(string patch)
  // 无 input（旧 oldText/newText 或缺失）→ missingInputError 明确拒绝，不静默降级
  async execute(...) {
    // 1. snapshot store 取该 path 的行 hash 索引
    // 2. 跑 transforms pipeline
    // 3. 成功 → 返回新 snapshot + diff；失败 → 结构化错误引导重读
  },
  // 不提供 renderCall/renderResult → 复用内置 edit 渲染（diff 高亮）
  promptSnippet, promptGuidelines,     // 教模型用新格式
});
```

### override read
```ts
const builtinRead = createReadTool(cwd);
pi.registerTool({
  name: "read",
  parameters: readSchema,              // 保持兼容（path/offset/limit）
  async execute(...) {
    // 1. 非文本 → 透传 builtinRead
    // 2. 文本 → 算行 hash、存 snapshot、输出带锚格式
  },
  // 复用内置 read 渲染
});
```

### session 状态
`globalThis` 单例 snapshot store（规避 Bun module identity 问题，见仓库 AGENTS）。`session_start` 初始化。

### 可选：constrained decoding
对支持 `openai_lark` 的 provider，给 edit 工具挂 grammar 约束输出格式（降错率）。非阻塞增强，provider 不支持时自动跳过。

## 8. 实现路线

### Phase 1 — 纯核心库（可独立测试，不接 pi）
`core/hash.ts` → `types.ts` → `parse.ts` → `apply.ts` → `snapshot.ts` → `diff.ts`，配齐 `node:test` 单元测试。
**验收**：`node --test src/core/*.test.ts` 全过；能用纯函数跑通 read→edit→apply 闭环。

### Phase 2 — pi 接入（最小可用）
`pi/read-tool.ts` + `pi/edit-tool.ts` + `pi/state.ts` + `pi/config.ts` + 入口 `index.ts` + README。
默认只开 `normalize-legacy` + `relocate-by-hash` + `noop-guard`。
**验收**：override 后能在真实 pi 会话里 read→edit；模型误发旧 oldText/newText 时收到明确错误（非静默降级）。

### Phase 3 — 容错中间件补全
`repair-boundary`（边界重复剥离，针对"模型重打保留行"）。
**验收**：中间件可独立开关、单测覆盖。

### Phase 4 — 高级特性
`resolve-blocks`（tree-sitter `replace.blk N#hash:` 语法块操作）、`append`/`prepend` 之外的文件操作。

## 9. 开放决策点（需确认）

1. **包名**：推荐 `pi-hashline-edit`（hashline 是公认术语、模型认得、@d3ara1n scope 已区分作者）。或换名体现独立性？
2. **verb 命名**：推荐语义化（`replace`/`delete`/`insert_after`），比 oh-my-pi 的 `SWAP`/`DEL`/`INS` 自解释。还是沿用 SWAP/DEL/INS 让模型迁移更顺？
3. **hash 分隔符**：推荐 `行号#hash│内容`（`│` 清晰分隔锚与代码）。或用更省 token 的 `行号#hash:`？

## 10. 风险

- **override read 的全局影响**：read 被所有工具/流程依赖，override 必须保留内置行为契约（truncation、图片、offset/limit），否则连带故障。→ 用 `createReadTool` 基底兜底非文本路径。
- **hash 碰撞**：默认 4 字符 base32（~100 万值）+ context-aware，千行级文件碰撞概率≈0；残余碰撞靠 per-file 自动扩展保证 apply 永不歧义。跨文件靠 snapshot store 按 path 隔离。长度可配（超大文件可调高）。
- **旧格式拒绝的明确性**：missingInputError 必须让开发者/模型清楚「没用 hashline」，措辞指向 re-read + input；不能含糊到让模型反复重试同一旧格式。
- **tree-sitter 依赖**（Phase 4）：引入 native 依赖，体积/编译成本。若用户不需要块操作可永久不做。

## 11. 与仓库规范契合

- `@d3ara1n/pi-hashline-edit`，keywords 含 `pi-package`/`pi`
- peerDependencies `"@earendil-works/pi-coding-agent": "*"`
- 配置字段 `hashlineEdit`（去 `pi-` 转 camelCase）
- 跨包依赖用 `"*"`（若 Phase 4 引入其他 @d3ara1n/pi-* 库）
- README 含 Installation + Dependencies 章节
- 测试 `node --test src/**/*.test.ts`，类型检查 `npx tsc --noEmit`
