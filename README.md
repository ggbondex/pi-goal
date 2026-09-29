# goal-loop

自主目标循环扩展：给 pi 一个目标，它停下来时由 AI 判定目标是否真的完成；没完成就把目标再发一遍，直到完成、受阻、或达到续跑上限。

## 为什么

pi 做完一个小项就会停下来问"要不要继续"。跑长计划（例如 `docs/IMPLEMENTATION_PLAN.md` 的 29 个切片）时得一直盯着回车。
这个扩展把"要不要继续"的判断交给一个判定模型，而不是交给人。

## 用法

```
/goal 按 docs/IMPLEMENTATION_PLAN.md 从当前进度顺序完成，直到所有切片的判定都跑通过
```

之后：

```
/goal                 查看状态（目标、续跑次数、上次判定、下一步）
/goal off             停止循环（保留目标）
/goal resume          恢复循环并接着跑
/goal model <spec>    指定判定模型：auto | provider/modelId | modelId
/goal max <n>         续跑上限（默认 15）
```

一次性默认值可用环境变量：`PI_GOAL_MAX`、`PI_GOAL_MODEL`。

## 每一轮发生什么

1. `/goal <目标>` 把目标当作普通用户消息发出，agent 开始干活。
2. 当这轮 agent 真正要收尾时（`agent_before_settle`），扩展把目标 + 当前对话记录交给判定模型，要求它只返回一个 JSON：
   `{"done": bool, "blocked": bool, "reason": "...", "next": "..."}`。
3. 判定为 `done` → 停止，并提示"目标已完成"。
   `blocked` → 停止，并把"需要你决定什么"告诉你。
   都不是 → 注入一条续跑消息（含判定原因、下一步、以及**原始目标原文**），agent 继续。
4. 硬上限保护：最多自动续跑 `max` 次；判定连续失败 3 次也停；你在判定或干活时按 Esc 会直接停止循环。

判定提示词里专门写明：**agent 问"要不要继续"不算完成、也不算受阻**——这正是要修的行为。

## 设计上的取舍

- **判定基于证据**：要求 transcript 里有实证（文件改动、命令输出、测试结果）。目标里写清验收标准，判定会准得多。
- **默认跟随会话模型**：判定调用用的是当前会话模型；想省钱可以在 `/goal model` 里换成便宜模型。
- **只读 transcript 尾部 40k 字符**：目标很长时前面的上下文可能被截断，所以续跑消息里每次都重申原始目标。
- **状态存在会话里**：以 `custom` 条目写进 transcript，不落额外文件、不发网络、不起进程。分支/恢复时状态自动正确。
- **不干预无目标会话**：没有活动目标时，扩展在所有事件上都是空操作。

## 结构

- `index.ts` — 全部实现（单文件）
- 依赖：只 import pi 自带供给的包（`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`）

## 安装

作为 pi 包装（推荐）：

```bash
pi install git:github.com:ggbondex/pi-goal
```

或手动放到用户级扩展目录（所有项目生效）：

```bash
ln -s "$PWD" ~/.pi/agent/extensions/goal-loop
```

改完在 pi 里执行 `/reload`。

## 测试

```bash
npm test          # 先 test/setup.mjs 复用本机已装的 pi，再跑两个测试
```

- `test/mock.test.mjs` — 用假 model registry 覆盖各分支（启动 / 续跑 / 完成 / 受阻 / 中断 / 上限 / 恢复 / 判定失败 / 停止 / 状态行），不发网络、不花钱。
- `test/integration.test.mjs` — 在真实 pi 运行时里用假 provider 跑完整循环，验证续跑消息确实被下一轮看到。

`test/setup.mjs` 只是把本机已安装的 pi 包软链进 `node_modules/`，**不下载任何东西**；已存在的真实安装不会被覆盖。
