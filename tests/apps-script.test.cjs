const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const code = fs.readFileSync('apps-script/Code.gs', 'utf8');

function loadSandbox() {
  const props = new Map();
  const sheetValues = [['created', 'id']];
  const sheet = {
    getLastRow: () => sheetValues.length,
    getRange: (row, col, rows = 1, cols = 1) => ({
      setValues(values) { sheetValues[row - 1] = values[0]; return this; },
      getValue() { return (sheetValues[row - 1] || [])[col - 1] || ''; },
      setBackground(){ return this; }, setFontColor(){ return this; }, setFontWeight(){ return this; }
    }),
    createTextFinder: (text) => ({ matchEntireCell(){ return this; }, findAll(){
      const out = [];
      sheetValues.forEach((r, i) => r.forEach((v, j) => { if (v === text) out.push({getColumn: () => j + 1, getRow: () => i + 1}); }));
      return out;
    }}),
    appendRow(row) { sheetValues.push(row); },
    setFrozenRows(){}, setRightToLeft(){}, setColumnWidths(){}, setColumnWidth(){}
  };
  const sandbox = {
    console,
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    RegExp,
    Math,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props.get(k) || '',
      setProperty: (k, v) => props.set(k, String(v)),
      deleteProperty: (k) => props.delete(k),
      getProperties: () => Object.fromEntries(props)
    })},
    Utilities: {
      Charset: {UTF_8: 'UTF_8'},
      getUuid: () => '00000000-0000-4000-8000-000000000001',
      computeHmacSha256Signature: (payload, secret) => Array.from(crypto.createHmac('sha256', secret).update(payload).digest()).map(b => b > 127 ? b - 256 : b),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map(b => b > 127 ? b - 256 : b),
      newBlob: (bytes) => ({bytes: Buffer.from(bytes.map(b => (b + 256) % 256))}),
      formatDate: () => '2026-10-02'
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock(){} }) },
    ContentService: { MimeType: {JSON: 'JSON'}, createTextOutput: (text) => ({ text, mime: null, setMimeType(m){ this.mime = m; return this; } }) },
    ScriptApp: { getOAuthToken: () => 'token' },
    UrlFetchApp: { fetch: () => { throw new Error('fetch not stubbed'); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  props.set('CALLBACK_SECRET', 'a'.repeat(64));
  props.set('SPREADSHEET_ID', 'sheet');
  props.set('DRIVE_FOLDER_ID', 'folder');
  props.set('GITHUB_OWNER', 'novabyte2026');
  props.set('GITHUB_REPO', 'draive');
  return {sandbox, props, sheetValues};
}

function signed(secret, message) {
  const payload = JSON.stringify(message);
  return {postData: {contents: JSON.stringify({payload, signature: crypto.createHmac('sha256', secret).update(payload).digest('hex')})}};
}

test('normalizeUrl_ accepts single public video URLs and rejects host tricks', () => {
  const {sandbox} = loadSandbox();
  assert.equal(sandbox.normalizeUrl_('https://youtu.be/ABCDEFGHI01?t=5'), 'https://www.youtube.com/watch?v=ABCDEFGHI01');
  assert.throws(() => sandbox.normalizeUrl_('https://youtube.com.evil.test/watch?v=ABCDEFGHI01'), /INVALID_URL/);
  assert.throws(() => sandbox.normalizeUrl_('http://www.youtube.com/watch?v=ABCDEFGHI01'), /INVALID_URL/);
});

test('authenticate_ verifies HMAC and timestamp', () => {
  const {sandbox} = loadSandbox();
  const msg = {ts: Math.floor(Date.now() / 1000), job_id: '00000000-0000-0000-0000-000000000001', run_id: '1.1', action: 'claim', data: {}};
  assert.equal(sandbox.authenticate_(signed('a'.repeat(64), msg)).action, 'claim');
  assert.throws(() => sandbox.authenticate_(signed('b'.repeat(64), msg)), /AUTH_FAILED/);
  assert.throws(() => sandbox.authenticate_(signed('a'.repeat(64), {...msg, ts: 1})), /EXPIRED_SIGNATURE/);
});

test('claim fences duplicate runners and returns no secret fields', () => {
  const {sandbox, props} = loadSandbox();
  const job = {id: '00000000-0000-0000-0000-000000000001', url: 'https://www.youtube.com/watch?v=ABCDEFGHI01', format: 'mp4', status: 'queued', created: Date.now(), updated: Date.now(), offset: 0, maxBytes: 1000000, maxDuration: 60, row: 2};
  props.set('DRAIVE_JOB_' + job.id, JSON.stringify(job));
  const first = sandbox.handle_({job_id: job.id, run_id: '100.1', action: 'claim', data: {}});
  assert.equal(first.url, job.url);
  assert.equal(first.secret, undefined);
  assert.throws(() => sandbox.handle_({job_id: job.id, run_id: '101.1', action: 'claim', data: {}}), /JOB_CLAIMED/);
});

test('save_ relocates a sorted sheet row instead of overwriting another request', () => {
  const {sandbox, props, sheetValues} = loadSandbox();
  const job = {id: '00000000-0000-0000-0000-000000000001', url: 'u', format: 'mp4', status: 'queued', created: Date.now(), updated: Date.now(), row: 3};
  sheetValues.push(['old', 'other']);
  sheetValues.push(['old', job.id]);
  props.set('DRAIVE_JOB_' + job.id, JSON.stringify(job));
  sheetValues.reverse();
  sandbox.save_(job);
  const updatedRow = sheetValues.find(r => r[1] === job.id && r.length > 4);
  assert.equal(updatedRow[4], 'ממתין');
  assert.equal(sheetValues.filter(r => r[1] === 'other').length, 1);
});
