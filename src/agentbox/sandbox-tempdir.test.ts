import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('./credential-broker.js',()=>({CredentialBroker:vi.fn(),resolveGroupGid:()=>997}));
vi.mock('../tools/cmd-exec/restricted-bash.js',()=>({createRestrictedBashTool:vi.fn()}));
vi.mock('../tools/cmd-exec/host-exec.js',()=>({createHostExecTool:vi.fn()}));
vi.mock('../tools/cmd-exec/node-exec.js',()=>({createNodeExecTool:vi.fn()}));
vi.mock('../tools/cmd-exec/pod-exec.js',()=>({createPodExecTool:vi.fn()}));
vi.mock('../tools/infra/debug-pod.js',()=>({debugPodCache:{evictFor:vi.fn()}}));
import {executeSandboxBuiltin} from './sandbox-tools.js';

it('chown failure removes the unmaterialized snapshot directory',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'snapshot-failure-'));
 const change=vi.spyOn(fs,'chownSync').mockImplementation(()=>{throw Object.assign(new Error('fixture EPERM'),{code:'EPERM'});});
 const kube=JSON.stringify({'current-context':'c',contexts:[{name:'c',context:{cluster:'c',user:'u'}}],clusters:[{name:'c',cluster:{server:'https://cluster.example'}}],users:[{name:'u',user:{token:'fixture'}}]});
 try{
  await expect(executeSandboxBuiltin({tool:'pod_exec',arguments:{cluster:'c',pod:'p',command:'uname',timeout_seconds:1}}, {tool:'pod_exec',credential:{name:'c',type:'kubeconfig',files:[{name:'c.kubeconfig',content:kube}]}},root,new AbortController().signal)).rejects.toMatchObject({ execution: 'NOT_DISPATCHED' });
  const dirs=fs.readdirSync(root);expect(dirs).toEqual([]);
 } finally {change.mockRestore();fs.rmSync(root,{recursive:true,force:true});}
});
