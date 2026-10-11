# PowerLog

力量举训练记录：**在项目聊天中录入，保存到本地 Excel，在浏览器查看趋势。** 当前版本没有后端、数据库、账号或云上传。

## 聊天录入

在本项目聊天发送实际完成的训练，例如：

```text
今天 深蹲 140kg 5次×3组 RPE8
卧推 90kg 3次×4组
硬拉 180kg 2次×3组 备注：最后一组较慢
```

跑步、爬楼机等有氧也可以记录，例如 `10.11 跑步 12km`、`10.12 爬楼机 400 大卡`，写入同一个 Excel 的 `Cardio` 表（日期、项目、距离、用时、热量、备注）。距离、用时、热量至少写一项。

助手调用本地工具更新 `HylPowerliftingTraining.xlsx` 并回复结果。没有日期时使用澳大利亚悉尼当天，没有单位时使用公斤。`140×5×3` 表示重量×次数×组数，RPE和备注可以不填。聊天由助手理解，没有后台监听服务；`AGENTS.md` 保存以后继续录入的项目约定。

## 浏览器可视化

在仓库目录打开 PowerShell：

```powershell
.\start.ps1
```

打开 [PowerLog 本地页面](http://127.0.0.1:8765)。这是本机静态文件服务器，页面读取同目录 Excel。聊天写入后点击刷新读取新记录，Ctrl+C 关闭服务器。

也可以双击 `index.html`，在页面选择 Excel。浏览器仅在本地读取，不上传数据。不支持持续文件读取的浏览器，刷新时须重新选择文件。

页面按手机优先设计，从上到下依次是：三项历史最佳之和（Total）和三张项目卡片；可以拖动查看每一天的力量趋势图（最高重量、估算1RM、训练量）；训练日历；有氧（每周跑量和其他有氧）；按天显示的训练日志。顶部的时间范围（30 天、90 天、1 年、全部）作用于下面所有板块。页面跟随系统切换浅色和深色。估算1RM采用 Epley 公式，单次取实际重量，不代表比赛成绩或实测极限。最高重量和估算1RM 包含全程杠铃变式，但不含 Pin Squat (high) 这类半程动作，也不含哑铃、自重等辅助动作；训练量仍然计入所有动作。失败/不完整记录会提示。

历史日期兼容 Excel 日期与日/月/年文本。根据记录基本由旧到新的约定，读取器结合前后日期推断日月倒置和明显年份笔误，仅在日期能唯一确定时用于统计。各表独立判断，硬拉的正常日期不会被整表翻转。页面“历史日期校正明细”可核查原值与推断值，原 Excel 文件不被重写；无法确定的日期保留待确认。新写入的 `yyyy-mm-dd` 日期使用明确的年月日含义。2026-10-12 起，Excel 里的旧日期已全部改成明确的 `yyyy-mm-dd` 日期，页面不再需要校正；上面的推断只用于以后手动输入的其他格式日期。

## 手机通过流量访问

打开 [PowerLog 私人训练页面](https://hyl-powerlog.heyulong333.chatgpt.site)，登录创建此站点的同一账号。App 内无法打开时，可用手机的 Safari 或 Chrome 打开链接。`127.0.0.1` 和电脑上的文件路径不能用于手机访问。

手机页面是私有托管的纯静态网页，读取 Excel 派生的只读数据副本，不需要业务后端、API 或数据库。Excel 仍是唯一数据来源，原工作簿及备份不上传。网页标明数据生成时间和历史日期校正明细。

在本项目聊天录入后，助手更新 Excel 并重新发布网页，再刷新手机页面。手动改 Excel 后可以在聊天里说“同步到手机网页”。本地命令行和网页刷新本身不会自动发布。手机查看不要求电脑开机；聊天写入本地 Excel 和重新发布时，电脑的执行器需在线。

维护时使用 `node scripts/build-mobile.mjs <python解释器路径> [Sites工作目录]` 生成静态文件，再按 Sites 托管技能发布已有私人站点。默认部署目录 `.powerlog-runtime/mobile-site/` 的 `out/` 中只有网页资源和 JSON 副本。已有站点 ID 和发布流程见 `AGENTS.md`，不要再次注册站点。

## 在 Claude 手机 App 里查看

同一份只读副本也发布成了私有的 claude.ai Artifact：[PowerLog](https://claude.ai/artifact/Rh5aD9FB51ej1SPZdnZ6is)。在 Claude App 里登录本人账号就能打开，只有本人可以访问。在 Claude Code 里录入训练后，助手会运行 `node scripts/build-artifact.mjs <python解释器路径>` 重新生成，然后发布到同一个链接。

## 命令行

Python 3.10+，标准库即可。PATH 无 Python 时可将 `python` 替换为 Codex 自带解释器的完整路径：`$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`。

```powershell
# 预览，不写表
python -m powerlog add --text '今天 深蹲 140kg 5次×3组 RPE8' --dry-run

# 请把以下示例替换成真实训练
python -m powerlog add --text '今天 深蹲 140kg 5次×3组 RPE8'

# 相对日期基准由聊天上下文确定
python -m powerlog add --text '昨天 卧推 90kg 3次×4组' --today 2026-10-05

# 记录有氧（第一次使用时自动创建 Cardio 表）
python -m powerlog add-cardio --json cardio.json   # [{"date":"2026-10-11","activity":"Run","distance_km":12,"duration":"1:02:30"},{"date":"2026-10-12","activity":"Stair Climber","calories_kcal":400}]

# 更正已有行的动作名（先 --dry-run 预览）
python -m powerlog rename-exercise --sheet 2025-B --rows 55-59 --from 'Comp Deadlift' --to 'Comp Bench' --dry-run

# 把旧格式日期改成明确的 yyyy-mm-dd 日期（先生成计划，再预览，再写入）
node scripts/plan-date-fixes.mjs python > .powerlog-runtime/date-plan.json
python -m powerlog set-dates --json .powerlog-runtime/date-plan.json --dry-run

# 撤销最近一次写入或更正
python -m powerlog undo
```

助手也可以将自由表达转换为 JSON：

```json
[{"date":"2026-10-05","lift":"S","exercise":"Pause Squat","weight_kg":140,"reps":5,"sets":3,"rpe":8,"notes":"最后一组较慢"}]
```

动作名称统一使用表中已有的英文写法（如 Comp Squat、Comp Bench、Comp Deadlift、RDL）。`--text` 也能识别中文别名，但写入 Excel 时会转换成英文；单说“深蹲/卧推/硬拉”时，对应的是 Comp Squat/Comp Bench/Comp Deadlift。

```powershell
python -m powerlog add --json records.json
python -m powerlog --workbook '其他路径\HylPowerliftingTraining.xlsx' add --json records.json
```

`lift` 为 S/B/D。可选 `max` 仅用于明确提供的 Max 数字或 `PR`，默认留空。`--request-id` 和相同内容检测防止重复请求。只有确认是另外一批相同训练时使用 `--allow-duplicate`。

## 文件保护

- 整批验证、生成候选文件并校验后，原子替换 Excel。
- 每次更新前备份到 `.powerlog/HylPowerliftingTraining.xlsx/`，并保存变更清单。
- 保留历史行、合并区域及不相关 ZIP 内容。新行使用普通样式，日期显示 `yyyy-mm-dd`。
- 更新前关闭 Excel 工作簿；并行录入由文件锁阻止。
- 最近录入后若有外部修改，自动撤销会拒绝覆盖这些更改，原备份仍保留。
- 工作簿和备份已加入 `.gitignore`。

## 开发与测试

```powershell
python -m unittest discover -s tests -v
node --test tests/frontend-reader.test.mjs
```

测试仅修改临时副本。前端采用原生 HTML/CSS/JavaScript，无远程依赖。本地页面直接读取 Excel；手机版本使用一次性的静态导出步骤和托管平台的私有访问控制，无业务后端。
