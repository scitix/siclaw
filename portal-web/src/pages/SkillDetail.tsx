import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, Loader2, Save, Send, Undo2, Trash2, RotateCcw, Terminal, FileCode, X, History, ShieldAlert, Code2, FileUp, FolderUp, Archive, ChevronDown, ChevronRight, Folder, FileText, FilePlus2, FolderPlus, Pencil, MoreHorizontal } from "lucide-react"
import { api, apiRaw } from "../api"
import { useToast } from "../components/toast"
import { PackageDiffView } from "../components/SimpleDiff"
import { useConfirm } from "../components/confirm-dialog"
import Editor from "react-simple-code-editor"
import Prism from "prismjs"
import "prismjs/components/prism-python"
import "prismjs/components/prism-bash"
import "prismjs/components/prism-json"
import "prismjs/components/prism-markdown"
import "prismjs/themes/prism-dark.css"

// ── Types ───────────────────────────────────────────────────────

interface Skill {
  id: string; name: string; description: string; labels: string[] | null
  author_id: string; status: "draft" | "pending_review" | "installed"
  version: number; specs: string
  scripts: { name: string; content: string }[] | string | null
  files?: SkillPackageFile[] | string | null
  created_at: string; updated_at: string
  is_builtin?: boolean; overlay_of?: string | null
}

interface SkillVersion {
  id: string; version: number; specs: string; scripts: string
  files?: SkillPackageFile[] | string | null
  commit_message: string; author_id: string
  is_approved: number; created_at: string
  diff?: unknown
}

interface SkillPackageFile {
  path: string
  content: string
  encoding?: "utf8" | "base64"
  size?: number
  sha256?: string
  executable?: boolean
}

type NewPackageEntryKind = "file" | "folder"
type RenameTarget = { type: "file" | "dir"; path: string }

interface FileTreeNode {
  name: string
  path: string
  type: "file" | "dir"
  file?: SkillPackageFile
  virtual?: boolean
  children: FileTreeNode[]
}

interface SkillReview {
  id: string; version: number; diff: string | null
  security_assessment: { risk_level: string; findings: { category: string; severity: string; pattern: string; match: string; scriptName: string; line: number }[]; summary: string } | null
  submitted_by: string; reviewed_by: string | null
  decision: string | null; reject_reason: string | null
  submitted_at: string; reviewed_at: string | null
}

// ── Constants ───────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: "bg-yellow-500/20", text: "text-yellow-400", label: "Draft" },
  pending_review: { bg: "bg-blue-500/20", text: "text-blue-400", label: "Pending Review" },
  installed: { bg: "bg-green-500/20", text: "text-green-400", label: "Installed" },
}

const RISK_STYLES: Record<string, { bg: string; text: string }> = {
  critical: { bg: "bg-red-500/20", text: "text-red-400" },
  high: { bg: "bg-orange-500/20", text: "text-orange-400" },
  medium: { bg: "bg-yellow-500/20", text: "text-yellow-400" },
  low: { bg: "bg-blue-500/20", text: "text-blue-400" },
  safe: { bg: "bg-green-500/20", text: "text-green-400" },
}

const DEFAULT_SPEC = `---
name: new-skill
description: Describe what this skill does
---

# New Skill

## Purpose
Explain the problem this skill solves.

## Parameters
- target: The resource to analyze (required)

## Procedure
1. Step one
2. Step two
`

function parseScripts(raw: Skill["scripts"]): { name: string; content: string }[] {
  if (!raw) return []
  if (typeof raw === "string") { try { return JSON.parse(raw) } catch { return [] } }
  return raw
}

function parseFiles(raw: Skill["files"]): SkillPackageFile[] {
  if (!raw) return []
  if (typeof raw === "string") { try { return JSON.parse(raw) } catch { return [] } }
  return Array.isArray(raw) ? raw : []
}

function byteSize(content: string, encoding: "utf8" | "base64" = "utf8") {
  if (encoding === "base64") return Math.ceil(content.length * 3 / 4)
  return new TextEncoder().encode(content).length
}

function textFile(path: string, content: string, executable = false): SkillPackageFile {
  return { path, content, encoding: "utf8", size: byteSize(content), executable }
}

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/").trim()
}

function isDirectScriptPath(path: string): boolean {
  return /^scripts\/[^/]+\.(sh|py)$/.test(path)
}

function decodeFile(file: SkillPackageFile): string {
  if (file.encoding === "base64") {
    try { return atob(file.content) } catch { return "" }
  }
  return file.content
}

function fileDirectory(path: string): string {
  const idx = path.lastIndexOf("/")
  return idx >= 0 ? path.slice(0, idx) : ""
}

function validatePackagePath(path: string, allowSkillMd = false): string | null {
  const normalized = normalizePackagePath(path)
  if (!normalized) return "Path is required"
  if (normalized.endsWith("/")) return "Use a file path, not a directory path"
  if (!allowSkillMd && normalized === "SKILL.md") return "SKILL.md already exists"
  const parts = normalized.split("/")
  if (parts.some(p => !p || p === "." || p === "..")) return "Path cannot contain empty, . or .. segments"
  if (parts.some(p => p.startsWith("."))) return "Hidden package paths are not supported"
  if (parts.some(p => p === ".git" || p === "node_modules")) return ".git and node_modules are not allowed"
  return null
}

function validateDirectoryPath(path: string): string | null {
  const normalized = normalizePackagePath(path)
  if (!normalized) return "Directory path is required"
  const parts = normalized.split("/")
  if (parts.some(p => !p || p === "." || p === "..")) return "Path cannot contain empty, . or .. segments"
  if (parts.some(p => p.startsWith("."))) return "Hidden package paths are not supported"
  if (parts.some(p => p === ".git" || p === "node_modules")) return ".git and node_modules are not allowed"
  return null
}

function shouldSkipFolderUploadPath(path: string): boolean {
  const normalized = normalizePackagePath(path)
  if (!normalized) return true
  return normalized.split("/").some(p => p.startsWith(".") || p === "__MACOSX" || p === "node_modules")
}

function packageFileKind(path: string): string {
  if (path === "SKILL.md") return "Entrypoint"
  if (path.endsWith(".py")) return "Python"
  if (path.endsWith(".sh")) return "Bash"
  if (path.endsWith(".json")) return "JSON"
  if (path.endsWith(".md")) return "Markdown"
  if (path.endsWith(".csv")) return "CSV"
  if (path.endsWith(".txt")) return "Text"
  return "File"
}

function prismLanguageForPath(path: string) {
  if (path.endsWith(".py")) return { grammar: Prism.languages.python, language: "python" }
  if (path.endsWith(".sh")) return { grammar: Prism.languages.bash, language: "bash" }
  if (path.endsWith(".json")) return { grammar: Prism.languages.json, language: "json" }
  if (path.endsWith(".md")) return { grammar: Prism.languages.markdown, language: "markdown" }
  return { grammar: Prism.languages.markdown || Prism.languages.bash, language: "markdown" }
}

function packageFileIcon(path: string, className = "h-4 w-4") {
  if (path === "SKILL.md") return <FileText className={`${className} text-purple-400`} />
  if (path.endsWith(".py")) return <FileCode className={`${className} text-blue-400`} />
  if (path.endsWith(".sh")) return <Terminal className={`${className} text-green-400`} />
  return <FileCode className={`${className} text-slate-400`} />
}

function buildFileTree(files: SkillPackageFile[], virtualDirs: string[] = []): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", type: "dir", children: [] }
  const dirMap = new Map<string, FileTreeNode>([["", root]])

  const ensureDir = (dirPath: string, virtual = false) => {
    const normalized = normalizePackagePath(dirPath)
    if (!normalized) return root
    const parts = normalized.split("/")
    let current = root
    let currentPath = ""
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let dir = dirMap.get(currentPath)
      if (!dir) {
        dir = { name: part, path: currentPath, type: "dir", children: [], virtual }
        dirMap.set(currentPath, dir)
        current.children.push(dir)
      } else if (virtual) {
        dir.virtual = true
      }
      current = dir
    }
    return current
  }

  for (const dir of virtualDirs) ensureDir(dir, true)

  for (const file of files) {
    const parts = file.path.split("/")
    let current = root
    let currentPath = ""
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isFile = i === parts.length - 1
      if (isFile) {
        current.children.push({ name: part, path: file.path, type: "file", file, children: [] })
      } else {
        current = ensureDir(currentPath)
      }
    }
  }

  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.path === "SKILL.md") return -1
      if (b.path === "SKILL.md") return 1
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach(n => sortNodes(n.children))
  }
  sortNodes(root.children)
  return root.children
}

function filesDiffPayload(oldFiles: SkillPackageFile[], newFiles: SkillPackageFile[]) {
  const oldMap = new Map(oldFiles.map(f => [f.path, f]))
  const newMap = new Map(newFiles.map(f => [f.path, f]))
  return Object.fromEntries([...new Set([...oldMap.keys(), ...newMap.keys()])].sort().map(path => {
    const oldFile = oldMap.get(path)
    const newFile = newMap.get(path)
    return [path, {
      old: oldFile ? decodeFile(oldFile) : null,
      new: newFile ? decodeFile(newFile) : null,
      encoding: newFile?.encoding ?? oldFile?.encoding ?? "utf8",
    }]
  }))
}

function decodeMaybeJsonString(raw: string | null | undefined): string {
  if (!raw) return ""
  if (raw.startsWith('"')) { try { return JSON.parse(raw) } catch { return raw } }
  return raw
}

function skillPackageFilesFromSkill(skill: Skill | null): SkillPackageFile[] {
  if (!skill) return []
  const files = parseFiles(skill.files)
  if (files.length > 0) return files
  const legacySpecs = decodeMaybeJsonString(skill.specs)
  return [
    ...(legacySpecs ? [textFile("SKILL.md", legacySpecs)] : []),
    ...parseScripts(skill.scripts).map(s => textFile(`scripts/${s.name}`, s.content, s.name.endsWith(".sh") || s.name.endsWith(".py"))),
  ]
}

async function browserFileToPackageFile(file: File, packagePath: string): Promise<SkillPackageFile> {
  const buffer = await file.arrayBuffer()
  const executable = isDirectScriptPath(packagePath)
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/\r\n/g, "\n")
    return textFile(packagePath, content, executable)
  } catch {
    let binary = ""
    const bytes = new Uint8Array(buffer)
    for (const b of bytes) binary += String.fromCharCode(b)
    return {
      path: packagePath,
      content: btoa(binary),
      encoding: "base64",
      size: bytes.byteLength,
      executable,
    }
  }
}

// ── Component ───────────────────────────────────────────────────

export function SkillDetail() {
  const { id } = useParams<{ id: string }>()
  const isCreate = !id
  const navigate = useNavigate()
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [loading, setLoading] = useState(!isCreate)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(isCreate)

  // Skill data
  const [skill, setSkill] = useState<Skill | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [labels, setLabels] = useState<string[]>([])
  const [specs, setSpecs] = useState(DEFAULT_SPEC)
  const [scripts, setScripts] = useState<{ name: string; content: string }[]>([])
  const [extraFiles, setExtraFiles] = useState<SkillPackageFile[]>([])
  const [commitMessage, setCommitMessage] = useState("")

  // Active package file editor
  const [selectedFilePath, setSelectedFilePath] = useState("SKILL.md")
  const [selectedNodePath, setSelectedNodePath] = useState("SKILL.md")
  const [selectedDirPath, setSelectedDirPath] = useState("")
  const [virtualDirs, setVirtualDirs] = useState<string[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  // Versions
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [versionDiffDialog, setVersionDiffDialog] = useState<{ title: string; diff: any } | null>(null)

  // Label input + autocomplete
  const labelInputRef = useRef<HTMLInputElement>(null)
  const [labelQuery, setLabelQuery] = useState("")
  const [allLabels, setAllLabels] = useState<string[]>([])
  const [showLabelSuggestions, setShowLabelSuggestions] = useState(false)

  useEffect(() => {
    api<{ labels: string[] }>("/siclaw/skills/labels")
      .then(r => setAllLabels(r.labels ?? []))
      .catch(() => {})
  }, [])

  // ── Data loading ──────────────────────────────────────────────

  const loadSkill = useCallback(async () => {
    if (isCreate) return
    try {
      const s = await api<Skill>(`/siclaw/skills/${id}`)
      setSkill(s)
      setName(s.name)
      setDescription(s.description || "")
      setLabels(Array.isArray(s.labels) ? s.labels : [])
      // specs may be double-JSON-encoded (JSON.stringify was called on the string before DB insert)
      let specsVal = s.specs || ""
      if (typeof specsVal === "string" && specsVal.startsWith('"')) {
        try { specsVal = JSON.parse(specsVal) } catch { /* keep as-is */ }
      }
      setSpecs(specsVal)
      const loadedFiles = parseFiles(s.files)
      if (loadedFiles.length > 0) {
        const skillFile = loadedFiles.find(f => f.path === "SKILL.md")
        if (skillFile) setSpecs(decodeFile(skillFile))
        setScripts(loadedFiles
          .filter(f => /^scripts\/[^/]+\.(sh|py)$/.test(f.path))
          .map(f => ({ name: f.path.slice("scripts/".length), content: decodeFile(f) })))
        setExtraFiles(loadedFiles.filter(f => f.path !== "SKILL.md" && !/^scripts\/[^/]+\.(sh|py)$/.test(f.path)))
      } else {
        setScripts(parseScripts(s.scripts))
        setExtraFiles([])
      }
      setVirtualDirs([])
      setSelectedFilePath("SKILL.md")
      setSelectedNodePath("SKILL.md")
      setSelectedDirPath("")
      setEditing(false)
    } catch (err: any) { toast.error(err.message) }
    finally { setLoading(false) }
  }, [id, isCreate])

  useEffect(() => { loadSkill() }, [loadSkill])

  useEffect(() => {
    if (isCreate || !id) return
    api<{ data: SkillVersion[] }>(`/siclaw/skills/${id}/versions`)
      .then(r => setVersions(Array.isArray(r.data) ? r.data : []))
      .catch(() => setVersions([]))
  }, [id, skill?.version])

  const disabled = !editing && !isCreate

  const packageFiles = useMemo<SkillPackageFile[]>(() => {
    const scriptFiles = scripts.map(s => textFile(`scripts/${s.name}`, s.content, s.name.endsWith(".sh") || s.name.endsWith(".py")))
    const extras = extraFiles
      .filter(f => f.path !== "SKILL.md" && !/^scripts\/[^/]+\.(sh|py)$/.test(f.path))
      .map(f => ({ ...f, encoding: f.encoding ?? "utf8", size: f.size ?? byteSize(f.content, f.encoding ?? "utf8") }))
    return [textFile("SKILL.md", specs), ...scriptFiles, ...extras].sort((a, b) => a.path.localeCompare(b.path))
  }, [specs, scripts, extraFiles])

  const fileTree = useMemo(() => buildFileTree(packageFiles, virtualDirs), [packageFiles, virtualDirs])
  const selectedFile = packageFiles.find(f => f.path === selectedFilePath) ?? packageFiles.find(f => f.path === "SKILL.md") ?? packageFiles[0]
  const selectedFileContent = selectedFile ? decodeFile(selectedFile) : ""
  const selectedFileReadOnly = disabled || selectedFile?.encoding === "base64"

  useEffect(() => {
    if (packageFiles.length === 0) return
    if (!packageFiles.some(f => f.path === selectedFilePath)) {
      setSelectedFilePath(packageFiles.find(f => f.path === "SKILL.md")?.path ?? packageFiles[0].path)
      setSelectedNodePath(packageFiles.find(f => f.path === "SKILL.md")?.path ?? packageFiles[0].path)
      setSelectedDirPath("")
    }
    setExpandedDirs(prev => {
      const next = new Set(prev)
      for (const dirPath of virtualDirs) {
        const parts = dirPath.split("/")
        let dir = ""
        for (const part of parts) {
          dir = dir ? `${dir}/${part}` : part
          next.add(dir)
        }
      }
      for (const file of packageFiles) {
        const parts = file.path.split("/")
        let dir = ""
        for (let i = 0; i < parts.length - 1; i++) {
          dir = dir ? `${dir}/${parts[i]}` : parts[i]
          next.add(dir)
        }
      }
      return next
    })
  }, [packageFiles, selectedFilePath, virtualDirs])

  // ── Dirty detection ───────────────────────────────────────────

  const isDirty = useMemo(() => {
    if (!skill) return isCreate && name.trim().length > 0
    const originalFiles = parseFiles(skill.files)
    return name !== skill.name ||
      description !== (skill.description || "") ||
      specs !== (typeof skill.specs === "string" ? skill.specs : "") ||
      JSON.stringify(scripts) !== JSON.stringify(parseScripts(skill.scripts)) ||
      (originalFiles.length > 0 ? JSON.stringify(packageFiles) !== JSON.stringify(originalFiles) : extraFiles.length > 0) ||
      JSON.stringify(labels) !== JSON.stringify(Array.isArray(skill.labels) ? skill.labels : [])
  }, [skill, name, description, specs, scripts, extraFiles, packageFiles, labels, isCreate])

  // ── Actions ───────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const created = await api<Skill>("/siclaw/skills", {
        method: "POST", body: { name: name.trim(), description: description.trim(), labels, specs, scripts, files: packageFiles },
      })
      toast.success("Skill created")
      navigate(`/skills/${created.id}`, { replace: true })
    } catch (err: any) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  const [showSaveDiffDialog, setShowSaveDiffDialog] = useState(false)
  const [saveDiff, setSaveDiff] = useState<any>(null)

  const buildSaveDiff = () => ({
    files_diff: filesDiffPayload(skillPackageFilesFromSkill(skill), packageFiles),
  })

  const handleSaveClick = () => {
    if (!skill || !isDirty) return
    setSaveDiff(buildSaveDiff())
    setShowSaveDiffDialog(true)
  }

  const performSave = async () => {
    if (!skill) return
    setSaving(true)
    try {
      const updated = await api<Skill>(`/siclaw/skills/${id}`, {
        method: "PUT", body: { name: name.trim(), description: description.trim(), labels, specs, scripts, files: packageFiles, commit_message: commitMessage || undefined },
      })
      // If the backend created an overlay (response has overlay_of set), redirect to the new overlay
      if (updated.overlay_of) {
        toast.success("Overlay created from builtin skill")
        navigate(`/skills/${updated.id}`)
        return
      }
      setSkill(updated)
      setEditing(false)
      setCommitMessage("")
      setShowSaveDiffDialog(false)
      toast.success("Saved")
    } catch (err: any) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  // Submit with diff preview
  const [showSubmitDialog, setShowSubmitDialog] = useState(false)
  const [submitDiff, setSubmitDiff] = useState<any>(null)
  const [submitLoading, setSubmitLoading] = useState(false)

  const handleSubmitClick = async () => {
    setSubmitLoading(true)
    try {
      const versionsRes = await api<{ data: SkillVersion[] }>(`/siclaw/skills/${id}/versions`)
      const approvedVersions = (versionsRes.data || []).filter(v => v.is_approved)
      const lastApproved = approvedVersions.length > 0 ? approvedVersions[0] : null

      // Decode baseline — may be double-encoded from old DB data
      let baselineSpecs = ""
      let baselineScripts: { name: string; content: string }[] = []
      let baselineFiles: SkillPackageFile[] = []
      if (lastApproved) {
        const vDetail = await api<SkillVersion>(`/siclaw/skills/${id}/versions/${lastApproved.version}`)
        baselineSpecs = vDetail.specs || ""
        if (baselineSpecs.startsWith('"')) { try { baselineSpecs = JSON.parse(baselineSpecs) } catch {} }
        try {
          const raw = vDetail.scripts || "[]"
          baselineScripts = typeof raw === "string" ? JSON.parse(raw) : raw
        } catch { baselineScripts = [] }
        baselineFiles = parseFiles(vDetail.files)
        if (baselineFiles.length === 0) {
          baselineFiles = [
            ...(baselineSpecs ? [textFile("SKILL.md", baselineSpecs)] : []),
            ...baselineScripts.map(s => textFile(`scripts/${s.name}`, s.content, s.name.endsWith(".sh") || s.name.endsWith(".py"))),
          ]
        }
      }

      setSubmitDiff({
        specs_diff: { old: baselineSpecs || null, new: specs },
        scripts_diff: { old: JSON.stringify(baselineScripts), new: JSON.stringify(scripts) },
        files_diff: filesDiffPayload(baselineFiles, packageFiles),
      })
      setShowSubmitDialog(true)
    } catch {
      setSubmitDiff(null)
      setShowSubmitDialog(true)
    } finally {
      setSubmitLoading(false)
    }
  }

  const [submitConfirming, setSubmitConfirming] = useState(false)

  const handleSubmitConfirm = async () => {
    setSubmitConfirming(true)
    try {
      await api(`/siclaw/skills/${id}/submit`, { method: "POST", body: { comment: commitMessage || undefined } })
      setShowSubmitDialog(false)
      setCommitMessage("")
      toast.success("Submitted for review")
      await loadSkill()
    } catch (err: any) {
      toast.error(err.message)
      setShowSubmitDialog(false)
    } finally {
      setSubmitConfirming(false)
    }
  }

  const handleWithdraw = async () => {
    try {
      await api(`/siclaw/skills/${id}/withdraw`, { method: "POST" })
      await loadSkill()
      toast.success("Withdrawn")
    } catch (err: any) { toast.error(err.message) }
  }

  const handleRollback = async (version: number) => {
    if (!(await confirmDialog({ title: "Rollback", message: `Roll back to v${version}? Status will become draft.`, confirmLabel: "Rollback" }))) return
    try {
      await api(`/siclaw/skills/${id}/rollback`, { method: "POST", body: { version } })
      await loadSkill()
      setEditing(false)
      toast.success(`Rolled back to v${version}`)
    } catch (err: any) { toast.error(err.message) }
  }

  // ── Package tree management ───────────────────────────────────

  const [showNameDialog, setShowNameDialog] = useState(false)
  const [newEntryKind, setNewEntryKind] = useState<NewPackageEntryKind>("file")
  const [newFilePath, setNewFilePath] = useState("")
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renamePath, setRenamePath] = useState("")
  const [showPackageMenu, setShowPackageMenu] = useState(false)
  const fileInputRef2 = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)

  const defaultPathForKind = (kind: NewPackageEntryKind) => {
    const base = selectedDirPath
    return kind === "folder"
      ? (base ? `${base}/new-folder` : "new-folder")
      : (base ? `${base}/new-file.md` : "new-file.md")
  }

  const newEntryTitle = (kind: NewPackageEntryKind) => {
    return kind === "folder" ? "Folder" : "File"
  }

  const selectPackageFile = (path: string) => {
    const normalized = normalizePackagePath(path)
    setSelectedFilePath(normalized)
    setSelectedNodePath(normalized)
    setSelectedDirPath(fileDirectory(normalized))
  }

  const selectPackageDirectory = (path: string) => {
    const normalized = normalizePackagePath(path)
    setSelectedNodePath(normalized)
    setSelectedDirPath(normalized)
  }

  const initiateAddEntry = (kind: NewPackageEntryKind, baseDir = selectedDirPath) => {
    setNewEntryKind(kind)
    setNewFilePath(kind === "folder"
      ? (baseDir ? `${baseDir}/new-folder` : "new-folder")
      : (baseDir ? `${baseDir}/new-file.md` : "new-file.md"))
    setShowNameDialog(true)
  }

  const normalizeUiPackageFile = (file: SkillPackageFile): SkillPackageFile => ({
    ...file,
    path: normalizePackagePath(file.path),
    encoding: file.encoding ?? "utf8",
    size: file.size ?? byteSize(file.content, file.encoding ?? "utf8"),
  })

  const setPackageFilesFromUi = (files: SkillPackageFile[], nextSelectedPath = "SKILL.md") => {
    const normalized = files.map(normalizeUiPackageFile).sort((a, b) => a.path.localeCompare(b.path))
    const skillFile = normalized.find(f => f.path === "SKILL.md")
    if (skillFile) setSpecs(decodeFile(skillFile))
    setScripts(normalized
      .filter(f => isDirectScriptPath(f.path))
      .map(f => ({ name: f.path.slice("scripts/".length), content: decodeFile(f) })))
    setExtraFiles(normalized.filter(f => f.path !== "SKILL.md" && !isDirectScriptPath(f.path)))
    setSelectedFilePath(nextSelectedPath)
    setSelectedNodePath(nextSelectedPath)
    setSelectedDirPath(fileDirectory(nextSelectedPath))
  }

  const packageDirectoryExists = (path: string) => {
    const normalized = normalizePackagePath(path)
    return packageFiles.some(f => f.path.startsWith(`${normalized}/`)) ||
      virtualDirs.some(d => d === normalized || d.startsWith(`${normalized}/`))
  }

  const addPackageTextFile = (path: string, content: string, executable = false) => {
    const normalized = normalizePackagePath(path)
    if (normalized === "SKILL.md") {
      setSpecs(content)
      selectPackageFile("SKILL.md")
      return true
    }
    if (isDirectScriptPath(normalized)) {
      const scriptName = normalized.slice("scripts/".length)
      if (scripts.some(s => s.name === scriptName)) return false
      setScripts(prev => [...prev, { name: scriptName, content }])
      selectPackageFile(normalized)
      return true
    }
    if (extraFiles.some(f => f.path === normalized)) return false
    setExtraFiles(prev => [...prev, textFile(normalized, content, executable)])
    selectPackageFile(normalized)
    return true
  }

  const confirmAddFile = () => {
    const normalized = normalizePackagePath(newFilePath)
    if (newEntryKind === "folder") {
      const dirError = validateDirectoryPath(normalized)
      if (dirError) {
        toast.error(dirError)
        return
      }
      if (packageFiles.some(f => f.path === normalized || f.path.startsWith(`${normalized}/`)) ||
          virtualDirs.some(d => d === normalized || d.startsWith(`${normalized}/`))) {
        toast.error(`Directory "${normalized}" already exists`)
        return
      }
      setVirtualDirs(prev => [...prev, normalized].sort())
      setExpandedDirs(prev => {
        const next = new Set(prev)
        const parts = normalized.split("/")
        let dir = ""
        for (const part of parts) {
          dir = dir ? `${dir}/${part}` : part
          next.add(dir)
        }
        return next
      })
      selectPackageDirectory(normalized)
      setShowNameDialog(false)
      setNewFilePath("")
      return
    }

    const pathError = validatePackagePath(normalized)
    if (pathError) {
      toast.error(pathError)
      return
    }
    if (packageFiles.some(f => f.path === normalized)) {
      toast.error(`File "${normalized}" already exists`)
      return
    }
    if (packageDirectoryExists(normalized)) {
      toast.error(`Directory "${normalized}" already exists`)
      return
    }
    const template = normalized.endsWith(".py")
      ? '#!/usr/bin/env python3\n\n'
      : normalized.endsWith(".sh")
        ? '#!/usr/bin/env bash\nset -euo pipefail\n\n'
        : normalized.endsWith(".json")
          ? "{\n  \n}\n"
          : normalized.endsWith(".md")
            ? "# New File\n\n"
            : ""
    const added = addPackageTextFile(normalized, template, isDirectScriptPath(normalized))
    if (!added) {
      toast.error(`File "${normalized}" already exists`)
      return
    }
    setShowNameDialog(false)
    setNewFilePath("")
  }

  const activeUploadDir = () => selectedDirPath

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    if (picked.length === 0) return
    try {
      const baseDir = activeUploadDir()
      const nextScripts = [...scripts]
      const nextExtras = [...extraFiles]
      const existing = new Set(packageFiles.map(f => f.path))
      let firstAdded: string | null = null
      for (const file of picked) {
        const normalized = normalizePackagePath(baseDir ? `${baseDir}/${file.name}` : file.name)
        const pathError = validatePackagePath(normalized)
        if (pathError) throw new Error(`${normalized}: ${pathError}`)
        if (existing.has(normalized)) throw new Error(`File "${normalized}" already exists`)
        if (packageDirectoryExists(normalized)) throw new Error(`Directory "${normalized}" already exists`)
        const packageFile = await browserFileToPackageFile(file, normalized)
        existing.add(normalized)
        if (!firstAdded) firstAdded = normalized
        if (isDirectScriptPath(normalized)) {
          nextScripts.push({ name: normalized.slice("scripts/".length), content: decodeFile(packageFile) })
        } else {
          nextExtras.push(packageFile)
        }
      }
      setScripts(nextScripts)
      setExtraFiles(nextExtras)
      if (firstAdded) selectPackageFile(firstAdded)
      toast.success(`${picked.length} file${picked.length > 1 ? "s" : ""} uploaded`)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      e.target.value = ""
    }
  }

  const applyPackage = (files: SkillPackageFile[], parsedName?: string, parsedDescription?: string) => {
    const skillFile = files.find(f => f.path === "SKILL.md")
    if (!skillFile) {
      toast.error("Package must include SKILL.md")
      return
    }
    const nextSpecs = decodeFile(skillFile)
    setSpecs(nextSpecs)
    const fmMatch = nextSpecs.match(/^---\n([\s\S]*?)\n---/)
    const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m)
    const descMatch = fmMatch?.[1]?.match(/^description:\s*(.+)$/m)
    setName(parsedName || nameMatch?.[1]?.trim() || name)
    setDescription(parsedDescription || descMatch?.[1]?.trim() || description)
    setScripts(files
      .filter(f => /^scripts\/[^/]+\.(sh|py)$/.test(f.path))
      .map(f => ({ name: f.path.slice("scripts/".length), content: decodeFile(f) })))
    setExtraFiles(files.filter(f => f.path !== "SKILL.md" && !/^scripts\/[^/]+\.(sh|py)$/.test(f.path)))
    setVirtualDirs([])
    selectPackageFile("SKILL.md")
  }

  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    if (picked.length === 0) return
    try {
      const uploadable = picked
        .map(file => ({
          file,
          path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        }))
        .filter(({ path }) => !shouldSkipFolderUploadPath(path))
      if (uploadable.length === 0) {
        toast.error("No supported package files selected")
        return
      }
      const files = await Promise.all(uploadable.map(({ file, path }) => browserFileToPackageFile(file, path)))
      const preview = await api<{ skill: { name: string; description: string; files: SkillPackageFile[] } }>("/siclaw/skills/package/preview", {
        method: "POST",
        body: { files },
      })
      applyPackage(preview.skill.files, preview.skill.name, preview.skill.description)
      toast.success("Package loaded")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      e.target.value = ""
    }
  }

  const handleArchiveUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const preview = await apiRaw<{ skill: { name: string; description: string; files: SkillPackageFile[] } }>("/siclaw/skills/package/preview", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      })
      applyPackage(preview.skill.files, preview.skill.name, preview.skill.description)
      toast.success("Archive loaded")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      e.target.value = ""
    }
  }

  const removeScript = (i: number) => {
    setScripts(scripts.filter((_, idx) => idx !== i))
    selectPackageFile("SKILL.md")
  }

  const updateScriptContent = (i: number, content: string) => {
    const next = [...scripts]
    next[i] = { ...next[i], content }
    setScripts(next)
  }

  const removeExtraFile = (i: number) => {
    setExtraFiles(extraFiles.filter((_, idx) => idx !== i))
    selectPackageFile("SKILL.md")
  }

  const updateExtraFileContent = (i: number, content: string) => {
    const next = [...extraFiles]
    next[i] = { ...next[i], content, encoding: "utf8", size: byteSize(content) }
    setExtraFiles(next)
  }

  const updateSkillFileContent = (content: string) => {
    setSpecs(content)
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
    const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m)
    if (nameMatch) setName(nameMatch[1].trim())
    const descMatch = fmMatch?.[1]?.match(/^description:\s*(.+)$/m)
    if (descMatch) setDescription(descMatch[1].trim())
  }

  const updatePackageFileContent = (path: string, content: string) => {
    if (path === "SKILL.md") {
      updateSkillFileContent(content)
      return
    }
    if (isDirectScriptPath(path)) {
      const scriptName = path.slice("scripts/".length)
      const idx = scripts.findIndex(s => s.name === scriptName)
      if (idx >= 0) updateScriptContent(idx, content)
      return
    }
    const idx = extraFiles.findIndex(f => f.path === path)
    if (idx >= 0) updateExtraFileContent(idx, content)
  }

  const removePackageFile = (path: string) => {
    if (path === "SKILL.md") {
      toast.error("SKILL.md is required")
      return
    }
    if (isDirectScriptPath(path)) {
      const scriptName = path.slice("scripts/".length)
      const idx = scripts.findIndex(s => s.name === scriptName)
      if (idx >= 0) removeScript(idx)
      return
    }
    const idx = extraFiles.findIndex(f => f.path === path)
    if (idx >= 0) removeExtraFile(idx)
  }

  const removePackageDirectory = async (path: string) => {
    const normalized = normalizePackagePath(path)
    const containedFiles = packageFiles.filter(f => f.path.startsWith(`${normalized}/`))
    if (containedFiles.length > 0) {
      const ok = await confirmDialog({
        title: "Delete Folder",
        message: `Delete "${normalized}" and ${containedFiles.length} file${containedFiles.length > 1 ? "s" : ""}?`,
        confirmLabel: "Delete",
        destructive: true,
      })
      if (!ok) return
    }
    const remainingFiles = packageFiles.filter(f => !f.path.startsWith(`${normalized}/`))
    setPackageFilesFromUi(remainingFiles, "SKILL.md")
    setVirtualDirs(prev => prev.filter(d => d !== normalized && !d.startsWith(`${normalized}/`)))
    selectPackageFile("SKILL.md")
  }

  const startRename = (target: RenameTarget) => {
    if (target.type === "file" && target.path === "SKILL.md") {
      toast.error("SKILL.md filename is required")
      return
    }
    setRenameTarget(target)
    setRenamePath(target.path)
  }

  const confirmRename = () => {
    if (!renameTarget) return
    const nextPath = normalizePackagePath(renamePath)

    if (renameTarget.type === "dir") {
      const oldPath = normalizePackagePath(renameTarget.path)
      const dirError = validateDirectoryPath(nextPath)
      if (dirError) { toast.error(dirError); return }
      if (nextPath === oldPath) { setRenameTarget(null); return }
      if (nextPath.startsWith(`${oldPath}/`)) {
        toast.error("Cannot move a folder inside itself")
        return
      }
      if (packageFiles.some(f => f.path === nextPath || (f.path.startsWith(`${nextPath}/`) && !f.path.startsWith(`${oldPath}/`))) ||
          virtualDirs.some(d => d === nextPath || (d.startsWith(`${nextPath}/`) && !d.startsWith(`${oldPath}/`)))) {
        toast.error(`Directory "${nextPath}" already exists`)
        return
      }
      const movedFiles = packageFiles.map(f => f.path.startsWith(`${oldPath}/`)
        ? { ...f, path: `${nextPath}/${f.path.slice(oldPath.length + 1)}` }
        : f)
      const selectedAfterMove = selectedFilePath.startsWith(`${oldPath}/`)
        ? `${nextPath}/${selectedFilePath.slice(oldPath.length + 1)}`
        : selectedFilePath
      setPackageFilesFromUi(movedFiles, selectedAfterMove)
      setVirtualDirs(prev => prev.map(d => d === oldPath || d.startsWith(`${oldPath}/`)
        ? `${nextPath}${d.slice(oldPath.length)}`
        : d).sort())
      setExpandedDirs(prev => {
        const next = new Set(prev)
        next.delete(oldPath)
        next.add(nextPath)
        return next
      })
      setSelectedDirPath(nextPath)
      setSelectedNodePath(nextPath)
      setRenameTarget(null)
      return
    }

    const oldPath = normalizePackagePath(renameTarget.path)
    const pathError = validatePackagePath(nextPath)
    if (pathError) { toast.error(pathError); return }
    if (nextPath === oldPath) { setRenameTarget(null); return }
    if (packageFiles.some(f => f.path === nextPath)) {
      toast.error(`File "${nextPath}" already exists`)
      return
    }
    if (packageDirectoryExists(nextPath)) {
      toast.error(`Directory "${nextPath}" already exists`)
      return
    }
    const movedFiles = packageFiles.map(f => f.path === oldPath ? { ...f, path: nextPath } : f)
    setPackageFilesFromUi(movedFiles, nextPath)
    setRenameTarget(null)
  }

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // ── Label management ──────────────────────────────────────────

  const addLabel = (val: string) => {
    const trimmed = val.trim()
    if (trimmed && !labels.includes(trimmed)) setLabels([...labels, trimmed])
    setLabelQuery("")
    // Keep dropdown open so user can continue adding labels
    labelInputRef.current?.focus()
  }

  const handleLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      addLabel(labelQuery)
    }
    if (e.key === "Escape") setShowLabelSuggestions(false)
  }

  const labelSuggestions = useMemo(() => {
    if (!labelQuery.trim()) return allLabels.filter(l => !labels.includes(l))
    const q = labelQuery.toLowerCase()
    return allLabels.filter(l => l.toLowerCase().includes(q) && !labels.includes(l))
  }, [labelQuery, allLabels, labels])

  const removeLabel = (lbl: string) => setLabels(labels.filter(l => l !== lbl))

  /** Sync header name → frontmatter `name:` field in specs */
  const syncNameToFrontmatter = (newName: string) => {
    setSpecs(prev => {
      const fmMatch = prev.match(/^(---\n)([\s\S]*?)(\n---)/)
      if (!fmMatch) return prev
      const updated = fmMatch[2].replace(/^name:\s*.+$/m, `name: ${newName}`)
      return `${fmMatch[1]}${updated}${fmMatch[3]}${prev.slice(fmMatch[0].length)}`
    })
  }

  const renderFileTree = (nodes: FileTreeNode[], depth = 0): ReactNode => nodes.map(node => {
    if (node.type === "dir") {
      const expanded = expandedDirs.has(node.path)
      const active = selectedNodePath === node.path
      return (
        <div key={node.path}
          className={`group rounded ${active ? "bg-primary/10 text-foreground ring-1 ring-primary/20" : ""}`}
        >
          <div className={`flex items-center rounded ${active ? "text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}>
            <button
              type="button"
              onClick={() => {
                setSelectedNodePath(node.path)
                setSelectedDirPath(node.path)
                toggleDir(node.path)
              }}
              className="min-w-0 flex-1 h-7 flex items-center gap-1.5 rounded px-1.5 text-left text-[12px] font-mono"
              style={{ paddingLeft: `${depth * 14 + 6}px` }}
              title={node.path}
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
              <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className="truncate">{node.name}</span>
              {node.virtual && node.children.length === 0 && <span className="ml-auto text-[10px] text-muted-foreground/50">empty</span>}
            </button>
            {(editing || isCreate) && (
              <div className="mr-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); selectPackageDirectory(node.path); initiateAddEntry("file", node.path) }}
                  title="New file in this folder"
                  className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                >
                  <FilePlus2 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); selectPackageDirectory(node.path); initiateAddEntry("folder", node.path) }}
                  title="New folder in this folder"
                  className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                >
                  <FolderPlus className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); startRename({ type: "dir", path: node.path }) }}
                  title="Rename folder"
                  className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); void removePackageDirectory(node.path) }}
                  title="Delete folder"
                  className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
          {expanded && renderFileTree(node.children, depth + 1)}
        </div>
      )
    }

    const active = selectedNodePath === node.path
    const size = node.file ? (node.file.size ?? byteSize(node.file.content, node.file.encoding ?? "utf8")) : 0
    return (
      <div key={node.path}
        className={`group flex items-center gap-1 rounded ${
          active ? "bg-primary/10 text-foreground ring-1 ring-primary/20" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
        }`}
        style={{ marginLeft: `${depth * 14}px` }}
      >
        <button
          type="button"
          onClick={() => {
            setSelectedFilePath(node.path)
            setSelectedNodePath(node.path)
            setSelectedDirPath(fileDirectory(node.path))
          }}
          className="min-w-0 flex-1 h-8 flex items-center gap-2 rounded px-1.5 text-left"
          title={node.path}
        >
          <span className="w-3.5 shrink-0" />
          {packageFileIcon(node.path, "h-3.5 w-3.5 shrink-0")}
          <span className="truncate text-[12px] font-mono">{node.name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">{size}B</span>
        </button>
        {(editing || isCreate) && node.path !== "SKILL.md" && (
          <div className="mr-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={e => { e.stopPropagation(); startRename({ type: "file", path: node.path }) }}
              title="Rename file"
              className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); removePackageFile(node.path) }}
              title="Delete file"
              className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    )
  })

  // ── Render ────────────────────────────────────────────────────

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  const st = STATUS_STYLES[skill?.status || "draft"] || STATUS_STYLES.draft
  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/skills")} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
          </button>
          {isCreate ? (
            <input value={name} onChange={e => { setName(e.target.value); syncNameToFrontmatter(e.target.value) }} placeholder="Skill name..."
              className="text-lg font-semibold bg-transparent border-none outline-none w-64" autoFocus />
          ) : editing ? (
            <div className="flex items-center gap-2">
              <input value={name} onChange={e => { setName(e.target.value); syncNameToFrontmatter(e.target.value) }}
                className="text-lg font-semibold bg-transparent border-none outline-none w-64 hover:bg-secondary/30 rounded px-1 -ml-1" />
              {isDirty && <span className="text-amber-400 text-lg leading-none" title="Unsaved changes">●</span>}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">{skill?.name}</h1>
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${st.bg} ${st.text}`}>{st.label}</span>
              <span className="text-[10px] text-muted-foreground">v{skill?.version}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Version history toggle */}
          {!isCreate && (
            <button onClick={() => setShowHistory(!showHistory)} title="Version History"
              className={`p-2 rounded-md transition-colors ${showHistory ? "text-blue-400 bg-blue-500/10" : "text-muted-foreground hover:bg-secondary"}`}>
              <History className="h-4 w-4" />
            </button>
          )}

          <div className="h-5 w-px bg-border mx-1" />

          {/* Context actions */}
          {isCreate && (
            <button onClick={handleCreate} disabled={saving || !name.trim()} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Create
            </button>
          )}
          {!isCreate && !editing && (skill?.status === "draft" || skill?.status === "installed") && (
            <>
              <button onClick={() => setEditing(true)} className="h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">Edit</button>
              {skill?.status === "draft" && (
                <button onClick={handleSubmitClick} disabled={submitLoading}
                  className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                  {submitLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Submit for Review
                </button>
              )}
            </>
          )}
          {!isCreate && editing && (
            <>
              <button onClick={() => { setEditing(false); loadSkill() }} className="h-8 px-3 text-sm rounded-md border border-border text-muted-foreground">Discard</button>
              <button onClick={handleSaveClick} disabled={saving || !isDirty} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
              </button>
            </>
          )}
          {!isCreate && skill?.status === "pending_review" && (
            <button onClick={handleWithdraw} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border hover:bg-secondary">
              <Undo2 className="h-3.5 w-3.5" /> Withdraw
            </button>
          )}
        </div>
      </header>

      {/* ── Status banners ──────────────────────────────────── */}
      {skill?.status === "pending_review" && (
        <div className="px-6 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 shrink-0">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          <span className="text-[12px] text-amber-300">Pending review — editing is locked until approved or withdrawn.</span>
        </div>
      )}
      {!!skill?.is_builtin && (
        <div className="mx-6 mt-4 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm text-purple-300 shrink-0">
          This is a builtin skill. Editing will create a personal overlay — the original remains unchanged.
        </div>
      )}
      {skill?.overlay_of && (
        <div className="mx-6 mt-4 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-sm text-cyan-300 shrink-0">
          This is an overlay of a builtin skill. Deleting it will revert to the original builtin version.
        </div>
      )}

      {/* ── Main content: split layout ──────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* LEFT PANEL: metadata + specs */}
        <div className={`flex flex-col border-r border-border ${packageFiles.length > 1 || editing || isCreate ? "w-[65%]" : "w-full"}`}>
          <div className="flex-1 overflow-y-auto flex flex-col">
            {/* Metadata bar: labels + description (compact, always visible) */}
            <div className="px-6 py-3 border-b border-border/50 space-y-2.5 shrink-0">
              {/* Labels row */}
              <div className="flex flex-wrap gap-1.5 items-center">
                {labels.map(lbl => (
                  <span key={lbl} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border border-border bg-secondary text-secondary-foreground">
                    {lbl}
                    {(editing || isCreate) && (
                      <button onClick={() => removeLabel(lbl)} className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-foreground">
                        <X className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </span>
                ))}
                {(editing || isCreate) && (
                  <div className="relative">
                    <input ref={labelInputRef} type="text" placeholder="+ Add label"
                      value={labelQuery}
                      onChange={e => { setLabelQuery(e.target.value); setShowLabelSuggestions(true) }}
                      onFocus={() => setShowLabelSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowLabelSuggestions(false), 150)}
                      onKeyDown={handleLabelKeyDown}
                      className="text-[11px] px-1.5 py-0.5 border border-transparent rounded bg-transparent text-muted-foreground outline-none w-24 focus:border-border focus:bg-background placeholder:text-muted-foreground/40" />
                    {showLabelSuggestions && labelSuggestions.length > 0 && (
                      <div className="absolute left-0 top-full mt-1 w-40 max-h-32 overflow-y-auto bg-card border border-border rounded-md shadow-lg z-20 py-0.5">
                        {labelSuggestions.slice(0, 10).map(s => (
                          <button key={s} onMouseDown={e => { e.preventDefault(); addLabel(s) }}
                            className="w-full text-left px-2.5 py-1 text-[11px] hover:bg-secondary/50 transition-colors truncate">
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {labels.length === 0 && !editing && !isCreate && (
                  <span className="text-[11px] text-muted-foreground/40">No labels</span>
                )}
              </div>

              {/* Commit message: only in edit mode (not create) */}
              {editing && !isCreate && (
                <input value={commitMessage} onChange={e => setCommitMessage(e.target.value)} placeholder="Commit message (optional)..."
                  className="w-full h-7 px-2 text-[12px] rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
              )}
            </div>

            {/* Selected package file editor */}
            <div className="flex-1 flex flex-col min-h-0">
              <div className="h-10 px-5 border-b border-border/50 flex items-center justify-between bg-background/60 shrink-0">
                <div className="min-w-0 flex items-center gap-2">
                  {selectedFile ? packageFileIcon(selectedFile.path, "h-4 w-4 shrink-0") : <FileCode className="h-4 w-4 text-muted-foreground" />}
                  <span className="text-[12px] font-mono font-medium truncate">{selectedFile?.path ?? "No file selected"}</span>
                  {selectedFile && (
                    <span className="text-[10px] text-muted-foreground">
                      {packageFileKind(selectedFile.path)} · {selectedFile.size ?? byteSize(selectedFile.content, selectedFile.encoding ?? "utf8")}B
                    </span>
                  )}
                </div>
                {selectedFile?.path === "SKILL.md" && (
                  <span className="text-[10px] text-muted-foreground">package entrypoint</span>
                )}
              </div>
              <div className="flex-1 overflow-auto min-h-0">
                {!selectedFile ? (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No file selected</div>
                ) : selectedFile.encoding === "base64" ? (
                  <div className="h-full flex flex-col items-center justify-center text-sm text-muted-foreground">
                    <FileCode className="h-8 w-8 mb-3 text-muted-foreground/40" />
                    <p>Binary file preview only</p>
                    <p className="mt-1 text-[11px] text-muted-foreground/50">{selectedFile.path}</p>
                  </div>
                ) : (
                  <Editor
                    value={selectedFileContent}
                    onValueChange={(code: string) => {
                      if (selectedFileReadOnly || !selectedFile) return
                      updatePackageFileContent(selectedFile.path, code)
                    }}
                    highlight={(code: string) => {
                      if (!selectedFile) return code
                      const lang = prismLanguageForPath(selectedFile.path)
                      return lang.grammar ? Prism.highlight(code, lang.grammar, lang.language) : code
                    }}
                    readOnly={selectedFileReadOnly}
                    padding={20}
                    style={{
                      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", monospace',
                      fontSize: 12,
                      lineHeight: 1.65,
                      minHeight: "100%",
                      backgroundColor: disabled ? "transparent" : "hsl(var(--background))",
                      color: "hsl(var(--foreground))",
                    }}
                    textareaClassName="outline-none"
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: skill package tree */}
        {(packageFiles.length > 1 || editing || isCreate) && (
          <div className="flex-1 flex flex-col min-w-0 bg-background">
            <div className="px-4 py-3 border-b border-border shrink-0 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  Package ({packageFiles.length})
                </span>
                {(editing || isCreate) && (
                  <div className="flex items-center gap-1">
                    <input
                      type="file"
                      ref={folderInputRef}
                      className="hidden"
                      multiple
                      onChange={handleFolderUpload}
                      {...({ webkitdirectory: "", directory: "" } as any)}
                    />
                    <input type="file" ref={archiveInputRef} className="hidden" accept=".zip,.tar,.tgz,.tar.gz,.gz" onChange={handleArchiveUpload} />
                    <input type="file" ref={fileInputRef2} className="hidden" multiple onChange={handleFileUpload} />
                    <button onClick={() => initiateAddEntry("file")} title={`New file in ${selectedDirPath || "package root"}`} aria-label={`New file in ${selectedDirPath || "package root"}`}
                      className="h-7 w-7 rounded bg-secondary hover:bg-secondary/80 text-foreground inline-flex items-center justify-center">
                      <FilePlus2 className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => initiateAddEntry("folder")} title={`New folder in ${selectedDirPath || "package root"}`} aria-label={`New folder in ${selectedDirPath || "package root"}`}
                      className="h-7 w-7 rounded bg-secondary hover:bg-secondary/80 text-foreground inline-flex items-center justify-center">
                      <FolderPlus className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => fileInputRef2.current?.click()} title={`Add files into ${activeUploadDir() || "package root"}`} aria-label={`Add files into ${activeUploadDir() || "package root"}`}
                      className="h-7 w-7 rounded border border-border/60 hover:bg-secondary text-muted-foreground hover:text-foreground inline-flex items-center justify-center">
                      <FileUp className="h-3.5 w-3.5" />
                    </button>
                    <div className="relative">
                      <button onClick={() => setShowPackageMenu(!showPackageMenu)} title="More package actions" aria-label="More package actions"
                        className="h-7 w-7 rounded border border-border/60 hover:bg-secondary text-muted-foreground hover:text-foreground inline-flex items-center justify-center">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                      {showPackageMenu && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setShowPackageMenu(false)} />
                          <div className="absolute right-0 top-full mt-1 w-52 bg-card border border-border rounded-lg shadow-lg z-20 py-1">
                            <button
                              type="button"
                              onClick={() => { setShowPackageMenu(false); folderInputRef.current?.click() }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left hover:bg-secondary/50 transition-colors"
                            >
                              <FolderUp className="h-3.5 w-3.5 text-muted-foreground" />
                              Replace from Folder
                            </button>
                            <button
                              type="button"
                              onClick={() => { setShowPackageMenu(false); archiveInputRef.current?.click() }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left hover:bg-secondary/50 transition-colors"
                            >
                              <Archive className="h-3.5 w-3.5 text-muted-foreground" />
                              Replace from Archive
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {packageFiles.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center">
                  <div className="p-3 bg-secondary/30 rounded-full mb-3">
                    <Code2 className="h-6 w-6 text-muted-foreground/30" />
                  </div>
                  <p className="text-[12px] text-muted-foreground/50">No package files</p>
                </div>
              ) : (
                <div className="space-y-0.5">{renderFileTree(fileTree)}</div>
              )}
            </div>
          </div>
        )}

        {/* VERSION HISTORY PANEL (slide-in) */}
        {showHistory && (
          <div className="w-[280px] border-l border-border flex flex-col shrink-0">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">History</span>
              <button onClick={() => setShowHistory(false)} className="p-1 rounded hover:bg-secondary text-muted-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {versions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50 text-center py-8">No versions yet</p>
              ) : versions.map(v => (
                <div key={v.id} className="p-2.5 rounded-md border border-border/50 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-mono font-medium">v{v.version}</span>
                    {v.is_approved ? (
                      <span className="px-1 py-0.5 rounded text-[9px] bg-green-500/20 text-green-400">approved</span>
                    ) : (
                      <span className="px-1 py-0.5 rounded text-[9px] bg-secondary text-muted-foreground">draft</span>
                    )}
                    {v.commit_message?.startsWith("Rollback to") && (
                      <span className="px-1 py-0.5 rounded text-[9px] bg-orange-500/20 text-orange-400">rollback</span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{v.commit_message || "No message"}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muted-foreground/60">{new Date(v.created_at).toLocaleDateString()}</span>
                    <div className="flex items-center gap-0.5">
                      {!!v.diff && (
                        <button onClick={() => setVersionDiffDialog({ title: `v${v.version} changes`, diff: v.diff })} title="View diff"
                          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <FileText className="h-3 w-3" />
                        </button>
                      )}
                      {skill?.status !== "pending_review" && (
                        <button onClick={() => handleRollback(v.version)} title="Rollback"
                          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── New Package Entry Dialog ──────────────────────────── */}
      {showNameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowNameDialog(false)} />
          <div className="relative bg-card rounded-xl shadow-xl border border-border p-5 w-80 space-y-4">
            <div>
              <h3 className="text-sm font-semibold">New {newEntryTitle(newEntryKind)}</h3>
            </div>
            <input autoFocus type="text" value={newFilePath}
              onChange={e => setNewFilePath(e.target.value)}
              onKeyDown={e => e.key === "Enter" && confirmAddFile()}
              placeholder={defaultPathForKind(newEntryKind)}
              className="w-full h-9 px-3 text-sm rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowNameDialog(false)}
                className="h-8 px-3 text-[12px] text-muted-foreground hover:text-foreground rounded-md">Cancel</button>
              <button onClick={confirmAddFile} disabled={!newFilePath.trim()}
                className="h-8 px-3 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50">Create {newEntryTitle(newEntryKind)}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rename Package Entry Dialog ───────────────────────── */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setRenameTarget(null)} />
          <div className="relative bg-card rounded-xl shadow-xl border border-border p-5 w-96 space-y-4">
            <div>
              <h3 className="text-sm font-semibold">Rename {renameTarget.type === "dir" ? "Folder" : "File"}</h3>
            </div>
            <input autoFocus type="text" value={renamePath}
              onChange={e => setRenamePath(e.target.value)}
              onKeyDown={e => e.key === "Enter" && confirmRename()}
              className="w-full h-9 px-3 text-sm rounded-md border border-border bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenameTarget(null)}
                className="h-8 px-3 text-[12px] text-muted-foreground hover:text-foreground rounded-md">Cancel</button>
              <button onClick={confirmRename} disabled={!renamePath.trim()}
                className="h-8 px-3 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50">Rename</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save Diff Preview Dialog ────────────────────────── */}
      {showSaveDiffDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => !saving && setShowSaveDiffDialog(false)} />
          <div className="relative w-full max-w-[92vw] h-[86vh] bg-card rounded-xl shadow-xl border border-border overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-border shrink-0 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-[14px] font-semibold">Review Changes</h3>
                <p className="text-[12px] text-muted-foreground mt-1">Check the package diff before saving this skill.</p>
              </div>
              <button onClick={() => setShowSaveDiffDialog(false)} disabled={saving}
                className="p-1.5 rounded hover:bg-secondary text-muted-foreground disabled:opacity-50">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-4">
              <PackageDiffView
                diff={saveDiff}
                className="h-full"
                emptyMessage="No package file changes. Metadata changes will still be saved."
              />
            </div>
            <div className="border-t border-border px-6 py-3 space-y-2 shrink-0">
              <input
                value={commitMessage} onChange={e => setCommitMessage(e.target.value)}
                placeholder="Commit message (optional) — describe what changed and why"
                className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setShowSaveDiffDialog(false)} disabled={saving}
                  className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">Cancel</button>
                <button onClick={performSave} disabled={saving}
                  className="flex items-center gap-1.5 h-8 px-4 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Submit Diff Preview Dialog ──────────────────────── */}
      {showSubmitDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowSubmitDialog(false)} />
          <div className="relative w-full max-w-[92vw] h-[86vh] bg-card rounded-xl shadow-xl border border-border overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-border shrink-0">
              <h3 className="text-[14px] font-semibold">Submit for Review</h3>
              <p className="text-[12px] text-muted-foreground mt-1">Review your changes before submitting.</p>
            </div>
            <div className="flex-1 min-h-0 p-4">
              {submitDiff ? (
                <PackageDiffView diff={submitDiff} className="h-full" />
              ) : (
                <p className="text-[12px] text-muted-foreground">First submission — all content will be reviewed.</p>
              )}
            </div>
            <div className="border-t border-border px-6 py-3 space-y-2">
              <input
                value={commitMessage} onChange={e => setCommitMessage(e.target.value)}
                placeholder="Comment (optional) — describe what changed and why"
                className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setShowSubmitDialog(false)} disabled={submitConfirming}
                  className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">Cancel</button>
                <button onClick={handleSubmitConfirm} disabled={submitConfirming}
                  className="flex items-center gap-1.5 h-8 px-4 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  {submitConfirming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {submitConfirming ? "Submitting..." : "Confirm Submit"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Version Diff Dialog ─────────────────────────────── */}
      {versionDiffDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setVersionDiffDialog(null)} />
          <div className="relative w-full max-w-[92vw] h-[86vh] bg-card rounded-xl shadow-xl border border-border overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-border shrink-0 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-[14px] font-semibold">{versionDiffDialog.title}</h3>
                <p className="text-[12px] text-muted-foreground mt-1">File-level changes recorded for this version.</p>
              </div>
              <button onClick={() => setVersionDiffDialog(null)}
                className="p-1.5 rounded hover:bg-secondary text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-4">
              <PackageDiffView diff={versionDiffDialog.diff} className="h-full" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
