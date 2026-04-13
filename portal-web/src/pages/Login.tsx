import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { api, setToken } from "../api"

export function Login() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [isRegister, setIsRegister] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const endpoint = isRegister ? "/auth/register" : "/auth/login"
      const res = await api<{ token: string }>(endpoint, {
        method: "POST",
        body: { username, password },
      })
      setToken(res.token)
      navigate("/")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-[360px] p-8 rounded-lg border border-border bg-card">
        <h1 className="text-xl font-bold mb-1">Siclaw Portal</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {isRegister ? "Create your admin account" : "Sign in to continue"}
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full h-9 px-3 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full h-9 px-3 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            required
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full h-9 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "..." : isRegister ? "Create Account" : "Sign In"}
          </button>
        </form>
        <button
          onClick={() => setIsRegister(!isRegister)}
          className="mt-4 text-xs text-muted-foreground hover:text-foreground w-full text-center"
        >
          {isRegister ? "Already have an account? Sign in" : "First time? Create an account"}
        </button>
      </div>
    </div>
  )
}
