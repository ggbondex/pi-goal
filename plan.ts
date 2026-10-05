/**
 * plan module — turns a user's intent (optionally plus a plan file) into a
 * frozen objective + ordered milestones, and renders/drives the board.
 *
 * Everything here is pure except `readPlanFile`, so the module is testable
 * without a model. The model call itself lives in index.ts, next to the judge,
 * where the loop already owns model resolution.
 *
 * The plan is frozen at planning time: the milestone set never changes during
 * a run (renaming the route mid-run would let a judge "finish" by dropping
 * milestones). Only the per-milestone status advances, and only from evidence.
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type MilestoneStatus = "todo" | "doing" | "done";

export interface Milestone {
	id: string;
	title: string;
	/** How this milestone is proven complete — must be a runnable check. */
	exit: string;
	/** Why it sits at this position in the order. */
	why: string;
	status: MilestoneStatus;
	evidence?: string;
}

export interface Plan {
	objective: string;
	/** The top-level definition of done. */
	exit: string;
	milestones: Milestone[];
	/** What the planner could not verify against the repo. */
	unknowns?: string[];
	/** Where the detailed plan lives — the plugin's own working file. */
	detailFile?: string;
}

export interface PlanSource {
	/** The user's raw words, kept for provenance and re-planning. */
	intent: string;
	/** The plan file the intent pointed at, if any (read-only input). */
	file?: string;
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

export function buildPlanningInstruction(intent: string, fileText?: string, clarifications?: string[], detailFile?: string): string {
	const lines = [
		"You are the planning stage of an autonomous coding-agent loop.",
		"Research this repository before you plan. Do not implement yet: your output right now is the plan.",
		"",
		"Research first:",
		"- Look at the repo layout, the contracts/docs that govern this work, the tests that already exist,",
		"  and what the current code actually does.",
		"- Establish what the REAL, runnable checks are. Never trust a name you have not seen:",
		"  every command, test, or script you name in an exit must exist in this repo right now.",
		"",
		"Then decouple the work into 3-9 milestones that TOGETHER cover the full difference between today and the terminal state.",
		"",
		"Hard rules for every milestone:",
		"- It is an independent checkpoint: its exit is a command that exists here and runs NOW,",
		"  without the later milestones being done.",
		"- It names the exact command or file it is checked with.",
		"- Together they cover the whole difference: no milestone that can never finish, no required work left out.",
		"- Order by dependency: irreversible first (cheapest now), then whatever blocks the rest,",
		"  then what can be seen last. Put the reason in why.",
		"- An agent must be able to execute each milestone without asking further questions.",
		"",
		"If you cannot produce a faithful plan without more information, ask instead of inventing one.",
		"",
		"INTENT (the user's words, verbatim):",
		"<intent>",
		intent,
		"</intent>",
	];
	if (fileText) {
		lines.push("", "PLAN FILE the user pointed at (read-only reference):", "<file>", fileText, "</file>");
	}
	if (clarifications?.length) {
		lines.push("", "USER CLARIFICATIONS (answers to your questions and/or requested changes):");
		for (const c of clarifications) lines.push(`- ${c}`);
	}
	if (detailFile) {
		lines.push(
			"",
			`Write the DETAILED plan to ${detailFile} — for each milestone: the concrete steps, the files/areas it touches, the exact acceptance command, and any decisions or risks. That file is the body; the JSON below is only the summary and must match it.`,
			"Do NOT modify the file the user pointed at. Only if the user's clarifications explicitly ask you to sync a decision into it, do so.",
		);
	}
	lines.push(
		"",
		"Reply with ONE JSON object and NOTHING else — no reasoning, no commentary, no markdown fences:",
		"- If you need answers first:",
		'  {"needs_answers": ["<short question>"]}',
		"- Otherwise:",
		'  {"objective": "<the terminal state in ONE sentence>", "exit": "<the exact top-level verification command(s), joined with &&>", "milestones": [{"title": "<short, one line>", "exit": "<the exact command that checks this milestone>", "why": "<one short line: why it sits here>"}], "unknowns": ["<a short question for the user about something you could not verify>"]}',
		"",
		"Keep it terse — the board must fit one screen. objective is ONE sentence; each why is ONE line; at most 3 unknowns, each a short question for the user. Do not restate the intent or your research inside these fields; long explanation belongs in the conversation, not in the JSON.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

export function parsePlan(raw: string): Plan {
	const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("planner returned no JSON object");

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch (err) {
		throw new Error(`planner returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`);
	}

	const rec = (parsed ?? {}) as Record<string, unknown>;
	const objective = typeof rec.objective === "string" ? rec.objective.trim() : "";
	const exit = typeof rec.exit === "string" ? rec.exit.trim() : "";
	const rawMilestones = Array.isArray(rec.milestones) ? rec.milestones : [];
	const rawUnknowns = Array.isArray(rec.unknowns) ? rec.unknowns : [];

	const milestones: Milestone[] = [];
	for (const item of rawMilestones) {
		const m = (item ?? {}) as Record<string, unknown>;
		const title = typeof m.title === "string" ? m.title.trim() : "";
		const mExit = typeof m.exit === "string" ? m.exit.trim() : "";
		if (!title || !mExit) continue;
		milestones.push({
			id: `m${milestones.length + 1}`,
			title,
			exit: mExit,
			why: typeof m.why === "string" ? m.why.trim() : "",
			status: "todo",
		});
	}

	if (!objective) throw new Error("planner returned no objective");
	if (!milestones.length) throw new Error("planner returned no usable milestones");
	const unknowns = rawUnknowns
		.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
		.map((u) => u.trim());
	return { objective, exit, milestones, unknowns: unknowns.length ? unknowns : undefined };
}

/** A planner turn either asks for answers first, or hands back a plan. */
export type PlannerReply = { kind: "plan"; plan: Plan } | { kind: "questions"; questions: string[] };

export function parsePlannerReply(raw: string): PlannerReply {
	const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("planner returned no JSON object");

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch (err) {
		throw new Error(`planner returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`);
	}

	const rec = (parsed ?? {}) as Record<string, unknown>;
	const rawQuestions = rec.needs_answers ?? rec.needsAnswers ?? rec.questions;
	if (Array.isArray(rawQuestions)) {
		const questions = rawQuestions
			.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
			.map((q) => q.trim());
		if (questions.length) return { kind: "questions", questions };
	}
	return { kind: "plan", plan: parsePlan(cleaned) };
}

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

export function currentMilestone(plan: Plan): Milestone | undefined {
	return plan.milestones.find((m) => m.status !== "done");
}

export function isPlanComplete(plan: Plan): boolean {
	return plan.milestones.length > 0 && plan.milestones.every((m) => m.status === "done");
}

/** Human-facing board: the plan summary. */
export function boardText(plan: Plan, run?: { iterations: number; maxIterations: number }): string {
	const current = currentMilestone(plan);
	const done = plan.milestones.filter((m) => m.status === "done").length;
	const meta = [`里程碑 ${done}/${plan.milestones.length}`];
	if (run) meta.push(`循环 ${run.iterations}/${run.maxIterations}`);
	if (plan.detailFile) meta.push(`详情 ${plan.detailFile}`);
	return [
		`🎯 ${plan.objective}`,
		`出口：${plan.exit}`,
		meta.join(" · "),
		"",
		...plan.milestones.map((m) => {
			const mark = m.status === "done" ? "✅" : m === current ? "▶" : "·";
			return `${mark} ${m.id} ${m.title} — ${m.exit}`;
		}),
	].join("\n");
}

/** The undecided points, as a standalone prompt that stands out from the board. */
export function questionsText(plan: Plan): string {
	const unknowns = plan.unknowns ?? [];
	if (!unknowns.length) return "";
	const lines = [
		"❓ 计划里有几点还没定，需要你拍板：",
		...unknowns.slice(0, 3).map((q, i) => `${i + 1}. ${clip(q, 200)}`),
	];
	if (unknowns.length > 3) lines.push(`…还有 ${unknowns.length - 3} 条`);
	lines.push("回一句就行；也可以直接回「同意」，照当前计划开始。");
	return lines.join("\n");
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The operating rules, written ONCE. The kickoff and every continuation must say the
 * same thing: they used to be two copies, one saying "stop only when the whole goal is
 * done" and the other "focus on the current milestone only" — so the agent, following
 * the kickoff, finished several milestones that the judge then credited one at a time.
 */
export function requirementsText(): string {
	return [
		"要求：",
		"- 不要询问我是否继续，直接执行。",
		"- 对照每一片自己的出口自查；做完了就继续往前推进，不必停下来等判定。",
		"- 只有目标全部完成、或确实需要我提供信息/做决定时才停下来。",
	].join("\n");
}

/** First user message once the plan is confirmed. */
export function kickoff(plan: Plan): string {
	const current = currentMilestone(plan);
	return [
		"[goal-loop 已确认计划，开始执行]",
		plan.objective,
		"",
		boardText(plan),
		"",
		current ? `从 ${current.id}「${current.title}」开始。它的出口是：${current.exit}` : "计划已全部完成。",
		"",
		requirementsText(),
	].join("\n");
}

// ---------------------------------------------------------------------------
// milestone updates
// ---------------------------------------------------------------------------

function sameMilestone(m: Milestone, key: string): boolean {
	const k = key.trim().toLowerCase();
	return Boolean(k) && (m.id.toLowerCase() === k || m.title.toLowerCase() === k);
}

/**
 * The milestones to tick this round: the current one, then on through `throughId`.
 * The judge may only extend the range FORWARD (a missing, unknown or earlier id
 * means "just the current one"), so a weak verdict can never tick a later plate.
 */
export function milestoneRange(plan: Plan, throughId?: string): string[] {
	const current = currentMilestone(plan);
	if (!current) return [];
	const start = plan.milestones.indexOf(current);
	const end = throughId ? plan.milestones.findIndex((m) => sameMilestone(m, throughId)) : -1;
	return plan.milestones.slice(start, Math.max(start, end) + 1).map((m) => m.id);
}

/** Mark milestones done by id or exact title. Idempotent; unknown keys are ignored. */
export function markDone(plan: Plan, keys: string[], evidence?: string): Plan {
	const wanted = new Set(keys.map((k) => String(k).trim().toLowerCase()).filter(Boolean));
	if (!wanted.size) return plan;
	return {
		...plan,
		milestones: plan.milestones.map((m) => {
			if (m.status === "done") return m;
			const hit = wanted.has(m.id.toLowerCase()) || wanted.has(m.title.toLowerCase());
			return hit ? { ...m, status: "done" as const, evidence: evidence || m.evidence } : m;
		}),
	};
}

// ---------------------------------------------------------------------------
// confirmation
// ---------------------------------------------------------------------------

const YES = new Set([
	"同意", "可以", "开始", "开始吧", "行", "好", "好的", "确认", "没问题", "干吧", "对", "是的",
	"继续", "ok", "okay", "yes", "y", "go", "agree", "approve", "continue", "proceed",
]);
const NO = new Set(["不", "不用", "不要", "不行", "不好", "取消", "算了", "停", "否", "不开始", "no", "stop", "cancel", "n", "abort"]);

/** "yes" starts the run, "no" discards the draft, anything else is a revision request. */
export function classifyReply(text: string): "yes" | "no" | "revise" {
	const t = text.trim().toLowerCase().replace(/[。.!！?？,，、\s]/g, "");
	if (!t) return "revise";
	if (NO.has(t)) return "no";
	if (YES.has(t)) return "yes";
	for (const w of YES) if (w.length >= 2 && (t === `${w}吧` || t === `${w}了`)) return "yes";
	for (const w of NO) if (w.length >= 2 && (t === `${w}吧` || t === `${w}了`)) return "no";
	return "revise";
}

// ---------------------------------------------------------------------------
// file input (the only side effect)
// ---------------------------------------------------------------------------

/** Pull a plan-file path out of the intent: an explicit @path, else a *.md token. */
export function findPlanFile(intent: string): string | undefined {
	const explicit = intent.match(/(?:^|\s)@([^\s]+)/);
	if (explicit) return explicit[1];
	const md = intent.match(/(?:^|\s)([^\s]+\.md)\b/i);
	return md ? md[1] : undefined;
}

export async function readPlanFile(file: string, cwd: string): Promise<string> {
	return readFile(resolve(cwd, file), "utf8");
}

/** Plugin-owned path for a goal's detailed plan. */
export function planFilePath(intent: string): string {
	const slug = intent
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return `.pi/goal-plans/${slug || "plan"}.md`;
}

/** Create the directory a plan file lives in, before the planning turn runs. */
export async function ensurePlanDir(file: string, cwd: string): Promise<void> {
	await mkdir(dirname(resolve(cwd, file)), { recursive: true });
}
