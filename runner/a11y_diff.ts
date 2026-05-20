import {createPatch} from 'diff';

// Fixed key order for the AT-tree JSON canonical form. Anything not in this
// list is dropped from the snapshot to keep diffs focused on AT-relevant fields.
const A11Y_KEY_ORDER = [
  'role',
  'name',
  'value',
  'description',
  'keyshortcuts',
  'roledescription',
  'valuetext',
  'disabled',
  'expanded',
  'focused',
  'modal',
  'multiline',
  'multiselectable',
  'readonly',
  'required',
  'selected',
  'checked',
  'pressed',
  'level',
  'valuemin',
  'valuemax',
  'autocomplete',
  'haspopup',
  'invalid',
  'orientation',
  'children',
];

// Drop fields whose values match the AT-tree default to reduce diff noise.
const DEFAULTS: Record<string, unknown> = {
  focused: false,
  disabled: false,
  expanded: false,
  modal: false,
  multiline: false,
  multiselectable: false,
  readonly: false,
  required: false,
  selected: false,
  pressed: false,
  invalid: 'false',
};

function canonicalNode(node: any): any {
  const out: Record<string, unknown> = {};
  for (const key of A11Y_KEY_ORDER) {
    if (!(key in node)) continue;
    const value = node[key];
    if (value === null || value === undefined) continue;
    if (key in DEFAULTS && DEFAULTS[key] === value) continue;
    if (key === 'children') {
      out.children = Array.isArray(value) ? value.map(canonicalNode) : [];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function canonicalize(tree: any | null): string {
  if (tree === null || tree === undefined) {
    return JSON.stringify(null, null, 2);
  }
  return JSON.stringify(canonicalNode(tree), null, 2);
}

// --- screen-reader style outline -------------------------------------------
//
// Walks the canonical tree and emits one line per AT-meaningful node, e.g.
//   heading level 1 — "Welcome"
//   navigation — "Site menu"
//     link — "Home"
//     list
//       listitem
//         link — "Create event"
// Roles that carry no meaning of their own (generic, none, presentation) get
// flattened away — their children appear at the parent's indent level, the
// way a screen reader treats them.

// Roles that carry no meaning of their own — flattened away. Their children
// appear at the parent's indent level, the way a screen reader treats them.
const SILENT_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  // Browser-internal: InlineTextBox wraps individual word fragments so the
  // engine can do line-breaking. Screen readers never expose them.
  'InlineTextBox',
]);

// StaticText/text nodes always carry their full text in `name`. The
// InlineTextBox children duplicate that text. After flattening InlineTextBox
// the StaticText becomes a leaf; drop it entirely if its name is empty.
// Icon fonts (e.g. Indico's UI icons) live in the Unicode Private Use Area;
// screen readers read them as nothing or as opaque code points. Strip them so
// they don't dominate the outline.
const PUA_CHAR = /[-]+/g;

function strippedName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(PUA_CHAR, '').replace(/\s+/g, ' ').trim();
}

function isEmptyText(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  const role = String(node.role ?? '');
  if (role !== 'StaticText' && role !== 'text') return false;
  return strippedName(node.name) === '';
}

// state/property keys worth surfacing in plain-English form
const STATE_LABELS: Record<string, (v: unknown) => string | null> = {
  disabled:        v => v ? 'disabled' : null,
  expanded:        v => v ? 'expanded' : 'collapsed',
  focused:         () => null,  // transient; never a meaningful diff
  modal:           v => v ? 'modal' : null,
  required:        v => v ? 'required' : null,
  readonly:        v => v ? 'read-only' : null,
  multiline:       v => v ? 'multiline' : null,
  multiselectable: v => v ? 'multi-select' : null,
  selected:        v => v ? 'selected' : null,
  checked:         v => v === 'mixed' ? 'partially checked' : (v ? 'checked' : null),
  pressed:         v => v ? 'pressed' : null,
  haspopup:        v => v && v !== 'false' ? 'has popup' : null,
  invalid:         v => v && v !== 'false' ? 'invalid' : null,
  autocomplete:    v => v && v !== 'none' && v !== 'false' ? `autocomplete: ${v}` : null,
  orientation:     v => v ? `${v}` : null,
};

function quote(s: string): string {
  // PUA icon glyphs are stripped; multi-line names get squashed onto one line
  // so the outline stays line-aligned.
  return JSON.stringify(strippedName(s));
}

// Plain-English role labels for common Chromium roles. Anything not listed
// passes through verbatim — adding entries is the cheapest way to soften the
// outline for readers who aren't AT-tree natives.
const ROLE_LABELS: Record<string, string> = {
  RootWebArea: 'page',
  StaticText: 'text',
  inlineTextBox: 'text',
  LineBreak: 'line break',
  LabelText: 'label',
  listitem: 'list item',
  navigation: 'navigation landmark',
  banner: 'banner landmark',
  main: 'main landmark',
  contentinfo: 'footer landmark',
  complementary: 'aside landmark',
  region: 'region',
  search: 'search landmark',
  form: 'form landmark',
};

function describeNode(node: any): string {
  const role = String(node.role ?? '');
  let head = ROLE_LABELS[role] ?? role;
  if (role === 'heading' && node.level != null) head = `heading level ${node.level}`;

  const parts: string[] = [head];

  if (typeof node.name === 'string' && strippedName(node.name).length) {
    parts.push(`— ${quote(node.name)}`);
  }
  if (node.value !== undefined && node.value !== null && node.value !== '') {
    parts.push(`(value: ${quote(String(node.value))})`);
  }
  if (typeof node.valuetext === 'string' && node.valuetext.length) {
    parts.push(`(value: ${quote(node.valuetext)})`);
  }
  if (typeof node.description === 'string' && node.description.length) {
    parts.push(`— description: ${quote(node.description)}`);
  }
  if (typeof node.roledescription === 'string' && node.roledescription.length) {
    parts.push(`(described as ${quote(node.roledescription)})`);
  }
  if (typeof node.keyshortcuts === 'string' && node.keyshortcuts.length) {
    parts.push(`(shortcut: ${node.keyshortcuts})`);
  }

  const flags: string[] = [];
  for (const [key, fn] of Object.entries(STATE_LABELS)) {
    if (key in node) {
      const label = fn(node[key]);
      if (label) flags.push(label);
    }
  }
  if (node.level != null && role !== 'heading') flags.push(`level ${node.level}`);
  if (flags.length) parts.push(`[${flags.join(', ')}]`);

  return parts.join(' ');
}

function isRedundantTextChild(parent: any, child: any): boolean {
  // When a link/button/heading has a `text` child whose content is the same
  // string as the parent's accessible name, the child adds nothing.
  if (!child || child.role !== 'StaticText') return false;
  if (!parent || typeof parent.name !== 'string') return false;
  const childName = strippedName(child.name);
  const parentName = strippedName(parent.name);
  return childName === parentName && parentName.length > 0;
}

function outlineLines(
  node: any,
  depth: number,
  logicalParent: any | null,
  out: string[],
): void {
  if (!node || typeof node !== 'object') return;
  const role = String(node.role ?? '');
  const children: any[] = Array.isArray(node.children) ? node.children : [];

  if (SILENT_ROLES.has(role) || isEmptyText(node)) {
    // Splice children at the same depth, preserving logicalParent so the
    // redundancy check below can still see the closest *visible* ancestor.
    for (const child of children) outlineLines(child, depth, logicalParent, out);
    return;
  }
  if (logicalParent && isRedundantTextChild(logicalParent, node)) return;

  out.push('  '.repeat(depth) + describeNode(node));
  // StaticText already carries its full content in `name` — its children are
  // just per-word fragments; emitting them adds noise.
  if (role === 'StaticText' || role === 'text') return;
  for (const child of children) outlineLines(child, depth + 1, node, out);
}

export function outline(tree: any | null): string {
  if (!tree) return '(empty tree)\n';
  const lines: string[] = [];
  outlineLines(canonicalNode(tree), 0, null, lines);
  return lines.join('\n') + '\n';
}

function parseTreeJson(jsonStr: string): any {
  try {
    const v = JSON.parse(jsonStr);
    return v == null ? null : v;
  } catch {
    return null;
  }
}

// Re-derive an outline from a stored canonical-tree JSON string.
export function outlineFromJson(jsonStr: string): string {
  return outline(parseTreeJson(jsonStr));
}

export function countNodes(tree: any | null): number {
  if (!tree) return 0;
  let n = 1;
  const children = Array.isArray(tree.children) ? tree.children : [];
  for (const child of children) {
    n += countNodes(child);
  }
  return n;
}

export interface A11yDiffResult {
  unchanged: boolean;
  diffText: string | null;
  added: number;
  removed: number;
}

export function compareTrees(baselineJson: string, actualJson: string): A11yDiffResult {
  // Exactness check on the canonical JSON — same bytes means the AT-relevant
  // structure is byte-identical. Diff the human outline rather than the JSON
  // so the diff is meaningful to reviewers who don't read AX-tree JSON.
  if (baselineJson === actualJson) {
    return {unchanged: true, diffText: null, added: 0, removed: 0};
  }
  const baselineOutline = outlineFromJson(baselineJson);
  const actualOutline = outlineFromJson(actualJson);
  if (baselineOutline === actualOutline) {
    // Canonical JSON differs but the human view is identical (e.g. only
    // transient/focus fields shifted). Treat as unchanged so we don't ping the
    // reviewer about something they couldn't perceive.
    return {unchanged: true, diffText: null, added: 0, removed: 0};
  }
  const patch = createPatch('accessibility tree', baselineOutline, actualOutline, 'baseline', 'proposal');
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return {unchanged: false, diffText: patch, added, removed};
}
