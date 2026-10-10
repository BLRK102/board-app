// Board.md <-> object, plus the card operations. Pure functions, no DOM, no I/O:
// shared by the web app (browser) and scripts/board-cli.mjs (Node).
export const COLUMNS = ['Notes', 'Today', 'Continue', 'Done'];

const CARD = /^- \[( |x)\] (.*)$/;
const DONE_DATE = / ✅ (\d{4}-\d{2}-\d{2})$/;
const FIELD_LINE = /^(\[\w+:: [^\]]*\]\s*)+$/;
const FIELD = /\[(\w+):: ([^\]]*)\]/g;

export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

export function parse(text) {
  const b = { front: [], head: [], cols: [], tail: [] };
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) b.front.push(lines[i]);
    i++;
  }
  let col = null, card = null, m;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('%%')) { b.tail = lines.slice(i); break; } // Kanban plugin settings block: keep verbatim
    if ((m = line.match(/^## (.+)$/))) {
      col = { name: m[1].trim(), extra: [], cards: [] };
      b.cols.push(col);
      card = null;
      continue;
    }
    if (!line.trim()) { card = null; continue; }
    if (col && (m = line.match(CARD))) {
      const d = m[2].match(DONE_DATE);
      card = { id: '', title: d ? m[2].slice(0, d.index) : m[2], done: m[1] === 'x', date: d ? d[1] : null, desc: [], fields: {} };
      col.cards.push(card);
      continue;
    }
    if (card && /^\s/.test(line)) {
      const t = line.trim();
      if (FIELD_LINE.test(t)) for (const [, k, v] of t.matchAll(FIELD)) card.fields[k] = v;
      else card.desc.push(t);
      continue;
    }
    (col ? col.extra : b.head).push(line); // anything we don't understand is kept, never dropped
  }
  const cards = allCards(b);
  for (const c of cards) { c.id = c.fields.id || ''; delete c.fields.id; }
  // Cards typed by hand (no id) or copy-pasted (duplicate id) get a stable id from their title, so the same text always parses the same.
  const used = new Set(), seen = {};
  for (const c of cards) if (c.id && !used.has(c.id)) used.add(c.id); else c.id = '';
  for (const c of cards) if (!c.id) {
    let n = seen[c.title] = (seen[c.title] || 0) + 1;
    while (used.has(c.id = stableId(c.title, n))) n++;
    used.add(c.id);
  }
  return b;
}

export function cardLines(c) {
  const fields = [['id', c.id], ...Object.entries(c.fields)].map(([k, v]) => `[${k}:: ${v}]`).join(' ');
  return [`- [${c.done ? 'x' : ' '}] ${c.title}${c.date ? ` ✅ ${c.date}` : ''}`, ...c.desc.map(d => `  ${d}`), `  ${fields}`];
}

export function serialize(b) {
  const out = [];
  if (b.front.length) out.push('---', ...b.front, '---', '');
  if (b.head.length) out.push(...b.head, '');
  for (const col of b.cols) out.push(`## ${col.name}`, ...col.extra, ...col.cards.flatMap(cardLines), '');
  out.push(...b.tail);
  return out.join('\n').replace(/\n*$/, '\n');
}

export const allCards = b => b.cols.flatMap(c => c.cards);

function stableId(title, n) { // FNV-1a, 4 base36 chars
  let h = 0x811c9dc5;
  for (const ch of `${title}
${n}`) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 1679616).toString(36).padStart(4, '0');
}

export function newId(b) {
  const used = new Set(allCards(b).map(c => c.id));
  let id = '';
  while (id.length !== 4 || used.has(id)) id = Math.random().toString(36).slice(2, 6);
  return id;
}

const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// Keeps every card writable as markdown: one-line title, no blank or field-looking desc lines, no brackets in values.
function clean(c) {
  c.title = oneLine(c.title);
  c.desc = (c.desc || []).flatMap(d => String(d).split('\n'))
    .map(d => d.trim().replace(/\[(\w+)::/g, '[$1:')).filter(Boolean);
  c.fields = Object.fromEntries(Object.entries(c.fields || {})
    .map(([k, v]) => [k, oneLine(v).replace(/[[\]]/g, '')])
    .filter(([k, v]) => /^\w+$/.test(k) && k !== 'id' && v));
  return c;
}

export function newCard(b, { title, desc = [], fields = {} }) {
  return clean({ id: newId(b), title, done: false, date: null, desc, fields });
}

export function column(b, name) {
  let c = b.cols.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!c) b.cols.push(c = { name, extra: [], cards: [] });
  return c;
}

export function findCard(b, id) {
  for (const col of b.cols) {
    const index = col.cards.findIndex(c => c.id === id);
    if (index >= 0) return { col, index, card: col.cards[index] };
  }
  return null;
}

// Returns null when applied, else why not ('gone' = the card no longer exists).
export function applyOp(b, op) {
  const found = op.id ? findCard(b, op.id) : null;
  switch (op.type) {
    case 'add': {
      if (findCard(b, op.card.id)) return null; // already applied (replay after a conflict)
      const card = clean(structuredClone(op.card));
      if (!card.title) return 'empty';
      column(b, op.col || 'Notes').cards.push(card);
      return null;
    }
    case 'move': {
      if (!found) return 'gone';
      const to = column(b, op.col);
      found.col.cards.splice(found.index, 1);
      to.cards.push(found.card);
      found.card.done = to.name === 'Done';
      found.card.date = found.card.done ? (found.card.date || op.date || today()) : null;
      return null;
    }
    case 'edit':
      if (!found) return 'gone';
      if ('title' in op.patch && !oneLine(op.patch.title)) return 'empty';
      Object.assign(found.card, structuredClone(op.patch));
      clean(found.card);
      return null;
    case 'delete':
      if (found) found.col.cards.splice(found.index, 1);
      return null;
    case 'rollover':
      rollover(b, op.date);
      return null;
    default:
      return 'unknown';
  }
}

export function replay(text, ops) {
  const board = parse(text), errors = [];
  for (const op of ops) {
    const error = applyOp(board, op);
    if (error) errors.push({ op, error });
  }
  return { board, errors };
}

const front = (b, key) => (b.front.find(l => l.startsWith(`${key}:`)) || '').slice(key.length + 1).trim();
function setFront(b, key, value) {
  const i = b.front.findIndex(l => l.startsWith(`${key}:`));
  if (i < 0) b.front.push(`${key}: ${value}`); else b.front[i] = `${key}: ${value}`;
}

export const needsRollover = (b, day = today()) => front(b, 'rollover') < day;

// Unfinished Today cards carry over to Continue. Safe to call any number of times a day.
export function rollover(b, day = today()) {
  if (!needsRollover(b, day)) return false;
  column(b, 'Continue').cards.push(...column(b, 'Today').cards.splice(0));
  setFront(b, 'rollover', day);
  return true;
}

// Takes Done cards finished more than keepDays ago off the board, grouped by 'YYYY-MM' for the archive files.
export function takeArchive(b, day = today(), keepDays = 7) {
  const cutoff = new Date(Date.parse(day) - keepDays * 864e5).toISOString().slice(0, 10);
  const done = column(b, 'Done'), out = {};
  done.cards = done.cards.filter(c => {
    if (!c.date || c.date >= cutoff) return true;
    (out[c.date.slice(0, 7)] ||= []).push(c);
    return false;
  });
  return out;
}

// GitHub's contents API speaks base64; these keep UTF-8 (emoji, accents) intact.
export function toBase64(text) {
  let bin = '';
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
}
export function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
}
