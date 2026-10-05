# goal-plan：目标 + 里程碑规划层

> 状态：代码完成（判据绿），待你在 pi 里手验（`/reload` → `/goal plan …`）· 改动仓库：`~/Desktop/pi-goal`（tooling，不属 family-chat 的 M0–M5 产品计划）

- **出口状态**：`/goal plan <意图|@文件>` 让 pi 先调研仓库（一次普通 pi turn，**不限制工具**），把**详细计划写进插件自己的文件** `.pi/goal-plans/<slug>.md`，只回一份**冻结的**「目标 + 有序里程碑」概要；打印看板，用户回一句「同意」后循环据此驱动；普通 `/goal <目标>` 行为完全不变。
- **判定按片，不按整目标**：计划模式下每轮收尾时，判定只回答一个窄问题——**当前里程碑完成了吗**。完成 → 标 ✅ → 自动进下一片；没完成 → 继续当前片。**整目标完成 = 所有片都 ✅**（推导，不单独问）。不再有「判定说完成但片没勾满就否决」那套补丁。
- **每轮给模型全貌 + 当前**：续跑消息带 总目标 + **完整里程碑路线（✅/▶/·）** + 详细计划文件路径；当前片由路线里的 ▶ 标出，它的 `exit` 也写在路线行上。
- **两个东西一个指针**：里程碑看板（概要，存会话状态）↔ 详细计划文件（正文，插件拥有）。用户 `@` 的文件**只读引用**，只有用户明确要求同步结论时才改。
- **受影响层**：pi-goal 扩展（`index.ts` 接线 + `plan.ts`）；**不碰 family-chat 任何代码与文档**。
- **接口与数据**：`GoalState` 增 `plan{objective,exit,milestones[],unknowns[],detailFile}`、`source{intent,file}`、`detailFile`、`phase:"planning"|"awaiting-answers"|"awaiting-confirmation"`、`questions[]`、`clarifications[]`、`askedUnknowns`；`plan.ts` 提供 `buildPlanningInstruction` / `parsePlan` / `parsePlannerReply` / `boardText` / `questionsText` / `kickoff` / `markDone` / `currentMilestone` / `isPlanComplete` / `classifyReply` / `findPlanFile` / `readPlanFile` / `planFilePath` / `ensurePlanDir`；新增 `input` 与 `message_end` 接线。
- **判据**（编译 + 单测，最便宜一档）：`npm test` 绿——① 规划期返回 `needs_answers` 挂起，回答后带答案重规划；② 合法 JSON 进 awaiting-confirmation，看板含里程碑/循环/详情指针；③ `unknowns` 单独一块 warning 式提问，答后重规划、不重复问；④ 规划失败 fail-closed；⑤ **判定 `done` = 当前片完成，一次只推进一片**，全片 ✅ 才结束；⑥ 普通 `/goal` 不带里程碑；⑦ 规划那轮的原始 JSON 被收起（`message_end`）但仍能到达 settle。
- **非目标**：不做「每个目标都强制规划」；**默认不写用户文件**；**不引入执行/验收命令（`pi.exec`）——相信 AI 的判断，不加重机制**；不做多计划/计划库。

## 结果（2026-10-01）

- 新增 `plan.ts`；`index.ts` 接线 `/goal plan`、`input` 确认/回答、`message_end` 收起 JSON、**按当前里程碑判定并推进**、看板；`package.json` 的 `files` 加 `plan.ts`；`.gitignore` 加 `.pi/goal-plans/`；`README.md` 文档化。
- 判据：`test/plan.test.mjs` **64/0** · `test/mock.test.mjs` **88/0**（含 16–25：调研→确认→驱动→**一次推进一片**→完成、`needs_answers`、unknowns 提问、规划失败 fail-closed、普通 `/goal` 不受影响、停掉的草案不再拦截、原始 JSON 收起）· `test/integration.test.mjs` OK。
- 无远程/部署层（本地扩展），验收 = 你在 pi 里跑一次 `/goal plan`。
- 耐久部分已并入 `README.md`；你手验通过后本片可删。

## 后续修订（2026-10，真链路暴露）

- **一轮认一片 → 一轮认一段**：判定多回一个 `done_through`（证据连续支持的最后一~片），循环一次 tick 当前片到那里（`index.ts` 的 tick 用 `plan.ts:milestoneRange`）。区间只向前；缺省 = 只有当前片。起因：8 片计划里 agent 一轮就把 m1–m6 都干完了，判定却一次只认一片，看着像"判定滞后"。
- **口径统一到一处**：开工轮与续跑共用 `plan.ts:requirementsText()`。原来开工轮说"目标全部完成时才停下来"、续跑说"只专注当前里程碑"—— agent 照前者一口气干几片，判定照后者一次只认一片，就是上面那个滞后的放大器。
- 判据仍是 `npm test`（plan 71/0 · mock 110/0 · integration OK）；新增用例：`milestoneRange` 的边界（缺省/向前/给早了/未知 id）+ mock 19b（`done_through: m2` 一轮 tick 两片、m3 留着；再 `done_through: m3` 收尾）。
