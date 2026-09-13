import { expect,it,vi,afterEach } from "vitest";
vi.mock("./chat-repo.js",async importOriginal=>({...await importOriginal<any>(),ensureChatSession:vi.fn(async()=>{throw new Error("fixture database unavailable");})}));
import { startRuntime } from "./server.js";
import { SandboxTurnContext } from "./script-sandbox/turn-context.js";
afterEach(()=>vi.restoreAllMocks());
it.each(["web","api"])("strict %s persistence failure releases its registered turn",async origin=>{
  const original=SandboxTurnContext.prototype.enter;
  let release:any,context:SandboxTurnContext|undefined;
  vi.spyOn(SandboxTurnContext.prototype,"enter").mockImplementation(function(this:SandboxTurnContext,...args:Parameters<typeof original>){context=this;release=vi.fn(original.apply(this,args));return release;});
  const frontend={request:vi.fn(async()=>({found:false})),onCommand:vi.fn(),emitEvent:vi.fn(),close:vi.fn()};
  const runtime=await startRuntime({
    config:{port:0,internalPort:0,host:"127.0.0.1",serverUrl:"",portalSecret:""} as any,
    agentBoxManager:{setCertManager:vi.fn(),setSpawnEnvResolver:vi.fn(),setPersistenceResolver:vi.fn(),setTurnTerminator:vi.fn(),getOrCreate:vi.fn(),list:()=>[],cleanup:vi.fn(async()=>{})} as any,
    frontendClient:frontend as any,credentialService:{} as any,
  });
  try{
    await expect(runtime.rpcMethods.get("chat.send")!({agentId:"a",userId:"u",text:"fixture",sessionId:"review-session",origin,requireSessionPersistence:true},{sendEvent:vi.fn()})).rejects.toThrow("durably persist");
    expect(release).toBeDefined();expect(release).toHaveBeenCalledOnce();
    expect(context!.user("review-session","a")).toBe("");
  }finally{release?.();await runtime.close();}
});
