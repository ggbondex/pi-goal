/**
 * plan module — the plan prologue: ONE research turn that writes a plan.
 *
 * 计划不是一种"模式"，是一段"开场"。pi 跑长目标的真问题从来不是"没人盯进度"，而是
 * "目标那句话没想清楚"。所以 plan 只做一件事：让 pi 先调研仓库，把目标写成**一份人读的
 * 计划**（外加一句话目标、一句话出口），然后交给**普通 goal 循环**去迭代到完成为止。
 *
 * 这里曾经有一整套台账：每条里程碑一个 `status`，判定回答 `done_through`，插件按区间打勾，
 * 全部勾完才算目标完成。那套东西的每一分"准确"都要一条规则来维持（区间只向前延伸、缺 id
 * 只认当前片、片一开始定好就不许改名、判定要从当前片起连续认……），换来的只是"一眼看进度"。
 * 代价更贵：**计划一冻结就成了不可修改的完成判据**——计划里当初多写一条，目标就永远完不成。
 * 计划本来就该是路线图（给 agent 看、可以随认知更新），不是账本。
 *
 * 所以现在这里只有：怎么问（提示词）、怎么读回目标与出口（文件头部两行）、怎么确认
 * （同意 / 改 / 否）、开工那句话。**没有任何状态机。**
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface PlanSource {
	/** The user's raw words, kept for provenance and re-planning. */
	intent: string;
	/** The plan file the intent pointed at, if any (read-only input). */
	file?: string;
}

/**
 * 计划文件头部那两个字段。提示词与解析**共用这两个常量**，所以两边不可能写漂。
 */
export const PLAN_OBJECTIVE_LABEL = "目标";
export const PLAN_EXIT_LABEL = "出口";

/** What the plugin reads back out of the plan file: one sentence + the proof. */
export interface PlanDraft {
	/** The terminal state, one sentence — this becomes the goal. */
	objective: string;
	/** The commands that prove it; may be empty (a goal can run on the sentence alone). */
	exit: string;
}

// ---------------------------------------------------------------------------
// the one prompt
// ---------------------------------------------------------------------------

export function buildPlanningInstruction(
	intent: string,
	fileText?: string,
	clarifications?: string[],
	planFile?: string,
): string {
	const lines = [
		"You are the planning stage of an autonomous coding-agent loop.",
		"Research this repository before you plan. Do not implement yet: your output right now is the plan.",
		"",
		"Research first:",
		"- Look at the repo layout, the contracts/docs that govern this work, the tests that already exist,",
		"  and what the current code actually does.",
		"- Establish what the REAL, runnable checks are. Never trust a name you have not seen:",
		"  every command you name as an acceptance check must exist in this repo right now.",
		"",
		"Then write the plan. It is a DOCUMENT for whoever runs it next — an agent with no memory of this",
		"conversation, and the user who will read it. Nothing downstream tracks or ticks anything off.",
	];
	if (planFile) {
		lines.push(
			"",
			`Write it to ${planFile}. Make its FIRST TWO LINES exactly these two fields:`,
			"",
			`${PLAN_OBJECTIVE_LABEL}：<the terminal state, ONE sentence>`,
			`${PLAN_EXIT_LABEL}：<the exact command(s) that prove it, joined with &&>`,
			"",
			"Then the body, in this order:",
			"- the route: the stages/milestones in dependency order (irreversible or cheapest first), each with",
			"  what to do, which files or areas it touches, and its own acceptance command. This is guidance for",
			"  the agent — write it as clearly as you can, but nothing checks it off.",
			"- the decisions already made, and the risks you can see;",
			`- a 「未定项」 section for anything you could not verify.`,
			"",
			"Every acceptance command must be something that runs in this repo today. Never describe work you",
			"cannot check, and never invent test or script names.",
		);
	}
	lines.push(
		"",
		"If — and only if — you cannot write a faithful plan without asking the user something, do NOT write",
		"the file: reply with your questions instead, and nothing else. They will answer; you plan again then.",
		"",
		"INTENT (the user's words, verbatim):",
		"<intent>",
		intent,
		"</intent>",
	);
	if (fileText) {
		lines.push("", "PLAN FILE the user pointed at (read-only reference):", "<file>", fileText, "</file>");
	}
	if (clarifications?.length) {
		lines.push("", "USER CLARIFICATIONS (answers to your questions and/or requested changes):");
		for (const c of clarifications) lines.push(`- ${c}`);
	}
	lines.push(
		"",
		fileText
			? "Do NOT modify the file the user pointed at — it is an input. The plan you write lives in the file named above."
			: "Do not modify anything else while planning.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// reading the plan back
// ---------------------------------------------------------------------------

/**
 * `目标：X`, `**出口**：X`, `# 目标: X`, `> 目标：X` all count. The first hit wins.
 *
 * Written by a model, so it has to tolerate markdown around the label: markers are
 * stripped on both sides of it, and a value that came out wrapped in `**` is unwrapped.
 */
export function headerValue(text: string, label: string): string | undefined {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/^[\s>#*\-–—]+/, "").trim();
		for (const separator of ["：", ":"]) {
			const match = line.match(new RegExp(`^${label}\\s*\\**\\s*${separator}\\s*(.*)$`));
			const value = (match?.[1] ?? "").replace(/^\**|\**$/g, "").trim();
			if (value) return value;
		}
	}
	return undefined;
}

/**
 * Read the plan's two header fields back. Unreadable, or no 目标 → `null`.
 *
 * `null` means "there is no plan yet" — never "an empty plan". That is the judgement the
 * caller uses to decide between "show the draft" and "the planner must have asked
 * something instead", so it must not be papered over with a fallback.
 */
export async function readPlanDraft(planFile: string, cwd: string): Promise<PlanDraft | null> {
	let text: string;
	try {
		text = await readFile(resolve(cwd, planFile), "utf8");
	} catch {
		return null;
	}
	const objective = headerValue(text, PLAN_OBJECTIVE_LABEL);
	if (!objective) return null;
	return { objective, exit: headerValue(text, PLAN_EXIT_LABEL) ?? "" };
}

/** First lines of the plan, for the confirmation message (the whole file stays on disk). */
export function planPreview(text: string, maxLines = 14): { text: string; more: boolean } {
	const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	const shown = lines.slice(0, maxLines);
	return { text: shown.join("\n"), more: lines.length > shown.length };
}

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

/**
 * The operating rules, written ONCE. The kickoff and every continuation must say
 * the same thing: they used to be two copies that contradicted each other.
 */
export function requirementsText(): string {
	return [
		"要求：",
		"- 不要询问我是否继续，直接执行。",
		"- 对照目标与出口自查；做完了就继续往前推进，不必停下来等判定。",
		"- 只有目标全部完成、或确实需要我提供信息/做决定时才停下来。",
	].join("\n");
}

/** The first user message once the plan is confirmed: the plan, then plain goal mode. */
export function kickoff(objective: string, exit: string, planFile?: string): string {
	const lines = ["[goal-loop 计划已确认，开始执行]", `目标：${objective}`];
	if (exit) lines.push(`出口：${exit}`);
	if (planFile) lines.push(`详细计划：${planFile} —— 先读它，按它的路线做（它是路线图，可以随认知更新）。`);
	lines.push("", requirementsText());
	return lines.join("\n");
}

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
// paths (the only other side effect is reading the user's file)
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

/** Plugin-owned path for a goal's plan. */
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
