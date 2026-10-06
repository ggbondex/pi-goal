/**
 * Logic tests for the goal-loop extension, driven by a fake model registry.
 * No network, no model calls, no cost. Run `npm test` (which runs setup first).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

// Fast cooldowns / judge timeout so the error-resilience paths don't really sleep.
process.env.PI_GOAL_RETRY_BASE_MS = "1";
process.env.PI_GOAL_JUDGE_TIMEOUT_MS = "50";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import("../index.ts");
const goalLoop = mod.default ?? mod;

// --- fake pi surface ------------------------------------------------------
const handlers = {};
const commands = {};
const entries = [];
const userMessages = [];
const notifications = [];

const pi = {
	on: (event, handler) => {
		(handlers[event] ||= []).push(handler);
	},
	registerCommand: (name, opts) => {
		commands[name] = opts;
	},
	registerEntryRenderer: () => {},
	registerMessageRenderer: () => {},
	registerFlag: () => {},
	registerShortcut: () => {},
	appendEntry: (type, data) => entries.push({ type, data }),
	sendUserMessage: (content) => userMessages.push(content),
};

goalLoop(pi);
console.log("registered handlers:", Object.keys(handlers));
console.log("registered commands:", Object.keys(commands));

const fakeModel = { provider: "fake", id: "judge", name: "judge" };

let judgeReply = { done: false, blocked: false, reason: "not yet", next: "do X" };
let lastJudgePrompt = "";

function makeCtx(overrides = {}) {
	const statuses = [];
	const ctx = {
		hasUI: false,
		mode: "print",
		cwd: process.cwd(),
		ui: {
			notify: (m) => notifications.push(m),
			setStatus: (_key, value) => statuses.push(value),
		},
		modelRegistry: {
			getAll: () => [fakeModel],
			find: () => fakeModel,
			hasConfiguredAuth: () => true,
			complete: async (_model, options) => {
				lastJudgePrompt = options?.messages?.[0]?.content?.[0]?.text ?? "";
				return { content: [{ type: "text", text: JSON.stringify(judgeReply) }] };
			},
		},
		model: fakeModel,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		...overrides,
	};
	ctx.statuses = statuses;
	return ctx;
}

/**
 * Planning reads the plan file back off disk, so those scenarios run in a sandbox
 * directory. Everything else keeps using the repo cwd.
 */
const sandbox = mkdtempSync(path.join(os.tmpdir(), "pi-goal-mock-"));
const planCtx = (overrides = {}) => makeCtx({ hasUI: true, mode: "tui", cwd: sandbox, ...overrides });

function makeEvent(overrides = {}) {
	return {
		type: "agent_before_settle",
		entries: [],
		continue: false,
		outcome: "completed",
		context: { contextMessages: [] },
		...overrides,
	};
}

/** A settle whose last assistant message is `text` — how a planning turn answers. */
function assistantEvent(text) {
	return makeEvent({ context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text }] }] } });
}

const settle = handlers.agent_before_settle[0];
async function settleAndCommit(event, ctx) {
	const result = await settle(event, ctx);
	for (const draft of result?.entries ?? []) {
		if (draft.type === "custom") entries.push({ type: draft.customType, data: draft.data });
	}
	return result;
}

const goal = commands.goal;
const inputHandler = handlers.input[0];

let pass = 0;
let fail = 0;
function check(name, condition, extra) {
	if (condition) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}`, extra ?? "");
	}
}

// --- scenario 1: start a goal --------------------------------------------
console.log("\n[1] /goal start");
await goal.handler("把 IMPLEMENTATION_PLAN.md 全部做完", makeCtx());
check("sends objective as user message", userMessages.at(-1) === "把 IMPLEMENTATION_PLAN.md 全部做完");
check("persists state", entries.at(-1)?.type === "goal-loop" && entries.at(-1)?.data?.active === true);

// --- scenario 2: settle, judge says not done -> continue ------------------
console.log("\n[2] settle -> not done -> continue");
judgeReply = { done: false, blocked: false, reason: "S1.1 还没开始", next: "开始 S1.1" };
let result = await settleAndCommit(makeEvent({ entries: [{ type: "custom", customType: "other", data: 1 }] }), makeCtx());
check("continues", result?.continue === true);
check("keeps prior entries", result?.entries?.[0]?.customType === "other");
const continuation = result?.entries?.find((e) => e.type === "custom_message");
check("injects continuation message", Boolean(continuation));
check("continuation carries objective", continuation?.content?.includes("把 IMPLEMENTATION_PLAN.md 全部做完"));
check("continuation mentions next step", continuation?.content?.includes("开始 S1.1"));
check("iteration counted", entries.at(-1)?.data?.iterations === 1, entries.at(-1)?.data);

// --- scenario 3: judge says done -> stop ---------------------------------
console.log("\n[3] settle -> done -> stop");
judgeReply = { done: true, blocked: false, reason: "全部完成且已验证", next: "" };
result = await settleAndCommit(makeEvent(), makeCtx());
check("does not continue", !result || result.continue !== true);
check("state inactive", entries.at(-1)?.data?.active === false);
check("stop reason done", entries.at(-1)?.data?.stopReason === "done");

// --- scenario 4: blocked -> stop without burning iterations ---------------
console.log("\n[4] settle -> blocked -> stop");
await goal.handler("需要密钥的目标", makeCtx());
judgeReply = { done: false, blocked: true, reason: "需要 API key", next: "" };
result = await settleAndCommit(makeEvent(), makeCtx());
check("does not continue", !result || result.continue !== true);
check("stop reason blocked", entries.at(-1)?.data?.stopReason === "blocked");

// --- scenario 5: abort stops the loop ------------------------------------
console.log("\n[5] abort -> stop");
await goal.handler("会被中断的目标", makeCtx());
result = await settleAndCommit(makeEvent({ outcome: "aborted" }), makeCtx());
check("does not continue", !result || result.continue !== true);
check("stop reason manual", entries.at(-1)?.data?.stopReason === "manual");

// --- scenario 6: max iterations ------------------------------------------
console.log("\n[6] max iterations");
await goal.handler("无限目标", makeCtx());
await goal.handler("max 2", makeCtx());
check("max applies to active goal", entries.at(-1)?.data?.maxIterations === 2);
judgeReply = { done: false, blocked: false, reason: "还没完", next: "继续" };
await settleAndCommit(makeEvent(), makeCtx()); // iteration 1
await settleAndCommit(makeEvent(), makeCtx()); // iteration 2
result = await settleAndCommit(makeEvent(), makeCtx()); // cap
check("stops at cap", !result || result.continue !== true);
check("stop reason max-iterations", entries.at(-1)?.data?.stopReason === "max-iterations");

// --- scenario 7: resume ---------------------------------------------------
console.log("\n[7] resume");
userMessages.length = 0;
await goal.handler("resume", makeCtx());
check("resumes active", entries.at(-1)?.data?.active === true);
check("sends continuation prompt", typeof userMessages.at(-1) === "string" && userMessages.at(-1).includes("无限目标"));

// --- scenario 8: judge failure does not continue --------------------------
console.log("\n[8] judge error");
await goal.handler("judge 出错的目标", makeCtx());
const badCtx = makeCtx({
	modelRegistry: {
		getAll: () => [fakeModel],
		find: () => fakeModel,
		hasConfiguredAuth: () => true,
		complete: async () => {
			throw new Error("boom");
		},
	},
});
result = await settleAndCommit(makeEvent(), badCtx);
check("first judge error cools down and continues", result?.continue === true, result);
check(
	"the retry continuation names the attempt",
	(result?.entries ?? []).some((d) => d.type === "custom_message" && String(d.content ?? "").includes("[goal-loop 判定重试 1/3]")),
	result?.entries,
);
check("still active after 1 error", entries.at(-1)?.data?.active === true, entries.at(-1)?.data);
result = await settleAndCommit(makeEvent(), badCtx);
check("second judge error still continues", result?.continue === true, result);
result = await settleAndCommit(makeEvent(), badCtx);
check("stops after 3 judge errors", entries.at(-1)?.data?.stopReason === "judge-error", entries.at(-1)?.data);
check("judge-error stop is inactive", entries.at(-1)?.data?.active === false, entries.at(-1)?.data);

// --- scenario 9: off ------------------------------------------------------
console.log("\n[9] off");
await goal.handler("要停的目标", makeCtx());
await goal.handler("stop", makeCtx());
check("deactivated", entries.at(-1)?.data?.active === false && entries.at(-1)?.data?.stopReason === "manual");
result = await settleAndCommit(makeEvent(), makeCtx());
check("inactive goal never continues", !result || !result.entries?.length);

// --- scenario 10: abort during judging -----------------------------------
console.log("\n[10] abort while judging");
await goal.handler("会被中断的目标", makeCtx());
judgeReply = { done: false, blocked: false, reason: "还没完", next: "继续" };
const controller = new AbortController();
controller.abort();
const abortCtx = makeCtx();
Object.defineProperty(abortCtx, "signal", { get: () => controller.signal });
result = await settleAndCommit(makeEvent(), abortCtx);
check("does not continue", !result || result.continue !== true);
check("stop reason manual", entries.at(-1)?.data?.stopReason === "manual", entries.at(-1)?.data);

// --- scenario 11: /goal max refreshes the status line --------------------
console.log("\n[11] max updates footer status");
await goal.handler("状态行目标", makeCtx({ mode: "tui" }));
const tuiCtx = makeCtx({ mode: "tui" });
await goal.handler("max 50", tuiCtx);
check("last status shows 50", String(tuiCtx.statuses.at(-1) ?? "").includes("50"), tuiCtx.statuses.at(-1));

// --- scenario 12: blocked pauses; answering resumes automatically --------
console.log("\n[12] blocked pauses, answering resumes");
await goal.handler("stop", makeCtx());
await goal.handler("受阻目标", makeCtx());
judgeReply = { done: false, blocked: true, reason: "需要用户在方案 A/B 之间选", next: "" };
await settleAndCommit(makeEvent(), makeCtx());
check(
	"paused waiting for the user",
	entries.at(-1)?.data?.active === false && entries.at(-1)?.data?.waitingForUser === true,
	entries.at(-1)?.data,
);
const beforeAgentStart = handlers.before_agent_start[0];
const resumed = await beforeAgentStart({ type: "before_agent_start", prompt: "选 A" }, makeCtx());
check("resumes on the user's answer", entries.at(-1)?.data?.active === true, entries.at(-1)?.data);
check("injects a resume reminder", String(resumed?.message?.content ?? "").includes("原始目标"));
check("reminder restates the objective", String(resumed?.message?.content ?? "").includes("受阻目标"));
judgeReply = { done: false, blocked: false, reason: "继续做 A", next: "做 A" };
const afterResume = await settleAndCommit(makeEvent(), makeCtx());
check("continues after resuming", afterResume?.continue === true);
check("no resume while already active", (await beforeAgentStart({ type: "before_agent_start", prompt: "x" }, makeCtx())) === undefined);

// --- scenario 13: clear deletes the goal, even across a reload ------------
console.log("\n[13] clear removes the goal");
const uiCtx = () => makeCtx({ hasUI: true, mode: "tui" });
await goal.handler("stop", uiCtx());
await goal.handler("会被中止的目标", uiCtx());
await settleAndCommit(makeEvent({ outcome: "aborted" }), uiCtx());
check(
	"aborted goal is stopped but kept",
	entries.at(-1)?.data?.active === false && entries.at(-1)?.data?.objective === "会被中止的目标",
	entries.at(-1)?.data,
);
notifications.length = 0;
await goal.handler("status", uiCtx());
check("status still shows it before clear", notifications.some((n) => n.includes("会被中止的目标")), notifications);
const clearCtx = uiCtx();
await goal.handler("clear", clearCtx);
check("persists a cleared marker", entries.at(-1)?.data?.cleared === true, entries.at(-1)?.data);
check("clears the footer status", clearCtx.statuses.at(-1) === undefined, clearCtx.statuses.at(-1));
notifications.length = 0;
await goal.handler("status", uiCtx());
check("status is empty after clear", notifications.at(-1) === "当前没有目标。用法：/goal <目标>", notifications.at(-1));
const afterClear = await settleAndCommit(makeEvent(), uiCtx());
check("cleared goal never continues", !afterClear || !afterClear.entries?.length);
const branch = entries.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data }));
await handlers.session_start[0]({ type: "session_start" }, makeCtx({ sessionManager: { getBranch: () => branch } }));
notifications.length = 0;
await goal.handler("status", uiCtx());
check("stays cleared after a reload", notifications.at(-1) === "当前没有目标。用法：/goal <目标>", notifications.at(-1));

// --- scenario 14: help does not create a goal ----------------------------
console.log("\n[14] help");
notifications.length = 0;
await goal.handler("help", uiCtx());
check("help lists the commands", String(notifications.at(-1) ?? "").includes("/goal stop"), notifications.at(-1));
notifications.length = 0;
await goal.handler("status", uiCtx());
check("help created no goal", notifications.at(-1) === "当前没有目标。用法：/goal <目标>", notifications.at(-1));

// --- scenario 15: the judge prompt guards the common false stalls -------
console.log("\n[15] judge prompt guards");
await goal.handler("判定提示词目标", makeCtx());
judgeReply = { done: false, blocked: false, reason: "still going", next: "continue" };
await settleAndCommit(makeEvent(), makeCtx());
check("prompt says out-of-context is not a blocker", lastJudgePrompt.includes("ran out of context"));
check("prompt says the harness compacts automatically", lastJudgePrompt.includes("harness compacts"));
check("prompt says a continue-request is not completion", lastJudgePrompt.includes("shall I continue"));

// --- scenario 16: /goal plan starts a research turn that writes a plan -----
console.log("\n[16] /goal plan -> research turn that writes the plan file");
await goal.handler("clear", makeCtx());
userMessages.length = 0;
notifications.length = 0;
await goal.handler("plan 给助手加记笔记能力", planCtx());
check("planning turn started", String(userMessages.at(-1) ?? "").includes("planning stage"));
check("phase is planning", entries.at(-1)?.data?.phase === "planning", entries.at(-1)?.data);
check("source keeps the intent", entries.at(-1)?.data?.source?.intent?.includes("记笔记"));
check(
	"plan file is plugin-owned",
	String(entries.at(-1)?.data?.planFile ?? "").startsWith(".pi/goal-plans/"),
	entries.at(-1)?.data?.planFile,
);
check("planner told to write that file", String(userMessages.at(-1) ?? "").includes(entries.at(-1)?.data?.planFile));
check(
	"planner told the header contract",
	String(userMessages.at(-1) ?? "").includes("目标：") && String(userMessages.at(-1) ?? "").includes("出口："),
);

// --- scenario 17: the plan FILE is what the settle reads -------------------
console.log("\n[17] planning settle -> the file is the plan");
const PLAN_FILE = entries.at(-1)?.data?.planFile;
writeFileSync(
	path.join(sandbox, PLAN_FILE),
	[
		"目标：给助手加记笔记能力",
		"出口：迁移干跑通过 && notes E2E 全绿",
		"",
		"## 路线",
		"1. 契约与表（迁移干跑通过）",
		"2. 后端读写（notes E2E 全绿）",
		"3. iOS 入口（单测绿 + 模拟器手点）",
		"",
		"## 未定项",
		"- 无",
		"",
	].join("\n"),
);
notifications.length = 0;
let planResult = await settleAndCommit(assistantEvent("调研完了，计划写进文件了。"), planCtx());
check("draft waits for confirmation", entries.at(-1)?.data?.phase === "awaiting-confirmation", entries.at(-1)?.data);
check("objective comes from the file", entries.at(-1)?.data?.objective === "给助手加记笔记能力", entries.at(-1)?.data?.objective);
check("exit comes from the file", String(entries.at(-1)?.data?.exit ?? "").includes("notes E2E"), entries.at(-1)?.data?.exit);
check(
	"the draft shows the objective, the exit, the file and a preview",
	notifications.some(
		(n) =>
			n.includes("计划已写好") &&
			n.includes("目标：给助手加记笔记能力") &&
			n.includes("出口：") &&
			n.includes(PLAN_FILE) &&
			n.includes("## 路线"),
	),
	notifications,
);
check("no milestone bookkeeping is stored", entries.at(-1)?.data?.plan === undefined && entries.at(-1)?.data?.milestones === undefined);

// --- scenario 18: a plain reply confirms; the plan is handed to plain goal --
console.log("\n[18] confirm -> transform -> plain goal");
const transformed = await inputHandler({ type: "input", text: "同意", source: "interactive" }, planCtx());
check("confirm transforms into the kickoff", transformed?.action === "transform", transformed);
check("kickoff names the objective", String(transformed?.text ?? "").includes("给助手加记笔记能力"));
check("kickoff names the exit", String(transformed?.text ?? "").includes("notes E2E"));
check("kickoff points at the plan file", String(transformed?.text ?? "").includes(PLAN_FILE));
check("goal is active after confirm", entries.at(-1)?.data?.active === true && entries.at(-1)?.data?.phase === undefined);
check("the plan file is remembered on the goal", entries.at(-1)?.data?.planFile === PLAN_FILE);

// --- scenario 19: the judge judges the goal, not milestones ----------------
console.log("\n[19] completion is the judge's call, not a milestone count");
judgeReply = { done: false, blocked: false, reason: "笔记还没写", next: "先做契约与表" };
planResult = await settleAndCommit(makeEvent(), planCtx());
check("judge prompt carries the exit criterion", lastJudgePrompt.includes("notes E2E"), lastJudgePrompt.slice(0, 400));
check("judge prompt has no milestone machinery", !lastJudgePrompt.includes("done_through") && !lastJudgePrompt.includes("milestone"));
check("continuation points back at the plan", String(planResult?.entries?.find((e) => e.type === "custom_message")?.content ?? "").includes(PLAN_FILE));
check("continues", planResult?.continue === true);
judgeReply = { done: true, blocked: false, reason: "三样都验过了", next: "" };
planResult = await settleAndCommit(makeEvent(), planCtx());
check("judge says done -> the goal is done, no counting involved", !planResult?.continue && entries.at(-1)?.data?.stopReason === "done");
judgeReply = { done: false, blocked: false, reason: "not yet", next: "do X" };

// --- scenario 20: the planner asks instead of planning --------------------
console.log("\n[20] planner asks (no file) -> answers -> re-plan");
await goal.handler("clear", makeCtx());
notifications.length = 0;
userMessages.length = 0;
await goal.handler("plan 一个需要澄清的目标", planCtx());
await settleAndCommit(assistantEvent("用哪个数据库？要不要兼容旧数据？"), planCtx());
check("phase awaiting answers", entries.at(-1)?.data?.phase === "awaiting-answers", entries.at(-1)?.data);
check("its own words are kept as the question", String(entries.at(-1)?.data?.plannerMessage ?? "").includes("用哪个数据库"));
check("the question is shown prominently", notifications.some((n) => n.includes("需要你先回答") && n.includes("用哪个数据库")), notifications);
const answered = await inputHandler({ type: "input", text: "用 Postgres，不兼容旧数据", source: "interactive" }, planCtx());
check("answer is consumed", answered?.action === "handled");
check("planning restarts", entries.at(-1)?.data?.phase === "planning", entries.at(-1)?.data);
check("answer recorded", entries.at(-1)?.data?.clarifications?.[0]?.includes("Postgres"));
check("planner told the answers", String(userMessages.at(-1) ?? "").includes("Postgres"));
check("the question is cleared once answered", entries.at(-1)?.data?.plannerMessage === undefined);

// --- scenario 20b: a planner that never writes the file gets stopped -------
console.log("\n[20b] a planner that never writes the file is stopped, not looped");
await goal.handler("clear", makeCtx());
notifications.length = 0;
await goal.handler("plan 一个永远不写文件的目标", planCtx());
await settleAndCommit(assistantEvent("我需要更多信息。"), planCtx());
await inputHandler({ type: "input", text: "信息在这里", source: "interactive" }, planCtx());
await settleAndCommit(assistantEvent("还是不行。"), planCtx());
await inputHandler({ type: "input", text: "再给一点", source: "interactive" }, planCtx());
await settleAndCommit(assistantEvent("我真写不出来。"), planCtx());
check("stopped instead of asking forever", entries.at(-1)?.data?.cleared === true, entries.at(-1)?.data);
check("says why, and quotes the planner", notifications.some((n) => n.includes("没写出计划文件") && n.includes("我真写不出来")), notifications);

// --- scenario 21: a plan file without the header is not a plan -------------
console.log("\n[21] a file without 目标 is not a plan");
await goal.handler("clear", makeCtx());
notifications.length = 0;
await goal.handler("plan 写了个没有目标字段的文件", planCtx());
writeFileSync(path.join(sandbox, entries.at(-1)?.data?.planFile), "我调研了一下，大概是这样做的……\n");
await settleAndCommit(assistantEvent("写好了。"), planCtx());
check("treated as a question, not as a plan", entries.at(-1)?.data?.phase === "awaiting-answers", entries.at(-1)?.data);

// --- scenario 22: bad planning outcome is fail-closed ---------------------
console.log("\n[22] planning failure is fail-closed");
await goal.handler("clear", makeCtx());
notifications.length = 0;
await goal.handler("plan 一个会失败的目标", planCtx());
await settleAndCommit(makeEvent({ outcome: "error" }), planCtx());
check("no goal is created", entries.at(-1)?.data?.cleared === true, entries.at(-1)?.data);
check("failure is reported", notifications.some((n) => n.includes("规划以错误结束")), notifications);
notifications.length = 0;
userMessages.length = 0;
await goal.handler("plan 一个什么都不产出的目标", planCtx());
await settleAndCommit(assistantEvent("   "), planCtx());
check("empty planning turn is fail-closed too", entries.at(-1)?.data?.cleared === true, entries.at(-1)?.data);
check("and says nothing was produced", notifications.some((n) => n.includes("没写成")), notifications);

// --- scenario 23: plain /goal stays plan-free -----------------------------
console.log("\n[23] plain /goal unaffected");
await goal.handler("clear", makeCtx());
userMessages.length = 0;
await goal.handler("一个普通目标", makeCtx());
check("starts directly", userMessages.at(-1) === "一个普通目标");
check("no plan attached", !entries.at(-1)?.data?.planFile && !entries.at(-1)?.data?.exit);
await settleAndCommit(makeEvent(), makeCtx());
check("judge prompt has no exit block", !lastJudgePrompt.includes("<exit>"));
judgeReply = { done: false, blocked: false, reason: "not yet", next: "do X" };

// --- scenario 24: stopping a draft stops the interception -----------------
console.log("\n[24] stopped draft is not intercepted");
await goal.handler("clear", makeCtx());
await goal.handler("plan 会被停掉的计划", planCtx());
writeFileSync(path.join(sandbox, entries.at(-1)?.data?.planFile), "目标：会被停掉的计划\n出口：E\n");
await settleAndCommit(assistantEvent("写好了。"), planCtx());
await goal.handler("stop", planCtx());
const stopped = await inputHandler({ type: "input", text: "同意", source: "interactive" }, makeCtx());
check("stopped draft does not transform", stopped === undefined, stopped);

// --- scenario 25: the planner's text stays in the transcript --------------
console.log("\n[25] nothing is hidden from the transcript");
check("no message_end interception is registered", handlers.message_end === undefined, Object.keys(handlers));

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
