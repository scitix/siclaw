import { useState, useEffect } from "react"
import { Outlet, Link, useLocation } from "react-router-dom"
import { Bot, MessageSquare, Zap, Plug, Settings, LogOut, Server, Monitor, ChevronDown, ChevronRight, Cpu, Users, Radio, BarChart3, BookOpen } from "lucide-react"
import { api, clearToken } from "../api"
import { NotificationBell } from "../components/NotificationBell"

const siclawItems = [
  { path: "/chat", label: "Chat", icon: MessageSquare },
  { path: "/agents", label: "Agents", icon: Bot },
  { path: "/skills", label: "Skills", icon: Zap },
  { path: "/mcp", label: "MCP", icon: Plug },
  { path: "/knowledge", label: "Knowledge", icon: BookOpen },
]

const settingsItems = [
  { path: "/metrics", label: "Metrics", icon: BarChart3 },
  { path: "/settings/users", label: "Users", icon: Users },
  { path: "/settings/clusters", label: "Clusters", icon: Server },
  { path: "/settings/hosts", label: "Hosts", icon: Monitor },
  { path: "/settings/channels", label: "Channels", icon: Radio },
  { path: "/settings/models", label: "Models", icon: Cpu },
]

export function Layout() {
  const location = useLocation()
  const [settingsOpen, setSettingsOpen] = useState(
    location.pathname.startsWith("/settings") || location.pathname.startsWith("/metrics")
  )
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    api<{ role: string }>("/auth/me")
      .then((u) => setIsAdmin(u.role === "admin"))
      .catch(() => {})
  }, [])

  const isActive = (path: string) => location.pathname.startsWith(path)

  return (
    <div className="flex h-screen">
      <aside className="w-[200px] border-r border-border flex flex-col bg-card">
        <div className="px-4 py-4 border-b border-border">
          <h1 className="text-sm font-bold tracking-wide">SICLAW</h1>
          <p className="text-[10px] text-muted-foreground mt-0.5">Agent Runtime Portal</p>
        </div>
        <nav className="flex-1 py-2 overflow-y-auto">
          {/* Siclaw section — matches Upstream sidebar style */}
          <span className="px-4 py-1.5 text-[11px] font-medium tracking-wider text-muted-foreground block">
            Siclaw
          </span>
          {siclawItems.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              className={`flex items-center gap-2.5 px-4 py-2 text-[13px] transition-colors ${
                isActive(path)
                  ? "text-foreground bg-secondary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}

          {/* Settings section — admin only, collapsible */}
          {isAdmin && (
            <div className="mt-2">
              <button
                onClick={() => setSettingsOpen(!settingsOpen)}
                className={`flex items-center gap-2.5 px-4 py-2 text-[13px] w-full transition-colors ${
                  isActive("/settings") || isActive("/metrics")
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                <Settings className="h-4 w-4" />
                <span className="flex-1 text-left">Settings</span>
                {settingsOpen
                  ? <ChevronDown className="h-3.5 w-3.5" />
                  : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              {settingsOpen && settingsItems.map(({ path, label, icon: Icon }) => (
                <Link
                  key={path}
                  to={path}
                  className={`flex items-center gap-2.5 pl-7 pr-4 py-2 text-[13px] transition-colors ${
                    isActive(path)
                      ? "text-foreground bg-secondary"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              ))}
            </div>
          )}
        </nav>
        <NotificationBell />
        <button
          onClick={() => { clearToken(); window.location.href = "/login" }}
          className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-muted-foreground hover:text-foreground border-t border-border"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </aside>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
