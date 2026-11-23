import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFile} from 'node:fs/promises';
import {parse, limits} from '../src/parser.js';
import {analyzeArtifact, analysisJson, compareArtifacts, comparisonMarkdown} from '../src/analysis.js';

const circuit = {
  version: {major: 3, minor: 0},
  inputs: [{name: '%x', type: 'Scalar<BLS12-381>'}],
  do_communications_commitment: false,
  instructions: [
    {op: 'add', a: '%x', b: '0x01', output: '%y'},
    {op: 'assert', cond: '%y'},
    {op: 'encode', input: '%y', outputs: ['%a', '%b']},
  ],
};
const decode = data => parse(JSON.stringify(data));

test('tracks ZKIR 3.0 dependencies and multiple outputs', () => {
  const result = decode(circuit);
  assert.deepEqual(result.edges.map(edge => [edge.source, edge.target]), [['input:%x', '0'], ['0', '1'], ['0', '2']]);
  assert.equal(result.decoder.status, 'complete');
  assert.equal(result.warnings.length, 0);
});

test('routes output operands by serialized ZKIR minor version', () => {
  const legacy = decode({...circuit, instructions: [{op: 'output', val: '%x'}]});
  const current = decode({...circuit, version: {major: 3, minor: 1}, outputs: ['Scalar<BLS12-381>'],
    instructions: [{op: 'output', vals: ['%x']}]});
  assert.equal(legacy.edges[0].field, 'val');
  assert.equal(current.edges[0].field, 'vals');
  assert.equal(legacy.decoder.status, 'complete');
  assert.equal(current.decoder.status, 'complete');
  assert.notEqual(legacy.decoder.revision, current.decoder.revision);
});

test('labels malformed files, unsupported versions and oversize workloads', async () => {
  assert.throws(() => parse('{'), {code: 'invalid_input'});
  assert.throws(() => decode({...circuit, version: {major: 3, minor: 2}}), {code: 'unsupported_version'});
  assert.throws(() => parse('é'.repeat(30), 40), {code: 'limit_exceeded'});
  assert.throws(() => decode({version: {major: 2, minor: 0}, num_inputs: 1_000_000,
    do_communications_commitment: false, instructions: []}), {code: 'limit_exceeded'});
  assert.throws(() => decode({...circuit, instructions: [{op: 'future', entries: Array(limits.entriesPerInstruction).fill(0)}]}),
    {code: 'limit_exceeded'});
  assert.throws(() => parse('{"big": 1e400,' + JSON.stringify(circuit).slice(1)), {code: 'invalid_input'});
  await assert.rejects(analyzeArtifact(Uint8Array.of(255), 'bad.zkir', 'test'), {code: 'invalid_input'});
});

test('preserves unknown operations and identifies unresolved, ambiguous and forward references', () => {
  const unknown = {op: 'future', output: '%unknown'};
  const result = decode({...circuit, instructions: [
    {op: 'assert', cond: '%later'},
    {op: 'copy', val: '%x', output: '%later'},
    {op: 'assert', cond: '%duplicate'},
    {op: 'copy', val: '%x', output: '%duplicate'},
    {op: 'copy', val: '%x', output: '%duplicate', futureField: true},
    unknown,
    {op: 'assert', cond: '%unknown'},
  ]});
  assert.equal(result.decoder.status, 'partial');
  assert.deepEqual(result.instructions[5].raw, unknown);
  assert.equal(result.edges.length, 3);
  assert.deepEqual(new Set(result.diagnostics.map(({code}) => code)), new Set([
    'unknown_field', 'unknown_opcode', 'duplicate_identifier', 'ambiguous_identifier', 'forward_reference',
    'unresolved_identifier',
  ]));
});

test('decodes indexed dependencies until v2 memory arity becomes unknown', () => {
  const result = decode({
    version: {major: 2, minor: 0}, num_inputs: 2, do_communications_commitment: true,
    instructions: [{op: 'add', a: 0, b: 1}, {op: 'assert', cond: 2}, {op: 'constructor'}, {op: 'assert', cond: 3}],
  });
  assert.deepEqual(result.edges.map(edge => [edge.source, edge.target]), [['input:0', '0'], ['input:1', '0'], ['0', '1']]);
  assert.equal(result.decoder.decodedInstructions, 2);
  assert.equal(result.decoder.status, 'partial');
  assert.equal(result.instructions[3].decoded, false);
});

test('tracks ZKIR 3.1 byte conversion and hash dependencies', () => {
  const result = decode({
    ...circuit, version: {major: 3, minor: 1}, outputs: [],
    instructions: [
      {op: 'to_bytes', input: '%x', output: '%b'},
      {op: 'sha512', alignment: [], inputs: ['%b'], output: '%hash'},
      {op: 'bytes_into_natives', bytes: '%hash', outputs: ['%one', '%two']},
      {op: 'add', a: '%one', b: '%two', output: '%result'},
    ],
  });
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.edges.map(edge => [edge.source, edge.target]),
    [['input:%x', '0'], ['0', '1'], ['1', '2'], ['2', '3'], ['2', '3']]);
});

test('invalid operand shape emits a diagnostic and does not invent a dependency', () => {
  const result = decode({...circuit, instructions: [{op: 'add', a: ['%x'], b: 3, output: '%z'}]});
  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.diagnostics.map(({code}) => code), ['invalid_operand_shape', 'invalid_operand']);
});

test('reports compiler fixtures deterministically and preserves negative constants', async () => {
  const baselineBytes = await readFile(new URL('../public/examples/baseline.zkir', import.meta.url));
  const candidateBytes = await readFile(new URL('../public/examples/changed.zkir', import.meta.url));
  const baseline = await analyzeArtifact(baselineBytes, 'baseline.zkir', 'test');
  const candidate = await analyzeArtifact(candidateBytes, 'changed.zkir', 'test');
  const comparison = compareArtifacts(baseline, candidate);
  assert.equal(baseline.warnings.length, 0);
  assert.equal(baseline.instructions[2].operands.find(operand => operand.value === '-0x02')?.kind, 'constant');
  const report = analysisJson(baseline, candidate, comparison);
  const roundTrip = await analyzeArtifact(baselineBytes, 'baseline.zkir', 'test');
  assert.equal(analysisJson(roundTrip, candidate, compareArtifacts(roundTrip, candidate)), report);
  const exported = JSON.parse(report);
  assert.equal(exported.schema_version, 1);
  assert.equal(exported.baseline.artifact.sha256, '806154b41fe78910a9e1f6580d0bf436d59bb5d4b1eba5dbe6fdf6677bf5e2ca');
  assert.equal(exported.baseline.artifact.compilerVersion, null);
  assert.equal(exported.baseline.graph.edges.length, 2);
  assert.deepEqual(comparison.histogramDelta, [{opcode: 'mul', before: 0, after: 1, delta: 1}]);
  assert.match(comparisonMarkdown(baseline, candidate, comparison), /\| mul \| 0 \| 1 \| 1 \|/);
});

test('decodes the Compact 0.31.0 fixtures with the pinned structural rules', async () => {
  const fixture = async version => parse(await readFile(
    new URL(`fixtures/compact-0.31-zkir-${version}.zkir`, import.meta.url), 'utf8'));
  const indexed = await fixture('2.0');
  const named = await fixture('3.0');
  assert.equal(indexed.decoder.status, 'complete');
  assert.equal(named.decoder.status, 'complete');
  assert.equal(indexed.instructions.length, 21);
  assert.equal(indexed.edges.length, 16);
  assert.deepEqual(indexed.edges.slice(0, 2).map(({source, target}) => [source, target]), [['input:0', '1'], ['0', '1']]);
  assert.deepEqual(named.edges.map(({source, target}) => [source, target]), [['input:%x.0', '0'], ['0', '1']]);
  assert.equal(named.hasOutputSignature, false);
  const withSignature = decode({...circuit, outputs: ['Scalar<BLS12-381>'],
    instructions: [{op: 'output', vals: ['%x']}]});
  assert.equal(withSignature.decoder.status, 'complete');
  assert.equal(withSignature.edges[0].field, 'vals');
});
