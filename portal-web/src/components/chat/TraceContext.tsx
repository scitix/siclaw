import { createContext } from "react"
export const TraceHostContext = createContext<{
  locale?: string
  onFollowUp?: (prompt: string) => void | Promise<void>
  attachedIds?: ReadonlySet<string>
}>({})
