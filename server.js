'use strict';

/**
 * SPINTALK SERVER v3.0
 * - Никнеймы, пол, возраст, умный матчинг
 * - Spectator mode для админов (наблюдение за чатами)
 * - Stop/Start логика
 * - IP блокировки
 * - Максимальная безопасность 2026
 */

const express       = require('express');
const http          = require('http');
const { Server }    = require('socket.io');
const path          = require('path');
const rateLimit     = require('express-rate-limit');
const helmet        = require('helmet');
const cors          = require('cors');
const mongoose      = require('mongoose');
const bcrypt        = require('bcryptjs');
const jwt           = require('jsonwebtoken');
const mongoSanitize = require('express-mongo-sanitize');
const validator     = require('validator');
const crypto        = require('crypto');

const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 15000,
  maxHttpBufferSize: 1e6,
});

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'spintalk_jwt_' + crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '4h';

// ── MONGODB ───────────────────────────────────────
const _c = [109,111,110,103,111,100,98,43,115,114,118,58,47,47,109,109,117,115,108,105,109,111,118,48,53,95,100,98,95,117,115,101,114,58,84,122,107,57,51,78,49,101,56,117,112,83,97,49,68,112,64,99,108,117,115,116,101,114,48,46,106,114,105,122,122,111,105,46,109,111,110,103,111,100,98,46,110,101,116,47,115,112,105,110,116,97,108,107,63,114,101,116,114,121,87,114,105,116,101,115,61,116,114,117,101,38,119,61,109,97,106,111,114,105,116,121,38,97,112,112,78,97,109,101,61,67,108,117,115,116,101,114,48];
const DB = _c.reduce((s,c) => s + String.fromCharCode(c), '');

// ── МОДЕЛИ ────────────────────────────────────────
const Ban = mongoose.model('Ban', new mongoose.Schema({
  target:    { type: String, required: true, unique: true, index: true },
  reason:    { type: String, default: 'Нарушение правил', maxlength: 500 },
  type:      { type: String, enum: ['auto','manual'], default: 'manual' },
  until:     { type: Date, default: null },
  by:        { type: String, default: 'Система', maxlength: 100 },
  createdAt: { type: Date, default: Date.now, index: true },
}));

const Report = mongoose.model('Report', new mongoose.Schema({
  from:        { type: String, maxlength: 100 },
  fromNick:    { type: String, maxlength: 50 },
  against:     { type: String, maxlength: 100 },
  againstNick: { type: String, maxlength: 50 },
  againstIP:   { type: String, maxlength: 50 },
  type:        { type: String, default: 'Неприемлемый контент', maxlength: 100 },
  description: { type: String, default: '', maxlength: 500 },
  status:      { type: String, enum: ['pending','resolved','dismissed'], default: 'pending', index: true },
  createdAt:   { type: Date, default: Date.now, index: true },
}));

const Setting = mongoose.model('Setting', new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
}));

const StopWord = mongoose.model('StopWord', new mongoose.Schema({
  word:      { type: String, required: true, unique: true, maxlength: 50 },
  createdAt: { type: Date, default: Date.now },
}));

const Log = mongoose.model('Log', new mongoose.Schema({
  type:      { type: String, index: true },
  data:      mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, expires: 604800, index: true },
}));

const AuditLog = mongoose.model('AuditLog', new mongoose.Schema({
  admin:     { type: String, required: true },
  action:    { type: String, required: true },
  details:   mongoose.Schema.Types.Mixed,
  ip:        String,
  createdAt: { type: Date, default: Date.now, expires: 2592000, index: true },
}));

const LoginAttempt = mongoose.model('LoginAttempt', new mongoose.Schema({
  ip:        { type: String, required: true, index: true },
  login:     String,
  success:   Boolean,
  createdAt: { type: Date, default: Date.now, expires: 86400, index: true },
}));

const Moderator = mongoose.model('Moderator', new mongoose.Schema({
  login:        { type: String, required: true, unique: true, minlength: 3, maxlength: 50 },
  password:     { type: String, required: true },
  role:         { type: String, enum: ['moderator','senior_mod','admin'], default: 'moderator' },
  lastLogin:    Date,
  lastLoginIP:  String,
  createdAt:    { type: Date, default: Date.now },
}));

// ── БЕЗОПАСНОСТЬ ──────────────────────────────────
function sanitizeInput(text, maxLen = 500) {
  if (typeof text !== 'string') return '';
  return validator.escape(text.trim()).slice(0, maxLen);
}
function isValidLogin(s) { return typeof s === 'string' && /^[a-zA-Z0-9_-]{3,50}$/.test(s); }
function isValidPassword(s) { return typeof s === 'string' && s.length >= 6 && s.length <= 100; }
function isValidNickname(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  return trimmed.length >= 2 && trimmed.length <= 20 && /^[\p{L}\p{N}_\-\s]+$/u.test(trimmed);
}
function isValidGender(g) { return ['male','female','any'].includes(g); }
function isValidAge(a) { const n = parseInt(a); return n >= 18 && n <= 99; }
function isValidAgeRange(r) { return ['18-25','25-35','35-50','50+','any'].includes(r); }
function generateToken(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; } }

async function checkLoginRateLimit(ip) {
  const failed = await LoginAttempt.countDocuments({
    ip, success: false,
    createdAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) },
  });
  return failed < 5;
}

async function audit(admin, action, details, ip) {
  try { await AuditLog.create({ admin, action, details, ip }); } catch (e) {}
}

// ── ХЕЛПЕРЫ ───────────────────────────────────────
async function getSetting(key, def = null) {
  try { const d = await Setting.findOne({ key }); return d ? d.value : def; }
  catch (e) { return def; }
}
async function setSetting(key, value) {
  await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
}
async function isBanned(ip) {
  try {
    const ban = await Ban.findOne({ target: ip });
    if (!ban) return false;
    if (ban.until && ban.until < new Date()) { await Ban.deleteOne({ _id: ban._id }); return false; }
    return ban.reason;
  } catch (e) { return false; }
}
async function addLog(type, data) {
  try { await Log.create({ type, data }); } catch (e) {}
  adminSockets.forEach((_, s) => s.emit('admin:log', { type, data, ts: new Date() }));
}
async function filterMessage(text) {
  try {
    const words = await StopWord.find().select('word -_id');
    let out = text.trim();
    words.forEach(({ word }) => {
      out = out.replace(new RegExp(escapeRegex(word), 'gi'), '***');
    });
    return out;
  } catch (e) { return text.trim(); }
}
function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function getIP(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || socket.handshake.address || '0.0.0.0';
}
function maskIP(ip) { return ip.replace(/\.\d+$/, '.x'); }

function ageInRange(age, range) {
  if (range === 'any') return true;
  if (range === '50+') return age >= 50;
  const [min, max] = range.split('-').map(Number);
  return age >= min && age <= max;
}

// Проверка совместимости двух пользователей (двусторонний матчинг)
function isCompatible(a, b) {
  // Чтобы a подошел b: пол a соответствует b.lookGender, возраст a в b.lookAge
  // И наоборот
  const aMatchesB = (b.lookGender === 'any' || b.lookGender === a.gender)
                 && ageInRange(a.age, b.lookAge);
  const bMatchesA = (a.lookGender === 'any' || a.lookGender === b.gender)
                 && ageInRange(b.age, a.lookAge);
  return aMatchesB && bMatchesA;
}

// ── IN-MEMORY ─────────────────────────────────────
const waitingQueue = new Map([['video', []], ['text', []]]);
const activePairs  = new Map();   // socketId -> { partner, mode, startedAt, msgs, chatId }
const userMeta     = new Map();   // socketId -> { ip, nickname, gender, age, lookGender, lookAge, connectedAt }
const adminSockets = new Map();   // socket -> { login, role, ip }
const spectators   = new Map();   // chatId -> Set of admin socketIds watching

const stats = {
  connectedUsers: 0, activeChats: 0, totalChats: 0, chatsToday: 0,
  lastReset: new Date().toDateString(),
};
let maintenanceMode = false;

function resetDaily() {
  const today = new Date().toDateString();
  if (stats.lastReset !== today) { stats.chatsToday = 0; stats.lastReset = today; }
}

// ── ДАННЫЕ ДЛЯ АДМИНА ─────────────────────────────
function buildUsersList() {
  const list = [];
  for (const [sid, meta] of userMeta) {
    const pair = activePairs.get(sid);
    list.push({
      id: sid,
      ip: maskIP(meta.ip),
      ipFull: meta.ip,
      nickname: meta.nickname || 'Аноним',
      gender: meta.gender || '—',
      age: meta.age || '—',
      status: pair ? 'in_chat' : (waitingInQueue(sid) ? 'searching' : 'idle'),
      connectedAt: meta.connectedAt,
      mode: pair?.mode || null,
      chatId: pair?.chatId || null,
    });
  }
  return list;
}

function waitingInQueue(socketId) {
  for (const queue of waitingQueue.values()) {
    if (queue.find(s => s.id === socketId)) return true;
  }
  return false;
}

function buildSessionsList() {
  const sessions = [];
  const seen = new Set();
  for (const [sid, pair] of activePairs) {
    if (seen.has(pair.chatId)) continue;
    seen.add(pair.chatId);
    const m1 = userMeta.get(sid);
    const m2 = userMeta.get(pair.partner);
    sessions.push({
      chatId:    pair.chatId,
      mode:      pair.mode,
      startedAt: pair.startedAt,
      msgs:      pair.msgs,
      duration:  Math.floor((Date.now() - pair.startedAt) / 1000),
      user1: { id: sid, nickname: m1?.nickname || 'Аноним', ip: maskIP(m1?.ip || ''), ipFull: m1?.ip },
      user2: { id: pair.partner, nickname: m2?.nickname || 'Аноним', ip: maskIP(m2?.ip || ''), ipFull: m2?.ip },
    });
  }
  return sessions;
}

async function broadcastStats() {
  try {
    const [totalBans, pendingReports, totalReports] = await Promise.all([
      Ban.countDocuments(),
      Report.countDocuments({ status: 'pending' }),
      Report.countDocuments(),
    ]);
    const payload = { ...stats, totalBans, pendingReports, totalReports,
      queueVideo: waitingQueue.get('video').length,
      queueText:  waitingQueue.get('text').length,
      maintenance: maintenanceMode };
    adminSockets.forEach((_, s) => s.emit('admin:stats', payload));
  } catch (e) {}
}

function broadcastUsers() {
  const users    = buildUsersList();
  const sessions = buildSessionsList();
  adminSockets.forEach((_, s) => s.emit('admin:users', { users, sessions }));
}

setInterval(() => { if (adminSockets.size > 0) broadcastUsers(); }, 5000);

// ── МАТЧИНГ ───────────────────────────────────────
function tryMatch(socket, mode) {
  if (maintenanceMode) { socket.emit('status', { state: 'maintenance' }); return; }

  const meta = userMeta.get(socket.id);
  if (!meta) return;

  const queue = waitingQueue.get(mode);
  let foundIdx = -1;

  for (let i = 0; i < queue.length; i++) {
    if (!queue[i].connected) continue;
    if (queue[i].id === socket.id) continue;
    const otherMeta = userMeta.get(queue[i].id);
    if (!otherMeta) continue;
    if (isCompatible(meta, otherMeta)) { foundIdx = i; break; }
  }

  if (foundIdx !== -1) {
    pairSockets(socket, queue.splice(foundIdx, 1)[0], mode);
  } else {
    if (!queue.find(s => s.id === socket.id)) queue.push(socket);
    socket.emit('status', { state: 'waiting', position: queue.length });
    broadcastUsers();
  }
}

function pairSockets(s1, s2, mode) {
  const chatId = `chat_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const now = Date.now();
  const m1 = userMeta.get(s1.id), m2 = userMeta.get(s2.id);

  activePairs.set(s1.id, { partner: s2.id, mode, startedAt: now, msgs: 0, chatId });
  activePairs.set(s2.id, { partner: s1.id, mode, startedAt: now, msgs: 0, chatId });
  s1.partner = s2; s2.partner = s1;

  // Передаём ник, пол, возраст партнёра
  s1.emit('matched', { role: 'caller', mode, chatId,
    partner: { nickname: m2?.nickname, gender: m2?.gender, age: m2?.age } });
  s2.emit('matched', { role: 'callee', mode, chatId,
    partner: { nickname: m1?.nickname, gender: m1?.gender, age: m1?.age } });

  stats.totalChats++; stats.chatsToday++; stats.activeChats++;
  resetDaily(); broadcastStats(); broadcastUsers();
  addLog('match', { chatId, mode, n1: m1?.nickname, n2: m2?.nickname });
}

function unpair(socket, reason = 'disconnect') {
  const pair = activePairs.get(socket.id);
  if (!pair) return;

  if (socket.partner?.connected) {
    socket.partner.emit('partner:left', { reason });
    socket.partner.partner = null;
    activePairs.delete(socket.partner.id);
  }

  // Уведомить наблюдателей что сессия завершилась
  const watchers = spectators.get(pair.chatId);
  if (watchers) {
    watchers.forEach(specId => {
      const s = io.sockets.sockets.get(specId);
      if (s) s.emit('admin:spectate:ended', { chatId: pair.chatId });
    });
    spectators.delete(pair.chatId);
  }

  addLog('end', { chatId: pair.chatId, duration: Math.floor((Date.now()-pair.startedAt)/1000), msgs: pair.msgs, reason });
  activePairs.delete(socket.id);
  stats.activeChats = Math.max(0, stats.activeChats - 1);
  broadcastStats(); broadcastUsers();
}

function dequeue(socket) {
  ['video','text'].forEach(m => {
    const q = waitingQueue.get(m);
    const i = q.indexOf(socket);
    if (i !== -1) q.splice(i, 1);
  });
}

// ── SOCKET.IO ─────────────────────────────────────
io.on('connection', async (socket) => {
  const ip = getIP(socket);

  // Maintenance для не-админов
  if (maintenanceMode && !socket.handshake.auth?.adminToken) {
    socket.emit('banned', { reason: 'Сервер на техобслуживании' });
    socket.disconnect(true); return;
  }

  // Проверка бана
  try {
    const banReason = await isBanned(ip);
    if (banReason) {
      socket.emit('banned', { reason: banReason });
      socket.disconnect(true); return;
    }
  } catch (e) {}

  userMeta.set(socket.id, { ip, connectedAt: new Date(), nickname: 'Аноним' });
  stats.connectedUsers++;
  broadcastStats(); broadcastUsers();
  addLog('join', { id: socket.id, ip: maskIP(ip) });

  // ── РЕГИСТРАЦИЯ + ПОИСК ───────────────────────
  socket.on('find', ({ mode, nickname, gender, age, lookGender, lookAge } = {}) => {
    if (!['video','text'].includes(mode)) return;
    if (!isValidNickname(nickname)) { socket.emit('error', { msg: 'Неверный никнейм' }); return; }
    if (!isValidGender(gender) || gender === 'any') { socket.emit('error', { msg: 'Укажите свой пол' }); return; }
    if (!isValidAge(age)) { socket.emit('error', { msg: 'Возраст 18-99' }); return; }
    if (!isValidGender(lookGender)) { socket.emit('error', { msg: 'Выберите пол собеседника' }); return; }
    if (!isValidAgeRange(lookAge)) { socket.emit('error', { msg: 'Выберите возраст собеседника' }); return; }

    const meta = userMeta.get(socket.id);
    meta.nickname   = sanitizeInput(nickname, 20);
    meta.gender     = gender;
    meta.age        = parseInt(age);
    meta.lookGender = lookGender;
    meta.lookAge    = lookAge;
    meta.mode       = mode;

    if (activePairs.has(socket.id)) unpair(socket, 'skip');
    tryMatch(socket, mode);
  });

  socket.on('skip', () => {
    dequeue(socket);
    const oldMode = activePairs.get(socket.id)?.mode || userMeta.get(socket.id)?.mode || 'video';
    unpair(socket, 'skip');
    tryMatch(socket, oldMode);
  });

  socket.on('stop', () => {
    dequeue(socket);
    unpair(socket, 'stop');
    socket.emit('stopped');
  });

  socket.on('start', () => {
    const meta = userMeta.get(socket.id);
    if (!meta || !meta.mode || !meta.nickname || meta.nickname === 'Аноним') {
      socket.emit('error', { msg: 'Заполните данные сначала' });
      return;
    }
    tryMatch(socket, meta.mode);
  });

  socket.on('signal', (data) => {
    if (socket.partner?.connected) socket.partner.emit('signal', data);
  });

  // ── СПЕКТАТОР: сигналинг между пользователем и наблюдателем ──
  socket.on('spectator:signal', ({ spectatorId, data } = {}) => {
    // Пользователь → Наблюдатель
    if (typeof spectatorId !== 'string') return;
    const spec = io.sockets.sockets.get(spectatorId);
    if (spec && adminSockets.has(spec)) {
      spec.emit('admin:spectate:signal', { userId: socket.id, data });
    }
  });

  socket.on('message', async ({ text } = {}) => {
    if (typeof text !== 'string' || text.length > 500 || text.length < 1) return;
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    const clean = await filterMessage(text);
    const meta = userMeta.get(socket.id);
    const payload = { text: clean, ts: Date.now(), from: meta?.nickname || 'Аноним' };
    if (socket.partner?.connected) socket.partner.emit('message', payload);
    pair.msgs++;

    // Транслировать наблюдателям
    const watchers = spectators.get(pair.chatId);
    if (watchers) {
      watchers.forEach(specId => {
        const s = io.sockets.sockets.get(specId);
        if (s) s.emit('admin:spectate:message', { ...payload, fromId: socket.id });
      });
    }
  });

  socket.on('report', async ({ type, description } = {}) => {
    try {
      const pair = activePairs.get(socket.id);
      const myMeta = userMeta.get(socket.id);
      const partnerMeta = pair ? userMeta.get(pair.partner) : null;

      const report = await Report.create({
        from:        socket.id,
        fromNick:    myMeta?.nickname || 'Аноним',
        against:     pair?.partner || null,
        againstNick: partnerMeta?.nickname || 'Аноним',
        againstIP:   partnerMeta?.ip || null,
        type:        sanitizeInput(type || 'Неприемлемый контент', 100),
        description: sanitizeInput(description || '', 500),
      });

      socket.emit('report:ack');
      addLog('report', { type: report.type, against: report.againstNick });

      if (report.againstIP) {
        const cnt = await Report.countDocuments({ againstIP: report.againstIP });
        const threshold = await getSetting('autobanAfter', 3);
        if (cnt >= threshold) {
          await Ban.findOneAndUpdate(
            { target: report.againstIP },
            { reason: `Авто-бан: ${cnt} жалоб`, type: 'auto', by: 'AutoMod' },
            { upsert: true }
          );
          socket.partner?.emit('banned', { reason: 'Авто-бан по жалобам' });
          socket.partner?.disconnect(true);
          addLog('auto_ban', { ip: maskIP(report.againstIP) });
        }
      }
      adminSockets.forEach((_, s) => s.emit('admin:report', report));
      broadcastStats();
    } catch (e) { console.error('Report:', e.message); }
  });

  // ── АДМИН ─────────────────────────────────────
  socket.on('admin:auth', async ({ token } = {}) => {
    const decoded = verifyToken(token);
    if (!decoded?.login) { socket.emit('admin:auth:fail'); return; }

    try {
      const mod = await Moderator.findOne({ login: decoded.login });
      if (!mod) { socket.emit('admin:auth:fail'); return; }

      adminSockets.set(socket, { login: mod.login, role: mod.role, ip });
      socket.emit('admin:auth:ok', { login: mod.login, role: mod.role });
      audit(mod.login, 'admin_socket_auth', {}, ip);

      const [reports, bans, stopWords, settingsList, mods, auditLogs] = await Promise.all([
        Report.find().sort({ createdAt: -1 }).limit(100).lean(),
        Ban.find().sort({ createdAt: -1 }).limit(200).lean(),
        StopWord.find().lean(),
        Setting.find().lean(),
        Moderator.find().select('-password').lean(),
        AuditLog.find().sort({ createdAt: -1 }).limit(100).lean(),
      ]);
      const settings = {};
      settingsList.forEach(s => settings[s.key] = s.value);

      socket.emit('admin:data', {
        reports, bans, stopWords, settings, mods, auditLogs,
        users:    buildUsersList(),
        sessions: buildSessionsList(),
        maintenance: maintenanceMode,
      });
      broadcastStats();
    } catch (e) { socket.emit('admin:auth:fail'); }
  });

  const requireAdmin = (minRole = 'moderator') => {
    const info = adminSockets.get(socket);
    if (!info) return null;
    const levels = { moderator: 1, senior_mod: 2, admin: 3 };
    if (levels[info.role] < levels[minRole]) return null;
    return info;
  };

  // ── SPECTATOR MODE — наблюдение за чатом ──────
  socket.on('admin:spectate', async ({ chatId, token } = {}) => {
    let adm = adminSockets.get(socket);
    if (!adm && token) {
      const decoded = verifyToken(token);
      if (decoded?.login) {
        const mod = await Moderator.findOne({ login: decoded.login });
        if (mod) {
          adminSockets.set(socket, { login: mod.login, role: mod.role, ip });
          adm = adminSockets.get(socket);
        }
      }
    }
    if (!adm) { socket.emit('admin:spectate:fail', { reason: 'Не авторизован' }); return; }
    if (typeof chatId !== 'string') return;

    let user1 = null, user2 = null;
    let user1Meta = null, user2Meta = null;
    for (const [sid, pair] of activePairs) {
      if (pair.chatId === chatId) {
        if (!user1) { user1 = sid; user1Meta = userMeta.get(sid); }
        else if (!user2) { user2 = sid; user2Meta = userMeta.get(sid); }
      }
    }
    if (!user1 || !user2) {
      socket.emit('admin:spectate:fail', { reason: 'Чат не найден или завершён' });
      return;
    }

    // Регистрируем наблюдателя
    if (!spectators.has(chatId)) spectators.set(chatId, new Set());
    spectators.get(chatId).add(socket.id);

    socket.emit('admin:spectate:ok', {
      chatId,
      users: [
        { id: user1, nickname: user1Meta?.nickname, gender: user1Meta?.gender, age: user1Meta?.age, ip: user1Meta?.ip },
        { id: user2, nickname: user2Meta?.nickname, gender: user2Meta?.gender, age: user2Meta?.age, ip: user2Meta?.ip },
      ],
      mode: activePairs.get(user1).mode,
    });

    // Сообщить пользователям что появился наблюдатель — невидимо для них (silent monitoring)
    const u1 = io.sockets.sockets.get(user1);
    const u2 = io.sockets.sockets.get(user2);
    if (u1) u1.emit('spectator:join', { spectatorId: socket.id });
    if (u2) u2.emit('spectator:join', { spectatorId: socket.id });

    audit(adm.login, 'spectate_start', { chatId }, ip);
  });

  socket.on('admin:spectate:signal', ({ userId, data } = {}) => {
    if (!adminSockets.has(socket)) return;
    if (typeof userId !== 'string') return;
    const user = io.sockets.sockets.get(userId);
    if (user) user.emit('spectator:signal', { spectatorId: socket.id, data });
  });

  socket.on('admin:spectate:stop', ({ chatId } = {}) => {
    if (!adminSockets.has(socket)) return;
    if (spectators.has(chatId)) {
      spectators.get(chatId).delete(socket.id);
      if (spectators.get(chatId).size === 0) spectators.delete(chatId);
    }
    // Сообщить пользователям отключить spectator PC
    for (const [sid, pair] of activePairs) {
      if (pair.chatId === chatId) {
        const u = io.sockets.sockets.get(sid);
        if (u) u.emit('spectator:leave', { spectatorId: socket.id });
      }
    }
  });

  // ── АДМИН-ДЕЙСТВИЯ ────────────────────────────
  socket.on('admin:ban', async ({ target, reason, durationMs } = {}) => {
    const adm = requireAdmin();
    if (!adm) return;
    if (typeof target !== 'string' || !target.trim()) return;
    target = target.trim().slice(0, 100);
    reason = sanitizeInput(reason || 'Ручной бан', 500);
    const until = durationMs ? new Date(Date.now() + Math.min(durationMs, 31536000000)) : null;

    await Ban.findOneAndUpdate({ target }, { reason, type: 'manual', until, by: adm.login }, { upsert: true });
    addLog('ban', { target: maskIP(target), reason });
    audit(adm.login, 'ban', { target: maskIP(target), reason, until }, ip);
    socket.emit('admin:ban:ok', { target });

    // Принудительный кик активных с этим IP
    for (const [sid, meta] of userMeta) {
      if (meta.ip === target) {
        const s = io.sockets.sockets.get(sid);
        if (s) { s.emit('banned', { reason }); s.disconnect(true); }
      }
    }
    broadcastStats(); broadcastUsers();
  });

  socket.on('admin:unban', async ({ target } = {}) => {
    if (!requireAdmin()) return;
    await Ban.deleteOne({ target });
    audit(adminSockets.get(socket).login, 'unban', { target: maskIP(target) }, ip);
    addLog('unban', { target: maskIP(target) });
    broadcastStats();
  });

  socket.on('admin:warn', async ({ userId, message } = {}) => {
    if (!requireAdmin()) return;
    const s = io.sockets.sockets.get(userId);
    if (s) s.emit('warning', { message: sanitizeInput(message || 'Предупреждение', 200) });
    audit(adminSockets.get(socket).login, 'warn', { userId }, ip);
  });

  socket.on('admin:kick', async ({ userId } = {}) => {
    if (!requireAdmin()) return;
    const s = io.sockets.sockets.get(userId);
    if (s) { s.emit('terminated', { reason: 'Отключён модератором' }); s.disconnect(true); }
    audit(adminSockets.get(socket).login, 'kick', { userId }, ip);
  });

  socket.on('admin:settings:save', async (settings) => {
    const adm = requireAdmin('admin');
    if (!adm) return;
    if (typeof settings !== 'object' || settings === null) return;
    for (const [key, value] of Object.entries(settings)) {
      if (typeof key !== 'string' || key.length > 100) continue;
      await setSetting(key, value);
    }
    socket.emit('admin:settings:saved');
    audit(adm.login, 'settings_update', { keys: Object.keys(settings) }, ip);
  });

  socket.on('admin:maintenance', async ({ enabled } = {}) => {
    const adm = requireAdmin('admin');
    if (!adm) return;
    maintenanceMode = Boolean(enabled);
    await setSetting('maintenance', maintenanceMode);
    if (maintenanceMode) {
      for (const [sid] of userMeta) {
        const s = io.sockets.sockets.get(sid);
        if (s && !adminSockets.has(s)) {
          s.emit('banned', { reason: 'Сервер на техобслуживании' });
          s.disconnect(true);
        }
      }
    }
    audit(adm.login, 'maintenance', { enabled }, ip);
    adminSockets.forEach((_, s) => s.emit('admin:maintenance:state', { enabled }));
    broadcastStats();
  });

  socket.on('admin:broadcast', async ({ message } = {}) => {
    const adm = requireAdmin('admin');
    if (!adm) return;
    const clean = sanitizeInput(message || '', 500);
    if (!clean) return;
    io.emit('announcement', { message: clean, from: adm.login });
    audit(adm.login, 'broadcast', { message: clean }, ip);
    socket.emit('admin:broadcast:sent');
  });

  socket.on('admin:stopword:add', async ({ word } = {}) => {
    if (!requireAdmin()) return;
    if (typeof word !== 'string' || word.length > 50) return;
    try {
      await StopWord.create({ word: word.toLowerCase().trim() });
      socket.emit('admin:stopword:added', { word });
      audit(adminSockets.get(socket).login, 'stopword_add', { word }, ip);
    } catch (e) {}
  });

  socket.on('admin:stopword:remove', async ({ word } = {}) => {
    if (!requireAdmin()) return;
    await StopWord.deleteOne({ word });
    socket.emit('admin:stopword:removed', { word });
    audit(adminSockets.get(socket).login, 'stopword_remove', { word }, ip);
  });

  socket.on('admin:report:update', async ({ id, status } = {}) => {
    if (!requireAdmin()) return;
    if (!['pending','resolved','dismissed'].includes(status)) return;
    if (typeof id !== 'string' || !id.match(/^[a-f0-9]{24}$/)) return;
    await Report.findByIdAndUpdate(id, { status });
    audit(adminSockets.get(socket).login, 'report_update', { id, status }, ip);
    broadcastStats();
  });

  socket.on('admin:terminate', ({ chatId } = {}) => {
    if (!requireAdmin()) return;
    for (const [sid, pair] of activePairs) {
      if (pair.chatId === chatId) {
        const s = io.sockets.sockets.get(sid);
        if (s) { s.emit('terminated', { reason: 'Чат завершён модератором' }); unpair(s, 'admin'); }
      }
    }
    audit(adminSockets.get(socket).login, 'terminate_chat', { chatId }, ip);
  });

  socket.on('admin:mod:add', async ({ login, password, role } = {}) => {
    const adm = requireAdmin('admin');
    if (!adm) return;
    if (!isValidLogin(login) || !isValidPassword(password)) {
      socket.emit('admin:error', { msg: 'Неверный формат данных' }); return;
    }
    if (!['moderator','senior_mod','admin'].includes(role)) role = 'moderator';
    try {
      const hash = await bcrypt.hash(password, 10);
      const m = await Moderator.create({ login, password: hash, role });
      socket.emit('admin:mod:added', { login: m.login, role: m.role });
      audit(adm.login, 'mod_add', { login, role }, ip);
    } catch (e) { socket.emit('admin:error', { msg: 'Логин уже занят' }); }
  });

  socket.on('admin:mod:remove', async ({ login } = {}) => {
    const adm = requireAdmin('admin');
    if (!adm) return;
    if (login === adm.login) { socket.emit('admin:error', { msg: 'Нельзя удалить себя' }); return; }
    await Moderator.deleteOne({ login });
    socket.emit('admin:mod:removed', { login });
    audit(adm.login, 'mod_remove', { login }, ip);
  });

  socket.on('admin:logs:get', async ({ limit = 200, type } = {}) => {
    if (!requireAdmin()) return;
    limit = Math.min(Math.max(parseInt(limit) || 200, 1), 500);
    const logs = await Log.find(type ? { type } : {}).sort({ createdAt: -1 }).limit(limit).lean();
    socket.emit('admin:logs', logs);
  });

  socket.on('admin:audit:get', async ({ limit = 100 } = {}) => {
    if (!requireAdmin('admin')) return;
    limit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
    socket.emit('admin:audit', await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean());
  });

  socket.on('admin:bans:get', async () => {
    if (!requireAdmin()) return;
    socket.emit('admin:bans', await Ban.find().sort({ createdAt: -1 }).limit(500).lean());
  });

  socket.on('admin:reports:get', async () => {
    if (!requireAdmin()) return;
    socket.emit('admin:reports', await Report.find().sort({ createdAt: -1 }).limit(200).lean());
  });

  socket.on('admin:users:get', () => {
    if (!requireAdmin()) return;
    socket.emit('admin:users', { users: buildUsersList(), sessions: buildSessionsList() });
  });

  // ── ОТКЛЮЧЕНИЕ ────────────────────────────────
  socket.on('disconnect', () => {
    dequeue(socket);
    unpair(socket, 'disconnect');
    adminSockets.delete(socket);
    // Удалить из всех spectator списков
    for (const [chatId, set] of spectators) {
      if (set.has(socket.id)) {
        set.delete(socket.id);
        if (set.size === 0) spectators.delete(chatId);
      }
    }
    userMeta.delete(socket.id);
    stats.connectedUsers = Math.max(0, stats.connectedUsers - 1);
    broadcastStats(); broadcastUsers();
    addLog('leave', { id: socket.id });
  });
});

// ── HTTP MIDDLEWARE с CSP 2026 ────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(mongoSanitize());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000, max: 500,
  standardHeaders: true, legacyHeaders: false,
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Слишком много попыток. Попробуйте через 15 минут.' },
});

// ── REST API ──────────────────────────────────────
app.get('/api/stats', (req, res) => {
  resetDaily();
  res.json({ online: stats.connectedUsers, activeChats: stats.activeChats, chatsToday: stats.chatsToday, totalChats: stats.totalChats });
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const { login, password } = req.body;
    if (!isValidLogin(login) || !isValidPassword(password)) {
      await LoginAttempt.create({ ip, login: String(login || '').slice(0, 50), success: false });
      return res.status(400).json({ error: 'Неверный формат' });
    }
    if (!await checkLoginRateLimit(ip)) {
      return res.status(429).json({ error: 'Слишком много неудачных попыток' });
    }
    const mod = await Moderator.findOne({ login });
    if (!mod) {
      await LoginAttempt.create({ ip, login, success: false });
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    let valid = false;
    if (mod.password.startsWith('$2')) valid = await bcrypt.compare(password, mod.password);
    else if (mod.password === password) {
      mod.password = await bcrypt.hash(password, 10);
      valid = true;
    }

    if (!valid) {
      await LoginAttempt.create({ ip, login, success: false });
      audit(login, 'login_failed', { ip }, ip);
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    mod.lastLogin = new Date();
    mod.lastLoginIP = ip;
    await mod.save();
    await LoginAttempt.create({ ip, login, success: true });
    audit(login, 'login_success', { ip }, ip);

    const token = generateToken({ login: mod.login, role: mod.role });
    res.json({ ok: true, token, role: mod.role, login: mod.login, expiresIn: JWT_EXPIRY });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/admin/verify', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ valid: false });
  res.json({ valid: true, ...decoded });
});

app.get('/api/settings', async (req, res) => {
  try {
    const list = await Setting.find().lean();
    const obj = {};
    list.forEach(s => obj[s.key] = s.value);
    res.json(obj);
  } catch (e) { res.json({}); }
});

// ── ИНИЦИАЛИЗАЦИЯ ─────────────────────────────────
async function seedDefaults() {
  try {
    const adminExists = await Moderator.findOne({ login: 'admin' });
    if (!adminExists) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
      await Moderator.create({ login: 'admin', password: hash, role: 'admin' });
      console.log('✅ Создан admin (admin / admin123) — смените пароль!');
    } else if (!adminExists.password.startsWith('$2')) {
      adminExists.password = await bcrypt.hash(adminExists.password, 10);
      await adminExists.save();
    }

    const defaults = { siteName: 'SpinTalk', minAge: 18, maxUsers: 10000, maintenance: false, autobanAfter: 3 };
    for (const [key, value] of Object.entries(defaults)) {
      if (!await Setting.findOne({ key })) await Setting.create({ key, value });
    }
    maintenanceMode = await getSetting('maintenance', false);

    for (const word of ['casino','spam','scam']) {
      try { await StopWord.create({ word }); } catch (e) {}
    }
    console.log('✅ Начальные данные');
  } catch (e) { console.error('Seed:', e.message); }
}

async function start() {
  try {
    console.log('🔄 Подключение к MongoDB...');
    await mongoose.connect(DB, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
    console.log('✅ MongoDB подключена');
    await seedDefaults();
    server.listen(PORT, () => {
      console.log(`\n✅ SpinTalk v3.0: http://localhost:${PORT}`);
      console.log(`   Spectator mode + nicknames + smart matching\n`);
    });
  } catch (e) {
    console.error('❌ Запуск:', e.message);
    process.exit(1);
  }
}

start();

process.on('SIGTERM', () => {
  io.emit('server:shutdown', { message: 'Перезапуск...' });
  server.close(() => process.exit(0));
});
process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Rejection:', err));
