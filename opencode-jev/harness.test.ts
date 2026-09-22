import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHarness, decodeDraft, workerRuleset, type HarnessDeps, type HarnessOptions, type JevReport } from "./harness.ts"
import { DEFAULTS } from "./io.ts"
import { applyDraft, validateDraft, materialize, readContext, candidateFiles, type Draft, type Original } from "./workspace.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), "jev-private-")); roots.push(dir); return dir }
const config = { ...DEFAULTS, maxRevisions: 3, maxStalls: 2, maxSourceBytes: 100000, timeout: 30 }
const model = { providerID: "mock", modelID: "chosen-model" }
const draft = (value: number, files = true): Draft => ({ answer: `ANSWER_${value}`, files: files ? [{ path: "x.js", content: `export const x = ${value};` }] : [] })
const report = (decision: JevReport["decision"], recommendation?: string): JevReport => ({ decision, unresolved_ids: decision === "revise" ? ["behavior"] : [],
  ...(recommendation ? { previous_comparison: { recommendation, gaps: [], possible_essential_regressions: [] } } : {}) })
async function setup(drafts: unknown[], reports: JevReport[], overrides: Partial<HarnessDeps> = {}) {
  const directory = await temp(); await writeFile(path.join(directory, "x.js"), "original")
  const prompts: any[] = [], creates: any[] = [], evaluations: any[] = [], records: any[] = [], aborts: any[] = []
  const reads: string[] = []
  const client = { session: {
    async create(request: any) { creates.push(request); return { data: { id: "child" } } },
    async prompt(request: any): Promise<any> { prompts.push(request); return { data: { info: {}, parts: [{ type: "text", text: (next => typeof next === "string" ? next : JSON.stringify(next))(drafts.shift()) }] } } },
    async abort(request: any) { aborts.push(request); return {} },
    async messages() { return { data: [{ info: {}, parts: reads.map(filePath => ({ type: "tool", tool: "read", state: { status: "completed", input: { filePath } } })) }] } },
  } }
  const run = createHarness({ evaluate: async payload => {
    assert.equal(await readFile(path.join(directory, "x.js"), "utf8"), "original", "No draft may touch live files before selection")
    evaluations.push(payload); return { report: reports.shift(), feedback: "Fix behavior; preserve interface" }
  }, route: async () => 0.9, saveRound: async (_d, _r, _n, record) => { records.push(record); return "audit.json" }, ...overrides })
  return { directory, prompts, creates, evaluations, records, aborts, client, reads,
    run: (options: Partial<HarnessOptions> = {}) => run({ client, directory, sessionID: "parent", model, task: "Set x to 2", config, ...options }) }
}

test("draft/evaluate/revise finishes privately and applies only the selected candidate", async () => {
  const s = await setup([draft(1), draft(2)], [report("revise"), report("rubric_satisfied", "improved_by_jev")])
  const result = await s.run()
  assert.equal(result.answer, "ANSWER_2"); assert.equal(result.rounds, 2)
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "export const x = 2;")
  assert.deepEqual(s.creates[0].body.permission, workerRuleset())
  assert.equal(s.creates[0].body.parentID, "parent")
  assert.ok(s.prompts.every(p => p.path.id === "child" && p.body.agent === "jev-worker" && p.body.model === model))
  assert.match(s.prompts[1].body.parts[0].text, /Fix behavior/)
  assert.equal(s.evaluations[1].previous_report, s.records[0].report)
})

test("worker is read-only: everything denied except read tools, secrets and outside paths", () => {
  const rules = workerRuleset()
  const decide = (permission: string, pattern: string) => rules.findLast(r =>
    new RegExp(`^${r.permission.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(permission)
    && new RegExp(`^${r.pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(pattern))?.action
  for (const tool of ["edit", "write", "bash", "task", "webfetch", "doom_loop"]) assert.equal(decide(tool, "*"), "deny")
  for (const tool of ["grep", "glob", "list"]) assert.equal(decide(tool, "anything"), "allow")
  assert.equal(decide("read", "src/app.ts"), "allow")
  assert.equal(decide("read", ".env.example"), "allow")
  for (const file of [".env", "config/.env.local", "api-credentials.json", "certs/server.pem"]) assert.equal(decide("read", file), "deny")
  assert.equal(decide("external_directory", "/etc/*"), "deny")
})

test("search/replace edits change only the matched text and the evaluator sees files the worker read", async () => {
  const s = await setup([{ answer: "Done", files: [{ path: "x.js", edits: [{ search: "original", replace: "export const x = 2;" }] }] }], [report("rubric_satisfied")])
  await writeFile(path.join(s.directory, "y.js"), "export const y = 1;")
  await writeFile(path.join(s.directory, ".env"), "SECRET")
  s.reads.push(path.join(s.directory, "y.js"), "x.js", path.join(s.directory, ".env"), "/etc/hosts")
  const result = await s.run()
  assert.deepEqual(result.changed, ["x.js"])
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "export const x = 2;")
  assert.deepEqual(s.evaluations[0].files.map((f: any) => f.path), ["[assistant response]", "x.js", "y.js"])
  assert.equal(s.evaluations[0].files.find((f: any) => f.path === "x.js").content, "export const x = 2;")
  assert.match(s.prompts[0].body.parts[0].text, /read, grep and glob/)
  assert.doesNotMatch(s.prompts[0].body.parts[0].text, /original/, "The project is not pasted into the prompt")
})

test("an unusable draft goes back to the worker without spending a JEV round", async () => {
  const broken = { answer: "Done", files: [{ path: "x.js", edits: [{ search: "missing", replace: "x" }] }] }
  const s = await setup(["not json", broken, draft(2)], [report("rubric_satisfied")])
  const result = await s.run()
  assert.equal(result.answer, "ANSWER_2"); assert.equal(s.evaluations.length, 1)
  assert.match(s.prompts[1].body.parts[0].text, /not a JSON draft/)
  assert.match(s.prompts[2].body.parts[0].text, /search text not found/)
  const hopeless = await setup([broken, broken, broken], [])
  await assert.rejects(hopeless.run(), /search text not found/)
  assert.equal(hopeless.evaluations.length, 0)
})

test("conversation skips the drafting loop: one direct answer, no grading, no file changes", async () => {
  const routed: any[] = []
  const s = await setup(["Because loops catch mistakes."], [], { route: async payload => { routed.push(payload); return 0.2 } })
  const result = await s.run({ task: "user:\nhi\n\nuser:\nWhy use loops?", request: "Why use loops?" })
  assert.deepEqual(result, { answer: "Because loops catch mistakes.", changed: [], decision: "chat", childID: "child" })
  assert.deepEqual(routed, [{ latest: "Why use loops?", conversation: "user:\nhi\n\nuser:\nWhy use loops?" }])
  assert.equal(s.evaluations.length, 0); assert.equal(s.prompts.length, 1)
  assert.match(s.prompts[0].body.parts[0].text, /plain Markdown \(not JSON\)/)
  assert.equal(s.creates[0].body.title, "JEV direct answer")
  assert.deepEqual(s.creates[0].body.permission, workerRuleset(), "Direct answers stay read-only")
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "original")
})

test("routing threshold: at or above it runs the loop; 0 disables routing; failures are not skipped", async () => {
  const edge = await setup([draft(2)], [report("rubric_satisfied")], { route: async () => 0.5 })
  assert.equal((await edge.run()).decision, "rubric_satisfied")
  let asked = false
  const off = await setup([draft(2)], [report("rubric_satisfied")], { route: async () => { asked = true; return 0 } })
  assert.equal((await off.run({ config: { ...config, codeThreshold: 0 } })).decision, "rubric_satisfied")
  assert.equal(asked, false)
  const down = await setup([draft(2)], [], { route: async () => { throw new Error("JEV offline") } })
  await assert.rejects(down.run(), /JEV offline/)
  assert.equal(down.prompts.length, 0, "A routing failure never falls back to an ungraded answer")
})

test("chat-only generated code is evaluated and returned without file writes", async () => {
  const s = await setup([draft(1, false), draft(2, false)], [report("revise"), report("rubric_satisfied", "improved_by_jev")])
  const result = await s.run()
  assert.equal(result.answer, "ANSWER_2"); assert.deepEqual(result.changed, [])
  assert.ok(s.evaluations[0].files.some((f: { path: string; content: string }) => f.path === "[assistant response]" && f.content === "ANSWER_1"))
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "original")
})

test("a regressing final attempt never replaces the better evaluated draft", async () => {
  const worse = report("revise", "hold_possible_regression")
  worse.previous_comparison!.possible_essential_regressions = ["behavior"]
  const s = await setup([draft(1), draft(0)], [report("revise"), worse])
  const result = await s.run({ config: { ...config, maxRevisions: 1 } })
  assert.equal(result.answer, "ANSWER_1"); assert.equal(result.selectedRound, 1)
  assert.equal(result.decision, "revise")
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "export const x = 1;")
})

test("plateau and repeated candidates stop without publishing the last attempt", async () => {
  const s = await setup([draft(1), draft(3), draft(4)], [report("revise"), report("revise", "no_material_implementation_gain"), report("revise", "no_material_implementation_gain")])
  assert.equal((await s.run()).stopReason, "no material improvement")
  assert.equal(s.evaluations.length, 3)
  const duplicate = await setup([draft(1), draft(1)], [report("revise")])
  assert.equal((await duplicate.run()).stopReason, "repeated candidate")
  assert.equal(duplicate.evaluations.length, 1)
})

test("JEV failure leaves the real project untouched", async () => {
  const s = await setup([draft(1)], [], { evaluate: async () => { throw new Error("offline") } })
  await assert.rejects(s.run(), /offline/)
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "original")
})

test("cancellation aborts the worker and never publishes its draft", async () => {
  const controller = new AbortController()
  const s = await setup([draft(1)], [], { evaluate: async () => { controller.abort(); return { report: report("rubric_satisfied") } } })
  await assert.rejects(s.run({ signal: controller.signal }))
  assert.ok(s.aborts.length)
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "original")
})

test("concurrent user edits invalidate publication", async () => {
  const s = await setup([draft(2)], [], { evaluate: async () => {
    await writeFile(path.join(s.directory, "x.js"), "user edit")
    return { report: report("rubric_satisfied") }
  } })
  await assert.rejects(s.run(), /Project changed/)
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "user edit")
})

test("worker deadline aborts private generation and does not publish", async () => {
  const s = await setup([], [])
  s.client.session.prompt = (request: any) => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
  })
  // Keep the event loop alive: AbortSignal.timeout intentionally unrefs its timer.
  const keepAlive = setTimeout(() => {}, 2000)
  try {
    await assert.rejects(s.run({ config: { ...config, generationTimeout: 1 } }), /timeout/i)
    assert.ok(s.aborts.length)
    assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "original")
  } finally { clearTimeout(keepAlive) }
})

test("draft validation rejects traversal, config, secrets, duplicates, ambiguous shapes and malformed output", () => {
  for (const name of ["../x.js", "/tmp/x.js", ".env", ".git/config", "opencode.json", "credentials.json"]) {
    assert.throws(() => validateDraft({ answer: "", files: [{ path: name, content: "bad" }] }, 10000))
  }
  assert.throws(() => validateDraft({ answer: "", files: [draft(1).files[0], draft(2).files[0]] }, 10000), /Duplicate/)
  assert.throws(() => validateDraft({ answer: "", files: [{ path: "x.js", content: "a", edits: [{ search: "a", replace: "b" }] }] }, 10000), /exactly one/)
  assert.throws(() => validateDraft({ answer: "", files: [{ path: "x.js", edits: [{ search: "", replace: "b" }] }] }, 10000), /nonempty search/)
  assert.throws(() => decodeDraft({ data: { info: {}, parts: [{ type: "text", text: "not JSON" }] } }, 10000), /JSON draft/)
  const wrapped = decodeDraft({ data: { info: {}, parts: [{ type: "text", text: "Here it is:\n```json\n{\"answer\":\"ok\",\"files\":[]}\n```" }] } }, 10000)
  assert.equal(wrapped.answer, "ok")
})

test("edits must match exactly once and replacements are literal", async () => {
  const dir = await temp(); await writeFile(path.join(dir, "a.js"), "one two two")
  const originals = new Map<string, Original>()
  const edit = (search: string, replace: string): Draft => ({ answer: "", files: [{ path: "a.js", edits: [{ search, replace }] }] })
  await assert.rejects(materialize(dir, edit("two", "2"), originals), /matches 2 places/)
  await assert.rejects(materialize(dir, edit("three", "3"), originals), /not found/)
  assert.deepEqual(await materialize(dir, edit("one", "$& $1"), originals), [{ path: "a.js", content: "$& $1 two two" }])
  await assert.rejects(materialize(dir, { answer: "", files: [{ path: "new.js", edits: [{ search: "a", replace: "b" }] }] }, originals), /does not exist/)
})

test("evaluator context skips unsafe files and respects the byte budget", async () => {
  const dir = await temp(); await writeFile(path.join(dir, "a.js"), "あ"); await writeFile(path.join(dir, "b.js"), "bb")
  await writeFile(path.join(dir, ".env"), "SECRET")
  assert.deepEqual((await readContext(dir, ["a.js", ".env", "b.js", "missing.js"], 100)).map(f => f.path), ["a.js", "b.js"])
  assert.deepEqual((await readContext(dir, ["a.js", "b.js"], 2)).map(f => f.path), ["b.js"])
  assert.throws(() => candidateFiles([], [], "あ", 2), /exceed/)
  assert.deepEqual(candidateFiles([{ path: "b.js", content: "bb" }], [], "a", 2).map(f => f.path), ["[assistant response]"])
})

test("publication creates nested files, deletes requested files and preserves existing modes", async () => {
  const dir = await temp(); await writeFile(path.join(dir, "old.js"), "old"); await writeFile(path.join(dir, "run.sh"), "old", { mode: 0o755 })
  const originals = new Map<string, Original>()
  const changes = await materialize(dir, { answer: "done", files: [{ path: "old.js", content: null }, { path: "src/new.js", content: "new" }, { path: "run.sh", edits: [{ search: "old", replace: "new" }] }] }, originals)
  await applyDraft(dir, originals, changes)
  await assert.rejects(readFile(path.join(dir, "old.js")), /ENOENT/)
  assert.equal(await readFile(path.join(dir, "src/new.js"), "utf8"), "new")
  assert.equal(await readFile(path.join(dir, "run.sh"), "utf8"), "new")
  assert.equal((await stat(path.join(dir, "run.sh"))).mode & 0o777, 0o755)
})

test("publication failure rolls back files already changed", async () => {
  const dir = await temp(); await writeFile(path.join(dir, "x.js"), "old"); await writeFile(path.join(dir, "blocked"), "a file, not a folder")
  const originals = new Map<string, Original>([["x.js", { content: "old", mode: 0o644 }], ["blocked/y.js", { content: null, mode: 0o644 }]])
  await assert.rejects(applyDraft(dir, originals, [{ path: "x.js", content: "new" }, { path: "blocked/y.js", content: "cannot create" }]), /EEXIST|ENOTDIR/)
  assert.equal(await readFile(path.join(dir, "x.js"), "utf8"), "old")
})
