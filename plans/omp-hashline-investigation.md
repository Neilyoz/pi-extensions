# omp (Oh My Pi) hashline 调查笔记

> **用途**：文章《hashline 的困境与突破》的一手素材。所有关键论断均对照一手来源验证：omp 仓库源码/文档/CHANGELOG/issue、作者 can1357 的博客、npm/crates.io registry 元数据。调查时点：2026-08-14（omp v17.3.4，本轮已对仓库 main 做二次核验）。
> 仓库：<https://github.com/can1357/oh-my-pi>（omp，Oh My Pi，fork 自 Mario Zechner 的 [Pi](https://github.com/badlogic/pi-mono)，omp.sh）

---

## 1. omp 项目速览

- omp = "Oh My Pi"，can1357 维护的 coding agent，pi 生态的旗舰 fork，Bun/TS + Rust 核心，60+ provider、31 个内置工具（README: <https://github.com/can1357/oh-my-pi/blob/main/README.md>）。
- `edit` 是内置核心工具，**默认模式就是 hashline**（docs/tools/edit.md: "default mode is the hashline patch language consumed from a single `input` string"；`resolveEditMode()` 优先级：模型级 `edit.modelVariants` → `PI_EDIT_VARIANT` → `edit.mode` → 默认 `hashline`，packages/coding-agent/src/utils/edit-mode.ts）。
- hashline 引擎独立成包 **`@oh-my-pi/hashline`**（npm 首发于 2026-05-27（v15.5.4），当前 v17.3.4，registry 元数据核验：<https://registry.npmjs.org/@oh-my-pi/hashline>、<https://www.npmjs.com/package/@oh-my-pi/hashline>），与 coding-agent 解耦：`Filesystem`/`SnapshotStore` 抽象使同一 patcher 可跑在磁盘、内存、网络等任意后端。
- 设计动机的权威陈述在作者博客 *The Harness Problem*（2026-02-12 发布，与"设 hashline 为默认"同一天）：<https://blog.can.ac/2026/02/12/the-harness-problem/>

---

## 2. hashline 格式精确规格

> 注意：格式经历过**至少 4 代演变**（详见 §5 时间线）。任务描述的 `SWAP N.=M` / `SWAP.BLK` / `DEL` / `DEL.BLK` / `INS.PRE|POST|BLK.POST|HEAD|TAIL` 是 **v16.x 时代（2026-06）** 的格式——绝大多数第三方移植和 GitHub 上被索引的 edit.md/prompt.md 快照都停在这一代；当前 v17.3.x（2026-08）已统一为 `PUT`/`CUT`/`REM`/`MV`。两代都给出。

### 2.1 当前格式（v17.3.x，PUT/CUT 时代）——docs/tools/edit.md + prompt.md

**Section 头（文件级 tag）**：

```
[src/example.ts#1A2B]
```

- 每个 section 以 `[PATH#TAG]` 开头；`TAG` 是 **4 位大写 hex**。源码定义（packages/hashline/src/format.ts）：

  ```ts
  export function computeFileHash(text: string): string {
      const normalized = normalizeFileHashText(text);   // 去行尾 [ \t\r]
      const low16 = Bun.hash.xxHash32(normalized, 0) & 0xffff;
      return low16.toString(16).padStart(HL_FILE_HASH_LENGTH, "0").toUpperCase();
  }
  ```

  即**整个文件**归一化文本的 xxHash32 低 16 位——内容派生、byte 级相同的读会铸出同一个 tag。但 16-bit 空间（65536）太小，tag **不能脱离 session `SnapshotStore` 单独验证**（npm README 原话："it is not meaningful outside that store"）；store 内碰撞按最近记录版本消歧（packages/hashline/src/snapshots.ts）。LRU 上限 30 路径 × 每路径 4 版本 × 总 64 MiB，超 4 MiB 的文件不打 tag（docs/tools/read.md）。
- "TAG is the four-hex snapshot tag emitted by the latest `read`/`grep`/`write`/successful `edit`"——必须复制，不能自造；缺 tag 的锚定编辑直接拒绝（edit.md 错误表："Missing hashline snapshot tag…"）。
- hashline **只编辑已存在的文件**，新建文件走 `write`（prompt.md："Create new files with `write`; hashline only edits existing files"）。

**Op 动词（当前）**——docs/tools/edit.md 原文：

| 形式 | 作用 |
|---|---|
| `PUT N.=M:` | 用下方 `+TEXT` 行替换原始文件第 N..M 行（含两端） |
| `PUT N*:` | 替换从第 N 行开始的整个语法块（tree-sitter 解析结束行） |
| `PUT <N:` / `PUT >N:` | 在第 N 行之前 / 之后插入；`PUT <1:` = 文件头，`PUT >$:` = 文件尾 |
| `PUT >N*:` | 插到第 N 行开始的语法块结束之后（同级深度） |
| `CUT N.=M` / `CUT N*` | 删除并捕获区间/块（可加 `@name` 命名寄存器） |
| `PUT <N @name` 等 | 把寄存器内容粘贴到 gap / 区间 / 块（17.2.0 引入跨文件剪贴板） |
| `REM` | 删除该 section 文件 |
| `MV DEST` | 移动/重命名文件 |

- 所有行号都指 **tagged 快照里的原始行号**，不被同一次调用里前面的 hunk 平移。
- body 行统一 `+TEXT`（`+` 单独一行 = 空行）；**body 是最终内容，不是 unified diff 的前后对比**；字面内容以 `-`/`+` 开头要写成 `+-`/`++`。`CUT`/寄存器 `PUT`/`REM`/`MV` 无 body。
- 纯文本 patch，可带 `*** Begin Patch` / `*** End Patch` 信封（被静默消费）；`*** Abort` 终止解析。**op 语法由 `grammar.lark` 精确定义并作为约束解码文法挂到工具上**（packages/coding-agent/src/edit/index.ts: `customFormat: { syntax: "lark", definition: hashlineGrammar }`）：

  ```
  file_header: "[" filename "#" file_hash "]" LF
  file_hash: /[0-9A-F]{4}/
  hunk: put_hunk | cut_hunk | rem_hunk | mv_hunk
  range: LID ".=" LID
  body: "+" /(.*)/ LF
  ```

**read 输出形状**——`[PATH#TAG]` 头 + 纯 `LINE:TEXT` 行（**无逐行哈希**），省略区用 `…`/`..` 和折叠的 `N-M:` 汇总行（docs/tools/read.md: "Prefix format in hashline mode is a `[PATH#TAG]` header followed by `LINE:TEXT`, e.g. `[src/foo.ts#0A1B]` and `41:def alpha():`"）。prompt.md 同时警告：折叠/elision 区**视为未见过**，不许在其上或跨其 hunk。

### 2.2 SWAP/DEL/INS 时代（v15.13.2 ~ v17.2.1，2026-06-15 ~ 07-31）——被第三方广泛移植的一代

docs/tools/edit.md（该时代快照，commit c0d0ad76: <https://github.com/can1357/oh-my-pi/blob/c0d0ad76/docs/tools/edit.md>）与 prompt.md 原文：

```
`SWAP N.=M:` — replace original lines N.=M with the body rows below. INCLUSIVE — line M is consumed too.
`SWAP.BLK N:` — replace the whole tree-sitter block beginning on line N.
`DEL N.=M` — delete original lines N.=M. No body.
`DEL.BLK N` — delete the whole tree-sitter block beginning on line N.
`INS.PRE N:` / `INS.POST N:` / `INS.BLK.POST N:` / `INS.HEAD:` / `INS.TAIL:`
```

- 2026-06-15 v15.13.2 把动词重命名为缩写（`replace`→`SWAP`、`insert before`→`INS.PRE`…），同日 v15.13.3 把区间分隔符 `..` 改为 `.=`（packages/hashline/CHANGELOG.md）。
- 注意：GitHub 搜索引擎当前对 `blob/main` 的 edit.md/prompt.md 索引仍停在这一代——**外部世界看到的"hashline 格式"大概率是 SWAP 方言**。

### 2.3 最早的逐行哈希时代（2026-02-10 ~ 05-26，JSON 工具参数）——与 pi-hashline-edit 设计最接近的时期

- 2026-02-10（coding-agent v11.10.1，CHANGELOG）：hashline edit mode 引入，**每行一个哈希**，read 输出 `LINE:HASH|content`，引用 `"5:a3f2"`，**JSON 结构化工具参数**（`HashlineEdit`，字段 `old`/`new`，`string | string[]`）。哈希曾从 4 hex 缩到 2 hex（"Reduced hash length from 4 to 2 hex characters (16-bit hashes)"）。博客里展示的正是这个形态：`1:a3|function hello() {`。
- 同期 CHANGELOG 已记录两个此后反复出现的病灶：**模型把 `LINE:HASH|` 前缀复制进替换内容**（"automatically stripping `LINE:HASH|` display prefixes and unified-diff `+` markers that models may copy into replacement content"）和**锚行/边界回声**（"heuristics to strip anchor line echoes and range boundary echoes"）。
- 2026-02-12（v12.0.0，CHANGELOG: "Changed default edit mode from `patch` to `hashline`"），同日发布博客。
- 2026-05-27 抽取 `@oh-my-pi/hashline` 包，**切换为纯文本 patch**（`¶PATH#HASH` 头 + 分节）；2026-05-29 v15.5.13 定型 verb 语法（`replace N..M:` 等）并把 tag 生成改为**全文件快照**——"hashline anchors now validate only when the complete file matches"（release v15.5.13: <https://github.com/can1357/oh-my-pi/releases/tag/v15.5.13>）。

### 2.4 为什么是纯文本 patch 而不是 JSON 工具参数

仓库没有一句"为什么不用 JSON"的原话，但证据链清晰（写文章时可作结构性论证）：

1. **格式定位就是"diff format"**：hashline 包 README 第一句 "Hashline is a diff format designed for LLM-driven file edits. It binds every hunk to a file-content hash so stale anchors are rejected before they corrupt code"（<https://www.npmjs.com/package/@oh-my-pi/hashline>）。
2. **一次调用表达多文件/多操作**：text patch 天然支持多 section、跨文件 `CUT`+`PUT`（寄存器流动）、`REM`/`MV`；JSON schema 表达同等能力需要嵌套很深的参数结构。
3. **可流式解析 + 约束解码**：streaming 渲染器逐 chunk 解析 in-flight payload 算 diff（packages/coding-agent/src/edit/streaming.ts）；`grammar.lark` 是 "canonical constrained-decoding grammar"（edit.md），通过 `customFormat` 挂给支持的 provider 在推理侧约束输出——这是对 Codex `apply_patch` "网关侧偏置"路线的显式复刻（博客原话批评：Codex 的格式优势 "almost certainly biased to fit this structure at the LLM gateway"，别的模型拿到就崩）。
4. **统一 wire contract**：一个 `input: string` 字段统一 hashline/apply_patch/patch 三种模式。
5. **token 经济**：模型只写 header + 新内容，从不重述旧内容（博客核心论点）。

### 2.5 过期/验证语义：文件级快照 + fail-closed recovery（与 pi-hashline-edit 的关键差异）

- **验证粒度是"整文件"**：应用时 patcher 读 live 文件，算整文件哈希与 section tag 比较。匹配 → 直接应用；不匹配（**文件里任何一处无关改动都会触发**）→ 进入 recovery。
- **Recovery 机制**（packages/hashline/src/recovery.ts，文件头注释原话）："Recovers stale section tags by proving that every anchored line still maps to one unchanged, contiguous region in the current file, then replaying the edit against that live content. **Recovery fails closed** when the target changed or became ambiguous." 流程：行级 diff（`diffLineRuns`）建快照→live 行映射 → 每个 anchor 经未变行重映射 + 邻域校验 + 偏移一致性 → 全过则重放并带恢复警告；任何失败 → `MismatchError`：live 文件哈希 + anchor 上下文行 + 重读引导（mismatch.ts）。
- 纯 head/tail 插入是唯一例外：位置稳定，stale tag 下直接应用 + 警告。
- **seen-line 守卫**：`edit.enforceSeenLines` **默认 false**（packages/coding-agent/src/config/settings-schema.ts 核验），开启后"锚在从未显示过的行"被拒并把实际内容内联进错误；因误伤长行/局部读经历多次回调（v15.13.1 曾作为 breaking 强制，后转 opt-in）。注意**模型侧 prompt 仍按严格姿态教学**——现行 prompt.md："Touch displayed lines only; undisplayed hunks REJECTED."（教学与执行的张力本身是素材）。
- 成功结果返回**新 `[path#TAG]`**（fresh 整文件哈希）+ 紧凑 diff 预览 + Warnings；prompt.md 三条铁律第一条："RE-GROUND AFTER EVERY EDIT. Every apply mints a fresh `#TAG` and renumbers."

### 2.6 tree-sitter 语法块操作（`PUT N*:` / 旧 `SWAP.BLK` 等）

- 块解析：原生 tree-sitter（pi-natives，按路径推断语言）从 **opening 行**解析到节点结束行返回 span（packages/coding-agent/src/edit/hashline/block-resolver.ts）；解析结果按内容哈希 memoize。块展开发生在 recovery 之前：tag 匹配对 live 文本解析，drift 则对快照文本解析再映射回 live。
- 解决的失效模式：模型数不对大区间的结束行号（"数闭括号数到眼花"）、跨多行构造（函数/类/try 块）。prompt 规则："Whole construct → `PUT N*:`"。
- 边界与失败：解析出的 span 是**恰好从 N 行开始的节点**——前导 decorator/attribute/doc-comment 是独立节点不并入（Python `@dec`+`def` 除外）；锚在空行/闭合符/无节点起始/块内有语法错误 → 拒绝并降级引导（"Use `PUT N.=M:` with explicit lines"）+ 上下文行预览；`PUT >N*:` 解析失败则**降级**为普通 `PUT >N:` + 警告而非报错；单行节点拒绝并引导用单行形式。
- Markdown 特例：tree-sitter-md 把 heading+body+更深小节包成一个 `section` 节点，锚在 `##`/`###` 上的块操作作用于整个小节（edit.md "Markdown sections" 节）。
- 成功回显解析结果供确认：`SWAP.BLK N → resolved lines A-B (K lines)`（PUT 时代为 `PUT N*: → resolved lines A-B`）。

---

## 3. 设计动机（作者原话）

### 3.1 博客 The Harness Problem（2026-02-12）——动机的第一手陈述

<https://blog.can.ac/2026/02/12/the-harness-problem/>

关键原话（英文引 + 中文注）：

> "none of these tools give the model a **stable, verifiable identifier for the lines it wants to change** without wasting tremendous amounts of context and depending on perfect recall. They all rely on the model reproducing content it already saw. When it can't — and it often can't — the user blames the model."
> —— 既有方案（apply_patch / str_replace / Cursor 专用模型 / aider）的共同缺陷：**让模型重述已经看过的内容**，模型记不住时用户怪模型。

> "What if, when the model reads a file, or greps for something, **every line comes back tagged with a 2-3 character content hash**... If the file changed since the last read, the hashes (optimistically) won't match and the edit is rejected before anything gets corrupted."
> —— 最初的设计就是逐行哈希（与 pi-hashline-edit 同源）。

> "If they can recall a pseudo-random tag, chances are, they know what they're editing. The model then wouldn't need to reproduce old content, or god forbid whitespace, to demonstrate a trusted 'anchor'."
> —— **anchor 优于重述**：记住一个随机 tag 比完美复述代码（含缩进）可靠得多。

> "Often the model isn't flaky at understanding the task. It's flaky at expressing itself. **You're blaming the pilot for the landing gear.**"
> —— 金句：模型不差，是表达机制差。

针对既有方案的批判（同篇博客）：

- Codex `apply_patch`："give this to any other model, completely unaware of it? Patch failures go through the roof. **Grok 4's patch failure rate in our benchmark was 50.7%**, GLM-4.7's was 46.2%."
- Claude Code `str_replace`："The model must reproduce every character perfectly, including whitespace and indentation... The 'String to replace not found in file' error is so common it has [its own GitHub issues megathread](https://github.com/anthropics/claude-code/issues/3471) (+27 other issues)."
- Cursor："trained a separate neural network: a fine-tuned 70B model whose entire job is to take a draft edit and merge it into the file correctly"——问题难到要再扔一个模型进去。
- Aider 自家 benchmark：格式选择让 GPT-4 Turbo 26%→59%；JetBrains Diff-XYZ（arxiv 2510.12487）"no single edit format dominates"；EDIT-Bench（arxiv 2511.04486）只有一个模型 pass@1 > 60%。

**Benchmark 方法论**：随机取 React 代码库文件 → 注入机械 bug（运算符互换/布尔翻转/off-by-one/可选链移除/标识符改名）→ 英文描述 → 3 runs × 180 tasks，16 模型，4 工具（read/edit/write），~$300。结果：

- hashline **在 14/16 模型上胜过 patch**；v2 修订再提升 12/16（最大增益 GPT-5.1 Codex Mini 60.0% → 77.5%）；平均 +15 pts vs patch。
- 最弱模型获益最大：Grok Code Fast 1 从 **6.7% → 68.3%**（10×，patch 失败掩盖了编码能力）；MiniMax 2.1×；Grok 4 Fast 输出 token **−61%**（不再烧 retry 循环）；Gemini 3 Flash +8pp（78.3%，比 Google 自家最好成绩高 5.0pp——为此 Google 封了作者的号，博客原文记录了 ban 截图）。
- **唯一输家是 DeepSeek V3.2**（patch −5 / replace −8.3 / token +20%）——16 模型中唯一 hashline 全面变差的，作者未展开解释。
- "+8% improvement in the success rate of Gemini is bigger than most model upgrades deliver, and it cost zero training compute."

### 3.2 README 的官方表述（README "11 · Hashline: edit by content hash"）

> "Perfect edits, fewer tokens. The model points at anchors instead of retyping the lines they want to change, so **whitespace battles and string-not-found loops just stop happening**. Edit a stale file and the anchors diverge — **we reject the patch before it corrupts anything**. Grok 4 Fast spends 61% fewer output tokens on the same work."

README 顶部 "Edits that land on the first attempt" + 每模型指标表（Grok Code Fast 1: 6.7% → 68.3% "Tenfold lift the moment the edit format stops eating the model alive"；Gemini 3 Flash +5 pp "Over str_replace — beats Google's own best attempt"；Grok 4 Fast −61% tokens "Output collapses once the retry loop on bad diffs disappears"；MiniMax 2.1×）。

### 3.3 演进中暴露的动机

- v15.5.13（2026-05-29）release notes："Changed hashline tag generation to use **full-file snapshots** for read/search/ast-grep... so hashline anchors now validate only when the complete file matches" + "Changed hashline context generation for line edits from partial/sparse snippets to **complete-file fingerprints**, reducing stale anchors for partially read files"——逐行/局部指纹 → 整文件快照的取舍声明（<https://github.com/can1357/oh-my-pi/releases/tag/v15.5.13>）。
- 块操作（v15.7.0，2026-05-31）：解决"模型不愿/不能手工写大范围行号区间"。
- 动词缩写化（v15.13.2）与后续海量 lenient 解析（`SWAP N-M:`/`N…M:`/裸 body 自动补 `+`/`-` bullet 宽容）都在回应同一个现实：**模型不断写歪格式，工具侧持续加修复**。

---

## 4. 与 @d3ara1n/pi-hashline-edit 的逐点对比

> 本地包：`packages/pi-hashline-edit`（npm `@d3ara1n/pi-hashline-edit`），README + 设计为据。

| 维度 | omp hashline（v17.3.x） | @d3ara1n/pi-hashline-edit |
|---|---|---|
| anchor 形态 | 文件级：`[PATH#4HEX]` 整文件 xxHash32 低 16 位 + 纯行号；**read 输出无逐行哈希** | 逐行：`LINE#HASH│content`；hash 折叠行号进内容哈希，**唯一性由构造保证**（空行/`}` 永不碰撞） |
| 交付形态 | **纯文本 patch**（grammar.lark 约束解码，一次调用多 section/多文件/寄存器） | **JSON schema 工具参数**（结构化 ops：replace/delete（anchor+可选 end={line,hash}）、insert_after/insert_before、append/prepend） |
| 验证粒度 | **整文件**：任何 drift（包括无关区域）→ 整 patch 走 recovery；判不了 → 整 patch 拒绝 | **外科手术式逐行**：只重哈希被引用的行；**无关改动永不阻塞** |
| anchor 失效恢复 | 行级 diff 重映射 + 邻域校验 + 统一偏移 → 重放；歧义/变更 fail-closed | 锚点不匹配 → **固定原行号 ±15 行重扫描**逐候选重哈希：唯一命中 → 返回可立即重发的 fresh anchor；歧义 → 候选列表；无 → live 内容 + 重读引导 |
| 成功返回 | 新 `[path#TAG]`（文件级）+ 紧凑 diff 预览 + warnings | "Updated anchors"：被触碰行的 fresh `LINE#HASH`，链式编辑免重读、行号不重排 |
| 块操作 | tree-sitter 语法块（`PUT N*:`），opening 行解析，成功回显 resolved span | 无（细粒度 op；另有独立 `replace` 工具做 bulk/regex） |
| 防呆/修复 | 大量工具侧修复：boundary-balance repair、off-by-one keeper 自动丢弃、parse-verified repair（17.2.12）、noop-loop 熔断、lenient 方言解析 | 保守重叠检测（相邻区间拒绝）；无 fuzzy、无 boundary repair（设计上拒绝猜测） |
| 模型路由 | 默认 hashline，但 **kimi / mimo / deepseek-v4-flash / step-3.7-flash 自动回退 replace**（edit-mode.ts 排除名单） | 默认开，用户手关（`hashlineEdit.enabled`） |
| 相同点 | 都以哈希 anchor 替代 oldText/newText 重述；都要求模型**复制** anchor 而非自造；失败时回传 live 上下文；返回 fresh anchor 支持免重读链式编辑 | 同左 |

**本质差异一句话**：omp 用"整文件哈希 + 行重映射"换**更强的完整性保证**（任何漂移都逃不过检测），代价是**无关改动牵连整 patch**（文件级耦合）；pi-hashline-edit 用"逐行哈希 + 固定行号邻域重扫"换**外科手术式独立性**（耦合只在你引用的行），代价是完整性只在被引用行上成立。

**与 omp 早期设计的历史巧合**：pi-hashline-edit 的逐行哈希 + JSON 参数，几乎就是 omp **2026-02 时代的原始设计**（`LINE:HASH|content`、HashlineEdit JSON 参数）。omp 后来放弃逐行转向文件级 tag，可考原因：read 输出的逐行 hash 是 O(行数) token 开销、全文件快照给 recovery 提供重放基底、部分 read 下局部指纹锚点误判。pi-hashline-edit 则把逐行路线补上了 omp 当年没做的两块：行号折叠进哈希解决同内容行碰撞、±15 行重扫解决漂移——两条路线殊途，各解决了对方没解决的问题。

---

## 5. hashline 生态扩散

### 5.1 omp 自身时间线（版本 → 格式）

| 日期 | 版本 | 事件 |
|---|---|---|
| 2026-02-10 | v11.10.x | hashline edit mode 引入：**逐行哈希**（`LINE:HASH\|content`，2~4 hex）、**JSON 参数**、edit.mode 枚举默认 patch |
| 2026-02-12 | v12.0.0 | 默认 edit mode 改为 hashline；同日发布博客 The Harness Problem |
| 2026-02-13~15 | — | 扩散开始：opencode issue #13393（02 月，"just introduced to the oh-my-pi"）；RimuruW/pi-hashline-edit 上 npm（02-15，"Inspired by oh-my-pi"） |
| 2026-05-27 | v15.5.4 | 抽包 @oh-my-pi/hashline；纯文本 patch + 分节（`¶PATH#TAG` 头） |
| 2026-05-29 | v15.5.13 | 全文件快照 tag + verb v4 语法（`replace N..M:` 等）；3-hex→4-hex |
| 2026-05-31 | v15.7.0 | tree-sitter 块操作（`replace block N:`） |
| 2026-06-06 | v15.9.67 | 头格式 `¶PATH#TAG` → `[PATH#TAG]`（ASCII 化） |
| 2026-06-15 | v15.13.2/3 | 动词缩写化（SWAP/DEL/INS.*，任务描述的一代）+ `..`→`.=` 分隔符；v15.13.1 未见行拒改 |
| 2026-06-26/27 | v16.1.x–16.2.0 | Markdown 小节块操作；REM/MV；boundary 修复链（#3142 等） |
| 2026-07-22~27 | v17.0.x–17.1.x | 恢复机制改原生行 diff；#6671 诊断改进；GLM 5.2 兼容（stray dots，v16.2.6） |
| 2026-07-30 | v17.2.0 | CUT/PASTE 寄存器（跨文件移动代码），删 DEL/COPY |
| 2026-07-31 | v17.2.2 | **统一 PUT/CUT/MV/REM 文法**（SWAP/INS/PASTE 退役） |
| 2026-08-08~14 | v17.2.12–17.3.4 | parse-verified boundary repair（tree-sitter 验证后才修）、寄存器守卫、Rust lifetime 词法修复；当前默认仍 hashline |

当前模型排除名单（packages/coding-agent/src/utils/edit-mode.ts，源码核验）：`kimi`、`mimo`、`deepseek-v4-flash`、`step-3.7-flash` → 默认 `replace`（`edit.modelVariants`/`PI_EDIT_VARIANT`/`PI_STRICT_EDIT_MODE` 可强制回 hashline）。

### 5.2 扩散清单（独立实现 vs 移植）

**pi 生态（pi coding agent 扩展）**：

| 包/仓库 | 时间 | 路线与说明 |
|---|---|---|
| `pi-hashline-edit`（RimuruW，npm 未加 scope） | 2026-02-15 | **pi 首个移植**（博客后 3 天）；逐行 `LINE#HASH`、16 字符自定义字母表 2~4 字符、JSON ops（replace/append/prepend/replace_text）、3-way snapshot merge 恢复、链式 fresh anchors；README 致谢 "Thanks to can1357... for the hashline concept"（<https://github.com/RimuruW/pi-hashline-edit>、<https://www.npmjs.com/package/pi-hashline-edit>）。⚠️ 与本仓库 `@d3ara1n/pi-hashline-edit` 同名异包（scoped vs unscoped） |
| `@the-agency/pi-hashline-edit` | 2026-03 | 独立实现 |
| `Fadouse/pi-hash-anchored-edit` | 2026-05-06 | 逐行短 SHA-256；**覆盖内置 read/edit 同名工具**（"Pi gives extension tools priority over built-ins"）；后被 YanwuZeng/pi-hashline 认作基底（<https://github.com/Fadouse/pi-hash-anchored-edit>） |
| `sergiobonfiglio/pi-hashline` | 2026-05-23 | 独立实现：另起 `hash_read`/`hash_grep`/`hash_edit` 工具名（不覆盖内置）+ 结构化 ops schema（<https://github.com/sergiobonfiglio/pi-hashline>）。同作者后来转向 **pi-lean-edit**（见 §6.5） |
| `pi-hashline-edit-pro` | 2026-06 | 独立实现："per-line content hash + stable mapping"，宣称 hash 跨编辑稳定、尽量不 re-read（转引自 piex 对比文档，未独立核实仓库） |
| `@jerryan/pi-hashline-edit` | 2026-05-31 | RimuruW 版 fork（精简 schema + 安全护栏） |
| `T50-Systems/pi-hashline-edit-plus` | 2026-07-01 | 跨平台 read/edit override |
| `pi-hashline`（YanwuZeng） | 2026-06-29 | **移植 omp SWAP 方言**：`[path#TAG]` 全文件 4-hex xxHash32 + `SWAP/DEL/INS.*` 文本 DSL + 快照校验 + noop guard；README 自注 "adopts the hashline syntax from can1357/oh-my-pi"，"based on Fadouse/pi-hash-anchored-edit"（<https://github.com/YanwuZeng/pi-hashline>） |
| `@piex-dev/hashline`（PieX） | 2026-07-14 | **直接封装 omp 的 npm 引擎 `@oh-my-pi/hashline`**（唯一带运行时 npm 依赖的 piex 包；Node polyfill Bun xxHash32）；继承全文件 tag + tree-sitter 块 + REM/MV，外补 noop/dup guard。其文档给出三路线对比表：omp 全文件 tag / pi-hashline-edit 逐行上下文哈希 / pi-hashline-edit-pro 稳定映射（<https://piex.dev/en/packages/hashline/>、<https://github.com/piex-dev/piex/blob/main/docs/packages/hashline.md>） |
| `@d3ara1n/pi-hashline-edit`（本仓库） | 2026-07 | 独立实现（行号折叠逐行哈希、±15 行重扫恢复、JSON 参数、独立 replace 工具） |

**pi 之外**：

- **opencode**（anomalyco/opencode）：issue #13393（2026-02，"Hashline is a new edit mode just introduced to the oh-my-pi agentic coding tool (a fork of Pi)... I really want to bring the feature over to OpenCode"）→ PR #13405/#14677 落地 `experimental.hashline_edit`，read 输出 `LINE#ID` anchors；维护者同时指向既有相关讨论 #12406（校验和）/#5840（edit 可靠性）/#4406（编辑间重读）。社区插件 `@angdrew/opencode-hashline-plugin`。（<https://github.com/anomalyco/opencode/issues/13393>）
- **Codeform**（codeform.io）：**独立实现**，逐行 2-char hash（`42#VK| content`，xxHash32 → 256 字符表），**默认对 GPT-5.4 / Gemini 3.1 Pro / MiniMax M2.7 开启、对 Claude 系关闭**（"strong positional fidelity and don't need it"）；校验是 additive 的——无 anchor 的编辑跳过校验（优雅降级）；write 时自动剥离 anchor 前缀防污染。（<https://codeform.io/docs/features/hashline-editing/>）
- **Rust `hashline` crate**（crates.io，registry API 核验：创建于 **2026-05-24**，作者 quangdang46，v0.2.1）：CLI + 库 + stdio MCP server，安装脚本自动往 claude-code/codex/cursor/windsurf/vscode/gemini/opencode/amp/droid 九个宿主的 MCP 配置里写入条目。早期是逐行 2-char xxh32（`42:ab`，docs.rs 的 `anchor`/`document`/`hash` 模块），当前 README 已演进为 **omp 风格全文件 tag**（`[path#HASH]`，xxh3-64 取高 16 位）+ `SWAP/DEL/INS.*` 动词——即跟随 omp 的 SWAP 方言移植。（<https://crates.io/crates/hashline>、<https://github.com/quangdang46/hashline>、<https://docs.rs/hashline/latest/hashline/>）

**结论**：扩散呈两条路线——**逐行哈希派**（RimuruW、Fadouse、sergiobonfiglio、Codeform、opencode 初版、Rust crate 早期）与**全文件 tag 派**（omp 当前、PieX、pi-hashline(YanwuZeng)、Rust crate 后期）。直接署名移植的：RimuruW（"Inspired by oh-my-pi"）、YanwuZeng（"adopts the hashline syntax from can1357/oh-my-pi"）、PieX（封装 npm 引擎）；其余为独立实现但概念同源（都读到了 The Harness Problem / omp 的格式）。

---

## 6. 公开讨论 / 批评 / 已知局限（"困境"素材）

### 6.1 模型遵循度问题（最核心的困境）

- **#3772** "High edit failure rate with MiMo v2.5 Pro and DeepSeek v4 Flash — hashline format not supported"（<https://github.com/can1357/oh-my-pi/issues/3772>）：
  - 用户 szavadsky 实测（ollama 环境）：**5,720 次 edit 调用，DeepSeek Flash 成功率 90.1%，#TAG 合规率 97.7%，68% 的失败是 staleness（hash mismatch/stale tag/file changed）而非格式错误**——即"能学会格式，但 anchor 过期"。
  - 用户 Genteure 在官方 provider 上约 1/10 失败率；失败形态包括**不带方括号输出 `flake.nix#EFB2`**、SWAP range 乱序 + retry 空转。
  - **can1357 原话**："Can't really repro on flash tbh. I have 90% success locally."
  - 结局：MiMo 默认切 replace（PR #3773）；DeepSeek V4 Flash 后续（v17.1.x，2026-07 末）也进排除名单（edit-mode.ts 现状核验）。
- **#2241** glm-5.1 频繁过度编辑/欠编辑/编辑错行（<https://github.com/can1357/oh-my-pi/issues/2241>）：issue 内分析原话 "**This is a model capability issue, not a hashline design flaw**... for models with weaker instruction-following ability (like glm-5.1), hashline's syntactic complexity (line number ranges, snapshot tags, `+`-prefixed body rows, `block` syntax, etc.) increases the probability of errors"；PR #2243 把 glm-5.1 默认切到 replace（`edit.modelVariants`）；can1357："Should be better now, but ultimately **this is a model thing**."
- 排除名单演化（kimi → mimo → deepseek-v4-flash → step-3.7-flash）本身就是官方对"部分模型学不会"的持续承认。docs/tools/edit.md 直白写明 hashline 严格、弱指令跟随模型会挣扎。
- **omp 第一周的同类证据**：v11.10.1（2026-02-10，引入 hashline 当天）CHANGELOG 就已记录"模型把 `LINE:HASH|` 前缀复制进替换内容""锚行/边界回声需要启发式剥离"——与用户 field note 中 DeepSeek V4 Flash 把 insert_after 误读成 string-replace（anchor 行复制进 body → 校验通过、文件被污染）是同一族问题，**omp 侧从第一天就在打补丁**。

### 6.2 工程性缺陷与事故

- **#2081** no-op 死循环：某会话 205 次调用里 **182 次**字节相同的 no-op edit，持续 16 分钟直到用户手动中止 → noop-loop guard（同 payload 重复 3 次升级为 ToolError；execute.ts 注释原话："empirically far more effective at breaking a no-op edit loop than the soft hint alone"）（<https://github.com/can1357/oh-my-pi/issues/2081>）。
- **#6366** 失败的多 section patch 可留下部分落盘写入——all-or-nothing 只覆盖 prepare 阶段，write 阶段 OS 失败不回滚。
- **#2603** "Audit hashline edit validation for indentation and transform-layer corruption gaps"。
- **#2705** 块编辑在 block 尾部留重复行；**#8482** read 头把 workspace-relative 路径折叠成 basename 致同名文件编辑被误拒；**#3867** BOM 字节丢失。
- **16-bit tag 碰撞**：4-hex tag 只有 65536 空间，快照存储显式做了碰撞消歧（#4113；snapshots.ts 的 byHash 碰撞时取最近记录版本）。
- **17.2.12 的事故级修复**（CHANGELOG）：模型把 read 输出的 `N:TEXT` 行整段粘进 body 且行号重复时，旧的合并逻辑**静默丢弃内容**——"in one incident replacing a block opener with `}` and deleting the following statement"。修复后：拒绝 + 教学错误。另有一个 `+` body 行本身恰为合法 hunk 头（`+CUT 5.=9`）的静默源码损坏案例，同样靠新增警告兜底。

### 6.3 格式本身的代价（结构性批评）

- **全文件耦合**：任何无关漂移牵连整 patch（§2.5、§4）。
- **格式 churn**：6 个月内 ≥5 次破坏性换代（JSON→sigil→verb v4→SWAP/DEL/INS→PUT/CUT；`¶`→`[`；3-hex→4-hex；`..`→`.=`）。后果有二：模型训练/索引知识过期（GitHub 索引的 edit.md 至今停在 SWAP 代）；**第三方移植被钉死在过期方言上**（YanwuZeng 停在 SWAP，PieX 封装的 ^17.1.3 引擎在 omp 换 PUT/CUT 后被迫 patch-package 打补丁，见其 0.1.2 changelog）。
- **文档漂移**：omp.sh 官网 docs 至今宣称 "Every line carries a short content-hash anchor. The model edits by anchor instead of reproducing whitespace"（<https://omp.sh/docs>）——描述的是 2026-02 的 v1 设计；现行 read 输出根本没有逐行哈希。**连源头项目自己的营销文案都停在初代设计**，外界对 hashline 的认知混乱可见一斑。
- **token 成本转移**：全文件 tag 省了 read 的逐行 hash，但失败时 MismatchError 内联上下文行、修复链的 warnings 都在涨输出；逐行派则每行付 2~4 字符。
- **修复黑盒化**：boundary-balance repair、off-by-one keeper 自动丢弃、parse-verified repair……omp 的 applier 越来越多"违背模型字面指令但修对结果"的静默修复——模型写错也成功，**模型永远学不会正确格式**（修复本身削弱反馈信号）。prompt.md 甚至要专门叮嘱 "never lean on the repair"。

### 6.4 第三方独立基准与批评（本轮新增，文章"困境"的核心弹药）

- **geometricagi《AST Edits: The Code Editing Format Nobody Uses》**（2026-04-02，<https://geometricagi.github.io/2026/04/02/ast-edits.html>）：4 模型（Opus/Haiku/GPT-5.4/o4-mini）× 7 格式（whole-file / unified diff / S-R / AST edit / hashline JSON ops / hashline S-R / hashline UD）。hashline 相对原生格式的 delta **不稳定**：hashline S/R 在 Haiku +3.4pp、o4-mini 0、GPT-5.4 **−10.3pp**、Opus **−6.9pp**；hashline UD 在 o4-mini +48.3pp 但 Haiku **−20.7pp**。结论关键句：**"Hashline methods fail when the model gets a hash wrong. It sees `483:d4` in the input, writes `483:3a` in the output. Every model does this, including Opus."**（哈希转写是转写任务，LLM 不擅长）同基准中 AST edit（按函数名定位）三模型 100%、零格式失败——提出替代路线。
- **nwyin《Hashline vs Replace: Does the Edit Format Matter?》+ edit-bench**（<https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html>、<https://github.com/nwyin/edit-bench>、语言依赖 issue <https://github.com/nwyin/edit-bench/issues/14>）：3 语言 × 3 模型（gemini-3-flash/qwen3.5-397b/gpt-4.1-mini）。发现：**hashline 惩罚是语言依赖的**——Python 显著受罚（gemini −25pp、gpt-4.1-mini −15pp、qwen −5pp，缩进即语法无括号冗余）、TypeScript 中性、Rust 略亏或平；结论："Hashline vs replace is not a clear winner either way"、"**edit format is not the bottleneck**"（模型间差距远大于格式间差距）。另两个反 omp 论点的发现：**fuzzy matching 从未触发**（114 次成功编辑 0 次；失败是二元的——要么精确复现要么整体幻觉，"whitespace 近失"这个 hashline 的靶子在实际中几乎不存在）；omp 的 react-edit-benchmark 是 JS-only + LSP 反馈回路，**LSP confound** 使其难以泛化。
- **opencode #15424**（<https://github.com/anomalyco/opencode/issues/15424>）：`experimental.hashline_edit` 下第二次 edit 用陈旧 `LINE#ID` anchor 时**返回成功 "Updated" 但改动落错行或被静默丢弃**——"The agent receives `Updated` and continues, never knowing the change didn't persist correctly"。原话："**A silent success is far worse than a loud failure**"。⚠️ 这是"hashline 实现错了比没有 hashline 更危险"的实证：安全机制的正确性依赖实现质量，锚校验一旦漏判就制造虚假信任。
- **quangdang46/hashline#46 "Agents think in diffs, not anchors"**（<https://github.com/quangdang46/hashline/issues/46>）：提案把 hashline 从"门禁"改为"安全网"——模型写它本来就会写的 unified diff，hashline 负责验证落盘。"The current design says: 'to edit, you must first learn our anchor format.' **This is a tax on every agent.**"（锚点税）
- **sergiobonfiglio 的转向**：pi-hashline 作者本人后来做了 **pi-lean-edit**——"Safer, cheaper edits by **verifying prior reads in the harness instead of the prompt**... without the per-read overhead of hash-decorated output"（<https://github.com/sergiobonfiglio/pi-lean-edit>）。早期采用者亲手放弃"读时装饰哈希"，转为"harness 记账、编辑时验证"——逐行装饰的 read 开销是真实的。
- **相邻学术证据（正面）**：arxiv 2607.12713（FileMark）对 line-anchored feedback 的配对实验：输出 token −22%（Opus）/−58%（Sonnet），100+ 行文件 −24%~−80%，弱本地模型正确率 +5~7pp（<https://arxiv.org/html/2607.12713>）。**锚定降低成本的方向性成立**，但对象是反馈格式而非编辑协议——支持"锚定有价值"与"编辑协议是否该长这样"可分开讨论。

### 6.5 正面数据（"突破"素材）

- 博客 benchmark：14/16 模型 hashline ≥ patch；最弱模型 10×；Grok 4 Fast −61% token（§3.1）。
- #3772 实测：DeepSeek Flash 90.1% 成功、97.7% tag 合规（§6.1）——"格式能学、过期是主因"。
- Codeform 的模型分层：对 Claude 关、对 GPT-5.4/Gemini 3.1 Pro/MiniMax 开——hashline 定位为"弱位置感模型的补丁"而非通用最优（§5.2）。
- 用户的 June 2026 field notes（packages/pi-hashline-edit/README.md）：GLM 5.2 hashline 100%；Kimi K3 适合 string-replace（与 omp 排除 kimi 方向一致）；DeepSeek V4 Flash 失败但**单轮收敛**（hashline 失败是收敛型——mismatch 回传 live 内容+可重发锚，一次重试闭环；string-replace 失败是发散型——同一错误记忆反复重试）。⚠️ 注意 omp 把 deepseek-v4-flash 也切到 replace，与本观察结论相反——同一模型在不同环境/任务分布下结论可逆，文章可用这对矛盾说明"没有全局最优、只有模型×任务×实现的三元组"。

---

## 7. 文章可直接引用的事实清单（每条带出处）

**格式与机制**

1. 当前默认 edit 模式是 hashline；读取优先级 `edit.modelVariants` → `PI_EDIT_VARIANT` → `edit.mode` → 默认 hashline。— <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/utils/edit-mode.ts>
2. `[PATH#TAG]` 的 TAG = 归一化**全文件**文本的 xxHash32 低 16 位、4 位大写 hex（`computeFileHash`，format.ts）；16-bit 空间不能脱离 SnapshotStore 验证（npm README："not meaningful outside that store"）。— <https://github.com/can1357/oh-my-pi/blob/main/packages/hashline/src/format.ts>、<https://www.npmjs.com/package/@oh-my-pi/hashline>
3. 当前 op 集：`PUT N.=M:` / `PUT N*:` / `PUT <N:` / `PUT >N:` / `PUT >$:` / `PUT >N*:` / `CUT N.=M` / `CUT N*`（+`@name` 寄存器）/ `REM` / `MV`；body 行统一 `+TEXT`，body 是最终内容而非 diff。— <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/edit.md>
4. 任务描述的 SWAP/DEL/INS.* 是 v15.13.2（2026-06-15）~v17.2.1（2026-07-31）间的格式；v17.2.2 统一为 PUT/CUT。— <https://github.com/can1357/oh-my-pi/blob/main/packages/hashline/CHANGELOG.md>（§17.2.2 "Replaced legacy SWAP, INS, and PASTE syntax"）
5. 最早（2026-02-10~05-26）是**逐行哈希 + JSON 工具参数**：`LINE:HASH|content`，哈希曾缩到 2 hex。— <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md>（§11.10.1，2026-02-10）
6. 2026-02-12（v12.0.0）默认 edit mode 从 patch 改为 hashline，同日发博客。— coding-agent CHANGELOG §12.0.0 + <https://blog.can.ac/2026/02/12/the-harness-problem/>
7. read 输出 = `[PATH#TAG]` 头 + `LINE:TEXT` 行，**无逐行哈希**；折叠/elision 区视为未见过。— <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/read.md>、packages/hashline/src/prompt.md
8. 验证是**文件级**：live 文件哈希 ≠ tag → 整 patch 进 recovery；recovery 证明每个锚行映射到 live 中未变连续区域才重放，否则 fail-closed。— <https://github.com/can1357/oh-my-pi/blob/main/packages/hashline/src/recovery.ts>（文件头注释）
9. seen-line 守卫 `edit.enforceSeenLines` **默认 false**，但模型侧 prompt 仍教"undisplayed hunks REJECTED"。— settings-schema.ts + prompt.md（源码核验）
10. 成功返回新 `[path#TAG]` + 紧凑 diff 预览；prompt 铁律 "RE-GROUND AFTER EVERY EDIT"。— packages/hashline/src/prompt.md
11. 块操作由原生 tree-sitter 从 opening 行解析；锚在空行/闭合符/无节点/语法错误 → 拒绝并引导；`PUT >N*:` 失败降级为普通插入+警告；Markdown heading 解析为整个 section。— docs/tools/edit.md
12. 纯文本 patch + `grammar.lark` 作为约束解码文法挂到工具 `customFormat`。— packages/coding-agent/src/edit/index.ts + packages/hashline/src/grammar.lark

**动机与基准**

13. "none of these tools give the model a stable, verifiable identifier... They all rely on the model reproducing content it already saw." / "If they can recall a pseudo-random tag, chances are, they know what they're editing." / "You're blaming the pilot for the landing gear." — <https://blog.can.ac/2026/02/12/the-harness-problem/>
14. 基准：16 模型 × 3 runs × 180 tasks（React 注入机械 bug），hashline 14/16 胜 patch、平均 +15pts；Grok Code Fast 1 **6.7%→68.3%**；Grok 4 Fast **−61% output tokens**；MiniMax 2.1×；Gemini 3 Flash +8pp（78.3% 超 Google 自家 5pp）；**唯一输家 DeepSeek V3.2**。— 同上
15. 基线批判：Grok 4 patch 失败率 50.7%、GLM-4.7 46.2%；Claude str_replace "String not found" 有专门 megathread（+27 issues）。— 同上
16. README §11："whitespace battles and string-not-found loops just stop happening... we reject the patch before it corrupts anything." — <https://github.com/can1357/oh-my-pi/blob/main/README.md>

**失败与困境**

17. 当前模型排除名单：kimi / mimo / deepseek-v4-flash / step-3.7-flash → 默认 replace。— edit-mode.ts（源码核验）
18. #3772 实测（用户 szavadsky）：DeepSeek Flash 90.1% 成功、97.7% tag 合规、68% 失败是 staleness；can1357："Can't really repro... I have 90% success locally." — <https://github.com/can1357/oh-my-pi/issues/3772>
19. #2241 glm-5.1 错行编辑："this is a model capability issue, not a hashline design flaw"；can1357："ultimately this is a model thing." — <https://github.com/can1357/oh-my-pi/issues/2241>、PR #2243
20. no-op 死循环：205 次调用 182 次字节相同重复 → 3 次硬熔断。— <https://github.com/can1357/oh-my-pi/issues/2081>
21. omp 首日（v11.10.1）就在修"模型把 `LINE:HASH|` 前缀复制进 body""锚行回声"——与用户 insert_after 复制锚行观察同族。— coding-agent CHANGELOG §11.10.1
22. 17.2.12 修复的静默内容丢弃事故：read 行号重复粘贴曾致"block opener 被换成 `}` 并删除后续语句"。— packages/hashline CHANGELOG §17.2.12
23. geometricagi：**"Hashline methods fail when the model gets a hash wrong. It sees `483:d4`... writes `483:3a`. Every model does this, including Opus."**；hashline S/R 对 GPT-5.4 −10.3pp、Opus −6.9pp；AST edit 三模型 100% 零格式失败。— <https://geometricagi.github.io/2026/04/02/ast-edits.html>
24. nwyin edit-bench：Python 惩罚（gemini −25pp / gpt-4.1-mini −15pp / qwen −5pp）、TS 中性、Rust 平；"edit format is not the bottleneck"；fuzzy 匹配 114 次成功编辑 0 次触发（whitespace 近失实际不存在）；omp 基准有 LSP confound。— <https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html>、<https://github.com/nwyin/edit-bench/issues/14>
25. opencode #15424：陈旧 anchor 返回静默成功 "Updated"，改动落错/丢失——"A silent success is far worse than a loud failure"。— <https://github.com/anomalyco/opencode/issues/15424>
26. 锚点税批评："to edit, you must first learn our anchor format. This is a tax on every agent."（提案 diff-first、hashline 作验证网）— <https://github.com/quangdang46/hashline/issues/46>
27. sergiobonfiglio（pi-hashline 作者）转向 pi-lean-edit："without the per-read overhead of hash-decorated output"。— <https://github.com/sergiobonfiglio/pi-lean-edit>
28. 格式 churn ≥5 代（JSON→sigil→verb→SWAP→PUT/CUT），第三方被钉死在过期方言（YanwuZeng 停在 SWAP；PieX 靠 patch-package 维护 ^17.1.3 引擎）；omp.sh/docs 营销文案至今仍描述 v1 的逐行哈希（"Every line carries a short content-hash anchor"）而现行实现没有。— 各包 README/changelog + <https://omp.sh/docs>
29. 相邻学术证据：line-anchored feedback 降输出 token 22%~58%（Opus/Sonnet），大文件 24%~80%。— <https://arxiv.org/html/2607.12713>

**生态扩散**

30. pi 首个移植：RimuruW/pi-hashline-edit，npm 创建于 **2026-02-15**（博客后 3 天），"Inspired by oh-my-pi"，逐行 2-char 自定义字母表 + JSON ops + 3-way merge 恢复。— <https://github.com/RimuruW/pi-hashline-edit>、<https://www.npmjs.com/package/pi-hashline-edit>（registry 元数据）
31. opencode 于 2026-02 跟进（issue #13393 → PR #13405/#14677），experimental `hashline_edit`，`LINE#ID` anchors。— <https://github.com/anomalyco/opencode/issues/13393>
32. Codeform 独立实现逐行 2-char hash；默认对 GPT-5.4/Gemini 3.1 Pro/MiniMax M2.7 开、对 Claude 关（"strong positional fidelity"）；校验 additive、缺锚跳过、write 剥离锚前缀。— <https://codeform.io/docs/features/hashline-editing/>
33. Rust `hashline` crate：crates.io 创建 2026-05-24（quangdang46，v0.2.1）；早期逐行 2-char xxh32，现演进为 omp 式全文件 tag + SWAP/DEL/INS 方言；自带 MCP server 并自动写入 9 个 agent 宿主配置。— <https://crates.io/api/v1/crates/hashline>、<https://github.com/quangdang46/hashline>
34. PieX @piex-dev/hashline（2026-07-14）直接封装 `@oh-my-pi/hashline` npm 引擎；其文档三路线对比：omp 全文件 tag / pi-hashline-edit 逐行+上下文哈希 / pi-hashline-edit-pro 稳定映射。— <https://piex.dev/en/packages/hashline/>
35. Fadouse/pi-hash-anchored-edit（2026-05-06，逐行短 SHA-256）被 YanwuZeng/pi-hashline（2026-06-29，omp SWAP 方言）认作基底。— <https://github.com/Fadouse/pi-hash-anchored-edit>、<https://github.com/YanwuZeng/pi-hashline>
36. 用户自己的 field notes（GLM 5.2 100% / Kimi 反噬 / DeepSeek 失败但单轮收敛）与 omp 排除名单在 kimi 上同向、在 deepseek 上相反——"模型×任务×实现"三元组决定成败，无全局最优。— packages/pi-hashline-edit/README.md + edit-mode.ts
