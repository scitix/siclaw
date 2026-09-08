import { describe, it, expect, vi } from "vitest";
import { ConversationClient, supportsConversations } from "./conversation-client.js";

function fixture() {
 let listener: (data: unknown) => void = () => {};
 const off = vi.fn();
 const frontend = { connected: true, request: vi.fn().mockResolvedValue({ ok: true }), subscribe: vi.fn((_channel, fn) => { listener = fn; return off; }) };
 const entry = { agentId: "cn", userId: "u", sessionId: "s", userMessageId: "m", origin: "channel" as const };
 const client = new ConversationClient(frontend as never, entry);
 const emit = (event: Record<string, unknown>, requestId = "m") => listener({ sessionId: "s", requestId, event });
 return { client, frontend, entry, emit, off };
}

describe("control-plane conversations", () => {
 it("subscribes before dispatch, filters old requests and observes the destination's conclusion", async () => {
  const f=fixture();
  f.frontend.request.mockImplementation(async () => {
   f.emit({type:"message_end",message:{role:"assistant",content:[]}},"old-input");
   f.emit({type:"agent_switch",toAgentId:"overseas"});
   f.emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"海外结果"}]}});
   f.emit({type:"prompt_done"});
   return {ok:true};
  });
  await f.client.prompt({text:"inspect overseas",subagentTiers:undefined,modelConfig:{apiKey:"must-not-cross"} as never});
  const seen=[];for await(const event of f.client.streamEvents("s")) seen.push(event);
  expect(seen.map((event:any)=>event.type)).toEqual(["agent_switch","message_end","prompt_done"]);
  expect(f.frontend.request).toHaveBeenCalledWith("conversation.start",expect.objectContaining(f.entry));
  expect(f.frontend.request.mock.calls[0][1]).not.toHaveProperty("modelConfig");
  expect(f.off).toHaveBeenCalledTimes(1);
 });
 it("a failed destination does not turn the source progress into a successful result", async () => {
  const f=fixture();await f.client.prompt({text:"inspect",subagentTiers:undefined});
  f.emit({type:"stream_error",error:{message:"private diagnostic"}});
  await expect(async()=>{for await(const _ of f.client.streamEvents("s")) { /* drain */ }}).rejects.toThrow("Conversation execution failed");
  expect(f.off).toHaveBeenCalled();
 });
 it("a timed-out submission never retries locally or redispatches", async () => {
  const f=fixture();f.frontend.request.mockRejectedValue(new Error("RPC timeout"));
  await expect(f.client.prompt({text:"inspect",subagentTiers:undefined})).rejects.toThrow("RPC timeout");
  expect(f.frontend.request).toHaveBeenCalledTimes(1);expect(f.off).toHaveBeenCalled();
 });
 it("routes cancellation through the entry identity without naming a target Runtime", async () => {
  const f=fixture();await f.client.prompt({text:"inspect",subagentTiers:undefined});await f.client.abort();
  expect(f.frontend.request).toHaveBeenLastCalledWith("conversation.abort",f.entry);
 });
 it("only an explicit unsupported method permits the local compatibility path", async () => {
  const request=vi.fn().mockRejectedValue(new Error("Unknown method: conversation.capabilities"));
  await expect(supportsConversations({request} as never)).resolves.toBe(false);
  request.mockRejectedValue(new Error("connection lost"));
  await expect(supportsConversations({request} as never)).rejects.toThrow("connection lost");
 });
});
