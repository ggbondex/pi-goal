/**
 * Logic tests for the goal-loop extension, driven by a fake model registry.
 * No network, no model calls, no cost. Run `npm test` (which runs setup first).
 */
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

// --- scenario 16: /goal plan starts a read-only research turn -------------
console.log("\n[16] /goal plan -> research turn");
await goal.handler("clear", makeCtx());
userMessages.length = 0;
notifications.length = 0;
await goal.handler("plan 给助手加记笔记能力", uiCtx());
check("planning turn started", String(userMessages.at(-1) ?? "").includes("planning stage"));
check("phase is planning", entries.at(-1)?.data?.phase === "planning", entries.at(-1)?.data);
check("source keeps the intent", entries.at(-1)?.data?.source?.intent?.includes("记笔记"));
check(
	"detail file is plugin-owned",
	String(entries.at(-1)?.data?.detailFile ?? "").startsWith(".pi/goal-plans/"),
	entries.at(-1)?.data?.detailFile,
);
check("planner told to write the detail file", String(userMessages.at(-1) ?? "").includes(entries.at(-1)?.data?.detailFile));

// --- scenario 17: planning settle parses the plan -------------------------
console.log("\n[17] planning settle -> draft");
const planObj = {
	objective: "给助手加记笔记能力",
	exit: "真机记一条、重启后能检索到，远程 E2E 全绿",
	milestones: [
		{ title: "契约与表", exit: "迁移干跑通过", why: "先定合同" },
		{ title: "后端读写", exit: "notes E2E 全绿", why: "写入面必须有 E2E" },
		{ title: "iOS 入口", exit: "单测绿 + 模拟器手点", why: "最后做能看见的" },
	],
};
notifications.length = 0;
let planResult = await settleAndCommit(assistantEvent(JSON.stringify(planObj)), uiCtx());
check("draft waits for confirmation", entries.at(-1)?.data?.phase === "awaiting-confirmation", entries.at(-1)?.data);
check("draft carries three milestones", entries.at(-1)?.data?.plan?.milestones?.length === 3);
check(
	"board shows progress, the current milestone, and the detail pointer",
	notifications.some((n) => n.includes("里程碑 0/3") && n.includes("▶ m1") && n.includes("详情 ")),
);

// --- scenario 18: a plain reply confirms; the plan drives -----------------
console.log("\n[18] confirm -> transform -> drive");
const transformed = await inputHandler({ type: "input", text: "同意", source: "interactive" }, makeCtx());
check("confirm transforms into the kickoff", transformed?.action === "transform", transformed);
check("kickoff names the objective", String(transformed?.text ?? "").includes("给助手加记笔记能力"));
check("kickoff names the first milestone", String(transformed?.text ?? "").includes("m1") && String(transformed?.text ?? "").includes("契约与表"));
check("goal is active after confirm", entries.at(-1)?.data?.active === true && entries.at(-1)?.data?.phase === undefined);
judgeReply = { done: true, blocked: false, reason: "m1 完成", next: "" };
planResult = await settleAndCommit(makeEvent(), makeCtx());
check("current milestone marked done", entries.at(-1)?.data?.plan?.milestones?.[0]?.status === "done", entries.at(-1)?.data?.plan?.milestones);
check("loop continues to the next milestone", planResult?.continue === true);
check("continuation names the new current milestone", String(planResult?.entries?.find((e) => e.type === "custom_message")?.content ?? "").includes("m2"));

// --- scenario 19: done is overruled while milestones remain ---------------
console.log("\n[19] plan advances one milestone at a time");
judgeReply = { done: true, blocked: false, reason: "m2 完成", next: "" };
planResult = await settleAndCommit(makeEvent(), makeCtx());
check(
	"only the current milestone advances",
	entries.at(-1)?.data?.plan?.milestones?.[1]?.status === "done" && entries.at(-1)?.data?.plan?.milestones?.[2]?.status !== "done",
);
check("still continues with m3 left", planResult?.continue === true, planResult);
judgeReply = { done: true, blocked: false, reason: "m3 完成", next: "" };
planResult = await settleAndCommit(makeEvent(), makeCtx());
check("finishes once every milestone is done", !planResult || planResult.continue !== true);
check("stop reason done", entries.at(-1)?.data?.stopReason === "done");
check("all milestones done", entries.at(-1)?.data?.plan?.milestones?.every((m) => m.status === "done"));
judgeReply = { done: false, blocked: false, reason: "not yet", next: "do X" };

// --- scenario 20: the planner asks questions; the reply re-plans ----------
console.log("\n[20] planner questions -> answers -> re-plan");
await goal.handler("clear", makeCtx());
notifications.length = 0;
userMessages.length = 0;
await goal.handler("plan 一个需要澄清的目标", uiCtx());
await settleAndCommit(assistantEvent(JSON.stringify({ needs_answers: ["用哪个数据库？", "要不要兼容旧数据？"] })), uiCtx());
check("phase awaiting answers", entries.at(-1)?.data?.phase === "awaiting-answers", entries.at(-1)?.data);
check("questions stored", entries.at(-1)?.data?.questions?.length === 2);
const answered = await inputHandler({ type: "input", text: "用 Postgres，不兼容旧数据", source: "interactive" }, uiCtx());
check("answer is consumed", answered?.action === "handled");
check("planning restarts", entries.at(-1)?.data?.phase === "planning", entries.at(-1)?.data);
check("answer recorded", entries.at(-1)?.data?.clarifications?.[0]?.includes("Postgres"));
check("planner told the answers", String(userMessages.at(-1) ?? "").includes("Postgres"));

// --- scenario 21: a plan with unknowns asks the user, then re-plans -------
console.log("\n[21] plan unknowns -> ask -> re-plan");
await goal.handler("clear", makeCtx());
notifications.length = 0;
userMessages.length = 0;
await goal.handler("plan 一个有待确认点的目标", uiCtx());
const planWithUnknowns = {
	objective: "O",
	exit: "E",
	milestones: [{ title: "A", exit: "a" }],
	unknowns: ["用哪个数据库？", "要不要兼容旧数据？"],
};
await settleAndCommit(assistantEvent(JSON.stringify(planWithUnknowns)), uiCtx());
check("phase awaiting answers", entries.at(-1)?.data?.phase === "awaiting-answers", entries.at(-1)?.data);
check("questions are the unknowns", entries.at(-1)?.data?.questions?.length === 2);
check(
	"questions are a separate prominent block",
	notifications.some((n) => n.includes("还没定") && n.includes("1. 用哪个数据库")),
);
check(
	"the board notification does not bury them",
	!notifications.some((n) => n.includes("里程碑") && n.includes("用哪个数据库")),
);
const unknownAnswer = await inputHandler({ type: "input", text: "用 Postgres，不兼容旧数据", source: "interactive" }, uiCtx());
check("answer consumed", unknownAnswer?.action === "handled");
check("re-planning restarts", entries.at(-1)?.data?.phase === "planning", entries.at(-1)?.data);
check("clarification recorded", entries.at(-1)?.data?.clarifications?.[0]?.includes("Postgres"));
// the re-plan still has unknowns, but the round is capped -> straight to confirmation
await settleAndCommit(assistantEvent(JSON.stringify(planWithUnknowns)), uiCtx());
check("stubborn unknowns are not re-asked", entries.at(-1)?.data?.phase === "awaiting-confirmation", entries.at(-1)?.data);

// --- scenario 22: bad planner output is fail-closed -----------------------
console.log("\n[22] planning failure is fail-closed");
await goal.handler("clear", makeCtx());
notifications.length = 0;
await goal.handler("plan 一个会失败的目标", uiCtx());
await settleAndCommit(assistantEvent("no json here at all"), uiCtx());
check("no goal is created", entries.at(-1)?.data?.cleared === true, entries.at(-1)?.data);
check("failure is reported", notifications.some((n) => n.includes("规划失败")), notifications);

// --- scenario 23: plain /goal stays plan-free -----------------------------
console.log("\n[23] plain /goal unaffected");
await goal.handler("clear", makeCtx());
userMessages.length = 0;
await goal.handler("一个普通目标", makeCtx());
check("starts directly", userMessages.at(-1) === "一个普通目标");
check("no plan attached", !entries.at(-1)?.data?.plan);

// --- scenario 24: stopping a draft stops the interception -----------------
console.log("\n[24] stopped draft is not intercepted");
await goal.handler("clear", makeCtx());
await goal.handler("plan 会被停掉的计划", uiCtx());
await settleAndCommit(
	assistantEvent(JSON.stringify({ objective: "会被停掉的计划", exit: "E", milestones: [{ title: "A", exit: "a" }] })),
	uiCtx(),
);
await goal.handler("stop", uiCtx());
const stopped = await inputHandler({ type: "input", text: "同意", source: "interactive" }, makeCtx());
check("stopped draft does not transform", stopped === undefined, stopped);

// --- scenario 25: the raw plan JSON is collapsed in the transcript --------
console.log("\n[25] raw plan JSON is collapsed");
await goal.handler("clear", makeCtx());
await goal.handler("plan 收起 JSON 的目标", uiCtx());
const messageEnd = handlers.message_end[0];
const planJson = JSON.stringify({ objective: "O", exit: "E", milestones: [{ title: "A", exit: "a" }] });
const replaced = await messageEnd(
	{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: planJson }] } },
	uiCtx(),
);
check("planning message replaced", replaced?.message?.content?.[0]?.text === "（已生成计划，见下方看板）", replaced);
check(
	"non-plan content untouched",
	(await messageEnd({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }, uiCtx())) === undefined,
);
// settle still sees the stashed JSON even though the transcript shows the placeholder
await settleAndCommit(
	makeEvent({ context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text: "（已生成计划，见下方看板）" }] }] } }),
	uiCtx(),
);
check("stashed JSON still reaches the settle step", entries.at(-1)?.data?.phase === "awaiting-confirmation", entries.at(-1)?.data);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
