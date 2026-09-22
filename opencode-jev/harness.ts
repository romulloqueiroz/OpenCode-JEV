import { promises as fs } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { validateDraft, materialize, readContext, candidateFiles, applyDraft, hash, DraftError, type Change, type Draft, type Original } from "./workspace.ts"
import { runBridge, type JevConfig } from "./io.ts"

export interface ModelRef { providerID: string; modelID: string }

export interface JevReport {
  decision: "revise" | "rubric_satisfied"
  unresolved_ids?: string[]
  previous_comparison?: { recommendation?: string; gaps?: unknown[]; possible_essential_regressions?: unknown[] }
  [key: string]: unknown
}

export interface EvaluationResult { report?: JevReport; feedback?: string }

export interface HarnessResult {
  answer: string
  changed: string[]
  rounds?: number
  selectedRound?: number
  decision: string
  stopReason?: string
  unresolved?: string[]
  audit?: string
  childID?: string
}

type Response = { data?: any; error?: unknown } | any

/** The subset of the OpenCode SDK client the harness calls. */
export interface HarnessClient {
  session: {
    create(request: { query: { directory: string }; body: Record<string, unknown> }): Promise<Response>
    prompt(request: { path: { id: string }; query: { directory: string }; body: Record<string, unknown>; signal?: AbortSignal }): Promise<Response>
    abort(request: { path: { id: string }; query: { directory: string } }): Promise<Response>
    messages?(request: { path: { id: string }; query: { directory: string } }): Promise<Response>
  }
}

export interface HarnessOptions {
  client: HarnessClient
  directory: string
  sessionID: string
  model?: ModelRef
  variant?: string
  task: string
  config: JevConfig
  signal?: AbortSignal
  progress?: (message: string) => Promise<void>
}

export type Harness = (options: HarnessOptions) => Promise<HarnessResult>

export interface HarnessDeps {
  applyDraft: typeof applyDraft
  runBridge: typeof runBridge
  saveRound: typeof saveRound
  evaluate?: (payload: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<EvaluationResult>
}

// Malformed drafts go back to the worker this many times per round before the run fails.
const MAX_REPAIRS = 2

const SECRET_READS = ["*.env", "*.env.*", "*secret*", "*credential*", "*.pem", "*.key", "*id_rsa*", "*id_ed25519*", "*.npmrc", "*.netrc", "*.pypirc"]

/** Read-only tools for the private worker. OpenCode applies the last matching rule. */
export const WORKER_PERMISSION: Record<string, string | Record<string, string>> = {
  "*": "deny",
  read: { "*": "allow", ...Object.fromEntries(SECRET_READS.map(pattern => [pattern, "deny"])), "*.env.example": "allow" },
  grep: "allow",
  glob: "allow",
  list: "allow",
  external_directory: "deny",
}

export const workerRuleset = () => Object.entries(WORKER_PERMISSION).flatMap(([permission, value]) =>
  typeof value === "string" ? [{ permission, pattern: "*", action: value }]
    : Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action })))

export const DRAFT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["answer", "files"],
  properties: {
    answer: { type: "string", description: "The final answer or code snippet to show the user." },
    files: { type: "array", maxItems: 128, description: "Proposed changes relative to the ORIGINAL files on disk. Empty for chat-only answers.",
      items: { type: "object", additionalProperties: false, required: ["path"], properties: {
        path: { type: "string", description: "Project-relative path, with no traversal or hidden directories." },
        edits: { type: "array", description: "For existing files: exact search/replace edits applied in order. Each search must match exactly once.",
          items: { type: "object", additionalProperties: false, required: ["search", "replace"], properties: {
            search: { type: "string", description: "Exact text copied from the file, unique within it." },
            replace: { type: "string", description: "Replacement text." },
          } } },
        content: { type: ["string", "null"], description: "Instead of edits: complete contents for a new or rewritten file, or null to delete it." },
      } } },
  },
}

const INSTRUCTIONS = `Return ONLY a JSON object matching the schema below, with no surrounding explanation.
- answer: your reply to the user. Put requested code snippets or explanations here.
- files: proposed file changes, or [] if the task needs none. For an existing file, use "edits": [{"search", "replace"}], where search is copied exactly from the file (including whitespace) and is unique in it; add surrounding lines if needed. For a new file, use "content" with the complete text. Use "content": null to delete a file.
Every draft is relative to the ORIGINAL files: nothing is written to disk until the harness applies the selected draft.

Schema:
${JSON.stringify(DRAFT_SCHEMA)}`

function unwrap(response: Response, label: string): any {
  if (response?.error) throw new Error(`${label} failed`)
  return response?.data ?? response
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  for (const candidate of [text, fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate) continue
    try { return JSON.parse(candidate) } catch {}
  }
  throw new DraftError("Your reply was not a JSON draft")
}

export function decodeDraft(response: Response, maxBytes: number): Draft {
  const data = unwrap(response, "Worker request")
  if (data?.info?.error) throw new Error(`Worker failed: ${data.info.error.name || "generation error"}`)
  const value = data?.info?.structured ?? data?.info?.structured_output
    ?? parseJson((data?.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("").trim())
  return validateDraft(value, maxBytes)
}

/** Project-relative paths of the files the worker opened with the read tool. */
async function filesRead(client: HarnessClient, childID: string, directory: string): Promise<string[]> {
  if (!client.session.messages) return []
  try {
    const messages = unwrap(await client.session.messages({ path: { id: childID }, query: { directory } }), "Listing worker messages")
    const root = await fs.realpath(directory)
    const inputs = (Array.isArray(messages) ? messages : []).flatMap((m: any) => m?.parts || [])
      .filter((p: any) => p?.type === "tool" && p.tool === "read" && typeof p.state?.input?.filePath === "string")
      .map((p: any) => path.resolve(directory, p.state.input.filePath))
    const names = await Promise.all(inputs.map(async (file: string) => {
      const relative = path.relative(root, await fs.realpath(file).catch(() => file))
      return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : relative.split(path.sep).join("/")
    }))
    return names.filter((name): name is string => !!name)
  } catch { return [] }
}

async function saveRound(directory: string, runID: string, round: number, value: unknown): Promise<string> {
  const folder = path.join(directory, ".opencode", "jev", "runs", runID)
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  const filename = path.join(folder, `${String(round).padStart(3, "0")}.json`)
  await fs.writeFile(filename, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  return filename
}

export function createHarness(overrides: Partial<HarnessDeps> = {}): Harness {
  const deps: HarnessDeps = { applyDraft, runBridge, saveRound, ...overrides }
  return async function runHarness({ client, directory, sessionID, model, variant, task, config, signal, progress = async () => {} }) {
    signal?.throwIfAborted()
    if (!model?.providerID || !model?.modelID) throw new Error("Select an OpenCode model before using the JEV agent")
    const rubric = config.rubricFile ? JSON.parse(await fs.readFile(path.resolve(directory, config.rubricFile), "utf8")) : undefined
    const runID = crypto.randomUUID()
    const created = unwrap(await client.session.create({ query: { directory }, body: {
      parentID: sessionID, title: "JEV private draft and revision", permission: workerRuleset(),
    } }), "Creating private session")
    if (!created?.id) throw new Error("OpenCode did not create a private worker session")
    const childID = created.id
    const abort = () => { void client.session.abort({ path: { id: childID }, query: { directory } }).catch(() => {}) }
    signal?.addEventListener("abort", abort, { once: true })

    async function generate(text: string): Promise<Response> {
      const deadline = AbortSignal.timeout((config.generationTimeout || 300) * 1000)
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      const stopWorker = () => abort()
      requestSignal.addEventListener("abort", stopWorker, { once: true })
      try {
        // OpenCode 1.18.32 can generate with format:json_schema, but its
        // persisted-message HTTP encoder rejects the resulting plain Format
        // object. Use validated JSON text so private sessions remain readable.
        return await client.session.prompt({ path: { id: childID }, query: { directory }, body: {
          model, agent: "jev-worker", ...(variant ? { variant } : {}), parts: [{ type: "text", text }],
        }, signal: requestSignal })
      } finally {
        requestSignal.removeEventListener("abort", stopWorker)
        requestSignal.throwIfAborted()
        signal?.throwIfAborted()
      }
    }

    let best: { draft: Draft; changes: Change[]; report: JevReport; round: number } | undefined
    let feedback: unknown = "", stalls = 0, rounds = 0, audit: string | undefined, stopReason = "revision budget"
    const seen = new Set<string>()
    const originals = new Map<string, Original>()
    try {
      for (let round = 0; round <= config.maxRevisions; round++) {
        signal?.throwIfAborted()
        await progress(round ? `Revising privately (${round}/${config.maxRevisions})` : "Drafting privately")
        let prompt = round === 0
          ? `Complete the user's current task. This is a PRIVATE draft: you cannot modify the user's project. Use the read, grep and glob tools to inspect the project in ${directory}, and read every file before you change it. Only propose file changes if the task requests them. Do not modify the evaluator, rubric, or plugin configuration to affect the grade.\n\nTask and conversation context:\n${task}\n\n${INSTRUCTIONS}`
          : `Revise the retained draft using JEV's feedback below. The files on disk are still the ORIGINAL files, so return the COMPLETE draft again, including edits you keep. Preserve satisfied behavior. Uncertain judgments are inspection prompts, not proven defects.\n\nRetained draft:\n${JSON.stringify(best!.draft)}\n\nJEV feedback on the last attempt:\n${feedback}\n\n${INSTRUCTIONS}`
        let draft: Draft, changes: Change[]
        for (let attempt = 0; ; attempt++) {
          const response = await generate(prompt)
          try {
            draft = decodeDraft(response, config.maxSourceBytes)
            changes = await materialize(directory, draft, originals, signal)
            break
          } catch (error) {
            if (!(error instanceof DraftError) || attempt >= MAX_REPAIRS) throw error
            await progress(`Repairing private draft (${error.message.split("\n")[0]})`)
            prompt = `Your draft could not be used: ${error.message}\n\nRead the file again if needed, then return the complete corrected draft.\n\n${INSTRUCTIONS}`
          }
        }
        const fingerprint = hash({ answer: draft.answer, changes })
        if (seen.has(fingerprint)) { stopReason = "repeated candidate"; break }
        seen.add(fingerprint)
        await progress(`Evaluating private draft (${round + 1})`)
        const context = await readContext(directory, await filesRead(client, childID, directory), config.maxSourceBytes)
        const payload: Record<string, unknown> = { task, files: candidateFiles(context, changes, draft.answer, config.maxSourceBytes), timeout: config.timeout,
          ...(rubric ? { rubric } : {}), ...(best ? { previous_report: best.report } : {}) }
        const result: EvaluationResult = deps.evaluate ? await deps.evaluate(payload, { signal })
          : await deps.runBridge({ python: config.python, directory, payload, timeout: config.timeout, signal })
        signal?.throwIfAborted()
        const report = result?.report
        if (!report || !["revise", "rubric_satisfied"].includes(report.decision)) throw new Error("JEV returned an invalid report")
        const comparison = report.previous_comparison
        const noLoss = comparison && !(comparison.possible_essential_regressions || []).length && !(comparison.gaps || []).length
        const promoted = !best || (noLoss && (comparison.recommendation === "improved_by_jev"
          || (report.decision === "rubric_satisfied" && best.report.decision !== "rubric_satisfied")))
        rounds++
        if (promoted) { best = { draft, changes, report, round: rounds }; stalls = 0 }
        else stalls++
        feedback = result.feedback
        audit = await deps.saveRound(directory, runID, rounds, { task, model, childID, draft, changed: changes.map(c => c.path), report, promoted, bestRound: best!.round })
        if (promoted && report.decision === "rubric_satisfied") { stopReason = "rubric satisfied"; break }
        if (stalls >= config.maxStalls) { stopReason = "no material improvement"; break }
        if (round < config.maxRevisions && (typeof feedback !== "string" || !feedback.trim())) throw new Error("JEV returned no revision feedback")
      }
      signal?.throwIfAborted()
      if (!best) throw new Error("No evaluated candidate is available")
      await progress("Applying the selected result")
      const changed = await deps.applyDraft(directory, originals, best.changes, signal)
      return { answer: best.draft.answer, changed, rounds, selectedRound: best.round, decision: best.report.decision,
        stopReason, unresolved: best.report.unresolved_ids || [], audit, childID }
    } finally {
      signal?.removeEventListener("abort", abort)
      if (signal?.aborted) abort()
    }
  }
}
