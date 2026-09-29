/**
 * Offline end-to-end test: drives the real pi agent runtime (sessions, the
 * agent loop, the before-settle boundary) against a fake in-process provider.
 * No network, no real model, no cost.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

process.env.PI_GOAL_MAX = "2";
const MAX = 2;

const sandbox = mkdtempSync(path.join(os.tmpdir(), "pi-goal-e2e-"));
const workDir = path.join(sandbox, "work");
const agentDir = path.join(sandbox, "agent");

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

function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
	return "";
}

function decide(messages) {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const text = textOf(lastUser?.content);
	if (text.includes("completion judge")) {
		judgeCalls += 1;
		return JSON.stringify({ done: false, blocked: false, reason: `judge call ${judgeCalls}`, next: "继续做" });
	}
	mainTurns += 1;
	const sawContinuation = messages.some(
		(m) => m.role === "user" && textOf(m.content).includes("[goal-loop 自动续跑"),
	);
	return `MAIN_TURN_${mainTurns} sawContinuation=${sawContinuation}`;
}

function fakeStream(context) {
	const stream = createAssistantMessageEventStream();
	const text = decide(context.messages);
	const message = {
		role: "assistant",
		api: "fake-api",
		provider: "fake",
		model: "fake-1",
		content: [{ type: "text", text }],
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
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
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
	stream: (_model, context) => fakeStream(context),
	streamSimple: (_model, context) => fakeStream(context),
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

const { session } = await createAgentSession({
	model,
	modelRuntime: runtime,
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(workDir),
	noTools: "all",
});

let ok = true;
try {
	session.subscribe((event) => {
		if (["agent_start", "agent_end", "agent_settled"].includes(event.type)) console.log("[event]", event.type);
	});
	await session.prompt("/goal 完成测试目标：让循环至少自动续跑两次");
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline && !(judgeCalls >= MAX && session.isIdle)) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await new Promise((resolve) => setTimeout(resolve, 100));

	const assistantTexts = session.messages.filter((m) => m.role === "assistant").map((m) => textOf(m.content));
	console.log("\n--- result ---");
	console.log("mainTurns:", mainTurns, "judgeCalls:", judgeCalls);
	console.log("assistant texts:", assistantTexts);

	const check = (name, condition, extra) => {
		console.log(`${condition ? "  ✓" : "  ✗"} ${name}`, condition ? "" : (extra ?? ""));
		if (!condition) ok = false;
	};
	check("no extension load errors", errors.length === 0, JSON.stringify(errors));
	check(`main ran ${MAX + 1} turns`, mainTurns === MAX + 1, mainTurns);
	check(`judge called ${MAX} times`, judgeCalls === MAX, judgeCalls);
	check("first turn saw no continuation", assistantTexts[0]?.includes("sawContinuation=false"), assistantTexts[0]);
	check("later turns saw the continuation", assistantTexts.slice(1).every((t) => t.includes("sawContinuation=true")), assistantTexts);
} finally {
	session.dispose();
	rmSync(sandbox, { recursive: true, force: true });
}

console.log(ok ? "\nintegration OK" : "\nintegration FAILED");
process.exit(ok ? 0 : 1);
