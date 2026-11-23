// Based on the Ledger 9 release-candidate ZKIR v3.0 instruction definitions.
// Operand fields from midnight-zkir 3.2.1 (Ledger 9.1.0.2). This is a
// structural decoder, not the official type checker or circuit verifier.
const fields = {
 encode:['input'], decode:['inputs'], assert:['cond'], cond_select:['bit','a','b'],
 constrain_bits:['val'], constrain_eq:['a','b'], constrain_to_boolean:['val'], copy:['val'],
 impact:['guard','inputs'], ec_mul:['a','scalar'], ec_mul_generator:['scalar'], hash_to_curve:['inputs'],
 into_coordinates:['point'], from_coordinates:['inputs'], into_bytes32:['input'], from_bytes32:['bytes'],
 reverse_bytes:['bytes'], bytes32_into_low_high:['bytes'], bytes32_from_low_high:['inputs'],
 div_mod_power_of_two:['val'], reconstitute_field:['divisor','modulus'], transient_hash:['inputs'],
 persistent_hash:['inputs'], keccak256:['inputs'], test_eq:['a','b'], add:['a','b'], mul:['a','b'],
 neg:['a'], inv:['a'], not:['a'], less_than:['a','b'], jubjub_scalar_from_native:['native'],
 public_input:['guard'], private_input:['guard'], output:['vals'], slice:['bytes'], nth:['bytes'],
 concat:['inputs'], load_constant:[], sha512:['inputs'], and:['inputs'], or:['inputs'], xor:['inputs'],
 to_bytes:['input'], from_bytes:['bytes'], reverse:['bytes'], bytes_into_natives:['bytes'], bytes_from_natives:['inputs']
};
export function operandFields(op) { return fields[op] ?? null; }
export function parse(text) {
 let data; try { data=JSON.parse(text); } catch { throw Error('Invalid JSON. Choose a text .zkir file.'); }
 if (data?.version?.major === 2 && data.version.minor === 0) {
  if (!Number.isInteger(data.num_inputs) || data.num_inputs < 0 || !Array.isArray(data.instructions) || typeof data.do_communications_commitment !== 'boolean' || data.instructions.some(x => !x || typeof x.op !== 'string')) throw Error('Invalid ZKIR 2.0 circuit.');
  const schema = {assert:[['cond'],0],cond_select:[['bit','a','b'],1],constrain_bits:[['var'],0],constrain_eq:[['a','b'],0],constrain_to_boolean:[['var'],0],copy:[['var'],1],declare_pub_input:[['var'],0],pi_skip:[['guard'],0],ec_add:[['a_x','a_y','b_x','b_y'],2],ec_mul:[['a_x','a_y','scalar'],2],ec_mul_generator:[['scalar'],2],hash_to_curve:[['inputs'],2],load_imm:[[],1],div_mod_power_of_two:[['var'],2],reconstitute_field:[['divisor','modulus'],1],output:[['var'],0],transient_hash:[['inputs'],1],persistent_hash:[['inputs'],2],test_eq:[['a','b'],1],add:[['a','b'],1],mul:[['a','b'],1],neg:[['a'],1],not:[['a'],1],less_than:[['a','b'],1],public_input:[['guard'],1],private_input:[['guard'],1]};
  const memory=Array.from({length:data.num_inputs},(_,i)=>`input:${i}`), edges=[], warnings=[];
  for (const [i,ins] of data.instructions.entries()) {
   const rule=schema[ins.op]; if(!rule){warnings.push(`Instruction ${i}: unknown opcode ${ins.op}; subsequent memory indices cannot be decoded.`);break;}
   for(const field of rule[0]) for(const value of (Array.isArray(ins[field])?ins[field]:[ins[field]])) {
    if(value==null) continue;
    if(!Number.isInteger(value) || value<0 || value>=memory.length) {warnings.push(`Instruction ${i}: invalid memory index ${value} in ${field}.`);continue;}
    edges.push({source:memory[value],target:String(i),label:`${field}: [${value}]`});
   }
   for(let j=0;j<rule[1];j++) memory.push(String(i));
  }
  return {data: {...data, inputs: Array.from({length:data.num_inputs}, (_,i)=>({name: `input ${i}`})), outputs: []}, edges, warnings};
 }
 if (!data || data.version?.major !== 3 || ![0,1].includes(data.version?.minor)) throw Error('Unsupported ZKIR version. Supported: 2.0, 3.0 and 3.1 (preview).');
 if (!Array.isArray(data.instructions) || !Array.isArray(data.inputs) || !Array.isArray(data.outputs) || typeof data.do_communications_commitment !== 'boolean') throw Error('Invalid circuit: inputs, outputs, instructions or commitment flag missing.');
 const producers=new Map(); const warnings=[]; const edges=[];
 for(const input of data.inputs) { if(typeof input?.name !== 'string') throw Error('Invalid typed input.'); producers.set(input.name, 'input:'+input.name); }
 data.instructions.forEach((inst,i)=>{
  if(!inst || typeof inst.op !== 'string') throw Error(`Instruction ${i} has no opcode.`);
  if(!Object.hasOwn(fields,inst.op)) { warnings.push(`Instruction ${i}: unsupported opcode ${inst.op}; dependencies may be incomplete.`); return; }
  for(const field of fields[inst.op]) { const val=inst[field]; for(const v of (Array.isArray(val)?val:[val])) { if(v == null && field === 'guard') continue; if(typeof v !== 'string') { warnings.push(`Instruction ${i}: invalid operand in ${field}.`); continue; } if (/^-?0x[0-9a-f]+$/i.test(v)) continue; const src=producers.get(v); if(src) edges.push({source:src,target:String(i),label:v,field}); else warnings.push(`Instruction ${i}: unresolved identifier ${v} in ${field}.`); } }
  const outs=[...(typeof inst.output==='string'?[inst.output]:[]),...(Array.isArray(inst.outputs)?inst.outputs:[])]; for(const out of outs) { if(typeof out !== 'string') { warnings.push(`Instruction ${i}: invalid output identifier.`); continue; } if(producers.has(out)) warnings.push(`Instruction ${i}: duplicate identifier ${out}.`); producers.set(out,String(i)); }
 });
 return {data,edges,warnings};
}
