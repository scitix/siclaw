import { useState, useEffect } from "react"
import { Outlet, Link, useLocation } from "react-router-dom"
import { Bot, MessageSquare, Zap, Plug, Settings, LogOut, Server, Monitor, ChevronDown, ChevronRight, Cpu, Users, Radio, BarChart3, BookOpen, PanelLeftClose, PanelLeftOpen, Sun, Moon } from "lucide-react"
import { api, clearToken } from "../api"
import { NotificationBell } from "../components/NotificationBell"
import { useTheme } from "../hooks/useTheme"

const siclawItems = [
  { path: "/chat", label: "Chat", icon: MessageSquare },
  { path: "/agents", label: "Agents", icon: Bot },
  { path: "/skills", label: "Skills", icon: Zap },
  { path: "/mcp", label: "MCP", icon: Plug },
]

const settingsItems = [
  { path: "/settings/users", label: "Users", icon: Users },
  { path: "/settings/clusters", label: "Clusters", icon: Server },
  { path: "/settings/hosts", label: "Hosts", icon: Monitor },
  { path: "/settings/channels", label: "Channels", icon: Radio },
  { path: "/settings/models", label: "Models", icon: Cpu },
  { path: "/settings/knowledge", label: "Knowledge", icon: BookOpen },
]

const COLLAPSED_KEY = "siclaw.sidebar.collapsed"

export function Layout() {
  const location = useLocation()
  const { theme, toggle: toggleTheme } = useTheme()
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1" } catch { return false }
  })
  const [settingsOpen, setSettingsOpen] = useState(
    location.pathname.startsWith("/settings")
  )
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    api<{ role: string }>("/auth/me")
      .then((u) => setIsAdmin(u.role === "admin"))
      .catch(() => {})
  }, [])

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0") } catch { /* ignore */ }
  }, [collapsed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        const t = e.target as HTMLElement | null
        const tag = t?.tagName
        if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return
        e.preventDefault()
        setCollapsed((c) => !c)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const isActive = (path: string) => location.pathname.startsWith(path)

  const rowBase = "flex items-center py-2 text-[13px] transition-colors"
  const rowLayout = collapsed ? "justify-center px-0" : "gap-2.5 px-4"
  const rowActive = "text-foreground bg-secondary"
  const rowIdle = "text-muted-foreground hover:text-foreground hover:bg-secondary/50"

  return (
    <div className="flex h-screen">
      <aside
        className={`${collapsed ? "w-14" : "w-[200px]"} border-r border-border flex flex-col bg-card transition-[width] duration-200 ease-out`}
      >
        <div className={`border-b border-border ${collapsed ? "py-3 flex justify-center" : "px-4 py-4 flex items-start justify-between gap-2"}`}>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm font-bold tracking-wide">SICLAW</h1>
                <button
                  onClick={toggleTheme}
                  title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                  aria-label="Toggle theme"
                  className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                >
                  {theme === "dark"
                    ? <Sun className="h-3.5 w-3.5" />
                    : <Moon className="h-3.5 w-3.5" />}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">Agent Runtime Portal</p>
            </div>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          >
            {collapsed
              ? <PanelLeftOpen className="h-4 w-4" />
              : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>

        <nav className="flex-1 py-2 overflow-y-auto overflow-x-hidden">
          {!collapsed && (
            <span className="px-4 py-1.5 text-[11px] font-medium tracking-wider text-muted-foreground block">
              Siclaw
            </span>
          )}
          {siclawItems.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              title={collapsed ? label : undefined}
              className={`${rowBase} ${rowLayout} ${isActive(path) ? rowActive : rowIdle}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{label}</span>}
            </Link>
          ))}

          {isAdmin && (
            <div className="mt-2">
              {collapsed ? (
                <button
                  onClick={() => { setCollapsed(false); setSettingsOpen(true) }}
                  title="Settings"
                  aria-label="Settings"
                  className={`${rowBase} ${rowLayout} w-full ${
                    isActive("/settings") ? rowActive : rowIdle
                  }`}
                >
                  <Settings className="h-4 w-4 shrink-0" />
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setSettingsOpen(!settingsOpen)}
                    className={`${rowBase} gap-2.5 px-4 w-full ${
                      isActive("/settings") ? "text-foreground" : rowIdle
                    }`}
                  >
                    <Settings className="h-4 w-4 shrink-0" />
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
                        isActive(path) ? rowActive : rowIdle
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </Link>
                  ))}
                </>
              )}
            </div>
          )}
        </nav>

        {isAdmin && (
          <Link
            to="/metrics"
            title={collapsed ? "Metrics" : undefined}
            className={`flex items-center ${collapsed ? "justify-center px-0" : "gap-2.5 px-4"} py-3 text-[13px] border-t border-border transition-colors ${
              isActive("/metrics") ? rowActive : rowIdle
            }`}
          >
            <BarChart3 className="h-4 w-4 shrink-0" />
            {!collapsed && "Metrics"}
          </Link>
        )}

        <NotificationBell collapsed={collapsed} />

        <button
          onClick={() => { clearToken(); window.location.href = "/login" }}
          title={collapsed ? "Logout" : undefined}
          aria-label="Logout"
          className={`flex items-center ${collapsed ? "justify-center px-0" : "gap-2.5 px-4"} py-3 text-[13px] text-muted-foreground hover:text-foreground border-t border-border`}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && "Logout"}
        </button>
      </aside>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
