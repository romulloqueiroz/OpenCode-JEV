import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createJevPlugin } from "./plugin.mjs"

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const model = { providerID: "mock", modelID: "selected" }
const message = (agent = "jev", id = "u1", text = "Implement X") => ({ info: { role: "user", agent, id, sessionID: "parent", model }, parts: [{ type: "text", text }] })
async function setup(harness) {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-hooks-")); roots.push(directory)
  const hooks = await createJevPlugin({ harness })({ directory, client: {} })
  const send = async (msg = message()) => hooks["chat.message"]({ sessionID: msg.info.sessionID, agent: msg.info.agent, model }, { message: msg.info, parts: msg.parts })
  const transform = async (msg = message()) => { const output = { messages: [msg] }; await hooks["experimental.chat.messages.transform"]({}, output); return output }
  return { hooks, directory, send, transform }
}

test("JEV agent is default, inherits selected model, and worker cannot use tools", async () => {
  const s = await setup(async () => ({})); const cfg = {}
  await s.hooks.config(cfg)
  assert.equal(cfg.default_agent, "jev")
  assert.equal(cfg.agent.jev.model, undefined)
  assert.deepEqual(cfg.agent.jev.permission, { "*": "deny" })
  assert.deepEqual(cfg.agent["jev-worker"].permission, { "*": "deny" })
  assert.equal(cfg.agent["jev-worker"].hidden, true)
  assert.equal(s.hooks["tool.execute.after"], undefined)
})

test("pre-generation hook waits for harness and exposes only selected result", async () => {
  let release, started
  const gate = new Promise(r => { release = r }), begun = new Promise(r => { started = r })
  let calls = 0
  const s = await setup(async args => { calls++; assert.deepEqual(args.model, model); started(); await gate; return { answer: "SELECTED_FINAL", changed: ["x.js"] } })
  await s.send()
  let returned = false
  const pending = s.transform().then(result => { returned = true; return result })
  await begun; assert.equal(returned, false)
  release(); const output = await pending
  assert.match(output.messages[0].parts[0].text, /SELECTED_FINAL/)
  assert.equal(output.messages.length, 1)
  await s.transform(); assert.equal(calls, 1)
  await assert.rejects(s.hooks["tool.execute.before"]({ sessionID: "parent", tool: "write" }), /harness owns/)
})

test("worker and ordinary non-JEV agents never recursively invoke harness", async () => {
  let calls = 0; const s = await setup(async () => { calls++; return {} })
  for (const agent of ["jev-worker", "build", "plan"]) { await s.send(message(agent)); await s.transform(message(agent)) }
  assert.equal(calls, 0)
})

test("new user message aborts old run; old result cannot reach visible model", async () => {
  let release, started, signal
  const gate = new Promise(r => { release = r }), begun = new Promise(r => { started = r })
  const s = await setup(async args => { signal = args.signal; started(); await gate; return { answer: "stale" } })
  await s.send(); const pending = s.transform(); await begun
  await s.send(message("jev", "u2", "Different task"))
  assert.equal(signal.aborted, true)
  release(); await assert.rejects(pending, /superseded/)
})

test("cancelling parent or disposing plugin aborts private work", async () => {
  for (const dispose of [false, true]) {
    let release, started, signal
    const gate = new Promise(r => { release = r }), begun = new Promise(r => { started = r })
    const s = await setup(async args => { signal = args.signal; started(); await gate; signal.throwIfAborted() })
    await s.send(); const pending = s.transform(); await begun
    if (dispose) await s.hooks.dispose()
    else await s.hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "parent", error: { name: "MessageAbortedError" } } } } })
    assert.equal(signal.aborted, true); release(); await assert.rejects(pending)
  }
})

test("failure is presented without falling back to unreviewed generation", async () => {
  const s = await setup(async () => { throw new Error("JEV unavailable") })
  await s.send(); const result = await s.transform()
  assert.match(result.messages[0].parts[0].text, /JEV unavailable/)
  assert.match(result.messages[0].parts[0].text, /No unreviewed draft/)
})

test("an aborted older assistant message does not cancel the current user turn", async () => {
  let signal
  const s = await setup(async args => { signal = args.signal; return { answer: "current" } })
  await s.send(message("jev", "u2")); await s.transform(message("jev", "u2"))
  await s.hooks.event({ event: { type: "message.updated", properties: { info: {
    role: "assistant", sessionID: "parent", parentID: "u1", error: { name: "MessageAbortedError" },
  } } } })
  assert.equal(signal.aborted, false)
})

test("disabled plugin changes no agents or messages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-disabled-")); roots.push(directory)
  await writeFile(path.join(directory, "opencode-jev.json"), '{"enabled":false}')
  assert.deepEqual(await createJevPlugin()({ directory, client: {} }), {})
})
