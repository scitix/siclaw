import { expect, it, vi, afterEach } from "vitest";
const calls=vi.hoisted(()=>vi.fn());
vi.mock("./exec-utils.js",()=>({spawnAsync:calls,prepareExecEnv:vi.fn()}));
vi.mock("../../core/config.js",()=>({loadConfig:()=>({debugImage:"fixture",debugNamespace:"diagnostic",debugPodIdleTimeout:60,debugPodTTL:120})}));
import { runInDebugPod, debugPodCache, resetStartupFailureMemo } from "./debug-pod.js";
afterEach(()=>{debugPodCache.remove("sandbox-owner","prod","node");resetStartupFailureMemo();vi.useRealTimers();calls.mockReset();});
it.each(["Succeeded","Failed",""])("phase %s invalidation preserves independent Job cleanup ownership",async phase=>{
  const env={kubeconfigArgs:[],childEnv:{}} as any;
  debugPodCache.set("sandbox-owner","prod","node","owned-job","owned-pod","diagnostic",env,60000);
  debugPodCache.own("sandbox-owner","prod","node","owned-job","diagnostic",env);
  calls.mockImplementation(async(_bin,args)=>{
    if(args.includes("delete")) return {stdout:"",stderr:""};
    if(args.includes("exec"))throw Object.assign(new Error("exec interrupted"),{code:null,stderr:"exec interrupted"});
    if(args.includes("get"))return {stdout:phase,stderr:"",exitCode:0};
    throw new Error("unexpected invocation");
  });
  const result=await runInDebugPod({userId:"sandbox-owner",clusterKey:"prod",nodeName:"node",command:["uname"],namespace:"diagnostic",confirmCleanup:true},env,{timeoutMs:1000});
  expect(result.exitCode).toBeNull(); expect(debugPodCache.size).toBe(0);
  await expect(debugPodCache.evictFor("sandbox-owner","prod","node")).resolves.toBeUndefined();
  expect(calls.mock.calls.some(c=>c[1].includes("delete"))).toBe(true);
});

it("confirmed deletion rejection occurs after three attempts with real eviction logic",async()=>{
  vi.useFakeTimers();
  debugPodCache.set("sandbox-owner","prod","node","owned-job","owned-pod","diagnostic",{kubeconfigArgs:[],childEnv:{}} as any,60000);
  calls.mockRejectedValue(new Error("fixture delete unavailable"));
  const outcome=expect(debugPodCache.evictFor("sandbox-owner","prod","node")).rejects.toThrow("cleanup unconfirmed");
  await vi.advanceTimersByTimeAsync(4001); await outcome;
  expect(calls).toHaveBeenCalledTimes(3); expect(debugPodCache.size).toBe(0);
});
