import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, validateExpr, compilationKey, triAll, triAny, triNot, type Tri, type Expr, type EvalContext } from './conditions-kernel.ts'
const digest = 'a'.repeat(64)
const binding = {sourceId:'result-A',version:'2',sha256:digest}
const context = (): EvalContext => ({now:'2026-11-16T02:00:00Z',allowedFacts:['A.total','A.ready'],facts:{'A.total':{value:64,binding,observedAt:'2026-11-16T01:00:00Z'}},currentBindings:{'result-A':binding}})
const atom: Expr = {op:'cmp',fact:'A.total',rel:'ge',value:64}
test('all/any/not exhaustively preserve unknown (Strong Kleene truth tables)',()=>{
 const vs:Tri[]=['false','unknown','true'], all:Tri[][]=[['false','false','false'],['false','unknown','unknown'],['false','unknown','true']], any:Tri[][]=[['false','unknown','true'],['unknown','unknown','true'],['true','true','true']]
 for(let i=0;i<3;i++)for(let j=0;j<3;j++){assert.equal(triAll([vs[i]!,vs[j]!]),all[i]![j]);assert.equal(triAny([vs[i]!,vs[j]!]),any[i]![j])}
 assert.deepEqual(vs.map(triNot),['true','unknown','false'])
})
test('new result changes evaluation while compile identity remains reusable',()=>{
 const c=context(); const identity={taskId:'A',commitmentRevision:2,userSources:[{turnId:'u1',sha256:digest}],schemaVersion:'pet-conditions/v1' as const,compilerSha256:digest,bindingRegistrySha256:digest};const key=compilationKey(identity)
 assert.equal(evaluate(atom,c).state,'true')
 assert.equal(evaluate(atom,{...c,facts:{'A.total':{...c.facts['A.total']!,value:48}}}).state,'false')
 assert.equal(compilationKey(identity),key)
 assert.notEqual(compilationKey({...identity,commitmentRevision:3}),key)
 assert.notEqual(compilationKey({...identity,compilerSha256:'b'.repeat(64)}),key)
 assert.notEqual(compilationKey({...identity,bindingRegistrySha256:'c'.repeat(64)}),key)
})
test('missing, retracted and mismatched evidence never become true under NOT',()=>{
 for(const c of [ {...context(),facts:{}}, {...context(),currentBindings:{}}, {...context(),currentBindings:{'result-A':{...binding,version:'3'}}}]){
  assert.equal(evaluate(atom,c).state,'unknown');assert.equal(evaluate({op:'not',arg:atom},c).state,'unknown')
 }
})
test('future, expiry and wrong types remain unknown without coercion',()=>{
 for(const change of [{observedAt:'2026-11-16T03:00:00Z'},{validUntil:'2026-11-16T02:00:00Z'},{value:'64'}]){
  const c=context();assert.equal(evaluate(atom,{...c,facts:{'A.total':{...c.facts['A.total']!,...change}}}).state,'unknown')
 }
})
test('partial facts can decide OR/AND and watch includes all referenced fields',()=>{
 const c=context(), missing:Expr={op:'cmp',fact:'A.ready',rel:'eq',value:true}
 const r=evaluate({op:'any',args:[atom,missing]},c)
 assert.equal(r.state,'true');assert.deepEqual(r.watch,['A.ready','A.total'])
 assert.equal(evaluate({op:'all',args:[{op:'not',arg:atom},missing]},c).state,'false')
 assert.equal(r.reads[0]?.binding?.sha256,digest)
})
test('reject invented fields, empty conditions, executable expressions and deep trees',()=>{
 for(const e of [{op:'cmp',fact:'other.secret',rel:'eq',value:true},{op:'all',args:[]},{op:'call',function:'fetch'}])assert.throws(()=>validateExpr(e,context().allowedFacts))
 let deep:Expr=atom;for(let i=0;i<9;i++)deep={op:'not',arg:deep};assert.throws(()=>validateExpr(deep,context().allowedFacts))
})
