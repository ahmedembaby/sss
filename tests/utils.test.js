// Run with: npm test   (no database needed)
const test = require('node:test');
const assert = require('node:assert');

// db.js opens a pool lazily; mock it so the helpers can be required without MySQL
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '../db' || request.endsWith('/db')) return { query: async () => [[]] };
  if (request === '../services/notify') return { notify: async () => {} };
  return origLoad.call(this, request, ...rest);
};

const { extractMentions, extractHashtags } = require('../utils/mentions');
const { notBlocked } = require('../utils/blocks');
const { toInt } = require('../utils/format');
const { isEncrypted, requiresEncryption } = require('../utils/e2ee');

test('mentions: finds unique @usernames, ignores emails', () => {
  assert.deepStrictEqual(extractMentions('hi @Ahmed_1 and @sara, mail me a@b.com @Ahmed_1'), ['ahmed_1', 'sara']);
});

test('hashtags: unicode tags, lowercased, no duplicates, not inside words', () => {
  assert.deepStrictEqual(extractHashtags('#Hello #مرحبا #hello a#b #x'), ['hello', 'مرحبا']);
});

test('notBlocked: one placeholder, column used consistently', () => {
  const sql = notBlocked('p.user_id');
  assert.strictEqual((sql.match(/\?/g) || []).length, 1);
  assert.ok(sql.includes('p.user_id'));
});

test('toInt clamps and falls back', () => {
  assert.strictEqual(toInt('abc', 5, 1, 10), 5);
  assert.strictEqual(toInt('99', 5, 1, 10), 10);
  assert.strictEqual(toInt('-4', 5, 1, 10), 1);
});

// The block check relies on: ids of a blocked pair sum to (target + viewer) and one of them is the target.
test('block sum trick is symmetric and has no false positives', () => {
  const hit = (blocker, blocked, target, viewer) => blocker + blocked === target + viewer && (blocker === target || blocked === target);
  assert.ok(hit(5, 9, 5, 9));   // viewer 9 blocked by 5 (target)
  assert.ok(hit(9, 5, 5, 9));   // viewer 9 blocked target 5
  for (let a = 1; a < 12; a++) for (let b = 1; b < 12; b++) for (let t = 1; t < 12; t++) for (let v = 1; v < 12; v++) {
    if (hit(a, b, t, v)) assert.ok((a === t && b === v) || (a === v && b === t) || (a === t && b === v));
  }
});

const { parse, inQuiet } = require('../services/prefs');

test('prefs: defaults and quiet hours (overnight window, timezone offset)', () => {
  const p = parse(null);
  assert.strictEqual(p.notif.message, true);
  const q = { enabled: true, start: 22, end: 7, tz: 120 }; // phone is UTC+2
  assert.strictEqual(inQuiet(q, new Date('2026-01-01T21:00:00Z')), true);  // 23:00 local
  assert.strictEqual(inQuiet(q, new Date('2026-01-01T06:00:00Z')), false); // 08:00 local
  assert.strictEqual(inQuiet(q, new Date('2026-01-01T03:00:00Z')), true);  // 05:00 local
  assert.strictEqual(inQuiet({ ...q, enabled: false }, new Date('2026-01-01T21:00:00Z')), false);
});

test('link preview refuses private / loopback addresses', () => {
  const { isPrivateIp } = require('../services/linkpreview');
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.18', '172.16.3.4', '169.254.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});


test('direct text messages require a valid E2EE envelope', () => {
  const ciphertext = 'e2ee:v1:' + 'A'.repeat(56);
  assert.strictEqual(isEncrypted(ciphertext), true);
  assert.strictEqual(isEncrypted('plain text'), false);
  assert.strictEqual(isEncrypted('e2ee:v1:short'), false);
  assert.strictEqual(isEncrypted('e2ee:v1:' + '!'.repeat(60)), false);
  assert.strictEqual(requiresEncryption('direct', 'plain text'), true);
  assert.strictEqual(requiresEncryption('direct', ciphertext), false);
  assert.strictEqual(requiresEncryption('group', 'plain text'), false);
});
