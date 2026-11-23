import {schemas, signatureSchema30} from './schema.js';

export const limits = Object.freeze({
  artifactBytes: 4 * 1024 * 1024,
  instructions: 20_000,
  signatureItems: 10_000,
  entriesPerInstruction: 512,
  instructionBytes: 16 * 1024,
  edges: 60_000,
  jsonValues: 250_000,
  jsonDepth: 40,
});

export class ArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

export function checkArtifactSize(bytes, maximum = limits.artifactBytes) {
  if (bytes > maximum) {
    throw new ArtifactError('limit_exceeded',
      `File is ${bytes} bytes. The configured limit is ${maximum} bytes.`);
  }
}

const invalid = message => new ArtifactError('invalid_input', message);
const exceeded = (what, maximum) => new ArtifactError('limit_exceeded',
  `Artifact exceeds the ${what} limit (${maximum}).`);
const encoder = new TextEncoder();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const specs = fields => fields ? fields.split(' ') : [];
const fieldName = spec => spec.replace(/\[.*\]|\?$/, '');
const isName = value => typeof value === 'string' && value.startsWith('%') && value.length > 1;
const isHex = value => /^-?0x(?:[0-9a-f]{2})+$/i.test(value);
const isLegacyHex = value => /^-?(?:[0-9a-f]{2})+$/i.test(value);
const unsignedFields = new Set(['bits', 'count', 'start', 'len', 'index']);

function inspectJson(value, depth = 0, budget = {values: 0}) {
  if (++budget.values > limits.jsonValues) throw exceeded('JSON value count', limits.jsonValues);
  if (depth > limits.jsonDepth) throw exceeded('JSON depth', limits.jsonDepth);
  if (typeof value === 'number' && (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw invalid('A JSON number is outside the safely representable range.');
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) inspectJson(child, depth + 1, budget);
  }
}

function readField(instruction, spec, warn, read) {
  const field = fieldName(spec);
  const value = instruction[field];
  if (value == null && spec.endsWith('?')) return;
  const list = spec.includes('[');
  if (Array.isArray(value) !== list || (spec.endsWith('[2]') && value.length !== 2)) {
    warn('invalid_operand_shape', field, `invalid field shape in ${field}.`);
    return;
  }
  if (list) value.forEach((entry, index) => read(entry, field, index));
  else read(value, field);
}

/**
 * @typedef {{field: string, element?: number, value: any, kind: string, issue?: string, producer?: string}} Operand
 * @typedef {{index: number, opcode: string, raw: Record<string, any>, operands: Operand[],
 *   definitions: (string|number)[], known: boolean, decoded?: boolean}} Instruction
 */

/** @returns {Instruction} */
function inspectInstruction(instruction, index, indexed, schema, diagnose) {
  const operands = [], definitions = [];
  const warn = (code, field, message) => diagnose(code, message, index, field);
  const opcode = instruction.op;
  const known = Object.hasOwn(schema.instructions, opcode);
  if (!known) {
    warn('unknown_opcode', 'op', indexed
      ? 'unknown opcode; subsequent memory indices cannot be decoded.'
      : 'unsupported opcode; dependencies may be incomplete.');
    return {index, opcode, raw: instruction, operands, definitions, known};
  }

  const [operandSpecs, definitionSpecs, metadataSpecs] = schema.instructions[opcode];
  const operandList = specs(operandSpecs);
  const definitionList = indexed ? [] : specs(definitionSpecs);
  const metadata = specs(metadataSpecs);
  const expected = new Set(['op', ...operandList.map(fieldName), ...definitionList.map(fieldName), ...metadata]);
  for (const field of Object.keys(instruction)) {
    if (!expected.has(field)) warn('unknown_field', field, 'unrecognized instruction field.');
  }
  for (const field of metadata) {
    const value = instruction[field];
    if (!Object.hasOwn(instruction, field)) {
      warn('missing_field', field, 'missing instruction field.');
    } else if ((unsignedFields.has(field) && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) ||
               (field === 'type' && typeof value !== 'string') ||
               (field === 'alignment' && !Array.isArray(value))) {
      warn('invalid_field', field, 'invalid instruction field.');
    }
  }

  for (const spec of operandList) {
    readField(instruction, spec, warn, (value, field, element) => {
      const kind = indexed
        ? (Number.isSafeInteger(value) && value >= 0 ? 'memory_index' : 'invalid')
        : (isName(value) ? 'identifier' : typeof value === 'string' && isHex(value) ? 'constant' : 'invalid');
      operands.push({field, ...(element === undefined ? {} : {element}), value: value ?? null, kind});
      if (kind === 'invalid') warn('invalid_operand', field, `invalid operand in ${field}.`);
    });
  }
  const literalField = opcode === 'load_imm' ? 'imm' : opcode === 'load_constant' ? 'encoding[]' : null;
  if (literalField) {
    readField(instruction, literalField, warn, (value, field, element) => {
      const valid = typeof value === 'string' && (indexed ? isLegacyHex(value) : isHex(value));
      operands.push({field, ...(element === undefined ? {} : {element}),
        value: value ?? null, kind: valid ? 'constant' : 'invalid'});
      if (!valid) warn('invalid_operand', field, `invalid constant in ${field}.`);
    });
  }
  for (const spec of definitionList) {
    readField(instruction, spec, warn, (name, field) => {
      if (isName(name)) definitions.push(name);
      else warn('invalid_definition', field, 'invalid output identifier.');
    });
  }
  return {index, opcode, raw: instruction, operands, definitions, known};
}

/** Decode inspected data flow under the pinned structural rules. */
export function parse(text, maxBytes = limits.artifactBytes) {
  checkArtifactSize(text.length, maxBytes);
  checkArtifactSize(encoder.encode(text).length, maxBytes);
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw invalid('Invalid JSON. Choose a UTF-8 JSON .zkir artifact.'); }
  if (!record(raw) || !record(raw.version) || !Number.isInteger(raw.version.major) ||
      !Number.isInteger(raw.version.minor)) {
    throw invalid('Invalid circuit. Expected an object with integer ZKIR major and minor versions.');
  }

  const version = `${raw.version.major}.${raw.version.minor}`;
  if (!Object.hasOwn(schemas, version)) {
    throw new ArtifactError('unsupported_version',
      `Unsupported ZKIR version ${version}. Structural decoding supports 2.0, 3.0 and 3.1.`);
  }
  const hasSignature30 = version === '3.0' && Object.hasOwn(raw, 'outputs');
  const schema = hasSignature30 ? signatureSchema30 : schemas[version];
  const indexed = version === '2.0';
  const hasOutputSignature = version === '3.1' || hasSignature30;
  if (!Array.isArray(raw.instructions) || typeof raw.do_communications_commitment !== 'boolean' ||
      (indexed ? !Number.isSafeInteger(raw.num_inputs) || raw.num_inputs < 0 :
        !Array.isArray(raw.inputs) || (hasOutputSignature && !Array.isArray(raw.outputs)))) {
    throw invalid(`Invalid ZKIR ${version} circuit. Check its signature, instructions and commitment flag.`);
  }
  if (raw.instructions.length > limits.instructions) throw exceeded('instruction count', limits.instructions);
  const inputCount = indexed ? raw.num_inputs : raw.inputs.length;
  if (inputCount > limits.signatureItems || (hasOutputSignature && raw.outputs.length > limits.signatureItems)) {
    throw exceeded('signature item count', limits.signatureItems);
  }
  inspectJson(raw);
  const inputs = indexed
    ? Array.from({length: inputCount}, (_, index) => ({name: `input ${index}`}))
    : raw.inputs;
  const data = {...raw, inputs, outputs: hasOutputSignature ? raw.outputs : []};
  const diagnostics = [], edges = [];
  const diagnose = (code, message, instructionIndex, field) => diagnostics.push({
    severity: 'warning', code, ...(instructionIndex === undefined ? {} : {instructionIndex}),
    ...(field === undefined ? {} : {field}), message,
  });
  const envelope = new Set(['version', 'instructions', 'do_communications_commitment',
    ...(indexed ? ['num_inputs'] : ['inputs']), ...(hasOutputSignature ? ['outputs'] : [])]);
  for (const field of Object.keys(raw)) {
    if (!envelope.has(field)) diagnose('unknown_field', 'Unrecognized artifact field.', undefined, field);
  }

  /** @type {Instruction[]} */
  const instructions = data.instructions.map((instruction, index) => {
    if (!record(instruction) || typeof instruction.op !== 'string' || !instruction.op.length) {
      throw invalid(`Instruction ${index} has no opcode.`);
    }
    if (encoder.encode(JSON.stringify(instruction)).length > limits.instructionBytes) {
      throw exceeded('serialized instruction size', limits.instructionBytes);
    }
    const fieldEntries = Object.values(instruction).reduce(
      (total, value) => total + (Array.isArray(value) ? value.length : 1), 0);
    if (fieldEntries > limits.entriesPerInstruction) {
      throw exceeded('entries per instruction', limits.entriesPerInstruction);
    }
    return inspectInstruction(instruction, index, indexed, schema, diagnose);
  });
  const producers = new Map();
  const memory = indexed ? inputs.map((_, index) => `input:${index}`) : [];
  function define(name, producer, index) {
    if (producers.has(name)) {
      diagnose('duplicate_identifier', `duplicate identifier ${name}.`, index);
      producers.set(name, null);
    } else producers.set(name, producer);
  }
  if (!indexed) {
    inputs.forEach((input, index) => {
      if (!record(input) || !isName(input.name) || typeof input.type !== 'string') {
        diagnose('invalid_input_signature', `Invalid typed input at index ${index}.`);
        return;
      }
      define(input.name, `input:${input.name}`);
    });
    data.outputs.forEach((output, index) => {
      if (typeof output !== 'string') diagnose('invalid_output_signature', `Invalid output type at index ${index}.`);
    });
    for (const {definitions, index} of instructions) {
      for (const name of definitions) define(name, String(index), index);
    }
  }

  let memoryAvailable = true;
  let decodedInstructions = 0;
  for (const instruction of instructions) {
    const {index, opcode, known, operands, definitions} = instruction;
    if (indexed && !known) memoryAvailable = false;
    instruction.decoded = known && (!indexed || memoryAvailable);
    if (!instruction.decoded) continue;
    decodedInstructions++;
    for (const operand of operands) {
      const {kind, value, field, element} = operand;
      if (kind === 'invalid' || kind === 'constant') continue;
      const producer = indexed ? memory[value] : producers.get(value);
      let issue;
      if (producer === null) issue = ['ambiguous_identifier', `ambiguous identifier ${value} in ${field}.`];
      else if (producer === undefined) issue = indexed
        ? ['invalid_memory_index', `invalid memory index ${value} in ${field}.`]
        : ['unresolved_identifier', `unresolved identifier ${value} in ${field}.`];
      else if (!indexed && Number(producer) >= index) {
        issue = ['forward_reference', `forward or self reference to ${value} in ${field}.`];
      }
      if (issue) {
        operand.issue = issue[0];
        diagnose(issue[0], issue[1], index, field);
        continue;
      }
      operand.producer = producer;
      edges.push({source: producer, target: String(index), label: indexed ? `${field}: [${value}]` : value,
        field, ...(element === undefined ? {} : {element})});
      if (edges.length > limits.edges) throw exceeded('dependency edge count', limits.edges);
    }
    if (indexed) {
      for (let i = 0; i < schema.instructions[opcode][1]; i++) {
        definitions.push(memory.length);
        memory.push(String(index));
      }
    }
  }

  const warnings = diagnostics.map(({instructionIndex, field, message}) =>
    `${instructionIndex === undefined ? '' : `Instruction ${instructionIndex}: `}${message}${field ? ` [${field}]` : ''}`);
  const {instructions: _, ...provenance} = schema;
  return {data, edges, warnings, diagnostics, instructions, hasOutputSignature, decoder: {
    ...provenance, status: diagnostics.length ? 'partial' : 'complete',
    decodedInstructions, totalInstructions: instructions.length,
  }};
}
