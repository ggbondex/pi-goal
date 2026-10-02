/**
 * Offline end-to-end test: drives the real pi agent runtime (sessions, the
 * agent loop, the before-settle boundary) against a fake in-process provider.
 * No network, no real model, no cost.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

process.env.PI_GOAL_MAX = "2";
// Fast cooldowns for the error-resilience phases: 20/40/80/100/100ms.
process.env.PI_GOAL_RETRY_BASE_MS = "20";
process.env.PI_GOAL_JUDGE_TIMEOUT_MS = "120";

const MAX = 2;

const sandbox = mkdtempSync(path.join(os.tmpdir(), "pi-goal-e2e-"));
const workDir = path.join(sandbox, "work");
const agentDir = path.join(sandbox, "agent");
// Disable pi's own in-run retry so a single provider error reaches the settle
// boundary exactly once — the plugin's cross-run cooldown is what's under test.
mkdirSync(agentDir, { recursive: true });
writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import("../index.ts");
const goalLoop = mod.default ?? mod;

const fakeModelDef = {
	id: "fake-1",
	name: "Fake",
	api: "fake-api",
	provider: "fake",
	baseUrl: "http://fake.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

let mainTurns = 0;
let judgeCalls = 0;
let blockNext = false;
let errorBudget = 0;
let errorAttempts = 0;
let hangJudge = false;
let judgeHangs = 0;

function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
	return "";
}

function lastUserText(context) {
	const messages = context?.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return textOf(messages[i].content);
	}
	return "";
}

function synthError(message) {
	return {
		role: "assistant",
		api: "fake-api",
		provider: "fake",
		model: "fake-1",
		content: [{ type: "text", text: "(provider error)" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function decide(messages) {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const text = textOf(lastUser?.content);
	if (text.includes("completion judge")) {
		judgeCalls += 1;
		if (blockNext) {
			blockNext = false;
			return JSON.stringify({ done: false, blocked: true, reason: "需要用户在方案 A/B 之间选", next: "" });
		}
		return JSON.stringify({ done: false, blocked: false, reason: `judge call ${judgeCalls}`, next: "继续做" });
	}
	mainTurns += 1;
	const sawContinuation = messages.some(
		(m) => m.role === "user" && textOf(m.content).includes("[goal-loop 自动续跑"),
	);
	return `MAIN_TURN_${mainTurns} sawContinuation=${sawContinuation}`;
}

function fakeStream(context, options) {
	const stream = createAssistantMessageEventStream();
	const text = lastUserText(context);
	const isJudge = text.includes("completion judge");

	// Injected transient provider failure (main turns only).
	if (!isJudge && errorBudget > 0) {
		errorBudget -= 1;
		errorAttempts += 1;
		stream.push({ type: "error", reason: "error", error: synthError("429 synthetic throttle (test)") });
		return stream;
	}
	// Judge call that never returns; only cancellation ends it (like a hung transport).
	if (isJudge && hangJudge) {
		judgeHangs += 1;
		const partial = { ...synthError(""), stopReason: "stop" };
		stream.push({ type: "start", partial });
		options?.signal?.addEventListener(
			"abort",
			() => stream.push({ type: "error", reason: "error", error: synthError("judge stream aborted (test)") }),
			{ once: true },
		);
		return stream;
	}

	const reply = decide(context.messages);
	const message = {
		role: "assistant",
		api: "fake-api",
		provider: "fake",
		model: "fake-1",
		content: [{ type: "text", text: reply }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "text_start", contentIndex: 0, partial: message });
	stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

const provider = {
	id: "fake",
	name: "Fake",
	auth: {
		apiKey: {
			name: "Fake key",
			resolve: async () => ({ auth: { apiKey: "fake-key" }, source: "test" }),
		},
	},
	getModels: () => [fakeModelDef],
	stream: (_model, context, options) => fakeStream(context, options),
	streamSimple: (_model, context, options) => fakeStream(context, options),
};

const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false, modelsPath: null });
runtime.registerNativeProvider(provider);
await runtime.setRuntimeApiKey("fake", "fake-key");
// Rebuild the availability snapshot so the runtime key counts as configured auth.
await runtime.getAvailable();

const model = runtime.getModel("fake", "fake-1");
if (!model) throw new Error("fake model not registered");

const loader = new DefaultResourceLoader({
	cwd: workDir,
	agentDir,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	extensionFactories: [goalLoop],
});
await loader.reload();
const errors = loader.getExtensions().errors;
console.log("extension load errors:", JSON.stringify(errors));

const sessionManager = SessionManager.inMemory(workDir);
const { session } = await createAgentSession({
	model,
	modelRuntime: runtime,
	resourceLoader: loader,
	sessionManager,
	agentDir,
	noTools: "all",
});

let ok = true;
const check = (name, condition, extra) => {
	console.log(`${condition ? "  ✓" : "  ✗"} ${name}`, condition ? "" : (extra ?? ""));
	if (!condition) ok = false;
};
async function waitFor(label, predicate, timeoutMs = 15000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until && !predicate()) await new Promise((resolve) => setTimeout(resolve, 50));
	await new Promise((resolve) => setTimeout(resolve, 100));
	if (!predicate()) console.log(`  … timed out waiting for ${label}`);
}

// The plugin persists its GoalState as custom entries on the branch.
function goalState() {
	let found = null;
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "goal-loop" && entry.data) {
			found = entry.data.cleared ? null : entry.data;
		}
	}
	return found;
}
const omissions = () => sessionManager.getBranch().filter((e) => e.type === "context_edit" && e.replacement === null).length;
const countMark = (mark) =>
	session.messages.filter((m) => m.role === "custom" && m.customType === "goal-loop-continuation" && textOf(m.content).includes(mark))
		.length;
const isResumeNotice = (m) =>
	m.role === "custom" && m.customType === "goal-loop-continuation" && textOf(m.content).includes("[goal-loop 恢复]");

try {
	session.subscribe((event) => {
		if (["agent_start", "agent_end", "agent_settled"].includes(event.type)) console.log("[event]", event.type);
	});

	// --- phase 1: "not done" keeps the loop going until the cap -----------
	await session.prompt("/goal 完成测试目标：让循环至少自动续跑两次");
	await waitFor("phase 1 cap", () => judgeCalls >= MAX && session.isIdle);

	const assistantTexts = session.messages.filter((m) => m.role === "assistant").map((m) => textOf(m.content));
	console.log("\n--- phase 1 ---");
	console.log("mainTurns:", mainTurns, "judgeCalls:", judgeCalls);
	console.log("assistant texts:", assistantTexts);
	check("no extension load errors", errors.length === 0, JSON.stringify(errors));
	check(`main ran ${MAX + 1} turns`, mainTurns === MAX + 1, mainTurns);
	check(`judge called ${MAX} times`, judgeCalls === MAX, judgeCalls);
	check("first turn saw no continuation", assistantTexts[0]?.includes("sawContinuation=false"), assistantTexts[0]);
	check("later turns saw the continuation", assistantTexts.slice(1).every((t) => t.includes("sawContinuation=true")), assistantTexts);

	// --- phase 2: blocked pauses; the user's answer resumes it -----------
	const turnsBefore = mainTurns;
	const judgesBefore = judgeCalls;
	blockNext = true;
	await session.prompt("/goal 第二个目标：受阻后要能自动恢复");
	await waitFor("blocked pause", () => judgeCalls === judgesBefore + 1 && session.isIdle);
	console.log("\n--- phase 2: blocked ---");
	console.log("mainTurns:", mainTurns, "judgeCalls:", judgeCalls, "idle:", session.isIdle);
	check("goal is paused after blocked", mainTurns === turnsBefore + 1 && judgeCalls === judgesBefore + 1, { mainTurns, judgeCalls });
	check("no resume notice while paused", !session.messages.some(isResumeNotice));

	await session.prompt("选方案 A");
	await waitFor("auto resume", () => session.messages.some(isResumeNotice) && mainTurns >= turnsBefore + 2);
	console.log("--- phase 2: after answer ---");
	console.log("mainTurns:", mainTurns, "judgeCalls:", judgeCalls);
	check("answering auto-resumes the goal", session.messages.some(isResumeNotice));
	check("the loop kept going after the answer", mainTurns >= turnsBefore + 2, mainTurns);

	// --- phase 3: one transient 429 → cooldown retry → loop continues -----
	console.log("\n--- phase 3: transient error ---");
	const p3 = { t: mainTurns, j: judgeCalls, e: errorAttempts, r: countMark("[goal-loop 错误重试"), o: omissions() };
	errorBudget = 1;
	await session.prompt("/goal 第三个目标：单次 429 后要自愈");
	await waitFor("transient recovery", () => judgeCalls === p3.j + 2 && session.isIdle);
	console.log("mainTurns:", mainTurns, "judgeCalls:", judgeCalls, "errorAttempts:", errorAttempts, "state:", goalState()?.stopReason);
	check("the failing turn was retried once", errorAttempts === p3.e + 1, errorAttempts);
	check("one cooldown continuation was sent", countMark("[goal-loop 错误重试") === p3.r + 1, countMark("[goal-loop 错误重试"));
	check("the failed message was omitted from context", omissions() === p3.o + 1, omissions());
	check("the loop kept going to its cap", goalState()?.stopReason === "max-iterations", goalState());
	check("judge still decided twice after recovery", judgeCalls === p3.j + 2, judgeCalls);

	// --- phase 4: persistent errors → 5 retries → visible pause → resume --
	console.log("\n--- phase 4: persistent errors ---");
	const p4 = { e: errorAttempts, r: countMark("[goal-loop 错误重试"), o: omissions() };
	errorBudget = 6; // one more than the 5-retry budget
	await session.prompt("/goal 第四个目标：持续错误要暂停而不是消失");
	await waitFor("pause after retries exhausted", () => session.isIdle && goalState()?.stopReason === "error");
	const paused = goalState();
	console.log("errorAttempts:", errorAttempts, "state:", JSON.stringify(paused && { ...paused, plan: undefined }));
	check("paused with stopReason error", paused?.stopReason === "error" && paused?.active === false, paused);
	check("the goal waits for the user", paused?.waitingForUser === true, paused);
	check("all six attempts failed", errorAttempts === p4.e + 6, errorAttempts);
	check("five cooldown retries were sent", countMark("[goal-loop 错误重试") === p4.r + 5, countMark("[goal-loop 错误重试"));
	// Every retried turn failure is omitted from context; only the final one (budget spent)
	// stays visible for the user.
	const branchErrorTurns = sessionManager.getBranch().filter((e) => e.type === "message" && e.message?.stopReason === "error").length;
	check("retried turns omitted, only the final one kept", omissions() === p4.o + 5 && branchErrorTurns === p4.o + 6, {
		omissions: omissions(),
		branchErrorTurns,
	});

	errorBudget = 0;
	const t4 = mainTurns;
	await session.prompt("好了，网络修好了，继续吧");
	await waitFor("resume after error pause", () => mainTurns >= t4 + 2 && session.isIdle);
	console.log("mainTurns:", mainTurns, "judgeCalls:", judgeCalls, "state:", goalState()?.stopReason);
	check("the user's message auto-resumed the loop", session.messages.some(isResumeNotice) && mainTurns === t4 + 3, mainTurns);
	check("the resumed goal ran to its cap", goalState()?.stopReason === "max-iterations", goalState());

	// --- phase 5: hung judge → timeout → cooldown retries → judge-error ---
	console.log("\n--- phase 5: hung judge ---");
	const p5 = { t: mainTurns, h: judgeHangs, k: countMark("[goal-loop 判定重试") };
	hangJudge = true;
	await session.prompt("/goal 第五个目标：判定挂死要超时而不是卡死");
	await waitFor("judge-error stop", () => session.isIdle && goalState()?.stopReason === "judge-error");
	hangJudge = false;
	const stopped = goalState();
	console.log("judgeHangs:", judgeHangs, "mainTurns:", mainTurns, "state:", stopped?.stopReason);
	check("the judge timed out three times", judgeHangs === p5.h + 3, judgeHangs);
	check("the loop kept running between timeouts", mainTurns === p5.t + 3, mainTurns);
	check("two judge-retry continuations were sent", countMark("[goal-loop 判定重试") === p5.k + 2, countMark("[goal-loop 判定重试"));
	check("stopped as judge-error", stopped?.active === false && stopped?.stopReason === "judge-error", stopped);
} finally {
	session.dispose();
	rmSync(sandbox, { recursive: true, force: true });
}

console.log(ok ? "\nintegration OK" : "\nintegration FAILED");
process.exit(ok ? 0 : 1);
