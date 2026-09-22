import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig, runBridge } from "./io.mjs"

async function tempDir() { return mkdtemp(path.join(tmpdir(), "jev-io-")) }

test("config defaults and validation bounds", async t => {
  const root = await tempDir(); t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal((await loadConfig(root)).maxStalls, 2)
  await writeFile(path.join(root, "opencode-jev.json"), JSON.stringify({ maxRevisions: 11 }))
  await assert.rejects(loadConfig(root), /maxRevisions/)
  await writeFile(path.join(root, "opencode-jev.json"), JSON.stringify({ timeout: 0 }))
  await assert.rejects(loadConfig(root), /timeout/)
  await writeFile(path.join(root, "opencode-jev.json"), JSON.stringify({ enabled: "yes" }))
  await assert.rejects(loadConfig(root), /enabled/)
})

test("runBridge rejects missing executable and malformed request", async t => {
  const root = await tempDir(); t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(runBridge({ python: "/definitely/not/a/python", directory: root, payload: {}, timeout: 1 }))
  await assert.rejects(runBridge({ python: "python3", directory: root, payload: {}, timeout: 10 }), /bridge|JSON|request|API|task/i)
})

test("runBridge aborts a hanging executable", async t => {
  const root = await tempDir(); t.after(() => rm(root, { recursive: true, force: true }))
  const executable = path.join(root, "hang.py")
  await writeFile(executable, "import time; time.sleep(30)")
  const controller = new AbortController()
  const pending = runBridge({ python: "python3", directory: root, payload: {}, timeout: 30, signal: controller.signal })
  setTimeout(() => controller.abort(new Error("test abort")), 25)
  await assert.rejects(pending, /test abort/)
})
