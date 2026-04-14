import { useState, useEffect } from "react"
import { Plus, Users as UsersIcon, Trash2, Loader2, Settings, X } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface User {
  id: string
  username: string
  role: string
  can_review_skills: boolean | number
  created_at: string
}

export function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ username: "", password: "", can_review_skills: false })
  const [creating, setCreating] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [editForm, setEditForm] = useState({ can_review_skills: false, password: "" })
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const confirmDialog = useConfirm()

  const loadUsers = () => {
    api<{ data: User[] }>("/users")
      .then((r) => setUsers(Array.isArray(r.data) ? r.data : []))
      .catch((err) => {
        setUsers([])
        if (err.message?.includes("403") || err.message?.includes("Admin")) {
          toast.error("Session expired — please re-login")
        }
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadUsers() }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const u = await api<User>("/users", { method: "POST", body: form })
      setUsers((prev) => [...prev, u])
      setShowCreate(false)
      setForm({ username: "", password: "", can_review_skills: false })
      toast.success("User created")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (u: User) => {
    if (!(await confirmDialog({
      title: "Delete User",
      message: `Delete user "${u.username}"? This action cannot be undone.`,
      destructive: true,
      confirmLabel: "Delete",
    }))) return
    try {
      await api(`/users/${u.id}`, { method: "DELETE" })
      setUsers((prev) => prev.filter((x) => x.id !== u.id))
      toast.success("User deleted")
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  const openEdit = (u: User) => {
    setEditUser(u)
    setEditForm({ can_review_skills: !!u.can_review_skills, password: "" })
  }

  const handleSaveEdit = async () => {
    if (!editUser) return
    setSaving(true)
    try {
      // Update permissions (non-admin only)
      if (editUser.role !== "admin") {
        const updated = await api<User>(`/users/${editUser.id}`, {
          method: "PUT",
          body: { can_review_skills: editForm.can_review_skills },
        })
        setUsers((prev) => prev.map((x) => x.id === editUser.id ? updated : x))
      }

      // Reset password if provided
      if (editForm.password.trim()) {
        await api(`/users/${editUser.id}/password`, {
          method: "PUT",
          body: { password: editForm.password },
        })
      }

      setEditUser(null)
      toast.success("User updated")
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">Manage user accounts and permissions</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> Add User
        </button>
      </div>

      {showCreate && (
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
            <input type="password" placeholder="Password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={form.can_review_skills} onChange={(e) => setForm({ ...form, can_review_skills: e.target.checked })} />
            Can review skills
          </label>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={creating || !form.username || !form.password} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{creating ? "Creating..." : "Create"}</button>
            <button onClick={() => setShowCreate(false)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <UsersIcon className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No users yet</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {users.map((u) => (
              <div key={u.id} className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-secondary text-foreground text-sm font-medium">
                    {u.username.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{u.username}</p>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${u.role === "admin" ? "bg-amber-500/20 text-amber-400" : "bg-blue-500/20 text-blue-400"}`}>
                        {u.role.toUpperCase()}
                      </span>
                      {!!u.can_review_skills && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500/20 text-green-400">REVIEWER</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">Created {new Date(u.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => openEdit(u)} title="Settings" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground">
                    <Settings className="h-4 w-4" />
                  </button>
                  {u.role !== "admin" && (
                    <button onClick={() => handleDelete(u)} title="Delete user" className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit dialog */}
      {editUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditUser(null)}>
          <div className="w-[400px] rounded-lg border border-border bg-card p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">User Settings — {editUser.username}</h2>
              <button onClick={() => setEditUser(null)} className="p-1 rounded-md text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              {editUser.role !== "admin" && (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={editForm.can_review_skills}
                    onChange={(e) => setEditForm({ ...editForm, can_review_skills: e.target.checked })}
                  />
                  Can review skills
                </label>
              )}

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Reset Password</label>
                <input
                  type="password"
                  placeholder="Leave empty to keep current"
                  value={editForm.password}
                  onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                  className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setEditUser(null)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">Cancel</button>
              <button onClick={handleSaveEdit} disabled={saving} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
