import { promises as fs } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const IGNORED = new Set(["node_modules", "vendor", "venv", "dist", "build", "coverage", "target", "__pycache__"])
const TEXT = new Set([".py", ".js", ".ts", ".cjs", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".c", ".h", ".cpp", ".cs", ".fs", ".html", ".css", ".scss", ".vue", ".svelte", ".json", ".yaml", ".yml", ".toml", ".xml", ".sql", ".sh", ".md", ".txt", ".dart", ".lua"])
export interface SourceFile { path: string; content: string; mode: number }
export interface DraftFile { path: string; content: string | null }
export interface Draft { answer: string; files: DraftFile[] }

const SECRETS = /(?:^|[._-])(?:env|keys?|secrets?|credentials?|tokens?|passwords?|passwd|private)(?:$|[._-])/i
export const hash = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function sourcePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f]/.test(value) || path.isAbsolute(value)) return false
  const parts = value.split("/")
  if (parts.some(p => !p || p.startsWith(".") || IGNORED.has(p))) return false
  const name = parts.at(-1)!
  if (SECRETS.test(name) || /^(?:opencode(?:-jev)?\.jsonc?|package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml)$/.test(name)) return false
  return TEXT.has(path.extname(name).toLowerCase()) || ["Dockerfile", "Makefile", "LICENSE"].includes(name)
}

async function safeTarget(root: string, name: string): Promise<string> {
  if (!sourcePath(name)) throw new Error(`Unsupported or unsafe file path: ${name}`)
  let cursor = root
  for (const segment of name.split("/")) {
    cursor = path.join(cursor, segment)
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Symlinks are not supported: ${name}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  return cursor
}

export async function readWorkspace(directory: string, maxBytes: number, signal?: AbortSignal): Promise<SourceFile[]> {
  const root = await fs.realpath(directory)
  const files: SourceFile[] = []
  let bytes = 0
  async function visit(folder: string, prefix = ""): Promise<void> {
    signal?.throwIfAborted()
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || IGNORED.has(entry.name) || entry.isSymbolicLink()) continue
      const name = prefix + entry.name
      if (entry.isDirectory()) { await visit(path.join(folder, entry.name), `${name}/`); continue }
      if (!entry.isFile() || !sourcePath(name)) continue
      const target = await safeTarget(root, name)
      const stat = await fs.stat(target)
      if (stat.size + bytes > maxBytes) throw new Error(`Project context exceeds maxSourceBytes (${maxBytes}); increase the limit or open a smaller project directory`)
      const data = await fs.readFile(target)
      if (data.includes(0)) continue
      const content = new TextDecoder("utf-8", { fatal: true }).decode(data)
      bytes += data.length
      if (bytes > maxBytes) throw new Error(`Project context exceeds maxSourceBytes (${maxBytes})`)
      files.push({ path: name, content, mode: stat.mode & 0o777 })
    }
  }
  await visit(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function validateDraft(value: any, maxBytes: number): Draft {
  if (!value || typeof value !== "object" || typeof value.answer !== "string" || !Array.isArray(value.files)) throw new Error("Worker returned an invalid draft")
  if (value.files.length > 128) throw new Error("Worker proposed too many files")
  const paths = new Set<string>()
  let bytes = Buffer.byteLength(value.answer)
  const files: DraftFile[] = value.files.map((file: any): DraftFile => {
    if (!file || !sourcePath(file.path) || (file.content !== null && typeof file.content !== "string")) throw new Error("Worker proposed an unsupported file or content")
    if (paths.has(file.path)) throw new Error(`Duplicate proposed file: ${file.path}`)
    paths.add(file.path)
    if (file.content?.includes("\0")) throw new Error("Binary file changes are not supported")
    bytes += Buffer.byteLength(file.content || "")
    return { path: file.path, content: file.content }
  }).sort((a: DraftFile, b: DraftFile) => a.path.localeCompare(b.path))
  if (!value.answer.trim() && !files.length) throw new Error("Worker returned an empty draft")
  if (bytes > maxBytes) throw new Error(`Draft exceeds maxSourceBytes (${maxBytes})`)
  return { answer: value.answer, files }
}

export function candidateFiles(baseline: SourceFile[], draft: Draft, maxBytes: number): { path: string; content: string }[] {
  const files = new Map<string, string>(baseline.map(f => [f.path, f.content]))
  for (const f of draft.files) files.set(f.path, f.content === null ? "[[FILE DELETED IN THIS CANDIDATE]]" : f.content)
  files.set("[assistant response]", draft.answer)
  const result = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }))
  if (result.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > maxBytes) throw new Error(`Candidate and context exceed maxSourceBytes (${maxBytes})`)
  return result
}

// Compare to the working files, including uncommitted edits. On failure roll
// back only our own writes; never overwrite a subsequent edit by another writer.
export async function applyDraft(directory: string, baseline: SourceFile[], draft: Draft, maxBytes: number, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  const root = await fs.realpath(directory)
  if (hash(await readWorkspace(root, maxBytes, signal)) !== hash(baseline)) throw new Error("Project changed during refinement; no draft applied. The selected result is in the run report.")
  const original = new Map(baseline.map(f => [f.path, f]))
  const changes = draft.files.filter(f => (original.get(f.path)?.content ?? null) !== f.content)
  const written: DraftFile[] = [], createdDirs: string[] = []
  async function replace(target: string, content: string, previous: string | null, mode: number): Promise<void> {
    const staging = path.join(path.dirname(target), `.jev-${crypto.randomUUID()}.tmp`)
    try {
      // A failed or interrupted write must not truncate an existing user file.
      await fs.writeFile(staging, content, { flag: "wx", mode })
      signal?.throwIfAborted()
      let live: string | null = null
      try { live = await fs.readFile(target, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      if (live !== previous) throw new Error(`File changed before publication: ${target}`)
      if (previous === null) await fs.link(staging, target)
      else await fs.rename(staging, target)
    } finally { await fs.unlink(staging).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error }) }
  }
  try {
    for (const file of changes) {
      signal?.throwIfAborted()
      const target = await safeTarget(root, file.path)
      let live: string | null = null
      try { live = await fs.readFile(target, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      if (live !== (original.get(file.path)?.content ?? null)) throw new Error(`File changed before publication: ${file.path}`)
      if (file.content === null) await fs.unlink(target)
      else {
        const firstCreated = await fs.mkdir(path.dirname(target), { recursive: true })
        if (firstCreated) createdDirs.push(firstCreated)
        await replace(target, file.content, live, original.get(file.path)?.mode ?? 0o644)
      }
      written.push(file)
    }
    signal?.throwIfAborted()
  } catch (error) {
    for (const file of written.reverse()) {
      const target = await safeTarget(root, file.path)
      let live: string | null = null
      try { live = await fs.readFile(target, "utf8") } catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") continue }
      if (live !== file.content) continue
      const old = original.get(file.path)
      if (old) await fs.writeFile(target, old.content, { mode: old.mode })
      else await fs.unlink(target)
    }
    for (const folder of createdDirs.reverse()) { try { await fs.rmdir(folder) } catch {} }
    throw error
  }
  return changes.map(f => f.path)
}
