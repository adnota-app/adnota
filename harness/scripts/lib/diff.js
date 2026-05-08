// Structural diff for captured-state objects. Walks both sides recursively and
// emits a flat list of differences keyed by dotted path. Returns [] when equal.

export function diffState(expected, actual) {
  const diffs = [];
  walk('', expected, actual, diffs);
  return diffs;
}

function walk(path, a, b, diffs) {
  if (a === b) return;

  if (a == null || b == null || typeof a !== typeof b) {
    diffs.push({ path, expected: a, actual: b });
    return;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      diffs.push({ path, expected: a, actual: b });
      return;
    }
    for (let i = 0; i < a.length; i++) walk(`${path}[${i}]`, a[i], b[i], diffs);
    return;
  }

  if (typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      walk(path ? `${path}.${k}` : k, a[k], b[k], diffs);
    }
    return;
  }

  diffs.push({ path, expected: a, actual: b });
}

export function formatDiffs(diffs) {
  return diffs.map(d => {
    const e = JSON.stringify(d.expected);
    const a = JSON.stringify(d.actual);
    return `  ${d.path}\n    expected: ${truncate(e)}\n    actual:   ${truncate(a)}`;
  }).join('\n\n');
}

function truncate(s, max = 200) {
  if (s == null) return s;
  return s.length > max ? s.slice(0, max) + '...' : s;
}
