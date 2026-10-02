/**
 * Draive bridge. Secrets live ONLY in Project Settings -> Script Properties.
 * The binary file goes Actions -> this web app -> Google Drive, in 1 MiB chunks.
 * Never return an OAuth token or a Drive resumable-session URL to the worker.
 */
const DRAIVE = Object.freeze({
  sheetName: 'בקשות Draive', chunkSize: 1024 * 1024, jobPrefix: 'DRAIVE_JOB_',
  headers: ['נוצר', 'מזהה בקשה', 'קישור YouTube', 'סוג', 'מצב', 'הועברו בתים',
    'גודל בבתים', 'קישור לקובץ', 'הודעה', 'עודכן', 'הרצת GitHub'],
  status: {queued: 'ממתין', downloading: 'מוריד', uploading: 'מעלה לדרייב', done: 'הושלם', error: 'נכשל'}
});
const DRAIVE_ERRORS = Object.freeze({
  INVALID_URL: 'יש להזין קישור HTTPS לסרטון YouTube בודד.',
  INVALID_FORMAT: 'הפורמט חייב להיות MP3 או MP4.',
  YOUTUBE_AUTH_REQUIRED: 'יוטיוב דורש התחברות או אימות. ההורדה ללא עוגיות אינה זמינה לבקשה הזו.',
  YOUTUBE_BLOCKED: 'יוטיוב חסם את הבקשה מכתובת השרת.',
  YOUTUBE_RATE_LIMIT: 'יוטיוב הגביל זמנית את קצב הבקשות.',
  VIDEO_UNAVAILABLE: 'הסרטון אינו זמין לצפייה ציבורית משרת ההורדה.',
  FORMAT_UNAVAILABLE: 'הפורמט המבוקש אינו זמין במסגרת המגבלות.',
  LIVE_UNSUPPORTED: 'שידור חי או מתוכנן אינו נתמך.',
  DURATION_LIMIT: 'אורך הסרטון אינו ידוע או חורג מהמגבלה שהוגדרה.',
  FILE_TOO_LARGE: 'הקובץ חורג ממגבלת הגודל שהוגדרה.',
  DOWNLOAD_TIMEOUT: 'ההורדה חרגה מהזמן המותר.',
  DOWNLOAD_FAILED: 'ההורדה נכשלה. ייתכן שינוי ביוטיוב או חסימה של השרת.',
  DRIVE_ERROR: 'העלאה לדרייב נכשלה. בדוק מקום פנוי, הרשאות והפעלת Drive API.',
  UPLOAD_EXPIRED: 'העברת הקובץ לדרייב פגה. יש לשלוח בקשה חדשה.',
  CHECKSUM_MISMATCH: 'בדיקת שלמות הקובץ נכשלה. הקובץ לא מסומן כהושלם.',
  SETUP_FAILED: 'הכנת סביבת ההורדה נכשלה. בדוק את לשונית Actions.',
  STALE: 'לא התקבל עדכון בזמן. בדוק אם הרצת Actions הושהתה, בוטלה או נכשלה.',
  DISPATCH_FAILED: 'GitHub לא קיבל את הבקשה. בדוק טוקן, הרשאת Actions ושם Workflow.',
  QUEUE_FULL: 'מספר הבקשות הפעילות הגיע למגבלה. נסה שוב מאוחר יותר.',
  DAILY_LIMIT: 'מכסת הבקשות היומית שהוגדרה הסתיימה.',
  WORKER_ERROR: 'רכיב ההורדה דיווח על תקלה.',
  CALLBACK_UNREACHABLE: 'החיבור אל Apps Script נכשל.',
  CALLBACK_ACCESS: 'כתובת Web App או הרשאות הגישה אליה אינן תקינות.',
  UPLOAD_STALLED: 'העלאת הקובץ לא התקדמה לאחר כמה ניסיונות.'
});

/** Run once from the editor. Safe to repeat; does not overwrite properties. */
function setupDraive() {
  const p = PropertiesService.getScriptProperties();
  const defaults = {GITHUB_OWNER: 'novabyte2026', GITHUB_REPO: 'draive', GITHUB_REF: 'main',
    GITHUB_WORKFLOW: 'download.yml', FORM_URL_FIELD: 'קישור ליוטיוב', FORM_FORMAT_FIELD: 'סוג קובץ',
    MAX_FILE_MB: '200', MAX_DURATION_MINUTES: '60', MAX_ACTIVE_JOBS: '3', MAX_DAILY_REQUESTS: '20',
    EXECUTION_MODE: 'actions'};
  Object.keys(defaults).forEach(k => { if (!p.getProperty(k)) p.setProperty(k, defaults[k]); });
  if (!p.getProperty('CALLBACK_SECRET')) {
    p.setProperty('CALLBACK_SECRET', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }
  if (!p.getProperty('DRIVE_FOLDER_ID')) {
    p.setProperty('DRIVE_FOLDER_ID', DriveApp.createFolder('Draive downloads').getId());
  }
  if (!p.getProperty('SPREADSHEET_ID')) {
    p.setProperty('SPREADSHEET_ID', SpreadsheetApp.create('Draive — מעקב הורדות').getId());
  }
  const book = SpreadsheetApp.openById(p.getProperty('SPREADSHEET_ID'));
  let sheet = book.getSheetByName(DRAIVE.sheetName);
  if (!sheet) sheet = book.insertSheet(DRAIVE.sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(DRAIVE.headers);
    sheet.setFrozenRows(1);
    sheet.setRightToLeft(true);
    sheet.getRange(1, 1, 1, DRAIVE.headers.length).setBackground('#173b32').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setColumnWidths(1, DRAIVE.headers.length, 150);
    sheet.setColumnWidth(9, 420);
  }
  if (!p.getProperty('FORM_ID')) {
    const form = FormApp.create('בקשת הורדה לדרייב');
    form.setDescription('הורדת תוכן שיש לך רשות להוריד. ללא התחברות לחשבון YouTube; חלק מהסרטונים אינם זמינים בדרך זו.');
    form.addTextItem().setTitle(p.getProperty('FORM_URL_FIELD')).setRequired(true);
    form.addMultipleChoiceItem().setTitle(p.getProperty('FORM_FORMAT_FIELD'))
      .setChoiceValues(['MP4 — וידאו עד 720p', 'MP3 — שמע']).setRequired(true);
    form.setConfirmationMessage('הבקשה התקבלה בטופס. מצב העיבוד וקישור לקובץ יופיעו בגיליון המעקב.');
    p.setProperty('FORM_ID', form.getId());
  }
  const form = FormApp.openById(p.getProperty('FORM_ID'));
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.some(t => t.getHandlerFunction() === 'draiveOnFormSubmit' && t.getTriggerSourceId() === form.getId())) {
    ScriptApp.newTrigger('draiveOnFormSubmit').forForm(form).onFormSubmit().create();
  }
  if (!triggers.some(t => t.getHandlerFunction() === 'draiveMaintenance')) {
    ScriptApp.newTrigger('draiveMaintenance').timeBased().everyHours(1).create();
  }
  console.log('עריכת טופס: ' + form.getEditUrl());
  console.log('גיליון מעקב: ' + book.getUrl());
  console.log('תיקיית קבצים: https://drive.google.com/drive/folders/' + p.getProperty('DRIVE_FOLDER_ID'));
  console.log('השלם את ההגדרות לפי README. הסוד נוצר ב-Script Properties ואינו מודפס כאן.');
}

/** Installable Form trigger; also accepts a Sheets namedValues event. */
function draiveOnFormSubmit(e) {
  const p = PropertiesService.getScriptProperties();
  const values = {};
  let sourceId = '';
  if (e && e.response) {
    sourceId = e.response.getId();
    e.response.getItemResponses().forEach(r => { values[r.getItem().getTitle()] = String(r.getResponse()); });
  } else if (e && e.namedValues) {
    Object.keys(e.namedValues).forEach(k => { values[k] = String(e.namedValues[k][0] || ''); });
    sourceId = e.range ? e.source.getId() + ':' + e.range.getSheet().getSheetId() + ':' + e.range.getRow() : '';
  } else {
    throw new Error('שלח את הטופס לבדיקה; אין להריץ את פונקציית הטריגר ידנית.');
  }
  try {
    return submitDraiveRequest(values[p.getProperty('FORM_URL_FIELD')] || '',
      values[p.getProperty('FORM_FORMAT_FIELD')] || 'MP4', sourceId);
  } catch (error) {
    const code = error.draiveCode || 'WORKER_ERROR';
    withLock_(function () {
      sheet_().appendRow([new Date(), '', '', '', 'נדחה', 0, 0, '', DRAIVE_ERRORS[code] || code, new Date(), '']);
    });
    throw new Error(DRAIVE_ERRORS[code] || code);
  }
}

/** Integration point for your existing Apps Script. Call on the server only. */
function submitDraiveRequest(youtubeUrl, outputFormat, sourceId) {
  const url = normalizeUrl_(youtubeUrl);
  const format = normalizeFormat_(outputFormat);
  const p = PropertiesService.getScriptProperties();
  const mode = p.getProperty('EXECUTION_MODE') || 'actions';
  if (mode !== 'actions' && mode !== 'manual') fail_('MISSING_CONFIG');
  if (mode === 'actions' && !p.getProperty('GITHUB_TOKEN')) fail_('MISSING_CONFIG');
  if ((p.getProperty('CALLBACK_SECRET') || '').length < 32) fail_('MISSING_CONFIG');
  const result = withLock_(function () {
    const jobs = jobs_();
    if (sourceId) {
      const old = jobs.find(j => j.sourceId === String(sourceId));
      if (old) return {job: old, fresh: false};
    }
    if (jobs.filter(j => !terminal_(j)).length >= numberProperty_('MAX_ACTIVE_JOBS', 3, 1, 10)) fail_('QUEUE_FULL');
    const day = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
    let count = JSON.parse(p.getProperty('DRAIVE_DAILY') || '{}');
    if (count.day !== day) count = {day: day, count: 0};
    if (count.count >= numberProperty_('MAX_DAILY_REQUESTS', 20, 1, 100)) fail_('DAILY_LIMIT');
    const job = {id: Utilities.getUuid(), url: url, format: format, status: 'queued',
      sourceId: String(sourceId || '').slice(0, 200), created: Date.now(), updated: Date.now(), offset: 0,
      maxBytes: numberProperty_('MAX_FILE_MB', 200, 1, 500) * 1024 * 1024,
      maxDuration: numberProperty_('MAX_DURATION_MINUTES', 60, 1, 120) * 60,
      row: sheet_().getLastRow() + 1};
    save_(job);
    p.setProperty('DRAIVE_DAILY', JSON.stringify({day: day, count: count.count + 1}));
    return {job: job, fresh: true};
  });
  if (!result.fresh || mode === 'manual') return result.job.id;
  const id = result.job.id;
  let status = 0;
  try {
    const api = 'https://api.github.com/repos/' + encodeURIComponent(p.getProperty('GITHUB_OWNER')) + '/' +
      encodeURIComponent(p.getProperty('GITHUB_REPO')) + '/actions/workflows/' +
      encodeURIComponent(p.getProperty('GITHUB_WORKFLOW')) + '/dispatches';
    status = UrlFetchApp.fetch(api, {method: 'post', contentType: 'application/json',
      headers: {Authorization: 'Bearer ' + p.getProperty('GITHUB_TOKEN'), Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'},
      payload: JSON.stringify({ref: p.getProperty('GITHUB_REF'), inputs: {request_id: id}}),
      muteHttpExceptions: true}).getResponseCode();
  } catch (ignore) { /* A timeout can occur after GitHub accepted the dispatch. */ }
  if (status < 200 || status >= 300) {
    withLock_(function () {
      const job = load_(id);
      // Do not overwrite a worker that has already claimed the request.
      if (job.status === 'queued') {
        job.note = DRAIVE_ERRORS.DISPATCH_FAILED + ' HTTP ' + status;
        // On a transport/server failure acceptance is ambiguous: leave queued.
        if (status >= 400 && status < 500) { job.status = 'error'; job.error = 'DISPATCH_FAILED'; }
        save_(job);
      }
    });
  }
  return id;
}

/** Anonymous HTTP endpoint; every operation requires an HMAC-signed request. */
function doPost(e) { return draiveDoPost(e); }
function draiveDoPost(e) {
  try {
    const message = authenticate_(e);
    const result = withLock_(function () { return handle_(message); });
    return json_(Object.assign({ok: true}, result));
  } catch (error) {
    return json_({ok: false, code: error.draiveCode || 'INTERNAL_ERROR',
      retryable: error.draiveRetryable === true || !error.draiveCode});
  }
}
function doGet() { return json_({service: 'draive', version: 1}); }

function authenticate_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string' || e.postData.contents.length > 2 * 1024 * 1024) fail_('BAD_REQUEST');
  let wrapper;
  try { wrapper = JSON.parse(e.postData.contents); } catch (ignore) { fail_('BAD_REQUEST'); }
  if (!wrapper || typeof wrapper.payload !== 'string' || !/^[a-f0-9]{64}$/.test(wrapper.signature || '')) fail_('AUTH_FAILED');
  const secret = PropertiesService.getScriptProperties().getProperty('CALLBACK_SECRET') || '';
  if (secret.length < 32) fail_('MISSING_CONFIG');
  const expected = hex_(Utilities.computeHmacSha256Signature(wrapper.payload, secret, Utilities.Charset.UTF_8));
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ wrapper.signature.charCodeAt(i);
  if (diff !== 0) fail_('AUTH_FAILED');
  let message;
  try { message = JSON.parse(wrapper.payload); } catch (ignore) { fail_('BAD_REQUEST'); }
  if (!message || !Number.isInteger(message.ts) || Math.abs(Date.now() / 1000 - message.ts) > 300) fail_('EXPIRED_SIGNATURE');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(message.job_id || '') ||
      !/^[A-Za-z0-9._-]{1,80}$/.test(message.run_id || '')) fail_('BAD_REQUEST');
  if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) fail_('BAD_REQUEST');
  return message;
}

function handle_(m) {
  const job = load_(m.job_id);
  if (job.status === 'done') return state_(job);
  if (job.status === 'error') fail_('JOB_CLOSED');
  if (m.action === 'fail_setup') {
    if (job.status !== 'queued') fail_('JOB_CLAIMED');
    job.status = 'error'; job.error = 'SETUP_FAILED'; save_(job);
    return {done: false};
  }
  if (m.action === 'claim') {
    if (job.runId && job.runId !== m.run_id) fail_('JOB_CLAIMED');
    if (!job.runId) { job.runId = m.run_id; job.status = 'downloading'; job.note = ''; }
    save_(job);
    return {url: job.url, format: job.format, max_bytes: job.maxBytes, max_duration: job.maxDuration};
  }
  if (job.runId !== m.run_id) fail_('JOB_CLAIMED');
  if (m.action === 'fail') {
    // A timed-out last chunk might have succeeded. Check Drive before failing.
    if (job.fileId && recoverCompleted_(job)) return state_(job);
    job.status = 'error'; job.error = DRAIVE_ERRORS[m.data.code] ? m.data.code : 'WORKER_ERROR';
    save_(job); return {done: false};
  }
  if (m.action === 'init') return initUpload_(job, m.data);
  if (m.action === 'chunk') return uploadChunk_(job, m.data);
  fail_('BAD_ACTION');
}

function initUpload_(job, data) {
  if (!Number.isInteger(data.size) || data.size <= 0 || data.size > job.maxBytes) fail_('FILE_TOO_LARGE');
  const mime = job.format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
  if (data.mime !== mime || typeof data.name !== 'string' || !data.name.endsWith('.' + job.format) ||
      !/^[a-f0-9]{32}$/.test(data.md5 || '')) fail_('BAD_FILE');
  const name = data.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 190);
  if (job.size && (job.size !== data.size || job.md5 !== data.md5)) fail_('FILE_CHANGED');
  job.size = data.size; job.mime = mime; job.name = name; job.md5 = data.md5;
  if (job.session) return syncUpload_(job);
  if (job.fileId && recoverCompleted_(job)) return state_(job);
  if (!job.fileId) {
    const response = driveFetch_('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files', {method: 'get'});
    if (response.getResponseCode() !== 200) fail_('DRIVE_ERROR');
    job.fileId = JSON.parse(response.getContentText()).ids[0];
  }
  // Persist the pre-generated ID before initiating upload, to prevent duplicate files.
  save_(job);
  const response = driveFetch_('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum', {
    method: 'post', contentType: 'application/json',
    headers: {'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(job.size)},
    payload: JSON.stringify({id: job.fileId, name: name, mimeType: mime,
      parents: [PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID')]})
  });
  if (response.getResponseCode() === 409 && recoverCompleted_(job)) return state_(job);
  if (response.getResponseCode() !== 200) fail_('DRIVE_ERROR', response.getResponseCode() >= 500);
  const session = header_(response, 'location');
  if (!/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/.test(session)) fail_('DRIVE_ERROR');
  job.session = session; job.status = 'uploading'; job.offset = 0; save_(job);
  return state_(job);
}

function uploadChunk_(job, data) {
  if (!job.session || job.status !== 'uploading') fail_('NO_UPLOAD');
  if (!Number.isInteger(data.offset) || data.offset < 0 || typeof data.content !== 'string' ||
      data.content.length > Math.ceil(DRAIVE.chunkSize / 3) * 4) fail_('BAD_CHUNK');
  let bytes;
  try { bytes = Utilities.base64Decode(data.content); } catch (ignore) { fail_('BAD_CHUNK'); }
  if (!bytes.length || bytes.length > DRAIVE.chunkSize || data.offset + bytes.length > job.size ||
      (data.offset + bytes.length < job.size && bytes.length % 262144 !== 0)) fail_('BAD_CHUNK');
  // Query Drive when the previous PUT's result was ambiguous. Its Range is authoritative.
  if (job.uncertain) syncUpload_(job);
  if (job.status === 'done') return state_(job);
  if (data.offset !== job.offset) return state_(job);
  job.uncertain = true;
  save_(job);
  const response = driveFetch_(job.session, {method: 'put', contentType: job.mime,
    headers: {'Content-Range': 'bytes ' + data.offset + '-' + (data.offset + bytes.length - 1) + '/' + job.size},
    payload: Utilities.newBlob(bytes, job.mime)});
  return consumeUploadResponse_(job, response);
}

function syncUpload_(job) {
  const response = driveFetch_(job.session, {method: 'put', contentType: job.mime,
    headers: {'Content-Range': 'bytes */' + job.size}, payload: ''});
  return consumeUploadResponse_(job, response);
}

function consumeUploadResponse_(job, response) {
  const code = response.getResponseCode();
  if (code === 200 || code === 201) {
    complete_(job, JSON.parse(response.getContentText()));
  } else if (code === 308) {
    const range = header_(response, 'range');
    const match = /^bytes=0-(\d+)$/.exec(range);
    if (range && !match) fail_('DRIVE_ERROR');
    const offset = match ? Number(match[1]) + 1 : 0;
    if (!Number.isSafeInteger(offset) || offset < job.offset || offset > job.size) fail_('DRIVE_ERROR');
    job.offset = offset; job.uncertain = false; save_(job);
  } else if (code === 404 || code === 410) {
    if (!recoverCompleted_(job)) fail_('UPLOAD_EXPIRED');
  } else {
    fail_('DRIVE_ERROR', code === 429 || code >= 500);
  }
  return state_(job);
}

function recoverCompleted_(job) {
  const response = driveFetch_('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(job.fileId) +
    '?fields=id,size,md5Checksum', {method: 'get'});
  if (response.getResponseCode() === 404) return false;
  if (response.getResponseCode() !== 200) fail_('DRIVE_ERROR', response.getResponseCode() >= 500);
  complete_(job, JSON.parse(response.getContentText()));
  return true;
}

function complete_(job, file) {
  if (file.id !== job.fileId || Number(file.size) !== job.size || file.md5Checksum !== job.md5) {
    job.status = 'error'; job.error = 'CHECKSUM_MISMATCH'; save_(job); fail_('CHECKSUM_MISMATCH');
  }
  job.status = 'done'; job.offset = job.size; job.uncertain = false; job.note = '';
  delete job.session;
  save_(job);
}

function driveFetch_(url, options) {
  options.headers = Object.assign({}, options.headers || {}, {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()});
  options.muteHttpExceptions = true;
  options.followRedirects = false; // 308 means Resume Incomplete, not a redirect.
  try { return UrlFetchApp.fetch(url, options); } catch (ignore) { fail_('DRIVE_ERROR', true); }
}

/** Hourly: closes abandoned jobs; removes expired state while retaining sheet history. */
function draiveMaintenance() {
  withLock_(function () {
    const now = Date.now();
    jobs_().forEach(job => {
      if (!terminal_(job) && now - job.updated > 2 * 60 * 60 * 1000) {
        if (job.fileId) {
          try { if (recoverCompleted_(job)) return; } catch (ignore) { /* Mark stale below. */ }
        }
        job.status = 'error'; job.error = 'STALE'; delete job.session; save_(job);
      }
      if (terminal_(job) && now - job.updated > 24 * 60 * 60 * 1000) {
        PropertiesService.getScriptProperties().deleteProperty(DRAIVE.jobPrefix + job.id);
      }
    });
  });
}

function normalizeUrl_(value) {
  const text = String(value || '').trim();
  if (text.length > 2048) fail_('INVALID_URL');
  const match = /^https:\/\/(youtube\.com|www\.youtube\.com|m\.youtube\.com|music\.youtube\.com|youtu\.be)(\/[^#\s]*)?(?:#[^\s]*)?$/.exec(text);
  if (!match) fail_('INVALID_URL');
  const path = (match[2] || '/').split('?')[0];
  let id = '';
  if (match[1] === 'youtu.be') id = path.replace(/^\/+|\/+$/g, '');
  else if (path === '/watch') {
    const found = /[?&]v=([^&#]*)/.exec(match[2]);
    try { id = found ? decodeURIComponent(found[1]) : ''; } catch (ignore) { fail_('INVALID_URL'); }
  } else {
    const found = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(path);
    id = found ? found[1] : '';
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) fail_('INVALID_URL');
  return 'https://www.youtube.com/watch?v=' + id;
}

function normalizeFormat_(value) {
  const match = /^(mp3|mp4)(?:$|\s|[—–-])/i.exec(String(value || '').trim());
  if (!match) fail_('INVALID_FORMAT');
  return match[1].toLowerCase();
}
function numberProperty_(name, fallback, min, max) {
  const value = Number(PropertiesService.getScriptProperties().getProperty(name) || fallback);
  if (!Number.isInteger(value) || value < min || value > max) fail_('MISSING_CONFIG');
  return value;
}
function sheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) fail_('MISSING_CONFIG');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(DRAIVE.sheetName);
  if (!sheet) fail_('MISSING_CONFIG');
  return sheet;
}
function save_(job) {
  job.updated = Date.now();
  PropertiesService.getScriptProperties().setProperty(DRAIVE.jobPrefix + job.id, JSON.stringify(job));
  const p = PropertiesService.getScriptProperties();
  const sheet = sheet_();
  job.row = findJobRow_(sheet, job) || sheet.getLastRow() + 1;
  PropertiesService.getScriptProperties().setProperty(DRAIVE.jobPrefix + job.id, JSON.stringify(job));
  const run = /^\d+\.\d+$/.test(job.runId || '') ? 'https://github.com/' + p.getProperty('GITHUB_OWNER') + '/' +
    p.getProperty('GITHUB_REPO') + '/actions/runs/' + job.runId.split('.')[0] : '';
  const link = job.status === 'done' ? 'https://drive.google.com/file/d/' + job.fileId + '/view' : '';
  sheet.getRange(job.row, 1, 1, DRAIVE.headers.length).setValues([[new Date(job.created), job.id, job.url, job.format,
    DRAIVE.status[job.status], job.offset || 0, job.size || 0, link,
    DRAIVE_ERRORS[job.error] || job.note || '', new Date(job.updated), run]]);
}
function findJobRow_(sheet, job) {
  if (job.row && job.row > 1 && sheet.getRange(job.row, 2).getValue() === job.id) return job.row;
  const finder = sheet.createTextFinder(job.id).matchEntireCell(true).findAll();
  const match = finder.find(r => r.getColumn() === 2 && r.getRow() > 1);
  return match ? match.getRow() : 0;
}
function load_(id) {
  const raw = PropertiesService.getScriptProperties().getProperty(DRAIVE.jobPrefix + id);
  if (!raw) fail_('JOB_NOT_FOUND');
  return JSON.parse(raw);
}
function jobs_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(p).filter(k => k.startsWith(DRAIVE.jobPrefix)).map(k => JSON.parse(p[k]));
}
function terminal_(job) { return job.status === 'done' || job.status === 'error'; }
function state_(job) { return {done: job.status === 'done', offset: job.offset || 0, chunk_size: DRAIVE.chunkSize}; }
function header_(response, name) {
  const headers = response.getAllHeaders();
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) fail_('BUSY', true);
  try { return fn(); } finally { lock.releaseLock(); }
}
function fail_(code, retryable) {
  const error = new Error(code);
  error.draiveCode = code; error.draiveRetryable = retryable === true;
  throw error;
}
function hex_(bytes) { return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''); }
function json_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
