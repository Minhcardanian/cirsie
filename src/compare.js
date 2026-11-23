export const maxAlignmentCells = 2_000_000;

// Object field order and formatting are incidental to the parsed instruction.
// Array order and identifier spelling are preserved.
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function compareInstructions(before, after, maxCells = maxAlignmentCells) {
  const identities = new Map();
  const identify = instruction => {
    const key = canonicalJson(instruction);
    if (!identities.has(key)) identities.set(key, identities.size);
    return identities.get(key);
  };
  const a = before.map(identify), b = after.map(identify);
  const changes = [], matches = [];
  const width = b.length + 1;
  const cells = (a.length + 1) * width;
  if (cells > maxCells) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const pair = {beforeIndex: index < a.length ? index : null, afterIndex: index < b.length ? index : null};
      (a[index] === b[index] ? matches : changes).push(pair);
    }
    return {method: 'positional', fallback: true, maxCells, matches, changes};
  }

  const lengths = new Uint32Array(cells);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] = a[i] === b[j] ? 1 + lengths[(i + 1) * width + j + 1]
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      matches.push({beforeIndex: i++, afterIndex: j++});
    } else if (i === a.length || (j < b.length && lengths[i * width + j + 1] > lengths[(i + 1) * width + j])) {
      changes.push({beforeIndex: null, afterIndex: j++});
    } else {
      changes.push({beforeIndex: i++, afterIndex: null});
    }
  }
  return {method: 'sequence', fallback: false, maxCells, matches, changes};
}
