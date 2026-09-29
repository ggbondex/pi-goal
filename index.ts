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
 *   /goal <objective>      start a goal (or repeat the objective verbatim)
 *   /goal                  show status
 *   /goal off              stop the loop (keeps the objective for /goal resume)
 *   /goal resume           re-activate and keep going
 *   /goal model <spec>     judge model: "auto" | "provider/modelId" | modelId
 *   /goal max <n>          hard cap on automatic continuations (default 15)
 *
 * Environment defaults:
 *   PI_GOAL_MAX            default max continuations
 *   PI_GOAL_MODEL          default judge model spec
 *
 * State is stored in the session transcript as a `custom` entry, so branching
 * and resuming behave correctly. It never leaves the session.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageRenderOptions,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "goal-loop";
const MESSAGE_TYPE = "goal-loop-continuation";
const STATUS_KEY = "goal-loop";

const DEFAULT_MAX_ITERATIONS = 15;
const MAX_JUDGE_ERRORS = 3;
const TRANSCRIPT_TAIL_CHARS = 40_000;

type NotifyKind = "info" | "warning" | "error";

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
	stopReason?: "done" | "blocked" | "max-iterations" | "manual" | "judge-error";
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

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

function buildJudgePrompt(objective: string, transcript: string): string {
	return [
		"You are the completion judge inside an autonomous coding-agent loop.",
		"",
		"GOAL (what the user asked for, verbatim):",
		"<goal>",
		objective,
		"</goal>",
		"",
		"Decide whether the GOAL is FULLY achieved, using ONLY evidence in the transcript.",
		"",
		"Rules:",
		"- Judge against the goal's own success criteria, not against \"the agent did something\".",
		"- Require concrete evidence in the transcript: files created or edited, commands run and their results, tests passing, artifacts produced. If the goal references a plan, evidence is that every required item is done and verified.",
		"- The agent asking the user \"shall I continue?\" / \"should I proceed?\" / writing a summary and pausing is NOT completion and NOT a blocker. That is exactly the behavior this loop exists to fix: answer done=false and name the next concrete step.",
		"- Set blocked=true only when the agent genuinely cannot proceed without new information, credentials, or a decision that only the user can supply. Do not use blocked just because work is unfinished.",
		"- If done=true then next must be an empty string.",
		"- Do not invent requirements the goal does not state. Be strict but fair.",
		"",
		"Reply with ONE JSON object and nothing else (no markdown fences, no prose):",
		'{"done": <boolean>, "blocked": <boolean>, "reason": "<one or two sentences>", "next": "<single concrete next action, or empty string>"}',
		"",
		"TRANSCRIPT (oldest to newest; it may be truncated at the front):",
		"<transcript>",
		transcript,
		"</transcript>",
	].join("\n");
}

function buildContinuation(objective: string, verdict: Verdict, iteration: number, max: number): string {
	const step = verdict.next.trim() || "继续推进目标，直到全部完成并自行验证。";
	return [
		`[goal-loop 自动续跑 ${iteration}/${max}]`,
		"上一轮结束时目标尚未完成，现已自动接续，无需等待用户确认。",
		"",
		`判定原因：${verdict.reason || "(未给出)"}`,
		`下一步：${step}`,
		"",
		"要求：",
		"- 不要询问我是否继续，直接执行。",
		"- 每完成一步自行验证（跑测试 / 读回文件 / 检查命令输出）。",
		"- 只有当你确信目标全部完成、或确实需要我提供信息/做决定时才停下来。",
		"",
		"--- 原始目标（再次附上，防止上下文丢失）---",
		objective,
	].join("\n");
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function goalLoop(pi: ExtensionAPI): void {
	let state: GoalState | null = null;
	let judging = false;
	let judgeErrors = 0;

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
			if (state?.active) {
				ctx.ui.setStatus(STATUS_KEY, `🎯 goal ${state.iterations}/${state.maxIterations}`);
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

	function reconstruct(ctx: ExtensionContext): void {
		let last: GoalState | null = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
				last = entry.data as GoalState;
			}
		}
		state = last ? { ...last, judgeModel: last.judgeModel ?? "" } : null;
		judgeErrors = 0;
		updateStatus(ctx);

		if (state?.active) {
			notify(
				ctx,
				`🎯 有一个未完成的目标（${state.iterations}/${state.maxIterations}）。用 /goal resume 继续，/goal off 停止。`,
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

	async function judge(ctx: ExtensionContext, objective: string, transcript: string): Promise<Verdict> {
		const model = resolveJudgeModel(ctx);
		if (!model) throw new Error("no model available to judge with");
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`no credentials configured for ${model.provider}/${model.id}`);
		}

		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: buildJudgePrompt(objective, transcript) }],
				timestamp: Date.now(),
			},
		];

		const response = await ctx.modelRegistry.complete(
			model,
			{ messages },
			{ cacheRetention: "none", sessionId: uuidv7(), signal: ctx.signal },
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		return parseVerdict(text);
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
		state = { ...state, active: false, stopReason: reason, updatedAt: Date.now() };
		updateStatus(ctx);
		notify(ctx, objectiveReason, kind);
	}

	// -----------------------------------------------------------------------
	// lifecycle
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// The whole loop lives here: this is the last boundary before pi settles.
	pi.on("agent_before_settle", async (event, ctx): Promise<AgentBeforeSettleEventResult | undefined> => {
		const s = state;
		if (!s || !s.active || judging) return;

		const entries: SessionBoundaryDraft[] = [...event.entries];

		// User pressed Esc / aborted: stop the loop instead of fighting them.
		if (event.outcome === "aborted") {
			stopWith("manual", "🎯 目标循环已停止（本轮被中断）。用 /goal resume 可继续。", ctx, "warning");
			entries.push(stateDraft(state as GoalState));
			return { entries };
		}

		// A provider/runtime error ended the run. Do not auto-continue on top of it.
		if (event.outcome === "error") {
			notify(ctx, "🎯 目标循环：本轮以错误结束，暂停自动续跑；修好后用 /goal resume 继续。", "warning");
			return;
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
			verdict = await judge(ctx, s.objective, buildTranscript(event));
			judgeErrors = 0;
		} catch (err) {
			judging = false;
			// Aborting while we judge (Esc) must stop the loop, not count as a judge failure.
			if (ctx.signal?.aborted) {
				stopWith("manual", "🎯 目标循环已停止（判定期间被中断）。用 /goal resume 可继续。", ctx, "warning");
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
			notify(ctx, `🎯 判定失败（${judgeErrors}/${MAX_JUDGE_ERRORS}），本轮不自动续跑：${message}`, "error");
			updateStatus(ctx);
			return;
		}
		judging = false;

		if (ctx.signal?.aborted) {
			stopWith("manual", "🎯 目标循环已停止（判定期间被中断）。用 /goal resume 可继续。", ctx, "warning");
			entries.push(stateDraft(state as GoalState));
			return { entries };
		}

		if (verdict.done) {
			state = { ...s, active: false, stopReason: "done", lastVerdict: verdict, updatedAt: Date.now() };
			updateStatus(ctx);
			notify(ctx, `🎯 目标已完成：${verdict.reason}`, "info");
			entries.push(stateDraft(state));
			return { entries };
		}

		if (verdict.blocked) {
			state = { ...s, active: false, stopReason: "blocked", lastVerdict: verdict, updatedAt: Date.now() };
			updateStatus(ctx);
			notify(ctx, `🎯 目标受阻，需要你决定后才能继续：${verdict.reason}`, "warning");
			entries.push(stateDraft(state));
			return { entries };
		}

		const iteration = s.iterations + 1;
		state = { ...s, iterations: iteration, lastVerdict: verdict, updatedAt: Date.now() };
		updateStatus(ctx);

		entries.push(stateDraft(state));
		entries.push({
			type: "custom_message",
			customType: MESSAGE_TYPE,
			content: buildContinuation(s.objective, verdict, iteration, s.maxIterations),
			display: true,
		});

		notify(ctx, `🎯 未完成，自动续跑 ${iteration}/${s.maxIterations}：${verdict.reason}`, "info");
		return { entries, continue: true };
	});

	// -----------------------------------------------------------------------
	// /goal command
	// -----------------------------------------------------------------------

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
		persist();
		updateStatus(ctx);
		notify(
			ctx,
			`🎯 目标已启动（判定模型：${state.judgeModel || "当前会话模型"}；上限 ${state.maxIterations} 次）。/goal off 停止。`,
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
		const lines = [
			`目标：${s.objective}`,
			`状态：${s.active ? "进行中" : `已停止（${s.stopReason ?? "unknown"}）`}`,
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
			const options = ["off", "status", "resume", "model ", "max "];
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

			if (verb === "off" || verb === "stop" || verb === "cancel") {
				if (!state) {
					notify(ctx, "当前没有进行中的目标。", "info");
					return;
				}
				stopWith("manual", "🎯 目标循环已停止。用 /goal resume 可继续。", ctx, "warning");
				persist();
				return;
			}

			if (verb === "resume") {
				if (!state) {
					notify(ctx, "没有可恢复的目标。用 /goal <目标> 新建一个。", "warning");
					return;
				}
				state = { ...state, active: true, iterations: 0, stopReason: undefined, updatedAt: Date.now() };
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
					pi.sendUserMessage(buildContinuation(state.objective, verdict, 0, state.maxIterations));
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
		const status = s.active ? theme.fg("accent", "active") : theme.fg("dim", s.stopReason ?? "stopped");
		const head = theme.fg("muted", `🎯 goal ${s.iterations}/${s.maxIterations} `) + status;
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
