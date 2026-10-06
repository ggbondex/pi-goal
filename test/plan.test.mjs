/**
 * Pure-function tests for the plan module. No model, no network, no cost.
 *
 * The plan module is deliberately small: one prompt, one parser for the plan
 * file's two header fields, one preview, one handoff. There is no milestone
 * state machine left to test — that was the point.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const plan = await jiti.import("../plan.ts");

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

const sandbox = mkdtempSync(path.join(os.tmpdir(), "pi-goal-plan-"));

console.log("[plan] header values");
check("plain label", plan.headerValue("目标：把登录超时修好", "目标") === "把登录超时修好");
check("bold label", plan.headerValue("**目标**：把登录超时修好", "目标") === "把登录超时修好");
check("heading label", plan.headerValue("# 出口: ./run.sh", "出口") === "./run.sh");
check("quoted label", plan.headerValue("> 出口：make check", "出口") === "make check");
check("value can contain the other separator", plan.headerValue("出口：curl a:b", "出口") === "curl a:b");
check("absent label is undefined", plan.headerValue("目标：X\n\n正文", "出口") === undefined);
check("empty value is not a value", plan.headerValue("出口：   ", "出口") === undefined);
check("the first hit wins", plan.headerValue("目标：一\n目标：二", "目标") === "一");
check("label inside the body still counts (it is the same marker)", plan.headerValue("正文\n\n目标：一", "目标") === "一");
check(
	"a label with no separator is not a header",
	plan.headerValue("目标是把这件事做完", "目标") === undefined,
);

console.log("[plan] readPlanDraft");
const goodPlan = "目标：给助手加记笔记能力\n出口：make check && make test\n\n## 路线\n1. 契约\n";
writeFileSync(path.join(sandbox, "good.md"), goodPlan);
mkdirSync(path.join(sandbox, ".pi", "goal-plans"), { recursive: true });
writeFileSync(path.join(sandbox, ".pi", "goal-plans", "nested.md"), goodPlan);
writeFileSync(path.join(sandbox, "no-objective.md"), "出口：make check\n");
writeFileSync(path.join(sandbox, "empty.md"), "");

const draft = await plan.readPlanDraft("good.md", sandbox);
check("reads the objective", draft?.objective === "给助手加记笔记能力", draft);
check("reads the exit", draft?.exit === "make check && make test", draft);
check("works for the plugin-owned path", (await plan.readPlanDraft(".pi/goal-plans/nested.md", sandbox))?.objective?.startsWith("给助手"));
check("a file without 目标 is NOT a plan", (await plan.readPlanDraft("no-objective.md", sandbox)) === null);
check("an empty file is NOT a plan", (await plan.readPlanDraft("empty.md", sandbox)) === null);
check("a missing file is NOT a plan", (await plan.readPlanDraft("nope.md", sandbox)) === null);
writeFileSync(path.join(sandbox, "no-exit.md"), "目标：只有目标\n正文\n");
const noExit = await plan.readPlanDraft("no-exit.md", sandbox);
check("the exit is optional", noExit?.objective === "只有目标" && noExit?.exit === "", noExit);

console.log("[plan] planPreview");
const longPlan = ["目标：O", "出口：E", ...Array.from({ length: 30 }, (_, i) => `行 ${i}`)].join("\n");
const preview = plan.planPreview(longPlan, 5);
check("caps the lines", preview.text.split("\n").length === 5, preview);
check("says there is more", preview.more === true);
check("short plan is not truncated", plan.planPreview("目标：O\n出口：E\n", 5).more === false);
check("trailing blank lines are dropped", plan.planPreview("目标：O\n\n\n", 5).text === "目标：O");

console.log("[plan] kickoff + requirements");
const kick = plan.kickoff("目标句", "make check", ".pi/goal-plans/x.md");
check("names the objective", kick.includes("目标句"));
check("names the exit", kick.includes("make check"));
check("points at the plan file", kick.includes(".pi/goal-plans/x.md"));
check("carries the rules", kick.includes("不要询问我是否继续"));
const plainKick = plan.kickoff("目标句", "");
check("plain goals get no exit line", !plainKick.includes("出口："));
check("plain goals get no plan line", !plainKick.includes("详细计划："));
check(
	"the rules text has exactly one source",
	plan.requirementsText().split("\n")[0] === "要求：" && kick.includes(plan.requirementsText()),
);

console.log("[plan] classifyReply");
check("同意", plan.classifyReply("同意") === "yes");
check("同意吧", plan.classifyReply("同意吧") === "yes");
check("ok 大小写与标点", plan.classifyReply("OK！") === "yes");
check("不用了", plan.classifyReply("不用了") === "no");
check("取消", plan.classifyReply("取消") === "no");
check("空回复按修改处理", plan.classifyReply("   ") === "revise");
check("其他文本按修改处理", plan.classifyReply("把数据库换成 Postgres") === "revise");
check("不要被 substring 骗到", plan.classifyReply("different") === "revise");

console.log("[plan] paths");
check("explicit @path wins", plan.findPlanFile("做 @docs/IMPLEMENTATION_PLAN.md 里的事") === "docs/IMPLEMENTATION_PLAN.md");
check("a bare *.md is picked up", plan.findPlanFile("按 docs/plan.md 做") === "docs/plan.md");
check("no file", plan.findPlanFile("修登录超时") === undefined);
check(
	"plan file is plugin-owned and slugged",
	plan.planFilePath("给助手加记笔记能力").startsWith(".pi/goal-plans/") && !plan.planFilePath("给助手加记笔记能力").includes(" "),
);
check("empty intent still yields a path", plan.planFilePath("!!!") === ".pi/goal-plans/plan.md");

console.log("[plan] the prompt");
const prompt = plan.buildPlanningInstruction("做点事", undefined, undefined, ".pi/goal-plans/x.md");
check("says it is the planning stage", prompt.includes("planning stage"));
check("tells it to research first", prompt.includes("Research first"));
check("names the file to write", prompt.includes(".pi/goal-plans/x.md"));
check("states the header contract", prompt.includes(`${plan.PLAN_OBJECTIVE_LABEL}：`) && prompt.includes(`${plan.PLAN_EXIT_LABEL}：`));
check("says the plan is a document, not a ledger", prompt.includes("no memory of this"));
check("says to ask instead of inventing", prompt.includes("do NOT write"));
check("carries the intent verbatim", prompt.includes("做点事"));
const withFile = plan.buildPlanningInstruction("做点事", "旧计划正文", ["用 Postgres"], ".pi/goal-plans/x.md");
check("includes the referenced file", withFile.includes("旧计划正文"));
check("includes the clarifications", withFile.includes("用 Postgres"));
check("forbids editing the user's file", withFile.includes("Do NOT modify the file the user pointed at"));
const bare = plan.buildPlanningInstruction("做点事");
check("works with no file at all", bare.includes("Do not modify anything else"));
check(
	"the labels the prompt asks for are the ones the parser reads",
	plan.headerValue(`${plan.PLAN_OBJECTIVE_LABEL}：X\n${plan.PLAN_EXIT_LABEL}：Y`, plan.PLAN_OBJECTIVE_LABEL) === "X",
);

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
