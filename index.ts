/**
 * goal-loop — an autonomous goal loop for pi.
 *
 * Problem it solves: pi finishes "one small item", writes a summary and asks
 * "shall I continue?". If you are running a long plan you have to babysit it.
 *
 * How it works:
 *   /goal <objective>   start the loop and send <objective> as the first turn
 *
 * When the agent run reaches its final boundary (`agent_before_settle`) the
 * extension asks a judge model whether the objective is really complete, using
 * only the transcript as evidence. If the judge says "not done" (which includes
 * "the agent asked for permission to continue"), the loop injects a continuation
 * message carrying the original objective and the agent keeps working. When the
 * judge says "done" (or "blocked" on a decision only the user can make), the loop
 * stops. A hard iteration cap prevents runaway loops.
 *
 * Commands:
 *   /goal <objective>      start a goal (or replace the current one)
 *   /goal plan <idea|@f>   plan an objective + ordered milestones first, then run
 *   /goal                  show status (the milestone board when there is a plan)
 *   /goal stop             stop the loop (keeps the objective for /goal resume)
 *   /goal resume           re-activate from the last verdict and keep going
 *   /goal clear            delete the goal entirely
 *   /goal model <spec>     judge model: "auto" | "provider/modelId" | modelId
 *   /goal max <n>          hard cap on automatic continuations (default 15)
 *   /goal help             usage
 *
 * Plan mode is opt-in: only `/goal plan` does it. It reads the referenced file
 * (read-only), asks a model to turn the intent into a frozen objective plus an
 * ordered list of milestones, prints the board, and waits. The user confirms
 * with an ordinary reply ("同意"); the extension classifies it — no second
 * `/goal plan` is needed. Plain `/goal` keeps the old verbatim behavior.
 *
 * Environment defaults:
 *   PI_GOAL_MAX            default max continuations
 *   PI_GOAL_MODEL          default judge model spec
 *   PI_GOAL_RETRY_BASE_MS  base backoff for transient-error cooldowns (default 60s)
 *   PI_GOAL_JUDGE_TIMEOUT_MS  judge call timeout (default 90s)
 *
 * State is stored in the session transcript as a `custom` entry, so branching
 * and resuming behave correctly. It never leaves the session.
 */

import { isRetryableAssistantError, uuidv7, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	BeforeAgentStartEventResult,
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageRenderOptions,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	boardText,
	buildPlanningInstruction,
	classifyReply,
	currentMilestone,
	ensurePlanDir,
	findPlanFile,
	isPlanComplete,
	kickoff,
	markDone,
	parsePlannerReply,
	planFilePath,
	questionsText,
	readPlanFile,
	type Plan,
	type PlanSource,
	type PlannerReply,
} from "./plan.ts";

const ENTRY_TYPE = "goal-loop";
const MESSAGE_TYPE = "goal-loop-continuation";
const STATUS_KEY = "goal-loop";

const DEFAULT_MAX_ITERATIONS = 15;
const MAX_JUDGE_ERRORS = 3;
const TRANSCRIPT_TAIL_CHARS = 40_000;

/**
 * Transient provider errors get a bounded cross-run cooldown once pi's own
 * in-run retries are exhausted: base * 2^(n-1) backoff, 5 attempts ≈ 17 min.
 */
const MAX_SETTLE_RETRIES = 5;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_BASE_MS = parsePositiveInt(process.env.PI_GOAL_RETRY_BASE_MS) ?? 60_000;
const JUDGE_TIMEOUT_MS = parsePositiveInt(process.env.PI_GOAL_JUDGE_TIMEOUT_MS) ?? 90_000;

type NotifyKind = "info" | "warning" | "error";

const STOP_LABELS: Record<string, string> = {
	done: "已完成",
	blocked: "受阻待答复",
	"max-iterations": "已达续跑上限",
	manual: "已停止",
	"judge-error": "判定失败",
	error: "运行出错",
};

const HELP_TEXT = [
	"/goal <目标>         启动目标循环（会覆盖当前目标）",
	"/goal plan <目标|@文件>  先生成目标 + 里程碑看板，确认后再跑",
	"/goal                查看状态（有计划时显示里程碑看板）",
	"/goal stop           停止循环（保留目标，可 resume）",
	"/goal resume         从断点接着跑",
	"/goal clear          彻底清除目标",
	"/goal model <spec>   判定模型：auto | provider/modelId | modelId",
	"/goal max <n>        自动续跑上限（默认 15）",
].join("\n");

interface Verdict {
	done: boolean;
	blocked: boolean;
	reason: string;
	next: string;
}

interface GoalState {
	active: boolean;
	objective: string;
	iterations: number;
	maxIterations: number;
	/** "" means "use the session's active model". */
	judgeModel: string;
	stopReason?: "done" | "blocked" | "max-iterations" | "manual" | "judge-error" | "error";
	/** True when the loop paused because it needs an answer from the user. */
	waitingForUser?: boolean;
	/** Set on the tombstone entry that deletes the goal from the branch. */
	cleared?: boolean;
	/** Planning lifecycle: research, then await answers or confirmation. */
	phase?: "planning" | "awaiting-answers" | "awaiting-confirmation";
	/** Frozen objective + milestones; only set in plan mode. */
	plan?: Plan;
	/** The user's raw intent and plan file, kept for provenance and re-planning. */
	source?: PlanSource;
	/** The plugin-owned file holding this plan's detail. */
	detailFile?: string;
	/** Questions the planner asked before it could plan. */
	questions?: string[];
	/** Answers / change requests the user gave, fed back into re-planning. */
	clarifications?: string[];
	/** True once we have already asked the user about a plan's unknowns. */
	askedUnknowns?: boolean;
	lastVerdict?: Verdict;
	createdAt: number;
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 1 ? n : undefined;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asBool(value: unknown): boolean {
	return value === true || value === "true" || value === 1;
}

function stateDraft(state: GoalState): SessionBoundaryDraft {
	return { type: "custom", customType: ENTRY_TYPE, data: state };
}

function backoffMs(attempt: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

function formatDelay(ms: number): string {
	return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** Resolve after ms; true when `signal` aborted during the wait. */
function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		if (signal?.aborted) {
			clearTimeout(timer);
			resolve(true);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * The still-projected assistant message the run failed on, with its entry id.
 * Earlier failed attempts are already hidden by pi's own in-run retry edits.
 */
function lastErrorAttempt(event: AgentBeforeSettleEvent): { targetId?: string; message?: AssistantMessage } {
	const entries = event.context?.contextEntries ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const source = entries[i].sourceEntry as { type?: string; id?: string; message?: AssistantMessage };
		const message = source?.message;
		if (source?.type !== "message" || message?.role !== "assistant" || message.stopReason !== "error") continue;
		if (!entries[i].messages.length) continue; // already omitted from the projection
		return { targetId: source.id, message };
	}
	return {};
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

function buildJudgePrompt(objective: string, transcript: string, plan?: Plan): string {
	const current = plan ? currentMilestone(plan) : undefined;
	const lines = [
		"You are the completion judge inside an autonomous coding-agent loop.",
		"",
		"GOAL (the terminal state):",
		"<goal>",
		objective,
		"</goal>",
	];
	if (plan && current) {
		lines.push(
			"",
			"You are judging ONE milestone of this plan, NOT the whole goal.",
			`CURRENT MILESTONE: ${current.id} ${current.title}`,
			`ITS EXIT (done when): ${current.exit}`,
			"",
			"Decide whether THIS milestone is DONE, using ONLY evidence in the transcript.",
			"",
			"Rules:",
			"- Require concrete evidence in the transcript: files created or edited, commands run and their results, tests passing. A claim alone is not evidence.",
			"- Judge only this milestone. A later milestone being done does not finish this one, and later milestones are not required here.",
			"- The agent asking \"shall I continue?\" / writing a summary and pausing is NOT done: answer done=false and name the next concrete step.",
			"- Out of context / a length limit / asking for a fresh session is NOT a blocker; the harness compacts and continues. Answer done=false and name the next concrete step.",
			"- Set blocked=true only when the agent genuinely cannot proceed without new information, credentials, or a decision only the user can supply.",
			"- If the milestone is not done, next must be a single concrete step toward it.",
			"",
			"ALL MILESTONES (context only; [>] is the one you are judging):",
			...plan.milestones.map(
				(m) => `- [${m.status === "done" ? "x" : m.id === current.id ? ">" : " "}] ${m.id} ${m.title} — ${m.exit}`,
			),
			"",
			"Reply with ONE JSON object and nothing else (no markdown fences, no prose):",
			'{"done": <boolean: is the CURRENT MILESTONE done?>, "blocked": <boolean>, "reason": "<one or two sentences>", "next": "<single concrete next action>"}',
		);
	} else {
		lines.push(
			"",
			"Decide whether the GOAL is FULLY achieved, using ONLY evidence in the transcript.",
			"",
			"Rules:",
			"- Judge against the goal's own success criteria, not against \"the agent did something\".",
			"- Require concrete evidence in the transcript: files created or edited, commands run and their results, tests passing, artifacts produced.",
			"- The agent asking the user \"shall I continue?\" / writing a summary and pausing is NOT completion and NOT a blocker: answer done=false and name the next concrete step.",
			"- The agent claiming it ran out of context or hit a length limit is NOT a blocker: the harness compacts and continues. Answer done=false and name the next concrete step.",
			"- Set blocked=true only when the agent genuinely cannot proceed without new information, credentials, or a decision only the user can supply.",
			"- If done=true then next must be an empty string.",
			"- Do not invent requirements the goal does not state. Be strict but fair.",
			"",
			"Reply with ONE JSON object and nothing else (no markdown fences, no prose):",
			'{"done": <boolean>, "blocked": <boolean>, "reason": "<one or two sentences>", "next": "<single concrete next action, or empty string>"}',
		);
	}
	lines.push("", "TRANSCRIPT (oldest to newest; it may be truncated at the front):", "<transcript>", transcript, "</transcript>");
	return lines.join("\n");
}

function buildContinuation(objective: string, verdict: Verdict, iteration: number, max: number, plan?: Plan): string {
	const step = verdict.next.trim() || "继续推进当前里程碑，直到它完成并自行验证。";
	const head = plan
		? verdict.done
			? "上一轮的里程碑已完成，已自动进入下一片。"
			: "当前里程碑尚未完成，已自动接续，无需等待用户确认。"
		: "上一轮结束时目标尚未完成，现已自动接续，无需等待用户确认。";
	const lines = [
		`[goal-loop 自动续跑 ${iteration}/${max}]`,
		head,
		"",
		`判定原因：${verdict.reason || "(未给出)"}`,
		`下一步：${step}`,
		"",
		"--- 原始目标 ---",
		objective,
	];
	if (plan) {
		const current = currentMilestone(plan);
		lines.push(
			"",
			"--- 里程碑路线（▶ 当前）---",
			...plan.milestones.map((m) => `${m.status === "done" ? "✅" : m === current ? "▶" : "·"} ${m.id} ${m.title} — ${m.exit}`),
		);
		if (plan.detailFile) lines.push(`详细计划：${plan.detailFile}`);
	}
	lines.push(
		"",
		"要求：",
		"- 不要询问我是否继续，直接执行。",
		"- 只专注当前里程碑；每完成一步自行验证（跑测试 / 读回文件 / 检查命令输出）。",
		"- 只有当你确信当前里程碑完成、或确实需要我提供信息/做决定时才停下来。",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function goalLoop(pi: ExtensionAPI): void {
	let state: GoalState | null = null;
	let judging = false;
	let judgeErrors = 0;
	/** Transient-error cooldowns spent on the current goal. */
	let settleRetries = 0;
	/** The planning turn's raw JSON, kept out of the transcript but available at settle. */
	let planningOutput = "";

	let defaultMaxIterations = parsePositiveInt(process.env.PI_GOAL_MAX) ?? DEFAULT_MAX_ITERATIONS;
	let defaultJudgeModel = process.env.PI_GOAL_MODEL ?? "";

	function notify(ctx: ExtensionContext, message: string, kind: NotifyKind = "info"): void {
		if (ctx.hasUI) {
			try {
				ctx.ui.notify(message, kind);
				return;
			} catch {
				// fall through to stderr
			}
		}
		// json / print modes have no UI surface
		console.error(`[goal-loop] ${message}`);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		try {
			if (state?.phase === "planning") {
				ctx.ui.setStatus(STATUS_KEY, "🎯 规划中…");
			} else if (state?.active) {
				const label = state.plan
					? `🎯 ${state.plan.milestones.filter((m) => m.status === "done").length}/${state.plan.milestones.length} · ${state.iterations}/${state.maxIterations}轮 ${state.plan.objective.slice(0, 16)}`
					: `🎯 goal ${state.iterations}/${state.maxIterations}`;
				ctx.ui.setStatus(STATUS_KEY, label);
			} else if (state?.waitingForUser && state.stopReason) {
				ctx.ui.setStatus(STATUS_KEY, `🎯 ${STOP_LABELS[state.stopReason] ?? state.stopReason} · 等你答复`);
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		} catch {
			// status is cosmetic; never fail the run for it
		}
	}

	function persist(): void {
		if (state) pi.appendEntry(ENTRY_TYPE, state);
	}

	/** Show a plan: the board, then the undecided points as their own warning block. */
	function showPlan(ctx: ExtensionContext, plan: Plan, header?: string): void {
		const run = state ? { iterations: state.iterations, maxIterations: state.maxIterations } : undefined;
		notify(ctx, `${header ? `${header}\n\n` : ""}${boardText(plan, run)}`, "info");
		const questions = questionsText(plan);
		if (questions) notify(ctx, questions, "warning");
	}

	function reconstruct(ctx: ExtensionContext): void {
		let last: GoalState | null = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
				const data = entry.data as GoalState;
				// A cleared marker tombstones every goal before it on this branch.
				last = data.cleared ? null : data;
			}
		}
		state = last ? { ...last, judgeModel: last.judgeModel ?? "" } : null;
		judgeErrors = 0;
		judging = false;
		settleRetries = 0;
		updateStatus(ctx);

		if (state?.phase === "planning") {
			// A planning turn cannot survive a reload: ask for a fresh one.
			state = null;
			pi.appendEntry(ENTRY_TYPE, { cleared: true, updatedAt: Date.now() });
			notify(ctx, "🎯 上次规划被中断，请重新 /goal plan。", "warning");
		} else if (state?.phase === "awaiting-answers" && state.plan) {
			showPlan(ctx, state.plan, "🎯 有一份计划，先回答下面几点：");
		} else if (state?.phase === "awaiting-answers" && state.questions?.length) {
			notify(ctx, `❓ 规划需要你先回答：\n${state.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`, "warning");
		} else if (state?.phase === "awaiting-confirmation" && state.plan) {
			showPlan(ctx, state.plan, "🎯 有一份待确认的计划（回复「同意」开始）：");
		} else if (state?.active) {
			notify(
				ctx,
				`🎯 有一个未完成的目标（${state.iterations}/${state.maxIterations}）。用 /goal resume 继续，/goal stop 停止。`,
				"info",
			);
		}
	}

	function resolveJudgeModel(ctx: ExtensionContext) {
		const spec = (state?.judgeModel ?? "").trim();
		if (!spec || spec === "auto" || spec === "session") return ctx.model;

		const all = ctx.modelRegistry.getAll();
		const byFull = all.find((m) => `${m.provider}/${m.id}` === spec);
		if (byFull) return byFull;
		const byId = all.find((m) => m.id === spec);
		if (byId) return byId;

		const colon = spec.indexOf(":");
		if (colon > 0) {
			const found = ctx.modelRegistry.find(spec.slice(0, colon), spec.slice(colon + 1));
			if (found) return found;
		}
		throw new Error(`judge model not found: ${spec}`);
	}

	function buildTranscript(event: AgentBeforeSettleEvent): string {
		const messages = event.context?.contextMessages ?? [];
		let text = serializeConversation(convertToLlm(messages));
		if (text.length > TRANSCRIPT_TAIL_CHARS) {
			text = `...[earlier transcript truncated]...\n${text.slice(-TRANSCRIPT_TAIL_CHARS)}`;
		}
		return text.trim() || "(empty transcript)";
	}

	async function completeText(ctx: ExtensionContext, prompt: string): Promise<string> {
		const model = resolveJudgeModel(ctx);
		if (!model) throw new Error("no model available");
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`no credentials configured for ${model.provider}/${model.id}`);
		}

		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			},
		];

		// The judge must never hang the settle boundary: cap the call, keep user
		// aborts distinguishable from a timeout (only ctx.signal means Esc).
		const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
		const response = await ctx.modelRegistry.complete(
			model,
			{ messages },
			{ cacheRetention: "none", sessionId: uuidv7(), signal },
		);

		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}

	async function judge(ctx: ExtensionContext, objective: string, transcript: string, plan?: Plan): Promise<Verdict> {
		return parseVerdict(await completeText(ctx, buildJudgePrompt(objective, transcript, plan)));
	}

	function parseVerdict(raw: string): Verdict {
		const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");

		if (start >= 0 && end > start) {
			try {
				const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
				const done =
					asBool(obj.done) ||
					asBool(obj.complete) ||
					asBool(obj.completed) ||
					obj.status === "done" ||
					obj.status === "complete";
				const blocked = asBool(obj.blocked) || obj.status === "blocked";
				const reason =
					asString(obj.reason) || asString(obj.explanation) || asString(obj.summary) || "";
				const next =
					asString(obj.next) ||
					asString(obj.next_step) ||
					asString(obj.nextStep) ||
					asString(obj.next_action) ||
					"";
				return {
					done,
					blocked: done ? false : blocked,
					reason: reason || (done ? "judge: done" : "judge: not done"),
					next: done ? "" : next,
				};
			} catch {
				// fall through to keyword parsing
			}
		}

		const lowered = cleaned.toLowerCase();
		if (lowered.includes("<approved") || /["']?done["']?\s*[:=]\s*true/.test(lowered)) {
			return { done: true, blocked: false, reason: "judge: done", next: "" };
		}

		throw new Error(`judge returned an unparseable verdict: ${cleaned.slice(0, 200)}`);
	}

	function stopWith(reason: GoalState["stopReason"], objectiveReason: string, ctx: ExtensionContext, kind: NotifyKind): void {
		if (!state) return;
		state = { ...state, active: false, phase: undefined, questions: undefined, stopReason: reason, waitingForUser: false, updatedAt: Date.now() };
		updateStatus(ctx);
		notify(ctx, objectiveReason, kind);
	}

	// -----------------------------------------------------------------------
	// planning: one research turn, then the user confirms
	// -----------------------------------------------------------------------

	function messageText(message: { content?: unknown }): string {
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter(
					(part): part is { type: "text"; text: string } =>
						!!part &&
						typeof part === "object" &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string",
				)
				.map((part) => part.text)
				.join("\n");
		}
		return "";
	}

	/** The last assistant message's text — where a planning turn emits its JSON. */
	function lastAssistantText(event: AgentBeforeSettleEvent): string {
		const messages = event.context?.contextMessages ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as { role?: string; content?: unknown };
			if (message.role !== "assistant") continue;
			const text = messageText(message);
			if (text.trim()) return text;
		}
		return "";
	}

	async function settlePlanning(
		event: AgentBeforeSettleEvent,
		ctx: ExtensionContext,
		s: GoalState,
	): Promise<AgentBeforeSettleEventResult | undefined> {
		const entries: SessionBoundaryDraft[] = [...event.entries];
		const cancel = (message: string, kind: NotifyKind): AgentBeforeSettleEventResult => {
			state = null;
			judgeErrors = 0;
			settleRetries = 0;
			entries.push({ type: "custom", customType: ENTRY_TYPE, data: { cleared: true, objective: s.objective, updatedAt: Date.now() } });
			updateStatus(ctx);
			notify(ctx, message, kind);
			return { entries };
		};

		if (event.outcome === "aborted") return cancel("🎯 规划已取消。", "warning");
		if (event.outcome === "error") return cancel("🎯 规划以错误结束，已取消。", "error");

		const raw = planningOutput || lastAssistantText(event);
		planningOutput = "";
		let reply: PlannerReply;
		try {
			reply = parsePlannerReply(raw);
		} catch (err) {
			return cancel(`🎯 规划失败，未启动：${err instanceof Error ? err.message : String(err)}`, "error");
		}

		if (reply.kind === "questions") {
			state = { ...s, phase: "awaiting-answers", questions: reply.questions, updatedAt: Date.now() };
			updateStatus(ctx);
			notify(ctx, `🎯 规划需要你先回答：\n${reply.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`, "info");
			entries.push(stateDraft(state));
			return { entries };
		}

		// A plan with points the planner could not verify: ask the user about them once
		// (folded back in as clarifications), then re-plan. Bounded to one round.
		const plan: Plan = { ...reply.plan, detailFile: s.detailFile };
		const unknowns = plan.unknowns ?? [];
		if (unknowns.length && !s.askedUnknowns) {
			state = {
				...s,
				objective: plan.objective,
				plan,
				phase: "awaiting-answers",
				questions: unknowns,
				askedUnknowns: true,
				updatedAt: Date.now(),
			};
			updateStatus(ctx);
			showPlan(ctx, plan, "🎯 计划草案（回复「同意」开始，或先回答下面这几点）：");
			entries.push(stateDraft(state));
			return { entries };
		}

		state = { ...s, objective: plan.objective, plan, phase: "awaiting-confirmation", questions: undefined, updatedAt: Date.now() };
		updateStatus(ctx);
		showPlan(ctx, plan, "🎯 计划草案（回复「同意」开始，或直接说要改什么）：");
		entries.push(stateDraft(state));
		return { entries };
	}

	// -----------------------------------------------------------------------
	// lifecycle
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// A blocked run is a pause, not an end: the moment the user answers the
	// question that blocked it, un-pause and keep working on the same objective.
	pi.on("before_agent_start", async (_event, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
		const s = state;
		if (!s || s.active || !s.waitingForUser) return;

		state = { ...s, active: true, waitingForUser: false, stopReason: undefined, updatedAt: Date.now() };
		judgeErrors = 0;
		settleRetries = 0;
		persist();
		updateStatus(ctx);
		notify(ctx, `🎯 收到你的答复，目标循环已自动恢复（${state.iterations}/${state.maxIterations}）。`, "info");

		return {
			message: {
				customType: MESSAGE_TYPE,
				content: [
					"[goal-loop 恢复]",
					s.stopReason === "error"
						? "目标循环上一轮因运行错误暂停，现在自动恢复。"
						: "你之前因为需要用户决定而暂停，用户已经在上面的消息里给出答复。",
					"继续推进目标，不要再次询问是否继续，完成每步后自行验证。",
					"",
					`原始目标：${state.objective}`,
				].join("\n"),
				display: true,
			},
		};
	});

	// Keep the planning turn's raw JSON out of the transcript: stash it for the
	// settle step and show a one-line placeholder instead.
	pi.on("message_end", async (event) => {
		if (state?.phase !== "planning") return;
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") return;
		const text = messageText(message);
		if (!text.trim()) return;
		try {
			parsePlannerReply(text);
		} catch {
			return;
		}
		planningOutput = text;
		return {
			message: {
				...(event.message as object),
				content: [{ type: "text", text: "（已生成计划，见下方看板）" }],
			} as typeof event.message,
		};
	});

	// A /goal plan draft waits for the user's confirmation. The reply is an
	// ordinary message, so no second `/goal plan` is needed: classify it here and
	// either start the run, discard the draft, or re-plan with the feedback.
	pi.on("input", async (event, ctx) => {
		const s = state;
		if (!s || event.source === "extension") return;

		// The planner asked questions: the reply is an answer, then plan again.
		if (s.phase === "awaiting-answers" && s.source) {
			const clarifications = [...(s.clarifications ?? []), event.text.trim()];
			state = { ...s, phase: "planning", questions: undefined, clarifications, updatedAt: Date.now() };
			persist();
			notify(ctx, "🎯 收到，接着规划…", "info");
			await beginPlanning(ctx, s.source.intent, s.source.file, clarifications, s.detailFile);
			return { action: "handled" };
		}

		if (s.phase !== "awaiting-confirmation" || !s.plan || !s.source) return;

		const kind = classifyReply(event.text);

		if (kind === "no") {
			const objective = s.objective;
			state = null;
			judgeErrors = 0;
			settleRetries = 0;
			pi.appendEntry(ENTRY_TYPE, { cleared: true, objective, updatedAt: Date.now() });
			updateStatus(ctx);
			notify(ctx, "🎯 已放弃这份计划。", "info");
			return { action: "handled" };
		}

		if (kind === "revise") {
			const clarifications = [...(s.clarifications ?? []), event.text.trim()];
			state = { ...s, phase: "planning", clarifications, updatedAt: Date.now() };
			persist();
			notify(ctx, "🎯 按你的意见重新规划中…", "info");
			await beginPlanning(ctx, s.source.intent, s.source.file, clarifications, s.detailFile);
			return { action: "handled" };
		}

		state = { ...s, active: true, phase: undefined, clarifications: undefined, updatedAt: Date.now() };
		judgeErrors = 0;
		settleRetries = 0;
		persist();
		updateStatus(ctx);
		notify(ctx, `🎯 计划已确认，开始执行（上限 ${s.maxIterations} 次续跑）。`, "info");
		return { action: "transform", text: kickoff(s.plan) };
	});

	// The whole loop lives here: this is the last boundary before pi settles.
	pi.on("agent_before_settle", async (event, ctx): Promise<AgentBeforeSettleEventResult | undefined> => {
		const s = state;
		if (!s || judging) return;
		if (s.phase === "planning") return await settlePlanning(event, ctx, s);
		if (!s.active) return;

		const entries: SessionBoundaryDraft[] = [...event.entries];

		// User pressed Esc / aborted: stop the loop instead of fighting them.
		if (event.outcome === "aborted") {
			stopWith("manual", "🎯 目标循环已停止（本轮被中断）。用 /goal resume 可继续，/goal clear 可清除。", ctx, "warning");
			entries.push(stateDraft(state as GoalState));
			return { entries };
		}

		// A provider/runtime error ended the run — pi's own in-run retries are
		// exhausted at this point. Transient errors get a bounded cross-run
		// cooldown; anything else pauses visibly instead of silently dying.
		if (event.outcome === "error") {
			const attempt = lastErrorAttempt(event);
			const errText = attempt.message?.errorMessage ?? "未知错误";
			if (attempt.message && isRetryableAssistantError(attempt.message) && settleRetries < MAX_SETTLE_RETRIES) {
				settleRetries += 1;
				const delay = backoffMs(settleRetries);
				notify(ctx, `🎯 瞬时错误（${errText}），冷却 ${formatDelay(delay)} 后自动重试（第 ${settleRetries}/${MAX_SETTLE_RETRIES} 次）。`, "warning");
				if (ctx.mode === "tui") {
					try {
						ctx.ui.setStatus(STATUS_KEY, `🎯 冷却中…（${settleRetries}/${MAX_SETTLE_RETRIES}）`);
					} catch {
						// status is cosmetic
					}
				}
				if (await sleepAbortable(delay, ctx.signal)) {
					stopWith("manual", "🎯 目标循环已停止（冷却期间被中断）。用 /goal resume 可继续，/goal clear 可清除。", ctx, "warning");
					entries.push(stateDraft(state as GoalState));
					return { entries };
				}
				// Hide the failed attempt so the retry starts from a clean context.
				if (attempt.targetId) entries.push({ type: "context_edit", targetId: attempt.targetId, replacement: null });
				entries.push(stateDraft(state as GoalState));
				entries.push({
					type: "custom_message",
					customType: MESSAGE_TYPE,
					content: [
						`[goal-loop 错误重试 ${settleRetries}/${MAX_SETTLE_RETRIES}]`,
						`上一轮因瞬时错误中断（${errText}），已自动冷却并重试。`,
						"接着当前里程碑继续，不要重述计划，完成每步后自行验证。",
					].join("\n"),
					display: true,
				});
				return { entries, continue: true };
			}
			// Non-transient or budget exhausted: pause; the user's next message
			// auto-resumes via before_agent_start.
			state = { ...s, active: false, stopReason: "error", waitingForUser: true, updatedAt: Date.now() };
			updateStatus(ctx);
			notify(ctx, `🎯 目标循环：本轮以错误结束，已暂停（${errText}）。直接回话即可自动恢复；也可用 /goal stop 停止。`, "warning");
			entries.push(stateDraft(state as GoalState));
			return { entries };
		}

		if (s.iterations >= s.maxIterations) {
			stopWith(
				"max-iterations",
				`🎯 已达到自动续跑上限 ${s.maxIterations} 次，停止。用 /goal max <n> 提高上限，或 /goal resume 再跑。`,
				ctx,
				"warning",
			);
			entries.push(stateDraft(state as GoalState));
			return { entries };
		}

		let verdict: Verdict;
		judging = true;
		if (ctx.mode === "tui") {
			try {
				ctx.ui.setStatus(STATUS_KEY, `🎯 判定中… (${s.iterations}/${s.maxIterations})`);
			} catch {
				// ignore
			}
		}
		try {
			verdict = await judge(ctx, s.objective, buildTranscript(event), s.plan);
			judgeErrors = 0;
			settleRetries = 0;
		} catch (err) {
			judging = false;
			// Aborting while we judge (Esc) must stop the loop, not count as a judge failure.
			if (ctx.signal?.aborted) {
				stopWith("manual", "🎯 目标循环已停止（判定期间被中断）。用 /goal resume 可继续，/goal clear 可清除。", ctx, "warning");
				entries.push(stateDraft(state as GoalState));
				return { entries };
			}
			judgeErrors += 1;
			const message = err instanceof Error ? err.message : String(err);
			if (judgeErrors >= MAX_JUDGE_ERRORS) {
				stopWith("judge-error", `🎯 判定连续失败 ${judgeErrors} 次，停止循环：${message}`, ctx, "error");
				entries.push(stateDraft(state as GoalState));
				return { entries };
			}
			// Judge hiccups get the same cooldown as provider errors: retry the turn
			// instead of stalling until the user says something.
			const delay = backoffMs(judgeErrors);
			notify(ctx, `🎯 判定失败（${judgeErrors}/${MAX_JUDGE_ERRORS}）：${message}，冷却 ${formatDelay(delay)} 后自动重试。`, "error");
			if (await sleepAbortable(delay, ctx.signal)) {
				stopWith("manual", "🎯 目标循环已停止（冷却期间被中断）。用 /goal resume 可继续，/goal clear 可清除。", ctx, "warning");
				entries.push(stateDraft(state as GoalState));
				return { entries };
			}
			entries.push(stateDraft(state as GoalState));
			entries.push({
				type: "custom_message",
				customType: MESSAGE_TYPE,
				content: [
					`[goal-loop 判定重试 ${judgeErrors}/${MAX_JUDGE_ERRORS}]`,
					`判定刚才临时失败（${message}），循环已自动接续。`,
					"继续推进当前里程碑，完成每步后自行验证，不要询问是否继续。",
				].join("\n"),
				display: true,
			});
			return { entries, continue: true };
		}
		judging = false;

		if (ctx.signal?.aborted) {
			stopWith("manual", "🎯 目标循环已停止（判定期间被中断）。用 /goal resume 可继续，/goal clear 可清除。", ctx, "warning");
			entries.push(stateDraft(state as GoalState));
			return { entries };
		}

		// In plan mode the judge answers a narrow question: is the CURRENT milestone
		// done? Tick it and advance. The goal is done only when every milestone is
		// ticked — so the plan, not the model, defines completeness.
		let plan = s.plan;
		if (plan && verdict.done) {
			const current = currentMilestone(plan);
			if (current) plan = markDone(plan, [current.id], verdict.reason);
		}
		const goalDone = verdict.done && (!plan || isPlanComplete(plan));

		if (goalDone) {
			state = { ...s, plan, active: false, stopReason: "done", waitingForUser: false, lastVerdict: verdict, updatedAt: Date.now() };
			updateStatus(ctx);
			notify(ctx, `🎯 目标已完成：${verdict.reason}`, "info");
			entries.push(stateDraft(state));
			return { entries };
		}

		if (verdict.blocked) {
			state = { ...s, plan, active: false, stopReason: "blocked", waitingForUser: true, lastVerdict: verdict, updatedAt: Date.now() };
			updateStatus(ctx);
			notify(ctx, `🎯 目标受阻，需要你决定后才能继续：${verdict.reason}\n回答后循环会自动恢复；想彻底停下用 /goal stop。`, "warning");
			entries.push(stateDraft(state));
			return { entries };
		}

		const iteration = s.iterations + 1;
		state = { ...s, plan, iterations: iteration, lastVerdict: verdict, updatedAt: Date.now() };
		updateStatus(ctx);

		entries.push(stateDraft(state));
		entries.push({
			type: "custom_message",
			customType: MESSAGE_TYPE,
			content: buildContinuation(s.objective, verdict, iteration, s.maxIterations, plan),
			display: true,
		});

		notify(ctx, `🎯 未完成，自动续跑 ${iteration}/${s.maxIterations}：${verdict.reason}`, "info");
		return { entries, continue: true };
	});

	// -----------------------------------------------------------------------
	// /goal command
	// -----------------------------------------------------------------------

	async function beginPlanning(
		ctx: ExtensionContext,
		intent: string,
		file: string | undefined,
		clarifications: string[],
		detailFile: string | undefined,
	): Promise<void> {
		let fileText: string | undefined;
		if (file) {
			try {
				fileText = await readPlanFile(file, ctx.cwd);
			} catch (err) {
				notify(ctx, `🎯 读不到计划文件 ${file}：${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
		}
		if (detailFile) {
			try {
				await ensurePlanDir(detailFile, ctx.cwd);
			} catch {
				// the planning turn will surface a write failure with more context
			}
		}
		planningOutput = "";
		pi.sendUserMessage(buildPlanningInstruction(intent, fileText, clarifications, detailFile));
	}

	async function startPlan(intent: string, ctx: ExtensionContext): Promise<void> {
		if (!intent) {
			notify(ctx, "用法：/goal plan <目标 或 @计划文件>", "warning");
			return;
		}
		if (!ctx.isIdle()) {
			notify(ctx, "🎯 Agent 正忙，等这一轮结束再 /goal plan。", "warning");
			return;
		}
		const file = findPlanFile(intent);
		const detailFile = planFilePath(intent);
		state = {
			active: false,
			phase: "planning",
			objective: intent,
			source: { intent, file },
			detailFile,
			clarifications: [],
			iterations: 0,
			maxIterations: defaultMaxIterations,
			judgeModel: defaultJudgeModel,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		judgeErrors = 0;
		settleRetries = 0;
		persist();
		updateStatus(ctx);
		notify(ctx, `🎯 规划中：正在调研仓库，详细计划写到 ${detailFile}；稍后给你看里程碑看板…`, "info");
		await beginPlanning(ctx, intent, file, [], detailFile);
	}

	function startGoal(objective: string, ctx: ExtensionCommandContext): void {
		state = {
			active: true,
			objective,
			iterations: 0,
			maxIterations: defaultMaxIterations,
			judgeModel: defaultJudgeModel,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		judgeErrors = 0;
		settleRetries = 0;
		persist();
		updateStatus(ctx);
		notify(
			ctx,
			`🎯 目标已启动（判定模型：${state.judgeModel || "当前会话模型"}；上限 ${state.maxIterations} 次）。/goal stop 停止。`,
			"info",
		);

		if (!ctx.isIdle()) {
			notify(ctx, "Agent 正忙：目标已记录，本轮结束后会自动进入判定/续跑。", "info");
			return;
		}
		pi.sendUserMessage(objective);
	}

	function showStatus(ctx: ExtensionCommandContext): void {
		const s = state;
		if (!s) {
			notify(ctx, "当前没有目标。用法：/goal <目标>", "info");
			return;
		}
		if (s.plan) {
			const status =
				s.phase === "awaiting-confirmation"
					? "待确认（回复「同意」开始）"
					: s.active
						? "进行中"
						: `已停止（${s.stopReason ? (STOP_LABELS[s.stopReason] ?? s.stopReason) : "unknown"}）`;
			const verdict = s.lastVerdict;
			const verdictLine = verdict
				? `\n上次判定：${verdict.done ? "当前片完成" : verdict.blocked ? "受阻" : "当前片未完成"} — ${verdict.reason}`
				: "";
			notify(
				ctx,
				`${boardText(s.plan, { iterations: s.iterations, maxIterations: s.maxIterations })}\n\n状态：${status}${verdictLine}\n判定模型：${s.judgeModel || "跟随当前会话模型"}`,
				"info",
			);
			const questions = questionsText(s.plan);
			if (questions) notify(ctx, questions, "warning");
			return;
		}
		const lines = [
			`目标：${s.objective}`,
			`状态：${s.active ? "进行中" : `已停止（${s.stopReason ? (STOP_LABELS[s.stopReason] ?? s.stopReason) : "unknown"}）`}`,
			`续跑：${s.iterations}/${s.maxIterations}`,
			`判定模型：${s.judgeModel || "跟随当前会话模型"}`,
		];
		if (s.lastVerdict) {
			const kind = s.lastVerdict.done ? "完成" : s.lastVerdict.blocked ? "受阻" : "未完成";
			lines.push(`上次判定：${kind} — ${s.lastVerdict.reason}`);
			if (s.lastVerdict.next) lines.push(`下一步：${s.lastVerdict.next}`);
		}
		notify(ctx, lines.join("\n"), "info");
	}

	pi.registerCommand("goal", {
		description: "自主目标循环：每轮结束由 AI 判定目标是否完成，未完成则自动续跑",
		getArgumentCompletions: (prefix) => {
			const options = ["plan ", "stop", "resume", "clear", "status", "help", "model ", "max "];
			const matches = options.filter((o) => o.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input || input === "status") {
				showStatus(ctx);
				return;
			}

			const [verb, ...rest] = input.split(/\s+/);
			const restText = rest.join(" ").trim();

			if (verb === "help" || verb === "-h" || verb === "--help") {
				notify(ctx, HELP_TEXT, "info");
				return;
			}

			if (verb === "plan") {
				await startPlan(restText, ctx);
				return;
			}

			if (verb === "stop") {
				if (!state) {
					notify(ctx, "当前没有进行中的目标。", "info");
					return;
				}
				stopWith("manual", "🎯 目标循环已停止。用 /goal resume 可继续，/goal clear 可清除。", ctx, "warning");
				persist();
				return;
			}

			if (verb === "clear" || verb === "cancel") {
				if (!state) {
					notify(ctx, "当前没有目标可清除。", "info");
					return;
				}
				const objective = state.objective;
				state = null;
				judgeErrors = 0;
				// A tombstone entry, so a reload or a branch switch stays cleared.
				pi.appendEntry(ENTRY_TYPE, { cleared: true, objective, updatedAt: Date.now() });
				updateStatus(ctx);
				notify(ctx, `🎯 已清除目标（不再记忆）：${objective}`, "info");
				return;
			}

			if (verb === "resume") {
				if (!state) {
					notify(ctx, "没有可恢复的目标。用 /goal <目标> 新建一个。", "warning");
					return;
				}
				state = { ...state, active: true, phase: undefined, iterations: 0, stopReason: undefined, waitingForUser: false, updatedAt: Date.now() };
				judgeErrors = 0;
				persist();
				updateStatus(ctx);
				notify(ctx, `🎯 已恢复目标（续跑计数重置，上限 ${state.maxIterations}）。`, "info");

				if (!ctx.isIdle()) {
					notify(ctx, "Agent 正忙：本轮结束后会自动进入判定/续跑。", "info");
					return;
				}
				const verdict = state.lastVerdict;
				if (verdict && !verdict.done) {
					pi.sendUserMessage(buildContinuation(state.objective, verdict, 0, state.maxIterations, state.plan));
				} else {
					pi.sendUserMessage(state.objective);
				}
				return;
			}

			if (verb === "model") {
				const spec = restText;
				if (!spec) {
					notify(ctx, `当前判定模型：${state?.judgeModel || defaultJudgeModel || "跟随当前会话模型"}`, "info");
					return;
				}
				defaultJudgeModel = spec === "auto" || spec === "session" ? "" : spec;
				if (state) {
					state = { ...state, judgeModel: defaultJudgeModel, updatedAt: Date.now() };
					persist();
				}
				notify(ctx, `🎯 判定模型已设为：${defaultJudgeModel || "跟随当前会话模型"}`, "info");
				return;
			}

			if (verb === "max") {
				const n = parsePositiveInt(restText);
				if (!n) {
					notify(ctx, `当前上限：${state?.maxIterations ?? defaultMaxIterations} 次。用法：/goal max <正整数>`, "warning");
					return;
				}
				defaultMaxIterations = n;
				if (state) {
					state = { ...state, maxIterations: n, updatedAt: Date.now() };
					persist();
				}
				updateStatus(ctx);
				notify(ctx, `🎯 自动续跑上限已设为 ${n} 次。`, "info");
				return;
			}

			// Anything else is a fresh objective (verbatim, including the verb).
			startGoal(input, ctx);
		},
	});

	// -----------------------------------------------------------------------
	// rendering
	// -----------------------------------------------------------------------

	pi.registerEntryRenderer(ENTRY_TYPE, (entry: CustomEntry<GoalState>, _options, theme) => {
		const s = entry.data;
		if (!s) return undefined;
		if (s.cleared) {
			const objective = s.objective && s.objective.length > 80 ? `${s.objective.slice(0, 80)}…` : s.objective;
			return new Text(theme.fg("dim", `🎯 goal cleared${objective ? `: ${objective}` : ""}`), 0, 0);
		}
		const status =
			s.phase === "planning" || s.phase === "awaiting-answers"
				? theme.fg("accent", "planning")
				: s.phase === "awaiting-confirmation"
					? theme.fg("accent", "draft")
					: s.active
						? theme.fg("accent", "active")
						: theme.fg("dim", s.stopReason ? (STOP_LABELS[s.stopReason] ?? s.stopReason) : "stopped");
		const progress = s.plan
			? `${s.plan.milestones.filter((m) => m.status === "done").length}/${s.plan.milestones.length} · ${s.iterations}/${s.maxIterations}轮`
			: `${s.iterations}/${s.maxIterations}`;
		const head = theme.fg("muted", `🎯 ${s.plan ? "plan" : "goal"} ${progress} `) + status;
		const objective = s.objective.length > 100 ? `${s.objective.slice(0, 100)}…` : s.objective;
		return new Text(`${head}\n${theme.fg("dim", objective)}`, 0, 0);
	});

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options: MessageRenderOptions, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		const firstLine = text.split("\n")[0] ?? "";
		const body = text.split("\n").slice(1).join("\n").trim();
		const preview = body.length > 400 ? `${body.slice(0, 400)}…` : body;
		return new Text(theme.fg("accent", firstLine) + (preview ? `\n${theme.fg("muted", preview)}` : ""), 0, 0);
	});
}
