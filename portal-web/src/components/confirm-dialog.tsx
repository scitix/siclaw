import { useState, useCallback, createContext, useContext } from "react"

interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{
    options: ConfirmOptions
    resolve: (value: boolean) => void
  } | null>(null)

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({ options, resolve })
    })
  }, [])

  const handleClose = (result: boolean) => {
    state?.resolve(result)
    setState(null)
  }

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {state && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50" onClick={() => handleClose(false)} />
          {/* Dialog */}
          <div className="relative bg-card border border-border rounded-lg shadow-xl w-[400px] p-6 animate-scale-in">
            <h3 className="text-[15px] font-semibold">{state.options.title}</h3>
            <p className="text-[13px] text-muted-foreground mt-2">{state.options.message}</p>
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => handleClose(false)}
                className="h-8 px-4 text-[13px] rounded-md border border-border text-muted-foreground hover:text-foreground"
              >
                {state.options.cancelLabel || "Cancel"}
              </button>
              <button
                onClick={() => handleClose(true)}
                className={`h-8 px-4 text-[13px] rounded-md ${
                  state.options.destructive
                    ? "bg-red-500 text-white hover:bg-red-600"
                    : "bg-primary text-primary-foreground hover:opacity-90"
                }`}
              >
                {state.options.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider")
  return ctx.confirm
}
