/**
 * Logic tests for the goal-loop extension, driven by a fake model registry.
 * No network, no model calls, no cost. Run `npm test` (which runs setup first).
 */
import { createJiti } from "jiti";

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

function makeCtx(overrides = {}) {
	const statuses = [];
	const ctx = {
		hasUI: false,
		mode: "print",
		ui: {
			notify: (m) => notifications.push(m),
			setStatus: (_key, value) => statuses.push(value),
		},
		modelRegistry: {
			getAll: () => [fakeModel],
			find: () => fakeModel,
			hasConfiguredAuth: () => true,
			complete: async () => ({ content: [{ type: "text", text: JSON.stringify(judgeReply) }] }),
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

const settle = handlers.agent_before_settle[0];
async function settleAndCommit(event, ctx) {
	const result = await settle(event, ctx);
	for (const draft of result?.entries ?? []) {
		if (draft.type === "custom") entries.push({ type: draft.customType, data: draft.data });
	}
	return result;
}

const goal = commands.goal;

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
check("does not continue on judge error", !result || result.continue !== true);
check("still active after 1 error", entries.at(-1)?.data?.active === true, entries.at(-1)?.data);
await settleAndCommit(makeEvent(), badCtx);
result = await settleAndCommit(makeEvent(), badCtx);
check("stops after 3 judge errors", entries.at(-1)?.data?.stopReason === "judge-error");

// --- scenario 9: off ------------------------------------------------------
console.log("\n[9] off");
await goal.handler("要停的目标", makeCtx());
await goal.handler("off", makeCtx());
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
await goal.handler("off", makeCtx());
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
await goal.handler("off", uiCtx());
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
