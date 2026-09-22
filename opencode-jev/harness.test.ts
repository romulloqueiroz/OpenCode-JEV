import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHarness, decodeDraft, type HarnessDeps, type HarnessOptions, type JevReport } from "./harness.ts"
import { DEFAULTS } from "./io.ts"
import { readWorkspace, applyDraft, validateDraft, candidateFiles, type Draft } from "./workspace.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), "jev-private-")); roots.push(dir); return dir }
const config = { ...DEFAULTS, maxRevisions: 3, maxStalls: 2, maxSourceBytes: 100000, timeout: 30 }
const model = { providerID: "mock", modelID: "chosen-model" }
const draft = (value: number, files = true): Draft => ({ answer: `ANSWER_${value}`, files: files ? [{ path: "x.js", content: `export const x = ${value};` }] : [] })
const report = (decision: JevReport["decision"], recommendation?: string): JevReport => ({ decision, unresolved_ids: decision === "revise" ? ["behavior"] : [],
  ...(recommendation ? { previous_comparison: { recommendation, gaps: [], possible_essential_regressions: [] } } : {}) })
async function setup(drafts: Draft[], reports: JevReport[], overrides: Partial<HarnessDeps> = {}) {
  const directory = await temp(); await writeFile(path.join(directory, "x.js"), "original")
  const prompts: any[] = [], creates: any[] = [], evaluations: any[] = [], records: any[] = [], aborts: any[] = []
  const client = { session: {
    async create(request: any) { creates.push(request); return { data: { id: "child" } } },
    async prompt(request: any): Promise<any> { prompts.push(request); return { data: { info: {}, parts: [{ type: "text", text: JSON.stringify(drafts.shift()) }] } } },
    async abort(request: any) { aborts.push(request); return {} },
  } }
  const run = createHarness({ evaluate: async payload => {
    assert.equal(await readFile(path.join(directory, "x.js"), "utf8"), "original", "No draft may touch live files before selection")
    evaluations.push(payload); return { report: reports.shift(), feedback: "Fix behavior; preserve interface" }
  }, saveRound: async (_d, _r, _n, record) => { records.push(record); return "audit.json" }, ...overrides })
  return { directory, prompts, creates, evaluations, records, aborts, client,
    run: (options: Partial<HarnessOptions> = {}) => run({ client, directory, sessionID: "parent", model, task: "Set x to 2", config, ...options }) }
}

test("draft/evaluate/revise finishes privately and applies only the selected candidate", async () => {
  const s = await setup([draft(1), draft(2)], [report("revise"), report("rubric_satisfied", "improved_by_jev")])
  const result = await s.run()
  assert.equal(result.answer, "ANSWER_2"); assert.equal(result.rounds, 2)
  assert.equal(await readFile(path.join(s.directory, "x.js"), "utf8"), "export const x = 2;")
  assert.deepEqual(s.creates[0].body.permission, [{ permission: "*", pattern: "*", action: "deny" }])
  assert.equal(s.creates[0].body.parentID, "parent")
  assert.ok(s.prompts.every(p => p.path.id === "child" && p.body.agent === "jev-worker" && p.body.model === model))
  assert.match(s.prompts[1].body.parts[0].text, /Fix behavior/)
  assert.equal(s.evaluations[1].previous_report, s.records[0].report)
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

test("draft validation rejects traversal, config, secrets, duplicate paths and malformed output", () => {
  for (const name of ["../x.js", "/tmp/x.js", ".env", ".git/config", "opencode.json", "credentials.json"]) {
    assert.throws(() => validateDraft({ answer: "", files: [{ path: name, content: "bad" }] }, 10000))
  }
  assert.throws(() => validateDraft({ answer: "", files: [draft(1).files[0], draft(2).files[0]] }, 10000), /Duplicate/)
  assert.throws(() => decodeDraft({ data: { info: {}, parts: [{ type: "text", text: "not JSON" }] } }, 10000), /structured draft/)
})

test("source snapshots exclude secrets, dependency directories and symlinks; caps are bytes", async () => {
  const dir = await temp(); await writeFile(path.join(dir, "x.js"), "あ")
  await writeFile(path.join(dir, ".env"), "SECRET")
  await mkdir(path.join(dir, "node_modules")); await writeFile(path.join(dir, "node_modules/a.js"), "dependency")
  await symlink(path.join(dir, ".env"), path.join(dir, "alias.js"))
  assert.deepEqual((await readWorkspace(dir, 3)).map(f => f.path), ["x.js"])
  await assert.rejects(readWorkspace(dir, 2), /exceeds/)
  assert.throws(() => candidateFiles([], { answer: "あ", files: [] }, 2), /exceed/)
})

test("publication creates nested files, deletes requested files and preserves existing modes", async () => {
  const dir = await temp(); await writeFile(path.join(dir, "old.js"), "old"); await writeFile(path.join(dir, "run.sh"), "old", { mode: 0o755 })
  const baseline = await readWorkspace(dir, 10000)
  await applyDraft(dir, baseline, { answer: "done", files: [{ path: "old.js", content: null }, { path: "src/new.js", content: "new" }, { path: "run.sh", content: "new" }] }, 10000)
  await assert.rejects(readFile(path.join(dir, "old.js")), /ENOENT/)
  assert.equal(await readFile(path.join(dir, "src/new.js"), "utf8"), "new")
  assert.equal((await stat(path.join(dir, "run.sh"))).mode & 0o777, 0o755)
})

test("publication failure rolls back files already changed", async () => {
  const dir = await temp(); await writeFile(path.join(dir, "x.js"), "old"); await mkdir(path.join(dir, "blocked.js"))
  const baseline = await readWorkspace(dir, 10000)
  await assert.rejects(applyDraft(dir, baseline, { answer: "", files: [{ path: "x.js", content: "new" }, { path: "blocked.js", content: "cannot write a directory" }] }, 10000))
  assert.equal(await readFile(path.join(dir, "x.js"), "utf8"), "old")
})
