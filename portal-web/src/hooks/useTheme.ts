import { useCallback, useEffect, useState } from "react"

export type Theme = "light" | "dark"

const STORAGE_KEY = "siclaw.theme"

function readInitial(): Theme {
  if (typeof document === "undefined") return "dark"
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

function apply(theme: Theme) {
  const root = document.documentElement
  if (theme === "dark") root.classList.add("dark")
  else root.classList.remove("dark")
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readInitial)

  useEffect(() => {
    apply(theme)
    try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* ignore */ }
  }, [theme])

  const setTheme = useCallback((t: Theme) => setThemeState(t), [])
  const toggle = useCallback(() => setThemeState((t) => (t === "dark" ? "light" : "dark")), [])

  return { theme, setTheme, toggle }
}
