# error-resilience：瞬时错误自愈 + 暂停可见

> 状态：代码完成（判据绿），待你在 pi 里手验（断网/限流场景难真造，可选）· 改动仓库：`~/Desktop/pi-goal`（tooling，不属 family-chat 的 M0–M5 产品计划）

- **出口状态**：provider 瞬时错误（429 / 超时 / 掉线；判定复用 pi-ai 的 `isRetryableAssistantError`，与 pi 内置 in-run 重试同一把尺子）不再让目标循环静默停摆——在 settle 边界内退避冷却（60s 起指数、5min 封顶、共 5 次 ≈17 分钟），把失败那轮 assistant 消息用 `context_edit` 抠出投影，附「错误重试」续跑消息 `continue:true`。预算烧完 → 暂停（`stopReason:"error"` + `waitingForUser:true`）：状态行显示「运行出错 · 等你答复」，用户下一句话自动恢复（复用现有 `before_agent_start` 恢复逻辑）。
- **判定调用加 90s 超时**（`AbortSignal.timeout`，与 `ctx.signal` 组合，Esc 仍可打断）：judge 挂死不再卡死 settle 边界；判定失败也走同一冷却 + 重试续跑（不计 iterations），连续 3 次仍失败才 `judge-error` 停机——原来 notify 后裸 return，循环卡死到用户回话。
- **暂停可见**：`updateStatus` 对 `waitingForUser` 暂停态（受阻/出错）显示状态行（今天直接清空）；`reconstruct` 同步清 `judging` / `settleRetries`，会话重载不残留。
- **受影响层**：仅本扩展 `index.ts` + `test/integration.test.mjs`；不碰 family-chat 任何代码与文档。
- **接口与数据**：`GoalState.stopReason` 增 `"error"`；`STOP_LABELS.error`；新环境变量 `PI_GOAL_RETRY_BASE_MS`（默认 60000）、`PI_GOAL_JUDGE_TIMEOUT_MS`（默认 90000）；从 pi-ai 导入 `isRetryableAssistantError`。
- **判据**（最便宜一档：本地扩展，无部署层，`npm test` 绿）：① 1 次合成 429 → 冷却 1 次自动重试 → 循环照常跑到上限，失败消息被 `context_edit` 抠出；② 连续 6 次错误 → 5 次预算烧完 → 暂停态可见（`stopReason:"error"`、`waitingForUser:true`、失败消息保留在分支），用户回话自动恢复并跑完；③ judge 挂死 → 超时 → 冷却重试继续，3 次后 `judge-error` 停机，主循环在超时之间持续运转。
- **非目标**：不做跨进程状态落盘；不做限流治理 / 多模型判定降级链；不改 pi 内置 in-run 重试的配置（那是用户 `settings.json` 的事，另议）。
