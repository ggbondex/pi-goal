/**
 * Pure-function tests for the plan module. No model, no network, no cost.
 */
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

console.log("[plan] parsePlan");
const parsed = plan.parsePlan(
	'```json\n{"objective":"O","exit":"E","milestones":[{"title":"A","exit":"a","why":"first"},{"title":"B","exit":"b"}]}\n```',
);
check("assigns ids", parsed.milestones[0].id === "m1" && parsed.milestones[1].id === "m2");
check("all start todo", parsed.milestones.every((m) => m.status === "todo"));
check("keeps title/exit/why", parsed.milestones[0].title === "A" && parsed.milestones[0].exit === "a" && parsed.milestones[0].why === "first");
let threw = false;
try {
	plan.parsePlan("no json here");
} catch {
	threw = true;
}
check("throws on no JSON", threw);
threw = false;
try {
	plan.parsePlan('{"objective":"O","exit":"E","milestones":[]}');
} catch {
	threw = true;
}
check("throws on no milestones", threw);
threw = false;
try {
	plan.parsePlan('{"exit":"E","milestones":[{"title":"A","exit":"a"}]}');
} catch {
	threw = true;
}
check("throws on no objective", threw);

console.log("[plan] board");
let p = plan.parsePlan('{"objective":"O","exit":"E","milestones":[{"title":"A","exit":"a"},{"title":"B","exit":"b"},{"title":"C","exit":"c"}]}');
check("current is the first milestone", plan.currentMilestone(p).id === "m1");
check("not complete at start", plan.isPlanComplete(p) === false);
check("board marks current with ▶", plan.boardText(p).includes("▶ m1"));
check("board marks the rest with ·", plan.boardText(p).includes("· m2") && plan.boardText(p).includes("· m3"));

p = plan.markDone(p, ["A", "m2"], "evidence");
check("marks by title", p.milestones[0].status === "done");
check("marks by id", p.milestones[1].status === "done");
check("records evidence", p.milestones[0].evidence === "evidence");
check("unknown keys ignored", p.milestones[2].status === "todo");
check("current advances", plan.currentMilestone(p).id === "m3");
check("board marks done with ✅", plan.boardText(p).includes("✅ m1") && plan.boardText(p).includes("✅ m2"));
check("markDone is idempotent", plan.markDone(p, ["A"], "again").milestones[0].evidence === "evidence");
p = plan.markDone(p, ["C"]);
check("complete when all done", plan.isPlanComplete(p) === true);

console.log("[plan] classifyReply");
for (const t of ["同意", "可以", "开始", "开始吧", "好的", "OK", "yes", "确认"]) {
	check(`yes: ${t}`, plan.classifyReply(t) === "yes");
}
for (const t of ["取消", "不用了", "算了", "no", "stop"]) {
	check(`no: ${t}`, plan.classifyReply(t) === "no");
}
check("revision: a sentence", plan.classifyReply("第三个里程碑太大了，拆开") === "revise");
check("revision: empty", plan.classifyReply("") === "revise");

console.log("[plan] findPlanFile");
check("explicit @path", plan.findPlanFile("做这个 @docs/PLAN.md") === "docs/PLAN.md");
check("bare .md token", plan.findPlanFile("参考 docs/IMPLEMENTATION_PLAN.md 做") === "docs/IMPLEMENTATION_PLAN.md");
check("none", plan.findPlanFile("给助手加个功能") === undefined);

console.log("[plan] kickoff");
const k = plan.kickoff(parsed);
check("kickoff carries the objective", k.includes("O"));
check("kickoff names the current milestone", k.includes("m1") && k.includes("A"));

console.log("[plan] parsePlannerReply");
let reply = plan.parsePlannerReply('{"needs_answers":["q1","q2"]}');
check("questions reply", reply.kind === "questions" && reply.questions.length === 2);
reply = plan.parsePlannerReply('{"objective":"O","exit":"E","milestones":[{"title":"A","exit":"a"}],"unknowns":["u"]}');
check("plan reply", reply.kind === "plan" && reply.plan.objective === "O");
check("plan reply keeps unknowns", reply.plan.unknowns?.[0] === "u");
threw = false;
try {
	plan.parsePlannerReply("nothing");
} catch {
	threw = true;
}
check("throws on no JSON", threw);
check(
	"empty needs_answers falls through to a plan",
	plan.parsePlannerReply('{"needs_answers":[],"objective":"O","exit":"E","milestones":[{"title":"A","exit":"a"}]}').kind === "plan",
);

console.log("[plan] buildPlanningInstruction");
const instruction = plan.buildPlanningInstruction("加记笔记", "FILE TEXT", ["用 Postgres"]);
check("demands research", instruction.includes("Research first"));
check("demands grounded checks", instruction.includes("must exist in this repo"));
check("demands coverage of the difference", instruction.includes("cover the full difference"));
check("includes the intent", instruction.includes("加记笔记"));
check("includes the file", instruction.includes("FILE TEXT"));
check("includes clarifications", instruction.includes("用 Postgres"));
check("asks for needs_answers", instruction.includes("needs_answers"));
check("asks for unknowns", instruction.includes("unknowns"));
check("demands a terse JSON-only reply", instruction.includes("NOTHING else") && instruction.includes("ONE sentence"));

console.log("[plan] detail file");
check(
	"planFilePath is a plugin-owned .md path",
	plan.planFilePath("给助手加记笔记能力").startsWith(".pi/goal-plans/") && plan.planFilePath("给助手加记笔记能力").endsWith(".md"),
);
check("planFilePath is stable", plan.planFilePath("X") === plan.planFilePath("X"));
const withFile = plan.buildPlanningInstruction("I", undefined, [], ".pi/goal-plans/x.md");
check("instruction names the detail file", withFile.includes(".pi/goal-plans/x.md"));
check("instruction protects the user's file", withFile.includes("Do NOT modify the file the user pointed at"));
const detailed = plan.parsePlan('{"objective":"O","exit":"E","milestones":[{"title":"A","exit":"a"}]}');
detailed.detailFile = ".pi/goal-plans/x.md";
check("board shows the detail pointer", plan.boardText(detailed).includes("详情 .pi/goal-plans/x.md"));
const runBoard = plan.boardText(plan.parsePlan('{"objective":"O","exit":"E","milestones":[{"title":"A","exit":"a"}]}'), { iterations: 3, maxIterations: 15 });
check("board labels progress and the run counters", runBoard.includes("里程碑 0/1 · 循环 3/15"));
check("board omits run counters when unknown", !plan.boardText(detailed).includes("循环"));

console.log("[plan] unknowns become questions");
const withUnknowns = plan.parsePlan('{"objective":"O","exit":"E","milestones":[{"title":"A","exit":"a"}],"unknowns":["check X","check Y"]}');
check("board itself does not bury the questions", !plan.boardText(withUnknowns).includes("check X"));
const unknownQuestions = plan.questionsText(withUnknowns);
check(
	"questions are their own prominent block",
	unknownQuestions.includes("还没定") && unknownQuestions.includes("1. check X") && unknownQuestions.includes("2. check Y"),
);
check(
	"no questions -> empty",
	plan.questionsText(plan.parsePlan('{"objective":"O","exit":"E","milestones":[{"title":"A","exit":"a"}]}')) === "",
);
const manyUnknowns = plan.parsePlan(
	JSON.stringify({ objective: "O", exit: "E", milestones: [{ title: "A", exit: "a" }], unknowns: ["u1", "u2", "u3", "u4", "u5"] }),
);
const manyQuestions = plan.questionsText(manyUnknowns);
check(
	"questions cap at 3 and summarize the rest",
	manyQuestions.includes("1. u1") && manyQuestions.includes("3. u3") && !manyQuestions.includes("4. u4") && manyQuestions.includes("还有 2 条"),
);

console.log("[plan] readPlanFile");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const dir = mkdtempSync(path.join(os.tmpdir(), "pi-goal-plan-"));
writeFileSync(path.join(dir, "P.md"), "# the plan\n");
check("reads a relative file against cwd", (await plan.readPlanFile("P.md", dir)).includes("the plan"));
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
