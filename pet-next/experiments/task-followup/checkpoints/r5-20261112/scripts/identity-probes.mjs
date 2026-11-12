import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const source=process.argv[2]; const out=process.argv[3];
const {scoreAll}=await import(pathToFileURL(join(source,'eval/score.ts')).href);
const original=JSON.parse(readFileSync(process.argv[4] ?? new URL('./delivery-input/raw/P3/T01-a.json',import.meta.url),'utf8'));
const tests=[];
for (const name of ['control','missing-decisionId','missing-ticketId','missing-taskRevision','missing-assignmentId','duplicate-attention','mismatch-revision']) {
 const d=structuredClone(original);
 if(name.startsWith('missing-')) {const f=name.slice(8);for(const a of d.asks)delete a[f];for(const a of d.attentions)delete a[f];}
 if(name==='duplicate-attention')d.attentions.push(structuredClone(d.attentions[0]));
 if(name==='mismatch-revision')d.attentions[0].taskRevision+=1;
 const dir=join(out,name);mkdirSync(join(dir,'raw/P3'),{recursive:true});writeFileSync(join(dir,'raw/P3/T01-a.json'),JSON.stringify(d,null,2));
 const score=scoreAll(join(dir,'raw'),join(source,'gold')).policies.P3;
 const actual={visible:score.requiredVisible,answered:score.requiredAnswered,reasons:score.notVisibleDetail};
 const passed=name==='control'?actual.visible===1&&actual.answered===1:actual.visible===0&&actual.answered===0;
 tests.push({name,passed,actual});
}
writeFileSync(join(out,'identity-probes.json'),JSON.stringify({tests,failed:tests.filter(x=>!x.passed)},null,2));console.log(JSON.stringify({tests,failed:tests.filter(x=>!x.passed)},null,2));process.exit(tests.every(x=>x.passed)?0:1);
