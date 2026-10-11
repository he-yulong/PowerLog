# PowerLog 项目约定

## 架构

- 用户在本项目聊天里发训练数据，由助手调用本地工具更新根目录 `HylPowerliftingTraining.xlsx`。
- 目前只做纯静态前端可视化和本地文件工具，不添加后端、API、数据库或自动云同步服务。用户后来要求手机流量也能访问，已授权把 Excel 派生的只读数据副本发布到本人私有的 Sites 网页。
- `index.html` 是前端入口；`start.ps1` 仅启动本机静态文件服务器。
- Excel 是训练数据的唯一来源，不能用演示数据覆盖真实记录。

## 聊天录入

1. 收到明确的实际训练记录即执行更新。用户已经授权此工作流，无需每条记录重复确认，不能只回复“已记录”。
2. 常见格式：`python -m powerlog add --text '深蹲 140kg 5次×3组 RPE8' --today YYYY-MM-DD`。日期基准使用当前用户上下文的 Australia/Sydney 日期，勿固定复用示例日期。
3. 自由表达由助手解析成 JSON 数组，再用 `python -m powerlog add --json <临时文件>` 或 `--json -` 写入。字段：`date`、`lift`（S/B/D）、`exercise`、`weight_kg`、`reps`、`sets`、可选 `rpe`、`notes`、`max`。临时文件放 `.powerlog-runtime/`。
   - `exercise` 一律用英文，沿用表中已有写法：Comp Squat、High-bar Squat、Pause Squat、Pin Squat、Front Squat、Comp Bench、Pause Bench、Larsen Bench、Spoto Press、Dumbbell Bench、Comp Deadlift、Conv Deadlift、Pause Deadlift、RDL 等。只说“深蹲/卧推/硬拉”时，默认对应 Comp Squat/Comp Bench/Comp Deadlift。中文只用于聊天讨论，不写入 Excel。表中没有的新动作，用简洁的英文名称并在回执中说明。
4. 无日期默认当地今天，无单位默认公斤，并在回执展示。`140×5×3` 为重量×次数×组数。用户确认（2026-10-12）：只有两个数字的 `167.5*2` 是重量×次数，记 1 组；只写重量的 `147.5@10` 是单次，记 1 次 × 1 组；`@9` 是 RPE；`9.15` 这类日期是月.日，年份取最近一个不晚于今天的日期。缺少组数、次数或动作等实质歧义先问清，不猜测。
5. 不把计划、示例、疑问或讨论作为完成训练；不编造 RPE、备注、PR 或成绩。不同重量/次数拆成多条。
6. 成功后回复日期、动作、重量、次数×组数和工作表。重复提示如实报告，只有用户明确是另一批相同训练才用 `--allow-duplicate`。
7. 失败不能声称成功。Excel 占用时请用户关闭再试。
8. 用户明确要求撤销最近录入时使用 `python -m powerlog undo`（也能撤销最近一次更正）；其他更正先定位记录，勿作为追加或恢复整个旧文件覆盖外部修改。动作名写错时用 `python -m powerlog rename-exercise --sheet 2025-B --rows 55-59 --from 'Comp Deadlift' --to 'Comp Bench'`：先加 `--dry-run` 预览，只改当前值完全等于 `--from` 的单元格，合并单元格按首行修改。日期写错时用 `python -m powerlog set-dates --json <文件>`，文件是 `[{"sheet","row","from","to"}]` 数组：`from` 是单元格当前存的值（Excel 序列号或文字），`to` 是 `YYYY-MM-DD`；改成真实日期并显示为 `yyyy-mm-dd`，同样可以 `undo`。

## 工作簿

- 表：`2025-S` 深蹲、`2025-B` 卧推、`2025-D` 硬拉，名称不限制训练年份。
- 列：A日期 B动作 C重量kg D次数 E组数 F人工Max/PR G备注 H RPE。
- 末尾追加，保留历史行、合并区域和样式。F未明确提供时留空，估算1RM只在前端展示。
- 用户已确认历史日期基本按由旧到新追加，并授权结合前后顺序推断真实日期。前端兼容日/月/年文本，对旧Excel日期按顺序唯一推断日月倒置和异常年份；无法唯一确定时标注待确认。新ISO格式日期保持明确含义，补录不得破坏历史推断。页面展示校正明细。
- 2026-10-12 应用户要求，已把三张表全部 759 个旧日期在 Excel 里改成明确的 `yyyy-mm-dd` 真实日期：90 个日月颠倒或年份错误已改正，120 个文字日期转成了日期，其余只改显示格式。改前文件备份在 `.powerlog/HylPowerliftingTraining.xlsx/20261011T132734566452Z-c4094ba6.xlsx`。逐条核对过，1,626 条记录的日期与改前网页推断的结果完全一致。现在 Excel 里已经没有需要推断的日期；推断逻辑保留，只用于以后手动在 Excel 里输入的其他格式日期。
- 三表的日期格式变化时间不同，禁止整体翻转日月。已验证 S!A294、B!A618 是 2026-03-10（旧源存成了 2026-10-03，现已在 Excel 改正）；D!A270 原本就是 2026-03-10。最新历史记录：S2026-09-12、B2026-09-13、D2026-09-12（此结论只指本次原始历史，不能限制将来的新增日期）。
- 新增使用真实 Excel 日期及 `yyyy-mm-dd` 格式。
- `node scripts/plan-date-fixes.mjs <python解释器路径>` 只读：用前端同一套推断，为所有非 `yyyy-mm-dd` 的旧日期生成 `set-dates` 计划；有任何日期无法唯一确定时拒绝输出。2026-10-12 已用这个方法改正全部旧日期。以后如果有人手动在 Excel 里输入了其他格式的日期，可以用同样的方法改成 `yyyy-mm-dd`。
- 前端的最高训练重量和估算 1RM 包含全程变式，但不含半程动作，如 Pin Squat (high)（规则见 `web/xlsx-reader.js` 的 `PARTIAL_RANGE`）。训练量和组数仍然包含所有动作。这是用户 2026-10-12 选定的口径。

## 运行与验证

- Python 3.10+，只用标准库。PATH无Python时可用 `$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`。
- 测试：`python -m unittest discover -s tests -v`。写入测试只能针对临时副本，不向正式表写示例。
- 工作簿、`.powerlog/` 备份及运行时依赖不提交Git。

## 手机访问与发布

- 私人页面：https://hyl-powerlog.heyulong333.chatgpt.site 。仅本人账号访问，不擅自改为公开或组织共享。
- 已有 Site ID：`appgprj_6ac30c749bdc8191862d8549396e177f`。部署目录为 `.powerlog-runtime/mobile-site/`，标识保存在其中的 `.openai/hosting.json`；静态目录为 `out`。复用此 Site，不能重复创建。目录丢失时根据该 ID 恢复源代码。
- 成功新增、撤销或更正 Excel 后，助手按 Sites 托管技能重新生成并发布只读副本；无需重复询问。发布失败时如实区分“Excel 已保存”和“手机网页尚未更新”。重复录入被拒绝时不要重复写表。
- 构建：`node scripts/build-mobile.mjs <python解释器路径> [Sites工作目录]`。该命令只读取 Excel，生成 HTML/CSS/JS 和 `training-data.json`，复用前端的日期校正算法；不联网、不修改工作簿、不自行部署。
- 继续发布前按 Sites 技能打开现有 Site，使用返回的实际 checkout_path；然后构建、推送并发布本人私有版本。源工作簿和备份不上传、不提交Git；仅派生的静态数据副本进入私人网站的独立源仓库。根仓库仍忽略全部 `.powerlog-runtime/`。
- Windows 发布进程优先使用 Git Bash（`C:\Program Files\Git\bin`）及 Node 的 PATH，设置进程级 `TAR_OPTIONS=--force-local`，archivePath 使用 `E:/...` 格式。若提权进程因沙箱目录所有权被 Git 拒绝，仅在本次进程中为精确的 Site checkout 设置 `safe.directory`，不要改全局配置。凭据只传给托管脚本的隐藏标准输入，不写文件。
- 页面显示数据生成时间；刷新只获取最近已发布版本。手动改 Excel 后也需重新发布。手机查看已发布页面不依赖电脑在线；聊天录入及发布需要本地执行器可连接。

## Claude App 访问（Claude Code 发布）

- 用户要求在 Claude 手机 App 里查看，已授权把同一份只读副本发布成本人私有的 claude.ai Artifact：https://claude.ai/artifact/Rh5aD9FB51ej1SPZdnZ6is 。保持私有，不改共享设置，也不要另外新建 Artifact。
- 构建：`node scripts/build-artifact.mjs <python解释器路径> [输出目录]`，默认输出到 `.powerlog-runtime/artifact/`：页面 `powerlog.html`，加上 `web/app.js`、`web/styles.css`、`web/xlsx-reader.js` 和 `training-data.json`。和 `build-mobile.mjs` 共用 `scripts/snapshot.mjs`，只读取 Excel。
- 在 Claude Code 里成功新增、撤销或更正 Excel 后，重新构建，然后用 Artifact 工具发布到上面的 URL（`url` 填该地址；如果本会话还没读过这个 Artifact，先 read）。页面和上面 4 个文件一起发布，不需要重复询问。
- Claude Code 没有 Codex Sites 的发布工具，所以无法更新 chatgpt.site 页面。回执里要分别说明：Excel 已保存、Claude Artifact 已更新、chatgpt.site 未更新。

## Git

- 用户已授权：有重要更新（功能、修复、项目约定或文档变化）时，助手自己 `git commit` 并 `git push` 到 `origin main`，不需要每次询问。录入训练只改 Excel，不产生代码变化，所以不提交。
- 提交前跑完测试；只提交代码和文档。工作簿、`.powerlog/`、`.powerlog-runtime/` 都已被忽略，不能提交。不要 force push，不要跳过 hook。
