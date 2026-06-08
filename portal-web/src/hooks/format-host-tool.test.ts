import { describe, it, expect } from "vitest"
import { formatToolInput } from "./usePilotChat"

// host_exec/host_script: the model passes an opaque host id; the backend resolves the friendly
// name into metadata.host_label. The card must read `<name> $ <command>` like node_exec.
describe("formatToolInput — host_exec / host_script", () => {
  const ID = "d456a827-8dca-4e0c-954c-0bfdf9e78450"

  it("host_exec shows '<resolved name> $ <command>' when metadata.host_label is present", () => {
    const s = formatToolInput("host_exec", { host: ID, command: "ping -c 100 10.155.55.254" }, { host_label: "061" })
    expect(s).toBe("061 $ ping -c 100 10.155.55.254")
    expect(s).not.toContain(ID)
  })

  it("host_exec falls back to the raw host id when no label yet (pre-resolution frame), but still shows the command", () => {
    const s = formatToolInput("host_exec", { host: ID, command: "uptime" })
    expect(s).toBe(`${ID} $ uptime`) // command no longer hidden behind the id
  })

  it("host_script shows '<name> $ skill/script args'", () => {
    const s = formatToolInput(
      "host_script",
      { host: ID, skill: "rdma-diag", script: "check.sh", args: "--all" },
      { host_label: "061" },
    )
    expect(s).toBe("061 $ rdma-diag/check.sh --all")
  })
})
