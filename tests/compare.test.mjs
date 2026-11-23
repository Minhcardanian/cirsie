import {test} from 'node:test';import {strict as assert} from 'node:assert';import {compareInstructions} from '../src/compare.js';
test('insertion leaves later identical instructions aligned',()=>{const a=[{op:'add'},{op:'assert'}],b=[{op:'mul'},...a];const result=compareInstructions(a,b);assert.equal(result.method,'sequence');assert.deepEqual(result.changes,[{beforeIndex:null,afterIndex:0}]);});
test('reports removal and handles large circuits with bounded memory',()=>{assert.deepEqual(compareInstructions([{op:'a'},{op:'b'}],[{op:'b'}]).changes,[{beforeIndex:0,afterIndex:null}]);assert.equal(compareInstructions([{op:'a'}],[{op:'b'}],1).method,'positional')});

test('matches object values independent of field order and preserves array order', () => {
  const before = [{op: 'add', meta: {a: 1, b: 2}}, {op: 'list', operands: ['%a', '%b']}];
  const after = [{meta: {b: 2, a: 1}, op: 'add'}, {op: 'list', operands: ['%b', '%a']}];
  assert.deepEqual(compareInstructions(before, after).matches, [{beforeIndex: 0, afterIndex: 0}]);
  const fallback = compareInstructions(before, after, 1);
  assert.equal(fallback.fallback, true);
  assert.deepEqual(fallback.changes, [{beforeIndex: 1, afterIndex: 1}]);
});
