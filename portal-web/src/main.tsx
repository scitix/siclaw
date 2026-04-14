import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import "./index.css"
import { ToastProvider } from "./components/toast"
import { ConfirmProvider } from "./components/confirm-dialog"
import { Login } from "./pages/Login"
import { Layout } from "./pages/Layout"
import { Agents } from "./pages/Agents"
import { AgentDetail } from "./pages/AgentDetail"
import { Clusters } from "./pages/Clusters"
import { Hosts } from "./pages/Hosts"
import { Skills } from "./pages/Skills"
import { MCP } from "./pages/MCP"
import { Models } from "./pages/Models"
import { Chat } from "./pages/Chat"

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("token")
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ToastProvider>
  <ConfirmProvider>
  <BrowserRouter>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<Agents />} />
        <Route path="agents/:id" element={<AgentDetail />} />
        <Route path="chat" element={<Chat />} />
        <Route path="skills" element={<Skills />} />
        <Route path="mcp" element={<MCP />} />
        <Route path="settings/clusters" element={<Clusters />} />
        <Route path="settings/hosts" element={<Hosts />} />
        <Route path="settings/models" element={<Models />} />
      </Route>
    </Routes>
  </BrowserRouter>
  </ConfirmProvider>
  </ToastProvider>
)
