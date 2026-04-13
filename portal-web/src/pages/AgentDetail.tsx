import { useParams, useSearchParams } from "react-router-dom"

export function AgentDetail() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const tab = searchParams.get("tab") || "chat"
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold mb-2">Agent {id}</h1>
      <p className="text-sm text-muted-foreground">Tab: {tab}</p>
      <p className="text-sm text-muted-foreground mt-4">Agent detail page — to be implemented (chat, tasks, settings, api-keys tabs)</p>
    </div>
  )
}
