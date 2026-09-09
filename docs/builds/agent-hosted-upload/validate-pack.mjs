// Planning-only validator. No provider calls, product execution, or writes.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
const root=dirname(fileURLToPath(import.meta.url));
const read=p=>readFileSync(join(root,p),'utf8');
const manifest=JSON.parse(read('build-order.json'));
const evidence=JSON.parse(read('planning-evidence.json'));
const ts=manifest.tickets, byId=new Map(ts.map(t=>[t.id,t]));
assert.equal(ts.length,13); assert.equal(byId.size,ts.length);
const draft=ts.every(t=>t.ticket===null);
const promoted=ts.every(t=>Number.isSafeInteger(t.ticket) && t.ticket>0);
assert(draft || promoted,'ticket numbers must be either entirely draft or entirely promoted');
if(promoted){
 assert.equal(new Set(ts.map(t=>t.ticket)).size,ts.length,'promoted ticket numbers must be unique');
 assert(Number.isSafeInteger(manifest.root_number) && manifest.root_number>0,'promoted pack requires root_number');
}
assert.equal(manifest.build_order_id,evidence.build_order_id);
assert.equal(manifest.plan_version,evidence.plan_version);
const lanes=new Set(manifest.workstreams.map(w=>w.id));
const required=['Outcome','Context and evidence','Scope','Non-goals','Existing owner and reuse target','Contract and invariants','Acceptance and verification','Surfaces','Sibling boundaries and open gates'];
const canonical=read('contracts.md');
const blocks=new Map([...canonical.matchAll(/^## (C[1-6])\..*\n([\s\S]*?)(?=^## C[1-6]\.|$(?![\s\S]))/gm)].map(m=>[m[1],m[0].trim()]));
assert.equal(blocks.size,6);
const depths=new Map(), visiting=new Set();
function depth(id) {
 assert(byId.has(id),'unresolved '+id); if(depths.has(id))return depths.get(id);
 assert(!visiting.has(id),'cycle '+id); visiting.add(id);
 const d=1+Math.max(0,...byId.get(id).depends_on.map(depth));
 visiting.delete(id); depths.set(id,d); return d;
}
for(const t of ts) {
 assert.match(t.id,/^AHU-\d{3}$/); assert(lanes.has(t.lane));
 assert([1,2,3].includes(t.complexity)); assert.equal(t.phase,depth(t.id));
 assert.equal(new Set(t.depends_on).size,t.depends_on.length);
 assert.match(t.doc,/^tickets\/AHU-\d{3}\.md$/); assert(lstatSync(join(root,t.doc)).isFile());
 const body=read(t.doc);
 for(const h of required)assert(body.includes('## '+h),t.id+' missing '+h);
 assert(Number(body.match(/\*\*Phase(?: hint)?:\*\* p?(\d+)/)?.[1])===t.phase,t.id+' phase drift');
 assert(body.includes('**Complexity:** c'+t.complexity) || body.includes('**Complexity:** '+t.complexity),t.id+' complexity drift');
 const meta=evidence.tickets.find(x=>x.id===t.id); assert(meta); assert(meta.risk && meta.capability_requirements.length);
 const req=body.match(/^\*\*Requirements:\*\* (.*)$/m)[1].match(/R\d+/g);
 assert.deepEqual(new Set(req),new Set(meta.requirement_refs),t.id+' requirements drift');
 for(const m of body.matchAll(/^## (C[1-6])\./gm))assert(body.includes(blocks.get(m[1])),t.id+' copied '+m[1]+' drift');
 assert.equal(meta.serializes_with.length,0); assert.equal(meta.contains.length,0);
}
assert.deepEqual([1,2,3,4,5].map(p=>ts.filter(t=>t.phase===p).length),[2,4,5,1,1]);
assert.equal(evidence.requirements.length,15);
for(let i=1;i<=15;i++){
 const r=evidence.requirements.find(r=>r.id==='R'+i); assert(r && r.disposition==='ticket' && r.ticket_ids.length);
 for(const id of r.ticket_ids)assert(evidence.tickets.find(t=>t.id===id)?.requirement_refs.includes(r.id));
}
assert.equal(evidence.decisions.length,7); assert(evidence.external_gates.length>0); assert(evidence.feature_boundary);
const digest=s=>createHash('sha256').update(s).digest('hex');
const result={result:'PASS',ticket_state:promoted?'promoted':'draft',tickets:13,requirements:15,decisions:7,widths:[2,4,5,1,1],longest_path:5,contract_blocks:blocks.size,manifest_sha256:digest(read('build-order.json')),contracts_sha256:digest(canonical),design_sha256:digest(read('design-v1.md'))};
if(process.argv.includes('--runtime')){
 const canonicalRoot=resolve(process.env.AIUR_STATE_ROOT || join(homedir(),'.aiur/repo/aiur-team/archon/builds/agent-hosted-upload'));
 const mirror=resolve(root,'../../../.aiur/build_orders');
 assert.equal(readFileSync(join(canonicalRoot,'build-order.json'),'utf8'),read('build-order.json'));
 assert.equal(readFileSync(join(mirror,'agent-hosted-upload.json'),'utf8'),read('build-order.json'));
 for(const t of ts)for(const dir of[canonicalRoot,mirror])assert.equal(readFileSync(join(dir,t.doc),'utf8'),read(t.doc),dir+'/'+t.doc);
 result.runtime_copies='byte-identical';
}
console.log(JSON.stringify(result,null,2));
