'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const cors       = require('cors');
const mongoose   = require('mongoose');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.ORIGIN || '*', methods: ['GET','POST'] },
  pingTimeout: 30000, pingInterval: 15000,
});

const PORT   = process.env.PORT   || 3000;
const SECRET = process.env.ADMIN_SECRET || 'change-me';

// ── MONGODB ──────────────────────────────────────
mongoose.connect(Buffer.from('bW9uZ29kYitzcnY6Ly9tbXVzbGltb3YwNV9kYl91c2VyOlR6azkzTjFlOHVwU2ExRHBAY2x1c3RlcjAuanJpenpvaS5tb25nb2RiLm5ldC9zcGludGFsaz9yZXRyeVdyaXRlcz10cnVlJnc9bWFqb3JpdHkmYXBwTmFtZT1DbHVzdGVyMA==', 'base64').toString())
  .then(() => console.log('✅ MongoDB подключена'))
  .catch(e  => console.error('❌ MongoDB:', e.message));

// ── СХЕМЫ ────────────────────────────────────────
const Ban = mongoose.model('Ban', new mongoose.Schema({
  target:    { type: String, required: true, unique: true },
  reason:    { type: String, default: 'Нарушение правил' },
  type:      { type: String, enum: ['auto','manual'], default: 'manual' },
  until:     { type: Date,   default: null },
  by:        { type: String, default: 'Система' },
  createdAt: { type: Date,   default: Date.now },
}));

const Report = mongoose.model('Report', new mongoose.Schema({
  from:        String,
  against:     String,
  againstIP:   String,
  type:        { type: String, default: 'Неприемлемый контент' },
  description: { type: String, default: '' },
  status:      { type: String, enum: ['pending','resolved','dismissed'], default: 'pending' },
  createdAt:   { type: Date, default: Date.now },
}));

const Setting = mongoose.model('Setting', new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
}));

const StopWord = mongoose.model('StopWord', new mongoose.Schema({
  word:      { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
}));

const Log = mongoose.model('Log', new mongoose.Schema({
  type:      String,
  data:      mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, expires: 604800 },
}));

const Moderator = mongoose.model('Moderator', new mongoose.Schema({
  login:     { type: String, required: true, unique: true },
  password:  { type: String, required: true },
  role:      { type: String, enum: ['moderator','senior_mod','admin'], default: 'moderator' },
  createdAt: { type: Date, default: Date.now },
}));

// ── ХЕЛПЕРЫ ──────────────────────────────────────
async function getSetting(key, def = null) {
  const d = await Setting.findOne({ key });
  return d ? d.value : def;
}
async function setSetting(key, value) {
  await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
}
async function isBanned(ip) {
  const ban = await Ban.findOne({ target: ip });
  if (!ban) return false;
  if (ban.until && ban.until < new Date()) { await Ban.deleteOne({ _id: ban._id }); return false; }
  return ban.reason;
}
async function addLog(type, data) {
  await Log.create({ type, data }).catch(() => {});
  adminSockets.forEach(s => s.emit('admin:log', { type, data, ts: new Date() }));
}
async function filterMessage(text) {
  const words = await StopWord.find().select('word -_id');
  let out = text.trim();
  words.forEach(({ word }) => { out = out.replace(new RegExp(word, 'gi'), '***'); });
  return out;
}

// ── IN-MEMORY (только активные) ──────────────────
const waitingQueue = new Map([['video',[]],['text',[]]]);
const activePairs  = new Map();
const adminSockets = new Set();
const stats = { connectedUsers:0, activeChats:0, totalChats:0, chatsToday:0, lastReset: new Date().toDateString() };

function resetDaily() {
  const today = new Date().toDateString();
  if (stats.lastReset !== today) { stats.chatsToday = 0; stats.lastReset = today; }
}
function getIP(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address;
}
async function broadcastStats() {
  const [totalBans, pendingReports] = await Promise.all([
    Ban.countDocuments(), Report.countDocuments({ status:'pending' })
  ]);
  const payload = { ...stats, totalBans, pendingReports,
    queueVideo: waitingQueue.get('video').length,
    queueText:  waitingQueue.get('text').length };
  adminSockets.forEach(s => s.emit('admin:stats', payload));
}

// ── МАТЧИНГ ───────────────────────────────────────
function tryMatch(socket, mode, interests) {
  const queue = waitingQueue.get(mode);
  let bestIdx = -1, bestScore = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!queue[i].connected) continue;
    const score = (queue[i].interests||[]).filter(t => interests.includes(t)).length;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx === -1 && queue.length > 0) bestIdx = 0;
  if (bestIdx !== -1) {
    pairSockets(socket, queue.splice(bestIdx, 1)[0], mode);
  } else {
    queue.push(socket);
    socket.emit('status', { state:'waiting', position: queue.length });
  }
}
function pairSockets(s1, s2, mode) {
  const chatId = `chat_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const now = Date.now();
  activePairs.set(s1.id, { partner:s2.id, mode, startedAt:now, msgs:0, chatId });
  activePairs.set(s2.id, { partner:s1.id, mode, startedAt:now, msgs:0, chatId });
  s1.partner = s2; s2.partner = s1;
  s1.emit('matched', { role:'caller', mode, chatId });
  s2.emit('matched', { role:'callee', mode, chatId });
  stats.totalChats++; stats.chatsToday++; stats.activeChats++;
  resetDaily(); broadcastStats();
  addLog('match', { chatId, mode });
}
function unpair(socket, reason = 'disconnect') {
  const pair = activePairs.get(socket.id);
  if (!pair) return;
  if (socket.partner?.connected) {
    socket.partner.emit('partner:left', { reason });
    socket.partner.partner = null;
    activePairs.delete(socket.partner.id);
  }
  addLog('end', { chatId:pair.chatId, duration: Math.floor((Date.now()-pair.startedAt)/1000), msgs:pair.msgs, reason });
  activePairs.delete(socket.id);
  stats.activeChats = Math.max(0, stats.activeChats - 1);
  broadcastStats();
}
function dequeue(socket) {
  ['video','text'].forEach(m => { const q=waitingQueue.get(m); const i=q.indexOf(socket); if(i!==-1) q.splice(i,1); });
}

// ── SOCKET.IO ─────────────────────────────────────
io.on('connection', async (socket) => {
  const ip = getIP(socket);
  const banReason = await isBanned(ip);
  if (banReason) { socket.emit('banned', { reason: banReason }); socket.disconnect(true); return; }

  stats.connectedUsers++;
  broadcastStats();
  addLog('join', { id: socket.id, ip: ip.replace(/\.\d+$/, '.x') });

  socket.on('find', ({ mode='video', interests=[] }) => {
    if (!['video','text'].includes(mode)) return;
    if (activePairs.has(socket.id)) unpair(socket, 'skip');
    socket.interests = interests;
    tryMatch(socket, mode, interests);
  });

  socket.on('skip', () => {
    dequeue(socket); unpair(socket, 'skip');
    tryMatch(socket, activePairs.get(socket.id)?.mode||'video', socket.interests||[]);
  });

  socket.on('signal', d => socket.partner?.connected && socket.partner.emit('signal', d));

  socket.on('message', async ({ text }) => {
    if (typeof text !== 'string' || text.length > 500) return;
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    const clean = await filterMessage(text);
    socket.partner?.connected && socket.partner.emit('message', { text: clean, ts: Date.now() });
    pair.msgs++;
  });

  socket.on('report', async ({ type, description }) => {
    const pair = activePairs.get(socket.id);
    const report = await Report.create({
      from: socket.id, against: pair?.partner||null,
      againstIP: socket.partner ? getIP(socket.partner) : null,
      type: type||'Неприемлемый контент',
      description: description?.slice(0,500)||'',
    });
    socket.emit('report:ack');
    addLog('report', { type: report.type });
    if (report.againstIP) {
      const cnt = await Report.countDocuments({ againstIP: report.againstIP });
      if (cnt >= (await getSetting('autobanAfter', 3))) {
        await Ban.findOneAndUpdate({ target: report.againstIP },
          { reason:'Авто-бан: 3+ жалобы', type:'auto', by:'AutoMod' },
          { upsert: true });
        socket.partner?.emit('banned', { reason:'Авто-бан по жалобам' });
        addLog('auto_ban', { ip: report.againstIP });
      }
    }
    adminSockets.forEach(s => s.emit('admin:report', report));
    broadcastStats();
  });

  // ── ADMIN ────────────────────────────────────────
  socket.on('admin:auth', async ({ secret }) => {
    if (secret !== SECRET) { socket.emit('admin:auth:fail'); return; }
    adminSockets.add(socket);
    socket.emit('admin:auth:ok');
    const [reports, bans, stopWords, settingsList, mods] = await Promise.all([
      Report.find().sort({ createdAt:-1 }).limit(100),
      Ban.find().sort({ createdAt:-1 }),
      StopWord.find(),
      Setting.find(),
      Moderator.find().select('-password'),
    ]);
    const settings = {};
    settingsList.forEach(s => settings[s.key] = s.value);
    socket.emit('admin:data', { reports, bans, stopWords, settings, mods });
    broadcastStats();
  });

  socket.on('admin:ban', async ({ target, reason, durationMs }) => {
    if (!adminSockets.has(socket)) return;
    const until = durationMs ? new Date(Date.now()+durationMs) : null;
    await Ban.findOneAndUpdate({ target },
      { reason: reason||'Ручной бан', type:'manual', until, by:'Admin' },
      { upsert:true });
    addLog('ban', { target, reason });
    socket.emit('admin:ban:ok', { target });
    broadcastStats();
  });

  socket.on('admin:unban', async ({ target }) => {
    if (!adminSockets.has(socket)) return;
    await Ban.deleteOne({ target });
    addLog('unban', { target });
    broadcastStats();
  });

  socket.on('admin:settings:save', async (settings) => {
    if (!adminSockets.has(socket)) return;
    for (const [key, value] of Object.entries(settings)) await setSetting(key, value);
    socket.emit('admin:settings:saved');
    addLog('settings', { updated: Object.keys(settings) });
  });

  socket.on('admin:stopword:add', async ({ word }) => {
    if (!adminSockets.has(socket)) return;
    try { await StopWord.create({ word: word.toLowerCase().trim() }); socket.emit('admin:stopword:added', { word }); } catch(e) {}
  });

  socket.on('admin:stopword:remove', async ({ word }) => {
    if (!adminSockets.has(socket)) return;
    await StopWord.deleteOne({ word });
    socket.emit('admin:stopword:removed', { word });
  });

  socket.on('admin:report:update', async ({ id, status }) => {
    if (!adminSockets.has(socket)) return;
    await Report.findByIdAndUpdate(id, { status });
    broadcastStats();
  });

  socket.on('admin:terminate', ({ chatId }) => {
    if (!adminSockets.has(socket)) return;
    for (const [sid, pair] of activePairs) {
      if (pair.chatId === chatId) {
        const s = io.sockets.sockets.get(sid);
        if (s) { s.emit('terminated', { reason:'Модератор завершил чат' }); unpair(s, 'admin'); }
      }
    }
  });

  socket.on('admin:mod:add', async ({ login, password, role }) => {
    if (!adminSockets.has(socket)) return;
    try { const m = await Moderator.create({ login, password, role }); socket.emit('admin:mod:added', { login:m.login, role:m.role }); }
    catch(e) { socket.emit('admin:error', { msg:'Логин уже занят' }); }
  });

  socket.on('admin:mod:remove', async ({ login }) => {
    if (!adminSockets.has(socket)) return;
    await Moderator.deleteOne({ login });
    socket.emit('admin:mod:removed', { login });
  });

  socket.on('admin:logs:get', async ({ limit=200, type }={}) => {
    if (!adminSockets.has(socket)) return;
    const logs = await Log.find(type ? { type } : {}).sort({ createdAt:-1 }).limit(limit);
    socket.emit('admin:logs', logs);
  });

  socket.on('admin:bans:get', async () => {
    if (!adminSockets.has(socket)) return;
    socket.emit('admin:bans', await Ban.find().sort({ createdAt:-1 }));
  });

  socket.on('admin:reports:get', async () => {
    if (!adminSockets.has(socket)) return;
    socket.emit('admin:reports', await Report.find().sort({ createdAt:-1 }).limit(100));
  });

  socket.on('disconnect', () => {
    dequeue(socket); unpair(socket, 'disconnect');
    adminSockets.delete(socket);
    stats.connectedUsers = Math.max(0, stats.connectedUsers - 1);
    broadcastStats();
    addLog('leave', { id: socket.id });
  });
});

// ── REST API ──────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(rateLimit({ windowMs: 15*60*1000, max: 100 }));

app.get('/api/stats', (req, res) => {
  resetDaily();
  res.json({ online: stats.connectedUsers, activeChats: stats.activeChats, chatsToday: stats.chatsToday, totalChats: stats.totalChats });
});

app.post('/api/admin/login', async (req, res) => {
  const { login, password } = req.body;
  const mod = await Moderator.findOne({ login, password });
  if (!mod) return res.status(401).json({ error: 'Неверный логин или пароль' });
  res.json({ ok: true, role: mod.role, login: mod.login, secret: SECRET });
});

app.get('/api/settings', async (req, res) => {
  const list = await Setting.find();
  const obj  = {};
  list.forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

// ── ИНИЦИАЛИЗАЦИЯ ─────────────────────────────────
async function seedDefaults() {
  const adminExists = await Moderator.findOne({ login: 'admin' });
  if (!adminExists) {
    await Moderator.create({ login:'admin', password: process.env.ADMIN_PASSWORD||'admin123', role:'admin' });
    console.log('✅ Создан администратор (admin / admin123) — смените пароль!');
  }
  const defaults = { siteName:'SpinTalk', minAge:18, maxUsers:10000, maintenance:false, autobanAfter:3 };
  for (const [key, value] of Object.entries(defaults)) {
    if (!await Setting.findOne({ key })) await Setting.create({ key, value });
  }
  for (const word of ['casino','spam','scam','pornhub']) {
    try { await StopWord.create({ word }); } catch(e) {}
  }
}

// ── СТАРТ ─────────────────────────────────────────
server.listen(PORT, async () => {
  await seedDefaults();
  console.log(`\n✅ SpinTalk: http://localhost:${PORT}`);
  console.log(`   Админка:  http://localhost:${PORT}/admin/login.html\n`);
});

process.on('SIGTERM', () => {
  io.emit('server:shutdown', { message:'Сервер перезапускается...' });
  server.close(() => process.exit(0));
});
