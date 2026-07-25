# pi-hashline-edit 设计（as-built）

> **状态：已实现** — 本文档描述落地后的最终设计，与 `packages/pi-hashline-edit/` 源码一致。

## 1. 定位

用「行号 + 行内容 hash」双重锚替代 pi 内置 `oldText/newText` 精确匹配编辑，从根上消除 string-not-found 死循环与空白战争。覆盖内置 `read`/`edit`：read 输出带锚格式，edit 引用 `LINE#HASH` 锚。

## 2. 设计原则

### 2.1 hash = `base32(fnv1a32(行号 + 内容))`

每行 hash 把 **1-based 行号**混进行内容一起算，因此：

- **天然唯一**：行号唯一 ⇒ 每行 hash 唯一，无文件内碰撞，无需长度扩展、无兜底。
- **纯指纹**：hash 只取决于 `(位置, 内容)`，只在「本行内容变了」时才变——不像邻域 hash（prev+cur+next）会在邻居编辑时连带改变本行 hash。
- **可重算**：验证一个 anchor 只需要那一行的当前内容，不必留存全文快照。

为何混行号而非纯内容：纯内容会让相同行（空行、`}`）共享 hash；混行号免费区分，零额外代价。

### 2.2 就地验证，无快照、无全局 stale

apply 时对每个被引用的 `anchor{line,hash}` 现场算 `computeLineHash(line, 当前行内容)` 与模型给的 hash 比对。

- **外科手术级**：只有被引用的行真变了（或模型记错）才拒绝；别处的外部改动**不阻断**本行编辑（写入是读当前全文→只改引用行→写回，别处改动被保留）。
- 不存 snapshot、不做 `text !== snapshot.text` 全文比对。per-line hash **本身就是**漂移检查，只是精细到行。
- 模型没读过就乱编 hash → 现场重算对不上 → anchor 失败，自然引导它先 read。

> 这一节取代了早期设计里的「context-aware hash + per-file 碰撞扩展」与「snapshot store + 全局 stale」。前者让连续相同行膨胀到 9–10 字符且为未实现的漂移重定位买单；后者是 context hash 需要全文上下文才能验证单行的遗物。改用 `(行号, 内容)` 后两者都不必要。

### 2.3 edit 返回新锚，支持链式编辑

成功 edit 的结果附 `Updated anchors:` 块，给出本次产生的行（及 delete 后移位进空缺的那一行）的新 `LINE#HASH│`。模型可直接用这些锚发下一个 edit，**免去「每次 edit 后强制重读」**的往返。超过 40 行截断并提示重读，控制 token。

### 2.4 严格核心

`apply` 零猜测、快速失败：anchor 对不上就拒、操作范围重叠就拒、整文件结果逐字节不变就报 noop。不做模糊匹配、不做边界修复、不做漂移重定位。

## 3. 协议

### 3.1 read 输出

```
src/foo.ts · 6 lines
   1#aF3│import { compute } from "./util"
   2#7Qk│
   3#mP0│export function foo(x: number) {
```

`行号#hash│内容`，hash 默认 4 字符（Crockford base32，20 bits）。非文本（含 null 字节）/读错/被禁用 → 透传内置 read（内置用 file-type 识别图片、有打磨过的错误信息）。offset/limit、2000 行 / 256KB 截断与内置一致。

### 3.2 edit 操作

结构化 `edits[]`，每个 op：`{op, anchor?, end?, body?}`。op ∈ `replace | delete | insert_after | insert_before | append | prepend`。`anchor`/`end` = `{line, hash}`（从 read 或上一次 edit 结果抄）；`body` = string[]。

- `replace`/`delete`：`anchor`（+可选 `end` 成范围）；replace 需 `body`。
- `insert_after`/`insert_before`：`anchor` + `body`。
- `append`/`prepend`：仅 `body`。

schema 以 `op` 判别符强约束，旧 `oldText/newText` 在 schema 层就被拒（可见失败，不静默降级）。

### 3.3 成功结果

`content` 文本：`Edited <path> (N op(s)).` + `Updated anchors:` 块。
`details`（EditToolDetails）：`diff`（pi 的 `generateDiffString`，渲染器按 `+/-/空格` 着色）、`patch`、`firstChangedLine`。

## 4. 模块职责

```
src/
  core/                 纯库，零 pi 依赖，node --test 可独立跑
    hash.ts             computeLineHash(line, content, len=4) · hashFileLines(lines, len)
    lines.ts            splitLines / joinLines / detectLineEnding（CRLF 归一与回写）
    types.ts            Anchor · Edit · LineEnding · PatchErrorKind(anchor/range/noop) · ApplyResult
    apply.ts            applyEdits(text, edits, hashLen) → ApplyResult（就地验证 + touchedLines）
    index.ts            公共 API
  pi/                   接入层
    edit-tool.ts        override edit：schema → toCoreEdits → runHashline（read/apply/write + 返回新锚）
    read-tool.ts        override read：hashFileLines 现算展示，offset/limit/截断，非文本透传内置
    state.ts            config 持有（globalThis 单例）
    config.ts           loadConfig（project 整块替换 global，per-field ?? 兜底）
  index.ts              session_start 载入 config；注册 read/edit override
```

- **applyEdits**：split → 逐 anchor 现场重算比对 → 范围重叠检查 → 按 lo 降序回填（保持原 lo/hi 有效）→ join（回写原行尾）→ noop 检查 → 算 touchedLines（各 op 产生的行，按累计行增量映射到新文件坐标；纯 delete 回填移位进空缺的那行）。
- **edit-tool runHashline**：`withFileMutationQueue` 串行化同文件的 read-modify-write；abort 在 read 后、write 前各查一次；成功后 `generateDiffString` 出 diff、`formatUpdatedAnchors` 出新锚。
- **并发/原子性**：单次 `edits[]` 内所有 op 对同一快照验证、原子回填；同文件跨调用由 mutation queue 串行。

## 5. 关键取舍与风险

- **hash 长度 4 足够**：行号永远是主定位符，apply 永远在「引用的行号」上查 hash。即使两个不同行在 FNV 空间撞到同一 4 字符（10k 行 birthday 约几十对），系统也只在引用行操作、不会串行——碰撞只轻微削弱「反记错行」护栏，绝不影响正确性。无爆炸风险（唯一性靠行号，不靠去重）。要更稳可调 `hashLen` 到 5–6，非必需。
- **override read 是全局的**：每次 read 都付 hash 税（约每行 5 字符），不论是否要编辑。这是 hashline 路线的固有成本；换来 edit 可靠性。
- **read override 自实现截断/二进制检测**（null 字节启发式 vs 内置 file-type）：与内置 read 是两套实现，内置以后加功能这边会漏。override 模式的固有维护税；要缓解需 pi 暴露 raw-read，目前没有。
- **edit 仅本地 FS**：直接 readFile/writeFile（算 hash 需要 raw bytes）；自定义 `ReadOperations`（SSH 等）不支持。
- **混合行尾**：文件只要含一行 `\r\n` 即判 CRLF，edit 后整文件归一成 CRLF。罕见。
- **重叠检查偏保守**：同一边界的相邻 insert+replace 会被拒（规避回填顺序歧义）；模型可拆成两次调用。
- **noop 报错**：与内置 edit 一致（整文件逐字节不变即报错）；错误信息引导重读，避免盲目重试。

## 6. 与仓库规范契合

- 包名 `@d3ara1n/pi-hashline-edit`，keywords 含 `pi-package`/`pi`。
- peerDependencies `@earendil-works/pi-coding-agent: "*"`；跨包依赖用 `"*"`。
- 配置字段 `hashlineEdit`（去 `pi-` 转 camelCase）：`{ enabled?: boolean, hashLen?: number(2–8) }`。
- README 含 Installation + Dependencies。
- 测试 `node --test src/**/*.test.ts`，类型检查 `npx tsc --noEmit`（仓库根 tsconfig 覆盖所有包）。
