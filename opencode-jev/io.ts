import { promises as fs } from "node:fs"
import path from "node:path"
import { spawn as nodeSpawn } from "node:child_process"
import { fileURLToPath } from "node:url"

export const DEFAULTS = Object.freeze({
  enabled: true,
  python: "python3",
  maxRevisions: 3,
  timeout: 60,
  maxSourceBytes: 200000,
  maxStalls: 2,
  generationTimeout: 300,
})

function invalid(message) { throw new TypeError(`Invalid opencode-jev config: ${message}`) }

export async function loadConfig(directory, { readFile = fs.readFile } = {}) {
  let raw
  try { raw = JSON.parse(await readFile(path.join(directory, "opencode-jev.json"), "utf8")) }
  catch (error) { if (error?.code === "ENOENT") return { ...DEFAULTS }; throw error }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("configuration must be an object")
  const config = { ...DEFAULTS, ...raw }
  if (typeof config.enabled !== "boolean") invalid("enabled must be boolean")
  if (typeof config.python !== "string" || !config.python.trim()) invalid("python must be a nonempty string")
  for (const key of ["maxRevisions", "maxStalls"]) {
    if (!Number.isFinite(config[key]) || !Number.isInteger(config[key])) invalid(`${key} must be an integer`)
  }
  if (config.maxRevisions < 0 || config.maxRevisions > 10) invalid("maxRevisions must be between 0 and 10")
  if (config.maxStalls < 1 || config.maxStalls > 5) invalid("maxStalls must be between 1 and 5")
  if (!Number.isFinite(config.timeout) || config.timeout < 1 || config.timeout > 300) invalid("timeout must be between 1 and 300 seconds")
  if (!Number.isFinite(config.generationTimeout) || config.generationTimeout < 1 || config.generationTimeout > 3600) invalid("generationTimeout must be between 1 and 3600 seconds")
  if (!Number.isFinite(config.maxSourceBytes) || config.maxSourceBytes < 1 || config.maxSourceBytes > 2_000_000) invalid("maxSourceBytes must be between 1 and 2000000 bytes")
  if (config.rubricFile !== undefined && (typeof config.rubricFile !== "string" || !config.rubricFile.trim())) invalid("rubricFile must be a nonempty string")
  return config
}

export function runBridge({ python = DEFAULTS.python, directory, payload, timeout = DEFAULTS.timeout, signal, spawn = nodeSpawn } = {}) {
  const bridge = fileURLToPath(new URL("../opencode_jev_bridge.py", import.meta.url))
  return new Promise((resolve, reject) => {
    let settled = false; let timer; let killTimer; let stdout = ""; let stderr = ""
    let onAbort
    const child = spawn(python, [bridge], { cwd: directory, shell: false, stdio: ["pipe", "pipe", "pipe"] })
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); if (signal && onAbort) signal.removeEventListener("abort", onAbort); if (error) reject(error); else resolve(value) }
    const stop = reason => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener("abort", onAbort)
      try { child.kill("SIGTERM"); killTimer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 250) } catch {}
      reject(reason)
    }
    child.once("error", error => finish(error))
    child.stdout.on("data", chunk => { if (settled) return; stdout += chunk; if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) stop(new Error("JEV bridge stdout exceeded 16MB")) })
    child.stderr.on("data", chunk => { if (settled) return; stderr += chunk; if (Buffer.byteLength(stderr) > 16 * 1024 * 1024) stop(new Error("JEV bridge stderr exceeded 16MB")) })
    child.stdin.once("error", error => { if (error.code !== "EPIPE") stop(error) })
    child.once("close", code => {
      clearTimeout(killTimer)
      if (settled) return
      if (code !== 0) return finish(new Error(stderr.trim() || `JEV bridge exited with code ${code}`))
      try { finish(null, JSON.parse(stdout)) } catch (error) { finish(new Error(`Invalid JEV bridge JSON: ${error.message}`)) }
    })
    timer = setTimeout(() => stop(new Error(`JEV bridge timed out after ${timeout} seconds`)), timeout * 1000)
    if (signal) {
      if (signal.aborted) return stop(signal.reason || new Error("JEV bridge aborted"))
      onAbort = () => stop(signal.reason || new Error("JEV bridge aborted"))
      signal.addEventListener("abort", onAbort, { once: true })
    }
    child.stdin.end(JSON.stringify(payload))
  })
}
