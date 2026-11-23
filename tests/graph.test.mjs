import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {parse} from '../src/parser.js';

test('the graph traces dependencies and switches from operands to raw JSON', () => {
  const host = readFileSync('extension/extension.cjs', 'utf8');
  const markup = host.match(/<body>([\s\S]+?)<script nonce=/)[1];
  const dom = new JSDOM(markup, {runScripts: 'outside-only'});
  const {window} = dom;
  const messages = [];
  window.requestAnimationFrame = run => run();
  window.acquireVsCodeApi = () => ({postMessage: message => messages.push(message), setState() {}});
  window.eval(readFileSync('extension/graph.js', 'utf8'));
  assert.equal(messages[0].type, 'ready');

  const {instructions, edges, decoder, diagnostics} = parse(readFileSync('public/examples/baseline.zkir', 'utf8'));
  const deliver = data => window.dispatchEvent(new window.MessageEvent('message', {data}));
  const get = id => window.document.getElementById(id);
  deliver({type: 'load', name: 'baseline.zkir', selected: 0, circuit: {
    instructions, edges, status: decoder.status, warningCount: diagnostics.length, version: '3.1',
  }});
  assert.match(get('heading').textContent, /#0\s+add/);
  assert.match(get('expression').textContent, /%tmp\.1 = %x\.0 \+ 0x01/);
  assert.match(get('operands').textContent, /0x01constant/);
  assert.match(get('definitions').textContent, /%tmp\.1/);
  assert.equal(window.document.querySelectorAll('svg .connection[marker-end]').length, 2);
  const target = [...window.document.querySelectorAll('.lane button')].find(button => button.textContent.includes('#2'));
  assert.ok(target);
  target.click();
  assert.match(get('heading').textContent, /#2\s+impact/);
  assert.match(get('operands').textContent, /%tmp\.1identifier/);
  assert.match(get('explanation').textContent, /public input/);
  assert.equal(window.document.querySelector('[aria-current="true"]').dataset.index, '2');

  get('show-raw').click();
  assert.equal(get('operand-view').hidden, true);
  assert.equal(get('raw-view').hidden, false);
  assert.equal(get('show-raw').getAttribute('aria-pressed'), 'true');
  assert.equal(JSON.parse(get('raw').textContent).op, 'impact');
  get('copy-raw').click();
  assert.equal(messages.at(-1).type, 'copyRaw');
  assert.equal(messages.at(-1).index, 2);
  deliver({type: 'copyResult', index: 2, ok: true});
  assert.equal(get('copy-status').textContent, 'Copied');

  get('search').value = '%tmp.1';
  get('search').dispatchEvent(new window.Event('input'));
  assert.equal(get('list-count').textContent, '2 / 4');
  const branching = parse(readFileSync('public/examples/branching.zkir', 'utf8'));
  deliver({type: 'load', name: 'branching.zkir', selected: 3, circuit: {
    instructions: branching.instructions, edges: branching.edges, status: branching.decoder.status,
    warningCount: branching.diagnostics.length, version: '3.1',
  }});
  assert.match(get('heading').textContent, /#3\s+add/);
  const consumers = [...window.document.querySelectorAll('.lane:last-child button')];
  assert.equal(consumers.length, 3);
  const repeated = consumers.find(button => button.textContent.includes('#10'));
  assert.ok(repeated);
  assert.deepEqual([...repeated.querySelectorAll('small')].map(label => label.textContent),
    ['a · %shared.7', 'b · %shared.7']);
  assert.equal(window.document.querySelectorAll('svg .connection').length, 5);
  deliver({type: 'load', name: 'empty.zkir', selected: 2,
    circuit: {instructions: [], edges: [], status: 'complete', warningCount: 0, version: '3.1'}});
  assert.match(get('heading').textContent, /No instructions/);
  assert.equal(get('lanes').children.length, 0);
  assert.equal(get('raw').textContent, '');
  assert.equal(get('next').disabled, true);
  assert.equal(get('inspector').hidden, true);
  dom.window.close();
});
