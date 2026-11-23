import {ArtifactError, checkArtifactSize, limits, parse} from './parser.js';
import {compareInstructions} from './compare.js';

const schemaVersion = 1;

function histogram(instructions) {
  const counts = new Map();
  for (const {op} of instructions) counts.set(op, (counts.get(op) ?? 0) + 1);
  return [...counts.keys()].sort().map(opcode => ({opcode, count: counts.get(opcode)}));
}

export async function analyzeArtifact(bytes, name, toolVersion, maxBytes = limits.artifactBytes, crypto = globalThis.crypto) {
  checkArtifactSize(bytes.byteLength, maxBytes);
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { throw new ArtifactError('invalid_input', 'Invalid UTF-8. Save the artifact as UTF-8 JSON.'); }
  const parsed = parse(text, maxBytes);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const {data, decoder} = parsed;
  return {
    ...parsed,
    artifact: {name, sha256, bytes: bytes.byteLength, zkirVersion: `${data.version.major}.${data.version.minor}`,
      compilerVersion: null},
    decoder: {...decoder, name: 'Cirsie structural decoder', version: toolVersion},
    summary: {
      inputs: data.inputs,
      outputs: parsed.hasOutputSignature ? data.outputs : null,
      instructions: data.instructions.length,
      opcodes: histogram(data.instructions),
      communicationsCommitment: data.do_communications_commitment,
    },
  };
}

export function compareArtifacts(baseline, candidate) {
  const result = compareInstructions(baseline.data.instructions, candidate.data.instructions);
  const a = new Map(baseline.summary.opcodes.map(row => [row.opcode, row.count]));
  const b = new Map(candidate.summary.opcodes.map(row => [row.opcode, row.count]));
  const histogramDelta = [...new Set([...a.keys(), ...b.keys()])].sort().flatMap(opcode => {
    const before = a.get(opcode) ?? 0, after = b.get(opcode) ?? 0;
    return before === after ? [] : [{opcode, before, after, delta: after - before}];
  });
  const counts = {matched: result.matches.length, added: 0, removed: 0, positionalDifferences: 0};
  for (const {beforeIndex, afterIndex} of result.changes) {
    if (beforeIndex === null) counts.added++;
    else if (afterIndex === null) counts.removed++;
    else counts.positionalDifferences++;
  }
  return {...result, counts, histogramDelta, coverage: {
    baseline: baseline.decoder.status, candidate: candidate.decoder.status,
  }};
}

function artifactEvidence({artifact, decoder, summary, diagnostics}) {
  return {artifact, decoder, summary, diagnostics};
}

export function analysisJson(baseline, candidate, comparison) {
  const result = {
    schema_version: schemaVersion,
    tool: {name: 'Cirsie', version: baseline.decoder.version},
    baseline: {...artifactEvidence(baseline), instructions: baseline.instructions,
      graph: {edges: baseline.edges, omittedCount: 0}},
  };
  if (candidate && comparison) {
    result.candidate = {...artifactEvidence(candidate), instructions: candidate.instructions,
      graph: {edges: candidate.edges, omittedCount: 0}};
    result.comparison = comparison;
  }
  return JSON.stringify(result) + '\n';
}

const escapeMarkdown = text => String(text).replace(/[\r\n\u2028\u2029]/g, ' ')
  .replace(/[&<>]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[char]))
  .replace(/[\\`*_\[\]|]/g, '\\$&');

// Indented code blocks preserve JSON containing Markdown fence characters.
const codeBlock = value => (value ? JSON.stringify(value, null, 2) : '(none)')
  .split('\n').map(line => '    ' + line).join('\n');

export function comparisonMarkdown(baseline, candidate, comparison) {
  const {changes, histogramDelta, counts, fallback} = comparison;
  const detail = changes.slice(0, 100).map(({beforeIndex, afterIndex}) => {
    const before = baseline.data.instructions[beforeIndex], after = candidate.data.instructions[afterIndex];
    const title = before ? `Baseline #${beforeIndex}` : `Added at candidate #${afterIndex}`;
    return `### ${title}\n\nBaseline\n\n${codeBlock(before)}\n\nCandidate\n\n${codeBlock(after)}`;
  });
  const rows = histogramDelta.slice(0, 100).map(({opcode, before, after, delta}) =>
    `| ${escapeMarkdown(opcode.slice(0, 120))}${opcode.length > 120 ? '…' : ''} | ${before} | ${after} | ${delta} |`);
  const coverage = [baseline, candidate].map(({decoder, diagnostics}) =>
    `${decoder.status} (${diagnostics.length} diagnostics; schema ${decoder.revision})`).join(' → ');
  return [
    '# Circuit comparison',
    `**${escapeMarkdown(baseline.artifact.name)} → ${escapeMarkdown(candidate.artifact.name)}**`,
    `- Instructions: ${baseline.summary.instructions} → ${candidate.summary.instructions}\n` +
      `- ZKIR: ${baseline.artifact.zkirVersion} → ${candidate.artifact.zkirVersion}\n` +
      `- Baseline SHA-256: \`${baseline.artifact.sha256}\` (${baseline.artifact.bytes} bytes)\n` +
      `- Candidate SHA-256: \`${candidate.artifact.sha256}\` (${candidate.artifact.bytes} bytes)\n` +
      `- Decoder coverage: ${coverage}\n` +
      `- Cirsie ${baseline.decoder.version}, schema version ${schemaVersion}\n` +
      `- Comparison: ${fallback ? 'positional fallback (alignment cell limit exceeded)' : 'longest common subsequence'}\n` +
      `- Matched: ${counts.matched} · Added: ${counts.added} · Removed: ${counts.removed} · Positional differences: ${counts.positionalDifferences}`,
    'Matches compare parsed JSON, preserving array order and identifier spelling. Position-based results can include shifted instructions. This structural comparison makes no claim about equivalence or proof cost.',
    '## Opcode counts\n\n| Opcode | Baseline | Candidate | Change |\n| --- | ---: | ---: | ---: |\n' +
      (rows.join('\n') || '| No count changes | | | |') +
      (histogramDelta.length > 100 ? '\n\nShowing the first 100 opcode changes.' : ''),
    `## Changed instructions\n\n${detail.join('\n\n') || 'No differences.'}` +
      (changes.length > 100 ? '\n\nShowing the first 100 instruction differences.' : ''),
  ].join('\n\n') + '\n';
}
