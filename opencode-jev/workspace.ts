import { promises as fs } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const IGNORED = new Set(["node_modules", "vendor", "venv", "dist", "build", "coverage", "target", "__pycache__"])
const TEXT = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".c", ".h", ".cpp", ".cs", ".fs", ".html", ".css", ".scss", ".vue", ".svelte", ".json", ".yaml", ".yml", ".toml", ".xml", ".sql", ".sh", ".md", ".txt", ".dart", ".lua"])
export interface DraftEdit { search: string; replace: string }
/** Exactly one of content (full text, or null to delete) or edits (search/replace against the original). */
export interface DraftFile { path: string; content?: string | null; edits?: DraftEdit[] }
export interface Draft { answer: string; files: DraftFile[] }
/** A file as it was on disk when the harness first touched it; content null means it did not exist. */
export interface Original { content: string | null; mode: number }
/** A materialized change: the complete new content, or null to delete. */
export interface Change { path: string; content: string | null }

/** A draft the worker can repair: the harness returns this message to it instead of failing the run. */
export class DraftError extends Error {}

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

async function readLive(target: string): Promise<string | null> {
  try { return await fs.readFile(target, "utf8") }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) return null; throw error }
}

export async function readOriginal(root: string, name: string): Promise<Original> {
  const target = await safeTarget(root, name)
  let data: Buffer, mode: number
  try { [data, mode] = await Promise.all([fs.readFile(target), fs.stat(target).then(s => s.mode & 0o777)]) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null, mode: 0o644 }; throw error }
  if (data.includes(0)) throw new DraftError(`Binary files cannot be edited: ${name}`)
  try { return { content: new TextDecoder("utf-8", { fatal: true }).decode(data), mode } }
  catch { throw new DraftError(`File is not valid UTF-8: ${name}`) }
}

export function validateDraft(value: any, maxBytes: number): Draft {
  if (!value || typeof value !== "object" || typeof value.answer !== "string" || !Array.isArray(value.files)) throw new DraftError("Draft must be a JSON object with a string answer and a files array")
  if (value.files.length > 128) throw new DraftError("Draft proposes too many files (maximum 128)")
  const paths = new Set<string>()
  let bytes = Buffer.byteLength(value.answer)
  const files: DraftFile[] = value.files.map((file: any): DraftFile => {
    if (!file || !sourcePath(file.path)) throw new DraftError(`Unsupported or unsafe file path: ${file?.path}`)
    if (paths.has(file.path)) throw new DraftError(`Duplicate proposed file: ${file.path}`)
    paths.add(file.path)
    const hasContent = "content" in file && file.content !== undefined, hasEdits = "edits" in file && file.edits !== undefined
    if (hasContent === hasEdits) throw new DraftError(`${file.path}: give exactly one of content or edits`)
    if (hasContent) {
      if (file.content !== null && typeof file.content !== "string") throw new DraftError(`${file.path}: content must be a string or null`)
      if (file.content?.includes("\0")) throw new DraftError("Binary file changes are not supported")
      bytes += Buffer.byteLength(file.content || "")
      return { path: file.path, content: file.content }
    }
    if (!Array.isArray(file.edits) || !file.edits.length) throw new DraftError(`${file.path}: edits must be a nonempty array`)
    const edits = file.edits.map((edit: any): DraftEdit => {
      if (!edit || typeof edit.search !== "string" || !edit.search || typeof edit.replace !== "string") throw new DraftError(`${file.path}: each edit needs a nonempty search string and a replace string`)
      if ((edit.search + edit.replace).includes("\0")) throw new DraftError("Binary file changes are not supported")
      bytes += Buffer.byteLength(edit.search) + Buffer.byteLength(edit.replace)
      return { search: edit.search, replace: edit.replace }
    })
    return { path: file.path, edits }
  }).sort((a: DraftFile, b: DraftFile) => a.path.localeCompare(b.path))
  if (!value.answer.trim() && !files.length) throw new DraftError("Draft is empty")
  if (bytes > maxBytes) throw new DraftError(`Draft exceeds maxSourceBytes (${maxBytes}); use smaller edits`)
  return { answer: value.answer, files }
}

/** Resolve a draft to complete file contents. Records each file's original in `originals` on first use. */
export async function materialize(directory: string, draft: Draft, originals: Map<string, Original>, signal?: AbortSignal): Promise<Change[]> {
  const root = await fs.realpath(directory)
  const changes: Change[] = []
  for (const file of draft.files) {
    signal?.throwIfAborted()
    let original = originals.get(file.path)
    if (!original) { original = await readOriginal(root, file.path); originals.set(file.path, original) }
    if (!file.edits) {
      if (file.content === null && original.content === null) throw new DraftError(`Cannot delete ${file.path}: it does not exist`)
      changes.push({ path: file.path, content: file.content ?? null })
      continue
    }
    if (original.content === null) throw new DraftError(`${file.path} does not exist; use content for new files`)
    let text = original.content
    for (const [index, edit] of file.edits.entries()) {
      const count = text.split(edit.search).length - 1
      const label = `${file.path} edit ${index + 1}`
      if (!count) throw new DraftError(`${label}: search text not found. Copy it exactly from the file, including whitespace:\n${edit.search.slice(0, 200)}`)
      if (count > 1) throw new DraftError(`${label}: search text matches ${count} places; include more surrounding lines so it is unique`)
      // A replacer function keeps "$&"-style patterns in the replacement literal.
      text = text.replace(edit.search, () => edit.replace)
    }
    changes.push({ path: file.path, content: text })
  }
  return changes
}

/** Read project files for evaluator context, skipping unsafe or unreadable ones and stopping at the byte budget. */
export async function readContext(directory: string, names: Iterable<string>, budget: number): Promise<{ path: string; content: string }[]> {
  const root = await fs.realpath(directory)
  const files = []
  for (const name of [...new Set(names)].filter(sourcePath).sort()) {
    try {
      const { content } = await readOriginal(root, name)
      if (content === null) continue
      const size = Buffer.byteLength(content)
      if (size > budget) continue
      budget -= size
      files.push({ path: name, content })
    } catch {}
  }
  return files
}

export function candidateFiles(context: { path: string; content: string }[], changes: Change[], answer: string, maxBytes: number): { path: string; content: string }[] {
  const files = new Map<string, string>()
  for (const c of changes) files.set(c.path, c.content === null ? "[[FILE DELETED IN THIS CANDIDATE]]" : c.content)
  files.set("[assistant response]", answer)
  let bytes = [...files.values()].reduce((n, content) => n + Buffer.byteLength(content), 0)
  if (bytes > maxBytes) throw new Error(`Candidate exceeds maxSourceBytes (${maxBytes})`)
  for (const f of context) {
    const size = Buffer.byteLength(f.content)
    if (files.has(f.path) || bytes + size > maxBytes) continue
    files.set(f.path, f.content); bytes += size
  }
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }))
}

// Compare to the files as first read, including uncommitted edits. On failure roll
// back only our own writes; never overwrite a subsequent edit by another writer.
export async function applyDraft(directory: string, originals: Map<string, Original>, draft: Change[], signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  const root = await fs.realpath(directory)
  const original = (name: string) => {
    const value = originals.get(name)
    if (!value) throw new Error(`No original recorded for ${name}`)
    return value
  }
  const changes = draft.filter(f => original(f.path).content !== f.content)
  for (const file of changes) {
    if (await readLive(await safeTarget(root, file.path)) !== original(file.path).content) throw new Error(`Project changed during refinement (${file.path}); no draft applied. The selected result is in the run report.`)
  }
  const written: Change[] = [], createdDirs: string[] = []
  async function replace(target: string, content: string, previous: string | null, mode: number): Promise<void> {
    const staging = path.join(path.dirname(target), `.jev-${crypto.randomUUID()}.tmp`)
    try {
      // A failed or interrupted write must not truncate an existing user file.
      await fs.writeFile(staging, content, { flag: "wx", mode })
      signal?.throwIfAborted()
      if (await readLive(target) !== previous) throw new Error(`File changed before publication: ${target}`)
      if (previous === null) await fs.link(staging, target)
      else await fs.rename(staging, target)
    } finally { await fs.unlink(staging).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error }) }
  }
  try {
    for (const file of changes) {
      signal?.throwIfAborted()
      const target = await safeTarget(root, file.path)
      const old = original(file.path)
      if (await readLive(target) !== old.content) throw new Error(`File changed before publication: ${file.path}`)
      if (file.content === null) await fs.unlink(target)
      else {
        const firstCreated = await fs.mkdir(path.dirname(target), { recursive: true })
        if (firstCreated) createdDirs.push(firstCreated)
        await replace(target, file.content, old.content, old.mode)
      }
      written.push(file)
    }
    signal?.throwIfAborted()
  } catch (error) {
    for (const file of written.reverse()) {
      const target = await safeTarget(root, file.path)
      let live: string | null
      try { live = await readLive(target) } catch { continue }
      if (live !== file.content) continue
      const old = original(file.path)
      if (old.content !== null) await fs.writeFile(target, old.content, { mode: old.mode })
      else await fs.unlink(target)
    }
    for (const folder of createdDirs.reverse()) { try { await fs.rmdir(folder) } catch {} }
    throw error
  }
  return changes.map(f => f.path)
}
