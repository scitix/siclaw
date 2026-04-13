import { Outlet, Link, useLocation } from "react-router-dom"
import { Bot, MessageSquare, Server, Monitor, Zap, Plug, Settings, LogOut } from "lucide-react"
import { clearToken } from "../api"

const navItems = [
  { path: "/chat", label: "Chat", icon: MessageSquare },
  { path: "/agents", label: "Agents", icon: Bot },
  { path: "/clusters", label: "Clusters", icon: Server },
  { path: "/hosts", label: "Hosts", icon: Monitor },
  { path: "/skills", label: "Skills", icon: Zap },
  { path: "/mcp", label: "MCP", icon: Plug },
  { path: "/models", label: "Models", icon: Settings },
]

export function Layout() {
  const location = useLocation()

  return (
    <div className="flex h-screen">
      <aside className="w-[200px] border-r border-border flex flex-col bg-card">
        <div className="px-4 py-4 border-b border-border">
          <h1 className="text-sm font-bold tracking-wide">SICLAW</h1>
          <p className="text-[10px] text-muted-foreground mt-0.5">Agent Runtime Portal</p>
        </div>
        <nav className="flex-1 py-2">
          {navItems.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              className={`flex items-center gap-2.5 px-4 py-2 text-[13px] transition-colors ${
                location.pathname.startsWith(path)
                  ? "text-foreground bg-secondary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
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
