require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const cors = require('cors');
const JwCrawler = require('./crawler');

const app = express();

const config = {
  port: readNumber(process.env.PORT, 3000),
  apiKey: process.env.API_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  appSecret: process.env.APP_SECRET || process.env.CREDENTIAL_SECRET || '',
  loginMode: process.env.JW_LOGIN_MODE || 'direct',
  useOcr: readBool(process.env.JW_USE_OCR, true),
  captchaAttempts: readNumber(process.env.JW_CAPTCHA_ATTEMPTS, 1),
  ocrMinConfidence: readNumber(process.env.JW_OCR_MIN_CONFIDENCE, 0),
  cacheTtlMs: readNumber(process.env.JW_CACHE_TTL_SECONDS, 600) * 1000,
  sessionTtlMs: readNumber(process.env.JW_SESSION_TTL_MINUTES, 20) * 60 * 1000,
  challengeTtlMs: readNumber(process.env.JW_CAPTCHA_TTL_SECONDS, 180) * 1000,
  userDataDir: process.env.USER_DATA_DIR || path.join('.data', 'users'),
  scheduleCacheRoot: process.env.JW_SCHEDULE_CACHE_ROOT || path.join('.cache', 'users'),
  saveRaw: readBool(process.env.JW_SAVE_RAW, false),
  verbose: readBool(process.env.JW_VERBOSE, false),
  timeout: readNumber(process.env.JW_TIMEOUT_MS, 8000),
  maxRetries: readNumber(process.env.JW_MAX_RETRIES, 1),
  retryBackoffBase: readNumber(process.env.JW_RETRY_BACKOFF_MS, 600),
  baseDelay: readNumber(process.env.JW_BASE_DELAY_MS, 250),
  jitter: readNumber(process.env.JW_JITTER_MS, 150),
};

const runtime = {
  users: new Map(),
  challenges: new Map(),
};

app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use(requireApiKey);

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    users: {
      activeSessions: runtime.users.size,
      pendingChallenges: runtime.challenges.size,
      stored: await countStoredUsers(),
    },
  });
});

app.get('/api/status', async (req, res) => {
  res.json({
    ok: true,
    users: {
      activeSessions: runtime.users.size,
      pendingChallenges: runtime.challenges.size,
      stored: await countStoredUsers(),
    },
    cacheRoot: path.resolve(config.scheduleCacheRoot),
  });
});

app.post('/api/user/login', async (req, res, next) => {
  try {
    const { account, password } = readLoginBody(req.body);
    const userId = makeUserId(account);
    const entry = getOrCreateRuntimeUser(userId, { account });

    try {
      await loginRuntimeUser(entry, { account, password, force: true });
      await saveUserRecord(userId, account, password);
      startDefaultScheduleSync(entry);
      res.json(loginSuccessResponse(userId, entry));
    } catch (err) {
      if (!shouldFallbackToCaptcha(err)) throw err;
      const challenge = await createManualChallenge({ userId, account, password });
      res.status(409).json(challengeResponse(challenge, 'CAPTCHA_REQUIRED'));
    }
  } catch (err) {
    next(err);
  }
});

app.post('/api/user/captcha/:challengeId', async (req, res, next) => {
  try {
    const challenge = runtime.challenges.get(req.params.challengeId);
    if (!challenge || Date.now() > challenge.expiresAt) {
      runtime.challenges.delete(req.params.challengeId);
      res.status(410).json({ ok: false, code: 'CAPTCHA_EXPIRED', message: 'Captcha challenge expired. Request a new one.' });
      return;
    }

    const code = String(req.body?.code || '').trim().toLowerCase();
    if (!/^[a-z0-9]{4}$/.test(code)) {
      res.status(400).json({ ok: false, code: 'BAD_CAPTCHA_FORMAT', message: 'Captcha code must be 4 lowercase letters or digits.' });
      return;
    }

    const entry = await submitManualChallenge(challenge, code);
    await saveUserRecord(challenge.userId, challenge.account, challenge.password);
    startDefaultScheduleSync(entry);
    runtime.challenges.delete(req.params.challengeId);
    res.json(loginSuccessResponse(challenge.userId, entry));
  } catch (err) {
    runtime.challenges.delete(req.params.challengeId);
    if (isCaptchaError(err)) {
      res.status(422).json({ ok: false, code: 'CAPTCHA_INVALID', message: 'Captcha was rejected. Request a new challenge.' });
      return;
    }
    next(err);
  }
});

app.get('/api/user/status', async (req, res, next) => {
  try {
    const userId = requireUserId(req.query.userId);
    const record = await loadUserRecord(userId);
    const entry = runtime.users.get(userId);
    res.json({
      ok: true,
      userId,
      account: mask(record.account),
      auth: runtimeStatus(entry),
      sync: entry?.sync || null,
      cache: await listUserCacheInfo(userId),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/user/schedule', async (req, res, next) => {
  try {
    const userId = requireUserId(req.query.userId);
    const rq = normalizeDate(req.query.date) || today();
    const format = req.query.format || 'mini';
    const force = readBool(req.query.force, false);
    const payload = await getUserSchedulePayload(userId, rq, { force, format });
    res.json({ ok: true, userId, ...payload });
  } catch (err) {
    if (err.challenge) {
      res.status(409).json(challengeResponse(err.challenge, 'CAPTCHA_REQUIRED'));
      return;
    }
    next(err);
  }
});

app.post('/api/user/schedule', async (req, res, next) => {
  try {
    const userId = requireUserId(req.body?.userId);
    const rq = normalizeDate(req.body?.date) || today();
    const format = req.body?.format || 'mini';
    const force = readBool(req.body?.force, false);
    const payload = await getUserSchedulePayload(userId, rq, { force, format });
    res.json({ ok: true, userId, ...payload });
  } catch (err) {
    if (err.challenge) {
      res.status(409).json(challengeResponse(err.challenge, 'CAPTCHA_REQUIRED'));
      return;
    }
    next(err);
  }
});

app.get('/api/user/schedule/weeks', async (req, res, next) => {
  try {
    const userId = requireUserId(req.query.userId);
    const semesterStart = normalizeDate(req.query.semesterStart || process.env.JW_SEMESTER_START);
    if (!semesterStart) {
      res.status(400).json({ ok: false, code: 'SEMESTER_START_REQUIRED', message: 'semesterStart is required, e.g. 2026-03-02.' });
      return;
    }

    const weeks = Math.min(Math.max(readNumber(req.query.weeks || process.env.JW_TOTAL_WEEKS, 19), 1), 30);
    const force = readBool(req.query.force, false);
    const format = req.query.format || 'mini';
    const dates = JwCrawler.generateWeekDates(semesterStart, weeks);
    const schedules = [];

    for (const rq of dates) {
      schedules.push(await getUserSchedulePayload(userId, rq, { force, format }));
    }

    res.json({
      ok: true,
      userId,
      semesterStart,
      weeks,
      generatedAt: new Date().toISOString(),
      schedules,
    });
  } catch (err) {
    if (err.challenge) {
      res.status(409).json(challengeResponse(err.challenge, 'CAPTCHA_REQUIRED'));
      return;
    }
    next(err);
  }
});

app.post('/api/user/cache/clear', async (req, res, next) => {
  try {
    const userId = requireUserId(req.body?.userId || req.query.userId);
    await fs.rm(userCacheDir(userId), { recursive: true, force: true });
    res.json({ ok: true, userId });
  } catch (err) {
    next(err);
  }
});

app.post('/api/user/logout', async (req, res, next) => {
  try {
    const userId = requireUserId(req.body?.userId || req.query.userId);
    runtime.users.delete(userId);
    res.json({ ok: true, userId });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status = statusForError(err);
  res.status(status).json({
    ok: false,
    code: err.code || (status === 404 ? 'USER_NOT_FOUND' : 'JW_CRAWLER_ERROR'),
    message: sanitizeError(err),
  });
});

if (require.main === module) {
  assertAppSecret();
  app.listen(config.port, () => {
    console.log(`JW multi-user API listening on http://localhost:${config.port}`);
  });
}

module.exports = app;

function readLoginBody(body = {}) {
  const account = String(body.account || body.userAccount || '').trim();
  const password = String(body.password || body.userPassword || '');
  if (!account || !password) {
    const err = new Error('account and password are required.');
    err.status = 400;
    err.code = 'BAD_LOGIN_REQUEST';
    throw err;
  }
  return { account, password };
}

function makeUserId(account) {
  assertAppSecret();
  return crypto
    .createHmac('sha256', config.appSecret)
    .update(String(account))
    .digest('hex')
    .slice(0, 32);
}

function getOrCreateRuntimeUser(userId, initial = {}) {
  let entry = runtime.users.get(userId);
  if (!entry) {
    entry = {
      userId,
      account: initial.account || '',
      crawler: null,
      status: 'idle',
      lastLoginAt: 0,
      loginPromise: null,
      sync: null,
      syncPromise: null,
    };
    runtime.users.set(userId, entry);
  }
  if (initial.account) entry.account = initial.account;
  return entry;
}

async function getRuntimeUserWithCredentials(userId) {
  const record = await loadUserRecord(userId);
  const password = decryptSecret(record.passwordEnc, config.appSecret);
  const entry = getOrCreateRuntimeUser(userId, { account: record.account });
  return { entry, account: record.account, password };
}

async function loginRuntimeUser(entry, options = {}) {
  const { account, password, force = false } = options;
  if (!force && isSessionFresh(entry)) return entry.crawler;
  if (entry.loginPromise) return entry.loginPromise;

  entry.status = 'authenticating';
  entry.account = account || entry.account;
  entry.loginPromise = (async () => {
    const crawler = makeCrawler();
    await loginWithMode(crawler, account || entry.account, password, {
      useOcr: config.useOcr,
      maxCaptchaAttempts: config.captchaAttempts,
    });
    entry.crawler = crawler;
    entry.lastLoginAt = Date.now();
    entry.status = 'authenticated';
    return crawler;
  })().catch(err => {
    entry.status = shouldFallbackToCaptcha(err) ? 'needs_captcha' : 'error';
    throw err;
  }).finally(() => {
    entry.loginPromise = null;
  });

  return entry.loginPromise;
}

async function ensureUserLoggedIn(userId) {
  const { entry, account, password } = await getRuntimeUserWithCredentials(userId);
  try {
    await loginRuntimeUser(entry, { account, password });
    return entry;
  } catch (err) {
    if (!shouldFallbackToCaptcha(err)) throw err;
    const challenge = await createManualChallenge({ userId, account, password });
    const wrapped = new Error('Manual captcha input is required.');
    wrapped.status = 409;
    wrapped.code = 'CAPTCHA_REQUIRED';
    wrapped.challenge = challenge;
    throw wrapped;
  }
}

async function loginWithMode(crawler, account, password, options = {}) {
  const loginMode = options.loginMode || config.loginMode;
  const common = {
    useOcr: options.useOcr,
    maxCaptchaAttempts: options.maxCaptchaAttempts,
    manualCaptcha: options.manualCaptcha,
  };

  if (loginMode === 'unified') {
    return crawler.loginWithCaptcha(account, password, common);
  }

  if (loginMode === 'auto') {
    try {
      return await crawler.loginWithCaptcha(account, password, common);
    } catch (err) {
      if (!shouldTryDirectLogin(err)) throw err;
      return crawler.loginJsxsdWithCaptcha(account, password, common);
    }
  }

  return crawler.loginJsxsdWithCaptcha(account, password, common);
}

function makeCrawler(overrides = {}) {
  return new JwCrawler({
    verbose: config.verbose,
    useOcr: config.useOcr,
    maxCaptchaAttempts: config.captchaAttempts,
    minOcrConfidence: config.ocrMinConfidence,
    captchaPath: null,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryBackoffBase: config.retryBackoffBase,
    baseDelay: config.baseDelay,
    jitter: config.jitter,
    ...overrides,
  });
}

function isSessionFresh(entry) {
  return Boolean(entry?.crawler && entry.lastLoginAt && Date.now() - entry.lastLoginAt < config.sessionTtlMs);
}

async function createManualChallenge({ userId, account, password, loginMode = config.loginMode }) {
  const effectiveMode = loginMode === 'unified' ? 'unified' : 'direct';
  const crawler = makeCrawler({ useOcr: false });
  let captchaBuffer;
  let factor = '';

  if (effectiveMode === 'unified') {
    const challenge = await crawler.createLoginChallenge({ captchaPath: null });
    captchaBuffer = challenge.captchaBuffer;
    factor = challenge.factor || '';
  } else {
    await crawler.initJsxsdLoginPage();
    captchaBuffer = await crawler.getJsxsdCaptcha(null);
  }

  const challengeId = crypto.randomUUID();
  const challenge = {
    id: challengeId,
    userId,
    account,
    password,
    crawler,
    mode: effectiveMode,
    factor,
    captchaBuffer,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.challengeTtlMs,
  };

  pruneChallenges();
  runtime.challenges.set(challengeId, challenge);
  const entry = getOrCreateRuntimeUser(userId, { account });
  entry.status = 'needs_captcha';
  return challenge;
}

async function submitManualChallenge(challenge, code) {
  if (challenge.mode === 'unified') {
    await challenge.crawler.submitLogin(challenge.account, challenge.password, code, challenge.factor);
  } else {
    await challenge.crawler.submitJsxsdLogin(challenge.account, challenge.password, code);
  }

  const entry = getOrCreateRuntimeUser(challenge.userId, { account: challenge.account });
  entry.crawler = challenge.crawler;
  entry.lastLoginAt = Date.now();
  entry.status = 'authenticated';
  return entry;
}

function challengeResponse(challenge, code) {
  return {
    ok: false,
    code,
    message: 'Manual captcha input is required.',
    userId: challenge.userId,
    challengeId: challenge.id,
    expiresAt: new Date(challenge.expiresAt).toISOString(),
    captcha: {
      mime: 'image/png',
      base64: challenge.captchaBuffer.toString('base64'),
      dataUrl: `data:image/png;base64,${challenge.captchaBuffer.toString('base64')}`,
    },
  };
}

function pruneChallenges() {
  const now = Date.now();
  for (const [id, challenge] of runtime.challenges.entries()) {
    if (now > challenge.expiresAt) runtime.challenges.delete(id);
  }
}

async function getUserSchedulePayload(userId, rq, options = {}) {
  const cached = options.force ? null : await readUserScheduleCache(userId, rq);
  if (cached) {
    return formatSchedule(cached, options.format, 'cache');
  }

  const entry = await ensureUserLoggedIn(userId);
  let courses;
  let html;

  try {
    html = await entry.crawler.getScheduleRaw(rq);
    courses = entry.crawler.parseSchedule(html);
  } catch (err) {
    if (!isSessionExpiredError(err)) throw err;
    const { account, password } = await getRuntimeUserWithCredentials(userId);
    await loginRuntimeUser(entry, { account, password, force: true });
    html = await entry.crawler.getScheduleRaw(rq);
    courses = entry.crawler.parseSchedule(html);
  }

  const record = {
    userId,
    rq,
    courses: courses.map(normalizeCourse),
    courseCount: courses.length,
    fetchedAt: new Date().toISOString(),
    ttlSeconds: Math.round(config.cacheTtlMs / 1000),
  };

  await writeUserScheduleCache(userId, rq, record, html);
  return formatSchedule(record, options.format, 'live');
}

async function syncDefaultSchedule(entry) {
  const rq = today();
  try {
    const payload = await getUserSchedulePayload(entry.userId, rq, { force: true, format: 'mini' });
    return {
      ok: true,
      date: rq,
      source: payload.source,
      courseCount: payload.courseCount,
    };
  } catch (err) {
    if (config.verbose) {
      console.warn(`[sync] user ${entry.userId} default schedule sync failed: ${err.message}`);
    }
    return {
      ok: false,
      date: rq,
      message: sanitizeError(err),
    };
  }
}

function startDefaultScheduleSync(entry) {
  if (entry.syncPromise) {
    return entry.syncPromise;
  }

  const rq = today();
  entry.sync = {
    status: 'syncing',
    date: rq,
    startedAt: new Date().toISOString(),
  };

  entry.syncPromise = syncDefaultSchedule(entry)
    .then(result => {
      entry.sync = {
        ...result,
        status: result.ok ? 'done' : 'failed',
        finishedAt: new Date().toISOString(),
      };
      return result;
    })
    .catch(err => {
      entry.sync = {
        ok: false,
        status: 'failed',
        date: rq,
        message: sanitizeError(err),
        finishedAt: new Date().toISOString(),
      };
      return entry.sync;
    })
    .finally(() => {
      entry.syncPromise = null;
    });

  return entry.syncPromise;
}

function formatSchedule(record, format = 'mini', source = 'live') {
  if (format === 'flat') {
    return { source, schedule: record };
  }

  const flat = record.courses || [];
  return {
    source,
    date: record.rq,
    fetchedAt: record.fetchedAt,
    courseCount: record.courseCount,
    schedule: {
      flat,
      byDay: groupByDay(flat),
      bySection: groupBySection(flat),
    },
  };
}

function normalizeCourse(course) {
  const name = clean(course.courseName || course.name || '');
  const teacher = clean(course.teacher || '');
  const location = clean(course.location || '');
  const courseTime = clean(course.courseTime || '');
  const idSource = [
    name,
    teacher,
    course.weekDayIndex,
    course.startSection,
    course.endSection,
    location,
    courseTime,
  ].join('|');

  return {
    id: crypto.createHash('sha1').update(idSource).digest('hex').slice(0, 12),
    name,
    teacher,
    location,
    campus: clean(course.campus || ''),
    weekDay: {
      index: Number(course.weekDayIndex || 0),
      name: clean(course.weekDay || ''),
    },
    section: {
      start: course.startSection,
      end: course.endSection,
      label: clean(course.sections || course.sectionRange || ''),
      timeRange: clean(course.timeRange || ''),
      startTime: clean(course.startTime || ''),
      endTime: clean(course.endTime || ''),
    },
    weeks: parseWeeks(courseTime),
    courseTime,
    credits: clean(course.credits || ''),
    attribute: clean(course.attribute || ''),
    groupName: clean(course.groupName || ''),
    rawTitle: clean(course.rawTitle || ''),
  };
}

function groupByDay(courses) {
  return Array.from({ length: 7 }, (_, index) => {
    const dayIndex = index + 1;
    return {
      dayIndex,
      courses: courses
        .filter(course => course.weekDay.index === dayIndex)
        .sort(compareCourse),
    };
  });
}

function groupBySection(courses) {
  const groups = new Map();
  for (const course of courses) {
    const key = String(course.section.start || 'unknown');
    if (!groups.has(key)) {
      groups.set(key, {
        startSection: course.section.start,
        endSection: course.section.end,
        timeRange: course.section.timeRange,
        courses: [],
      });
    }
    groups.get(key).courses.push(course);
  }

  return Array.from(groups.values())
    .map(group => ({ ...group, courses: group.courses.sort(compareCourse) }))
    .sort((a, b) => Number(a.startSection || 99) - Number(b.startSection || 99));
}

function compareCourse(a, b) {
  return Number(a.section.start || 99) - Number(b.section.start || 99)
    || Number(a.weekDay.index || 99) - Number(b.weekDay.index || 99)
    || a.name.localeCompare(b.name, 'zh-Hans-CN');
}

function parseWeeks(text) {
  const value = String(text || '');
  const ranges = [];
  const rangeRegex = /(\d{1,2})(?:\s*[-~]\s*(\d{1,2}))?\s*(?:周|week)?/gi;
  let match;

  while ((match = rangeRegex.exec(value))) {
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start > 0 && end >= start && end <= 30) {
      ranges.push({ start, end });
    }
  }

  return {
    text: clean(text),
    ranges,
    parity: /单周|odd/i.test(value) ? 'odd' : (/双周|even/i.test(value) ? 'even' : 'all'),
  };
}

async function saveUserRecord(userId, account, password) {
  assertAppSecret();
  await fs.mkdir(config.userDataDir, { recursive: true });
  const now = new Date().toISOString();
  const existing = await loadUserRecord(userId, { optional: true });
  const record = {
    userId,
    account,
    passwordEnc: encryptSecret(password, config.appSecret),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await fs.writeFile(userRecordPath(userId), JSON.stringify(record, null, 2), 'utf-8');
  return record;
}

async function loadUserRecord(userId, options = {}) {
  try {
    return JSON.parse(await fs.readFile(userRecordPath(userId), 'utf-8'));
  } catch (err) {
    if (options.optional) return null;
    const notFound = new Error('User is not logged in or stored credential was not found.');
    notFound.status = 404;
    notFound.code = 'USER_NOT_FOUND';
    throw notFound;
  }
}

function userRecordPath(userId) {
  return path.join(config.userDataDir, `${safeId(userId)}.json`);
}

async function countStoredUsers() {
  try {
    const files = await fs.readdir(config.userDataDir);
    return files.filter(file => file.endsWith('.json')).length;
  } catch (err) {
    return 0;
  }
}

async function readUserScheduleCache(userId, rq) {
  const filePath = cachePathForUserDate(userId, rq);
  try {
    const stat = await fs.stat(filePath);
    if (Date.now() - stat.mtimeMs > config.cacheTtlMs) return null;
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (err) {
    return null;
  }
}

async function writeUserScheduleCache(userId, rq, record, html) {
  const dir = userCacheDir(userId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(cachePathForUserDate(userId, rq), JSON.stringify(record, null, 2), 'utf-8');
  if (config.saveRaw && html) {
    await fs.writeFile(path.join(dir, `${rq}.html`), html, 'utf-8');
  }
}

function userCacheDir(userId) {
  return path.join(config.scheduleCacheRoot, safeId(userId), 'schedules');
}

function cachePathForUserDate(userId, rq) {
  return path.join(userCacheDir(userId), `${rq}.json`);
}

async function listUserCacheInfo(userId) {
  try {
    const files = await fs.readdir(userCacheDir(userId));
    return {
      dir: path.resolve(userCacheDir(userId)),
      count: files.filter(file => file.endsWith('.json')).length,
      ttlSeconds: Math.round(config.cacheTtlMs / 1000),
    };
  } catch (err) {
    return {
      dir: path.resolve(userCacheDir(userId)),
      count: 0,
      ttlSeconds: Math.round(config.cacheTtlMs / 1000),
    };
  }
}

function encryptSecret(value, secret) {
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(payload, secret) {
  const [ivHex, tagHex, encryptedHex] = String(payload).split(':');
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error('Encrypted credential must use iv:tag:ciphertext format.');
  }
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function requireApiKey(req, res, next) {
  if (!config.apiKey) {
    next();
    return;
  }

  const actual = String(req.get('x-api-key') || req.query.apiKey || '');
  const ok = crypto.timingSafeEqual(
    Buffer.from(crypto.createHash('sha256').update(actual).digest('hex')),
    Buffer.from(crypto.createHash('sha256').update(config.apiKey).digest('hex')),
  );

  if (!ok) {
    res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid API key.' });
    return;
  }

  next();
}

function assertAppSecret() {
  if (!config.appSecret || config.appSecret.length < 16) {
    const err = new Error('APP_SECRET or CREDENTIAL_SECRET must be set to at least 16 characters.');
    err.status = 500;
    err.code = 'APP_SECRET_REQUIRED';
    throw err;
  }
}

function requireUserId(value) {
  const userId = String(value || '').trim();
  if (!/^[a-f0-9]{32}$/.test(userId)) {
    const err = new Error('A valid userId is required.');
    err.status = 400;
    err.code = 'BAD_USER_ID';
    throw err;
  }
  return userId;
}

function safeId(value) {
  const text = String(value || '').trim();
  if (!/^[a-f0-9]{32}$/.test(text)) {
    throw new Error('Invalid safe id.');
  }
  return text;
}

function loginSuccessResponse(userId, entry, sync = null) {
  return {
    ok: true,
    userId,
    authenticated: true,
    auth: runtimeStatus(entry),
    sync: sync || entry.sync,
  };
}

function runtimeStatus(entry) {
  return {
    status: entry?.status || 'idle',
    authenticated: isSessionFresh(entry),
    lastLoginAt: entry?.lastLoginAt ? new Date(entry.lastLoginAt).toISOString() : null,
    expiresAt: entry?.lastLoginAt ? new Date(entry.lastLoginAt + config.sessionTtlMs).toISOString() : null,
  };
}

function readBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDate(value) {
  if (!value) return '';
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function today() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isCaptchaError(err) {
  return /captcha|验证码|驗證碼|楠岃瘉鐮/i.test(String(err?.message || ''));
}

function shouldFallbackToCaptcha(err) {
  return isCaptchaError(err) || /must be 4|OCR|randomcode/i.test(String(err?.message || ''));
}

function shouldTryDirectLogin(err) {
  return /login|登录|登入|请先|ticket|ticqzket|验证码|楠岃瘉鐮/i.test(String(err?.message || ''));
}

function isSessionExpiredError(err) {
  return /sjms|session|登录|登陆|未登录|过期|请先|xsMain|login/i.test(String(err?.message || ''));
}

function sanitizeError(err) {
  return String(err?.message || err || 'Unknown error')
    .replace(/(password|userPassword)=([^&\s]+)/gi, '$1=[redacted]');
}

function mask(value) {
  const text = String(value || '');
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function statusForError(err) {
  if (err.status) return err.status;
  if (err.code === 'USER_NOT_FOUND') return 404;
  if (err.code === 'BAD_USER_ID' || err.code === 'BAD_LOGIN_REQUEST') return 400;
  return 500;
}
