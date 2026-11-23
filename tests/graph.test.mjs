import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {parse, operandFields} from '../src/parser.js';

test('the graph shows constants and follows the real example dependencies',()=>{
 const ids=['heading','explanation','expression','raw','operands','warning','lanes','counter','previous','next','search','list','file'];
 const dom=new JSDOM(ids.map(id=>id==='search'?'<input id="search">':`<div id="${id}"></div>`).join(''),{runScripts:'outside-only'});
 const {window}=dom;window.requestAnimationFrame=fn=>fn();let ready=false;window.acquireVsCodeApi=()=>({postMessage:msg=>{if(msg.type==='ready')ready=true;},setState:()=>{}});
 window.eval(readFileSync('extension/graph.js','utf8'));assert.equal(ready,true);
 const c=parse(readFileSync('public/examples/baseline.zkir','utf8'));
 window.dispatchEvent(new window.MessageEvent('message',{data:{type:'load',name:'baseline.zkir',selected:0,circuit:{instructions:c.data.instructions,edges:c.edges,warnings:c.warnings,version:'3.1',operandFields:c.data.instructions.map(op=>operandFields(op.op))}}}));
 assert.match(window.document.querySelector('#heading').textContent,/#0\s+add/);assert.match(window.document.querySelector('#expression').textContent,/%tmp\.1 = %x\.0 \+ 0x01/);
 assert.match(window.document.querySelector('#operands').textContent,/0x01constant/);assert.equal(window.document.querySelectorAll('svg .connection').length,2);
 const target=[...window.document.querySelectorAll('.lane button')].find(e=>e.textContent.includes('#2'));
 assert.ok(target,'consumer appears as a selectable node');target.click();
 assert.match(window.document.querySelector('#heading').textContent,/#2\s+impact/);
 assert.match(window.document.querySelector('#operands').textContent,/%tmp\.1variable/);
 assert.match(window.document.querySelector('#explanation').textContent,/public input/);
});
