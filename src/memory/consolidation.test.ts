import { expect,it,vi } from 'vitest';
import { createMemoryConsolidator,validateConsolidationBatch,validateMemoryOutline } from './consolidation.js';
import { MemoryLearner } from './learning.js';
import type { MemoryConsolidationBatch } from '../shared/private-workspace.js';
const batch=():MemoryConsolidationBatch=>({token:'token',generation:0,revision:1,records:[{id:'a'.repeat(64),kind:'preference',scope:'harbor',claim:'reports',summary:'Harbor report style',text:'Use concise bullets for Harbor reports.',sourceSessionId:'s',createdAt:1,usageCount:0,negativeCount:0}],rollouts:[{sessionId:'s',ids:['a'.repeat(64)]}],previous:{topics:[],merges:[]}});
const outline=()=>({topics:[{scope:'harbor',title:'Report style',ids:['a'.repeat(64)]}],merges:[]});
it('validates provenance and limits before giving a batch to a model',()=>{
 expect(()=>validateConsolidationBatch(batch())).not.toThrow();
 const value=batch();value.rollouts[0].sessionId='foreign';expect(()=>validateConsolidationBatch(value)).toThrow();
 expect(()=>validateMemoryOutline({...outline(),run:'shell'} as any,batch().records)).toThrow();
 expect(()=>validateMemoryOutline({...outline(),topics:[{scope:'foreign',title:'Wrong project',ids:['a'.repeat(64)]}]},batch().records)).toThrow();
});
it('keeps phase two tool-free and sends the prior outline and chronological task accounts',async()=>{
 const completeSimple=vi.fn().mockResolvedValue({stopReason:'stop',content:[{type:'text',text:JSON.stringify(outline())}],usage:{input:5,output:5}});
 const consolidate=createMemoryConsolidator({completeSimple} as any,()=>({id:'model'} as any));
 await consolidate(batch(),new AbortController().signal);
 const [,context,options]=completeSimple.mock.calls[0];expect(context.tools).toBeUndefined();expect(options.maxTokens).toBe(4096);
 expect(JSON.parse(context.messages[0].content).rollouts).toEqual(batch().rollouts);
});
it('retries ambiguous phase-two publication with identical content without rerunning inference',async()=>{
 const backend={prepareLearning:vi.fn().mockResolvedValue({token:'',generation:0,revision:0,inputs:[],hints:[],more:false}),publishLearning:vi.fn(),failLearning:vi.fn(),prepareConsolidation:vi.fn().mockResolvedValue(batch()),publishConsolidation:vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue({ok:true}),failConsolidation:vi.fn()};
 const consolidate=vi.fn().mockResolvedValue(outline()),classify=vi.fn(),learner=new MemoryLearner(backend,classify,5000,consolidate);
 learner.wake();await learner.drain();await learner.close();
 expect(classify).not.toHaveBeenCalled();expect(consolidate).toHaveBeenCalledOnce();expect(backend.publishConsolidation).toHaveBeenCalledTimes(2);
 expect(backend.publishConsolidation.mock.calls[0]).toEqual(backend.publishConsolidation.mock.calls[1]);expect(backend.failConsolidation).not.toHaveBeenCalled();
});
