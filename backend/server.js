const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 3005;
const HOST = process.env.HOST || '127.0.0.1';
// An avatar key is `<colorKey>-<glyph>`; the colour half must be one of
// CATEGORY_COLORS so the frontend's .tint-* class resolves. Appending is
// always safe — existing rows keep whatever they already store.
const AVATARS = [
  'sunset-flame', 'ocean-wave', 'berry-heart', 'mint-leaf',
  'grape-star', 'citrus-sun', 'coral-feather', 'indigo-moon',
  'rose-diamond', 'teal-bolt', 'amber-paw', 'violet-rocket',
  'sunset-bird', 'ocean-cat', 'berry-dog', 'mint-flower',
  'grape-ninja', 'citrus-panda', 'coral-fox', 'indigo-owl',
  'rose-butterfly', 'teal-robot', 'amber-crown', 'violet-koala',
  'ocean-whale', 'indigo-mountain', 'teal-anchor', 'citrus-compass',
  'grape-planet', 'coral-comet', 'rose-mushroom', 'mint-cactus',
  'violet-penguin', 'amber-bear', 'sunset-turtle', 'berry-dolphin',
];

// Categories are per-room and host-editable. These are only the seed values
// a brand-new room starts with; the source of truth after that is the
// `categories` table.
const CATEGORY_COLORS = ['sunset', 'ocean', 'berry', 'mint', 'grape', 'citrus', 'coral', 'indigo', 'rose', 'teal', 'amber', 'violet'];
// Every id here must have a matching <symbol> in frontend/index.html.
const CATEGORY_ICON_LIBRARY = [
  // Everyday & bills
  'cat-groceries', 'cat-eatingout', 'cat-cafe', 'cat-nightlife', 'cat-transport', 'cat-taxi', 'cat-transit',
  'cat-shopping', 'cat-health', 'cat-entertainment', 'cat-gaming', 'cat-music', 'cat-sports', 'cat-gym',
  'cat-fuel', 'cat-parking', 'cat-rent', 'cat-carfinance', 'cat-insurance', 'cat-phone', 'cat-internet',
  'cat-subscriptions', 'cat-software', 'cat-roadtax', 'cat-tax', 'cat-utilities', 'cat-electricity',
  'cat-water', 'cat-gas', 'cat-laundry', 'cat-furniture', 'cat-hardware', 'cat-garden',
  // Life & money
  'cat-education', 'cat-books', 'cat-childcare', 'cat-pets', 'cat-haircut', 'cat-charity',
  'cat-savings', 'cat-investment', 'cat-cash', 'cat-gifts', 'cat-travel', 'cat-hotel', 'cat-flight',
  // Product glyphs, also selectable as category icons
  'prod-milk', 'prod-veg', 'prod-fruit', 'prod-meat', 'prod-chicken', 'prod-fish', 'prod-bread', 'prod-eggs',
  'prod-cheese', 'prod-butter', 'prod-yogurt', 'prod-honey', 'prod-oil', 'prod-sauce', 'prod-sugar', 'prod-flour',
  'prod-rice', 'prod-pasta', 'prod-cereal', 'prod-spices', 'prod-nuts', 'prod-snacks', 'prod-chocolate',
  'prod-icecream', 'prod-drinks', 'prod-juice', 'prod-water', 'prod-coffee', 'prod-tea', 'prod-frozen',
  'prod-canned', 'prod-cleaning', 'prod-toiletries', 'prod-paper', 'prod-babyfood', 'prod-petfood',
  'prod-fastfood', 'prod-clothing', 'prod-electronics', 'prod-gifts',
];
const DEFAULT_CATEGORIES = [
  { groupName: 'Day-to-day', name: 'Groceries', icon: 'cat-groceries', color: 'mint' },
  { groupName: 'Day-to-day', name: 'Eating Out', icon: 'cat-eatingout', color: 'coral' },
  { groupName: 'Day-to-day', name: 'Transport', icon: 'cat-transport', color: 'ocean' },
  { groupName: 'Day-to-day', name: 'Shopping', icon: 'cat-shopping', color: 'berry' },
  { groupName: 'Day-to-day', name: 'Health', icon: 'cat-health', color: 'rose' },
  { groupName: 'Day-to-day', name: 'Entertainment', icon: 'cat-entertainment', color: 'violet' },
  { groupName: 'Day-to-day', name: 'Fuel', icon: 'cat-fuel', color: 'citrus' },
  { groupName: 'Day-to-day', name: 'Parking', icon: 'cat-parking', color: 'indigo' },
  { groupName: 'Bills & Fixed Costs', name: 'Rent', icon: 'cat-rent', color: 'grape' },
  { groupName: 'Bills & Fixed Costs', name: 'Car Finance', icon: 'cat-carfinance', color: 'teal' },
  { groupName: 'Bills & Fixed Costs', name: 'Insurance', icon: 'cat-insurance', color: 'ocean' },
  { groupName: 'Bills & Fixed Costs', name: 'Phone', icon: 'cat-phone', color: 'violet' },
  { groupName: 'Bills & Fixed Costs', name: 'Subscriptions', icon: 'cat-subscriptions', color: 'berry' },
  { groupName: 'Bills & Fixed Costs', name: 'Road Tax', icon: 'cat-roadtax', color: 'amber' },
];

function seedDefaultCategories(roomId) {
  const insert = db.prepare(
    'INSERT INTO categories (room_id, group_name, name, icon, color, sort_order) VALUES (?,?,?,?,?,?)'
  );
  DEFAULT_CATEGORIES.forEach((c, i) => insert.run(roomId, c.groupName, c.name, c.icon, c.color, i));
}

// Backfill for any room that predates the categories table (safe to run every boot).
{
  const roomsWithoutCategories = db
    .prepare(`SELECT id FROM rooms WHERE id NOT IN (SELECT DISTINCT room_id FROM categories)`)
    .all();
  for (const r of roomsWithoutCategories) seedDefaultCategories(r.id);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function newRoomId() {
  for (let i = 0; i < 50; i++) {
    const candidate = 'FIN-' + String(Math.floor(1000 + Math.random() * 9000));
    const exists = db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(candidate);
    if (!exists) return candidate;
  }
  throw new Error('Could not allocate room id');
}

function fmtMoney(n) {
  return Math.round(n * 100) / 100;
}

function money(n) {
  return `£${fmtMoney(n).toFixed(2)}`;
}

function sanitizePin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

// ---------------------------------------------------------------------------
// Month keys
//
// Every figure in this app is scoped to one calendar month. A month key is
// `YYYY-MM`, which sorts correctly as a plain string, so range checks are
// ordinary comparisons and the SQL stays a `substr(date,1,7)` match.
//
// History is a *window*, not a purge: rows are never deleted or moved when a
// month rolls over. September starts empty because nothing is dated into it
// yet, and August stays readable for HISTORY_MONTHS.
// ---------------------------------------------------------------------------
const HISTORY_MONTHS = 18; // ~1.5 years, including the current month

function isMonthKey(ym) {
  return typeof ym === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(ym);
}

function monthToIndex(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}

function indexToMonth(i) {
  return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
}

function addMonths(ym, n) {
  return indexToMonth(monthToIndex(ym) + n);
}

// Matches the UTC basis the rest of the date handling already uses.
function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

// The months a room may browse: from the month it was created (or its oldest
// expense, if one was backdated further) up to now, floored by the retention
// window. Contiguous, so stepping back never skips a quiet month.
//
// The upper bound stretches past the current month if an expense was dated
// into the future — the date picker allows that, and a month that holds real
// rows must never become unreachable.
function browsableMonths(roomId) {
  const current = currentMonthKey();
  const floorMonth = addMonths(current, -(HISTORY_MONTHS - 1));

  const room = db.prepare('SELECT created_at FROM rooms WHERE id = ?').get(roomId);
  const span = db
    .prepare('SELECT MIN(substr(date,1,7)) as oldest, MAX(substr(date,1,7)) as newest FROM expenses WHERE room_id = ?')
    .get(roomId);

  // The floor bounds how far an *empty* room pages back — it stops a room
  // opened years ago from offering a corridor of blank months. It is not
  // applied to months that hold expenses: retention trims the navigation, and
  // must never be the reason a row someone entered becomes unreachable.
  let start = room && isMonthKey(room.created_at.slice(0, 7)) ? room.created_at.slice(0, 7) : current;
  if (start < floorMonth) start = floorMonth;
  if (span.oldest && span.oldest < start) start = span.oldest;

  let end = current;
  if (span.newest && span.newest > end) end = span.newest;
  if (start > end) start = end;

  const months = [];
  for (let i = monthToIndex(start); i <= monthToIndex(end); i++) months.push(indexToMonth(i));
  return months;
}

// Resolve the `month` query param against what the room may actually browse.
// An absent, malformed or out-of-window value falls back to the current month
// rather than erroring — a stale bookmark should land somewhere sensible.
function resolveMonth(roomId, requested) {
  const months = browsableMonths(roomId);
  const fallback = months.includes(currentMonthKey()) ? currentMonthKey() : months[months.length - 1];
  const month = isMonthKey(requested) && months.includes(requested) ? requested : fallback;
  return { month, months };
}

// ---------------------------------------------------------------------------
// The write window
//
// A month is open for entry while it is running, and for a short grace period
// after it ends — someone catching up on a shoebox of receipts on the 3rd
// still needs last month. Once the grace expires the month is *closed*: no new
// rows, no edits, no deletes. Nothing is hidden or removed by closing, it is
// only frozen, so the figures a room already agreed on cannot move under them.
//
// The future is never writable. An expense is something that already happened.
// ---------------------------------------------------------------------------
const BACKDATE_GRACE_DAYS = 7; // days into the new month that the old one stays open

// UTC, matching currentMonthKey() and the `YYYY-MM-DD` strings in the table.
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Strict, and calendar-real: `2026-02-31` matches the shape but is not a day.
function isDateKey(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

// The months an expense may be dated into right now: always the current one,
// plus the previous one while the grace period is still running.
function writableMonths() {
  const today = todayKey();
  const current = today.slice(0, 7);
  const dayOfMonth = Number(today.slice(8, 10));
  return dayOfMonth <= BACKDATE_GRACE_DAYS ? [addMonths(current, -1), current] : [current];
}

// Everything the client needs to draw the same rules without guessing, and to
// explain them in the same words the server would use on rejection.
function writeWindow() {
  const today = todayKey();
  const months = writableMonths();
  const current = today.slice(0, 7);
  const graceMonth = months.length > 1 ? months[0] : null;
  return {
    today,
    months,
    currentMonth: current,
    graceDays: BACKDATE_GRACE_DAYS,
    // The month still open on borrowed time, and the last day it stays open.
    graceMonth,
    graceEndsOn: graceMonth ? `${current}-${String(BACKDATE_GRACE_DAYS).padStart(2, '0')}` : null,
    // Bounds for the date picker. The floor is the first day of the oldest
    // writable month; the ceiling is today, never later.
    minDate: `${months[0]}-01`,
    maxDate: today,
  };
}

function monthIsWritable(ym) {
  return writableMonths().includes(ym);
}

// One message, used by every route that writes an expense, so a rejection
// always reads the same way and always names the way out.
function closedMonthMessage(ym) {
  const current = todayKey().slice(0, 7);
  return `${ym} is closed. Entries stay open for ${BACKDATE_GRACE_DAYS} days after a month ends — you can only add to ${current} now.`;
}

function expenseDateError(date) {
  if (!isDateKey(date)) return 'Date must be a real date in YYYY-MM-DD form';
  const today = todayKey();
  if (date > today) return 'An expense cannot be dated in the future';
  const ym = date.slice(0, 7);
  if (!monthIsWritable(ym)) return closedMonthMessage(ym);
  return null;
}

function sanitizeAvatar(avatar) {
  return AVATARS.includes(avatar) ? avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
}

function roomHasCategory(roomId, name) {
  return !!db.prepare('SELECT 1 FROM categories WHERE room_id = ? AND name = ?').get(roomId, name);
}

function publicMember(m) {
  return { id: m.id, name: m.name, isHost: !!m.is_host, avatar: m.avatar, createdAt: m.created_at, lastSeenAt: m.last_seen_at };
}

function publicExpense(e) {
  return {
    id: e.id,
    description: e.description,
    amount: e.amount,
    category: e.category,
    date: e.date,
    location: e.location || null,
    paidBy: { id: e.member_id, name: e.member_name, avatar: e.member_avatar },
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

function publicActivity(r) {
  return { id: r.id, action: r.action, message: r.message, memberName: r.member_name, memberAvatar: r.member_avatar, createdAt: r.created_at };
}

function logActivity(roomId, memberId, action, message) {
  const info = db
    .prepare('INSERT INTO activity_logs (room_id, member_id, action, message) VALUES (?,?,?,?)')
    .run(roomId, memberId, action, message);
  return publicActivity(
    db
      .prepare(
        `SELECT a.*, m.name as member_name, m.avatar as member_avatar FROM activity_logs a
         LEFT JOIN members m ON m.id = a.member_id WHERE a.id = ?`
      )
      .get(info.lastInsertRowid)
  );
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing session token' });

  const session = db
    .prepare(
      `SELECT s.token, m.*, r.id as room_id, r.name as room_name, r.password_hash as room_password_hash, r.created_at as room_created_at
       FROM sessions s
       JOIN members m ON m.id = s.member_id
       JOIN rooms r ON r.id = s.room_id
       WHERE s.token = ?`
    )
    .get(token);

  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });

  db.prepare("UPDATE members SET last_seen_at = datetime('now') WHERE id = ?").run(session.id);

  req.token = token;
  req.member = session;
  req.roomId = session.room_id;
  next();
}

function requireHost(req, res, next) {
  if (!req.member.is_host) return res.status(403).json({ error: 'Only the room host can do that' });
  next();
}

// ---------------------------------------------------------------------------
// Room auth: create / join / session / logout
// ---------------------------------------------------------------------------

app.post('/api/rooms/create', (req, res) => {
  const { roomName, roomPassword, hostName, hostPin, avatar } = req.body || {};
  if (!roomName || !roomPassword || !hostName || !hostPin) {
    return res.status(400).json({ error: 'roomName, roomPassword, hostName and hostPin are required' });
  }
  if (!sanitizePin(hostPin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  if (roomPassword.length < 4) return res.status(400).json({ error: 'Room password must be at least 4 characters' });

  const roomId = newRoomId();
  const passwordHash = bcrypt.hashSync(roomPassword, 10);
  const pinHash = bcrypt.hashSync(hostPin, 10);
  const avatarKey = sanitizeAvatar(avatar);

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO rooms (id, name, password_hash) VALUES (?,?,?)').run(roomId, roomName.trim(), passwordHash);
    seedDefaultCategories(roomId);
    const info = db
      .prepare('INSERT INTO members (room_id, name, pin_hash, is_host, avatar) VALUES (?,?,?,1,?)')
      .run(roomId, hostName.trim(), pinHash, avatarKey);
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, member_id, room_id) VALUES (?,?,?)').run(token, info.lastInsertRowid, roomId);
    logActivity(roomId, info.lastInsertRowid, 'create_room', `${hostName.trim()} created the room "${roomName.trim()}"`);
    return { token, memberId: info.lastInsertRowid };
  });

  const { token, memberId } = tx();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);

  res.status(201).json({
    token,
    room: { id: room.id, name: room.name, createdAt: room.created_at },
    member: publicMember(member),
  });
});

app.post('/api/rooms/join', (req, res) => {
  const { roomId, roomPassword, memberName, memberPin, avatar } = req.body || {};
  if (!roomId || !roomPassword || !memberName || !memberPin) {
    return res.status(400).json({ error: 'roomId, roomPassword, memberName and memberPin are required' });
  }
  if (!sanitizePin(memberPin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId.trim().toUpperCase());
  if (!room || !bcrypt.compareSync(roomPassword, room.password_hash)) {
    return res.status(401).json({ error: 'Room ID or room password is incorrect' });
  }

  const existing = db
    .prepare('SELECT * FROM members WHERE room_id = ? AND name = ? COLLATE NOCASE')
    .get(room.id, memberName.trim());

  let member;
  if (existing) {
    if (!bcrypt.compareSync(memberPin, existing.pin_hash)) {
      return res.status(401).json({ error: 'That name is already in use in this room and the PIN does not match' });
    }
    member = existing;
    db.prepare("UPDATE members SET last_seen_at = datetime('now') WHERE id = ?").run(member.id);
  } else {
    const pinHash = bcrypt.hashSync(memberPin, 10);
    const avatarKey = sanitizeAvatar(avatar);
    const info = db
      .prepare('INSERT INTO members (room_id, name, pin_hash, is_host, avatar) VALUES (?,?,?,0,?)')
      .run(room.id, memberName.trim(), pinHash, avatarKey);
    member = db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
    const activity = logActivity(room.id, member.id, 'join', `${member.name} joined the room`);
    broadcast(room.id, { type: 'member_joined', member: publicMember(member), activity });
  }

  const token = newToken();
  db.prepare('INSERT INTO sessions (token, member_id, room_id) VALUES (?,?,?)').run(token, member.id, room.id);

  res.json({
    token,
    room: { id: room.id, name: room.name, createdAt: room.created_at },
    member: publicMember(member),
  });
});

app.get('/api/session', authenticate, (req, res) => {
  res.json({
    room: { id: req.member.room_id, name: req.member.room_name, createdAt: req.member.room_created_at },
    member: publicMember(req.member),
  });
});

app.post('/api/session/logout', authenticate, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Room + members info (Profile tab)
// ---------------------------------------------------------------------------

app.get('/api/room', authenticate, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.roomId);
  const memberCount = db.prepare('SELECT COUNT(*) as c FROM members WHERE room_id = ?').get(req.roomId).c;
  const totalSpend = db.prepare('SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE room_id = ?').get(req.roomId).t;

  res.json({
    id: room.id,
    name: room.name,
    password: null, // never expose the hash; plaintext isn't stored server-side
    createdAt: room.created_at,
    memberCount,
    totalLifetimeSpend: fmtMoney(totalSpend),
  });
});

app.get('/api/members', authenticate, (req, res) => {
  const members = db.prepare('SELECT * FROM members WHERE room_id = ? ORDER BY name COLLATE NOCASE').all(req.roomId);
  res.json(members.map(publicMember));
});

app.patch('/api/member/avatar', authenticate, (req, res) => {
  const { avatar } = req.body || {};
  if (!AVATARS.includes(avatar)) return res.status(400).json({ error: 'Invalid avatar' });

  db.prepare('UPDATE members SET avatar = ? WHERE id = ?').run(avatar, req.member.id);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.member.id);

  broadcast(req.roomId, { type: 'member_updated', member: publicMember(member) });
  res.json(publicMember(member));
});

// A member's name is their login handle as well as their label, so a rename has
// to respect the same UNIQUE(room_id, name COLLATE NOCASE) the join path does.
// Expenses reference members by id, so nothing historical is rewritten — old
// entries simply start showing the new name.
app.patch('/api/member/name', authenticate, (req, res) => {
  const raw = (req.body || {}).name;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 32) return res.status(400).json({ error: 'Name must be 32 characters or fewer' });

  const before = db.prepare('SELECT * FROM members WHERE id = ?').get(req.member.id);
  if (!before) return res.status(404).json({ error: 'Member not found' });
  // Changing only the casing of your own name is a rename, not a clash.
  if (before.name === name) return res.json(publicMember(before));

  const clash = db
    .prepare('SELECT id FROM members WHERE room_id = ? AND name = ? COLLATE NOCASE AND id != ?')
    .get(req.roomId, name, req.member.id);
  if (clash) return res.status(409).json({ error: 'Someone in this room already uses that name' });

  db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, req.member.id);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.member.id);

  logActivity(req.roomId, member.id, 'rename_member', `${before.name} is now known as ${name}`);
  broadcast(req.roomId, { type: 'member_updated', member: publicMember(member) });
  res.json(publicMember(member));
});

app.get('/api/meta', (req, res) => {
  res.json({ avatars: AVATARS, categoryIconLibrary: CATEGORY_ICON_LIBRARY, categoryColors: CATEGORY_COLORS });
});

// ---------------------------------------------------------------------------
// Categories — per-room, host-editable. Members can only pick from what the
// host has configured; only the host may create/edit/delete.
// ---------------------------------------------------------------------------

function publicCategory(c) {
  return { id: c.id, groupName: c.group_name, name: c.name, icon: c.icon, color: c.color, sortOrder: c.sort_order };
}

app.get('/api/categories', authenticate, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM categories WHERE room_id = ? ORDER BY group_name, sort_order, id')
    .all(req.roomId);
  res.json(rows.map(publicCategory));
});

app.post('/api/categories', authenticate, requireHost, (req, res) => {
  const { groupName, name, icon, color } = req.body || {};
  if (!groupName || !name || !icon || !color) {
    return res.status(400).json({ error: 'groupName, name, icon and color are required' });
  }
  if (!CATEGORY_ICON_LIBRARY.includes(icon)) return res.status(400).json({ error: 'Invalid icon' });
  if (!CATEGORY_COLORS.includes(color)) return res.status(400).json({ error: 'Invalid color' });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM categories WHERE room_id = ? AND group_name = ?').get(req.roomId, groupName).m;

  let info;
  try {
    info = db
      .prepare('INSERT INTO categories (room_id, group_name, name, icon, color, sort_order) VALUES (?,?,?,?,?,?)')
      .run(req.roomId, groupName, name.trim(), icon, color, maxOrder + 1);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'A category with that name already exists' });
    throw err;
  }

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid);
  const activity = logActivity(req.roomId, req.member.id, 'category_added', `${req.member.name} added category "${category.name}"`);
  broadcast(req.roomId, { type: 'categories_changed', activity });
  res.status(201).json(publicCategory(category));
});

app.put('/api/categories/:id', authenticate, requireHost, (req, res) => {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ? AND room_id = ?').get(req.params.id, req.roomId);
  if (!existing) return res.status(404).json({ error: 'Category not found' });

  const { groupName, name, icon, color } = req.body || {};
  const next = {
    group_name: groupName || existing.group_name,
    name: name !== undefined ? String(name).trim() : existing.name,
    icon: icon || existing.icon,
    color: color || existing.color,
  };
  if (!next.name) return res.status(400).json({ error: 'Name cannot be empty' });
  if (!CATEGORY_ICON_LIBRARY.includes(next.icon)) return res.status(400).json({ error: 'Invalid icon' });
  if (!CATEGORY_COLORS.includes(next.color)) return res.status(400).json({ error: 'Invalid color' });

  const oldName = existing.name;

  try {
    db.prepare('UPDATE categories SET group_name=?, name=?, icon=?, color=? WHERE id=?')
      .run(next.group_name, next.name, next.icon, next.color, existing.id);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'A category with that name already exists' });
    throw err;
  }

  // Renaming a category doesn't rewrite historical expenses — but keep them
  // findable by carrying the new name forward onto existing rows so the
  // room's spending history stays consistent with what the host renamed it to.
  if (oldName !== next.name) {
    db.prepare('UPDATE expenses SET category = ? WHERE room_id = ? AND category = ?').run(next.name, req.roomId, oldName);
  }

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(existing.id);
  const activity = logActivity(req.roomId, req.member.id, 'category_edited', `${req.member.name} updated category "${category.name}"`);
  broadcast(req.roomId, { type: 'categories_changed', activity });
  res.json(publicCategory(category));
});

app.delete('/api/categories/:id', authenticate, requireHost, (req, res) => {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ? AND room_id = ?').get(req.params.id, req.roomId);
  if (!existing) return res.status(404).json({ error: 'Category not found' });

  const total = db.prepare('SELECT COUNT(*) as c FROM categories WHERE room_id = ?').get(req.roomId).c;
  if (total <= 1) return res.status(400).json({ error: 'A room must have at least one category' });

  db.prepare('DELETE FROM categories WHERE id = ?').run(existing.id);
  const activity = logActivity(req.roomId, req.member.id, 'category_deleted', `${req.member.name} removed category "${existing.name}"`);
  broadcast(req.roomId, { type: 'categories_changed', activity });
  res.json({ ok: true });
});

// Paused members do not add to a bill they are not sharing. Checked on the
// server for the same reason the write window is: a stale tab or a direct call
// must not be able to get round it. Keyed on the expense's *date*, not on
// today, so a pause that starts on the 15th blocks the 20th and allows the 3rd.
function participationDateBlock(roomId, memberId, subject, date) {
  if (statusOn(roomId, memberId, date) !== 'out') return null;
  const since = db
    .prepare(
      `SELECT effective_from FROM participation_changes
       WHERE room_id = ? AND member_id = ? AND effective_from <= ? AND status = 'out'
       ORDER BY effective_from DESC, id DESC LIMIT 1`
    )
    .get(roomId, memberId, date);
  const from = since ? since.effective_from : date;
  const be = subject === 'You' ? 'are' : 'is';
  return `${subject} ${be} paused from ${from} and ${be} not sharing the bill — nothing can be added dated ${date}. Ask the host to start sharing again first.`;
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

app.get('/api/expenses', authenticate, (req, res) => {
  const { month, category, memberId, q } = req.query;
  let sql = `SELECT e.*, m.name as member_name, m.avatar as member_avatar FROM expenses e JOIN members m ON m.id = e.member_id WHERE e.room_id = ?`;
  const params = [req.roomId];

  if (month) {
    sql += ' AND substr(e.date, 1, 7) = ?';
    params.push(month);
  }
  if (category) {
    sql += ' AND e.category = ?';
    params.push(category);
  }
  if (memberId) {
    sql += ' AND e.member_id = ?';
    params.push(memberId);
  }
  if (q) {
    sql += ' AND e.description LIKE ?';
    params.push(`%${q}%`);
  }
  // Ordered by when it was entered, not by the date it happened. Someone
  // catching up on a backdated receipt needs to see it land at the top and
  // confirm it saved — sorting by e.date buried it wherever that date fell,
  // which reads as the entry having been lost. Ties within the same second
  // fall back to id, so the newest row still wins.
  sql += ' ORDER BY e.created_at DESC, e.id DESC';

  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(publicExpense));
});

app.post('/api/expenses', authenticate, (req, res) => {
  const { description, amount, category, date, location } = req.body || {};
  if (!description || !amount || !category || !date) {
    return res.status(400).json({ error: 'description, amount, category and date are required' });
  }
  if (!roomHasCategory(req.roomId, category)) return res.status(400).json({ error: 'Invalid category' });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
  // The write window is enforced here, not in the UI. The client draws the
  // same rules, but a stale tab, a wrong device clock or a direct call must
  // not be able to write into a closed month or the future.
  const dateErr = expenseDateError(date);
  if (dateErr) return res.status(400).json({ error: dateErr });
  const pausedErr = participationDateBlock(req.roomId, req.member.id, 'You', date);
  if (pausedErr) return res.status(400).json({ error: pausedErr });

  // Who paid is never taken from the client — it's always the verified,
  // signed-in member making the request, so activity logs stay trustworthy.
  const paidById = req.member.id;
  const loc = typeof location === 'string' && location.trim() ? location.trim().slice(0, 120) : null;

  const info = db
    .prepare('INSERT INTO expenses (room_id, member_id, description, amount, category, date, location) VALUES (?,?,?,?,?,?,?)')
    .run(req.roomId, paidById, description.trim(), fmtMoney(amt), category, date, loc);

  const row = db
    .prepare('SELECT e.*, m.name as member_name, m.avatar as member_avatar FROM expenses e JOIN members m ON m.id = e.member_id WHERE e.id = ?')
    .get(info.lastInsertRowid);

  const activity = logActivity(
    req.roomId,
    req.member.id,
    'add_expense',
    `${req.member.name} spent ${money(row.amount)} on ${row.description} (${row.category})${row.location ? ` at ${row.location}` : ''}`
  );

  const payload = { type: 'expense_added', expense: publicExpense(row), activity };
  broadcast(req.roomId, payload);
  res.status(201).json(publicExpense(row));
});

app.put('/api/expenses/:id', authenticate, (req, res) => {
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND room_id = ?').get(req.params.id, req.roomId);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  // A closed month is frozen, not merely append-only: the room may have
  // settled up on these figures, and an edit would move a total someone
  // already agreed to and paid against.
  const existingMonth = existing.date.slice(0, 7);
  if (!monthIsWritable(existingMonth)) return res.status(400).json({ error: closedMonthMessage(existingMonth) });

  const { description, amount, category, date, location } = req.body || {};
  const next = {
    description: description !== undefined ? String(description).trim() : existing.description,
    amount: amount !== undefined ? fmtMoney(Number(amount)) : existing.amount,
    category: category !== undefined ? category : existing.category,
    date: date !== undefined ? date : existing.date,
    // Who paid is set once, at creation, and never reassigned via edit.
    member_id: existing.member_id,
    location: location !== undefined ? (String(location).trim().slice(0, 120) || null) : existing.location,
  };
  if (!next.description) return res.status(400).json({ error: 'Description cannot be empty' });
  if (!Number.isFinite(next.amount) || next.amount <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
  if (!roomHasCategory(req.roomId, next.category)) return res.status(400).json({ error: 'Invalid category' });
  // Moving a date is the same act as creating one at the destination.
  if (next.date !== existing.date) {
    const dateErr = expenseDateError(next.date);
    if (dateErr) return res.status(400).json({ error: dateErr });
    // The payer is whoever created the row, not whoever is editing it.
    const payer = db.prepare('SELECT name FROM members WHERE id = ?').get(existing.member_id);
    const pausedErr = participationDateBlock(req.roomId, existing.member_id, payer ? payer.name : 'That member', next.date);
    if (pausedErr) return res.status(400).json({ error: pausedErr });
  }

  db.prepare(
    `UPDATE expenses SET description=?, amount=?, category=?, date=?, member_id=?, location=?, updated_at=datetime('now') WHERE id=?`
  ).run(next.description, next.amount, next.category, next.date, next.member_id, next.location, existing.id);

  const row = db
    .prepare('SELECT e.*, m.name as member_name, m.avatar as member_avatar FROM expenses e JOIN members m ON m.id = e.member_id WHERE e.id = ?')
    .get(existing.id);

  const changes = [];
  if (existing.description !== next.description) changes.push(`item to "${next.description}"`);
  if (existing.amount !== next.amount) changes.push(`amount from ${money(existing.amount)} to ${money(next.amount)}`);
  if (existing.category !== next.category) changes.push(`category from ${existing.category} to ${next.category}`);
  if (existing.date !== next.date) changes.push(`date from ${existing.date} to ${next.date}`);
  if ((existing.location || null) !== (next.location || null)) changes.push(`place to ${next.location || 'unspecified'}`);
  const changeText = changes.length ? changes.join(', ') : 'no fields';

  const activity = logActivity(
    req.roomId,
    req.member.id,
    'edit_expense',
    `${req.member.name} edited "${existing.description}" — changed ${changeText}`
  );

  broadcast(req.roomId, { type: 'expense_updated', expense: publicExpense(row), activity });
  res.json(publicExpense(row));
});

app.delete('/api/expenses/:id', authenticate, (req, res) => {
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND room_id = ?').get(req.params.id, req.roomId);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  const existingMonth = existing.date.slice(0, 7);
  if (!monthIsWritable(existingMonth)) return res.status(400).json({ error: closedMonthMessage(existingMonth) });

  db.prepare('DELETE FROM expenses WHERE id = ?').run(existing.id);

  const activity = logActivity(
    req.roomId,
    req.member.id,
    'delete_expense',
    `${req.member.name} deleted "${existing.description}" (${money(existing.amount)}) from ${existing.category}`
  );

  broadcast(req.roomId, { type: 'expense_deleted', id: existing.id, activity });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Participation — pausing and resuming a share of the bill
//
// A member asks; the host decides. Asking rather than acting is the point: if
// anyone could pause themselves, anyone could walk away from a bill they were
// already part of. The host acts directly, on themselves or on anyone else.
// ---------------------------------------------------------------------------

// How far ahead you may plan. Beyond this you are not arranging next month,
// you are leaving notes for a room that may not exist.
const PARTICIPATION_HORIZON_MONTHS = 18;

// A change may land from the first of the current month (so "Dan actually
// stopped on the 15th" can be recorded on the 22nd, which is how people
// actually report it) up to the horizon. It may never reach back into a month
// that has already closed, and never into a month the room has settled — both
// would rewrite figures somebody has already paid against.
function participationDateError(roomId, day) {
  if (!isDateKey(day)) return 'Pick a real date';
  const floor = `${currentMonthKey()}-01`;
  if (day < floor) {
    return `${monthName(day.slice(0, 7))} has already closed — a change can only start from ${monthName(currentMonthKey())} onwards.`;
  }
  const ceiling = `${addMonths(currentMonthKey(), PARTICIPATION_HORIZON_MONTHS)}-01`;
  if (day >= ceiling) return 'That is too far ahead to plan.';

  const settled = db
    .prepare(`SELECT month FROM settlements WHERE room_id = ? AND month = ? AND status = 'settled'`)
    .get(roomId, day.slice(0, 7));
  if (settled) return `${monthName(day.slice(0, 7))} is already settled — its split can no longer change.`;

  // A settle-up awaiting approval quotes figures people are agreeing to. Its
  // stale check only watches the month's total, and a sharing change moves
  // the split without moving the total — so it would go on asking people to
  // approve payments that are no longer right. Clear the ask first.
  const pending = db
    .prepare(`SELECT month FROM settlements WHERE room_id = ? AND month = ? AND status = 'pending'`)
    .get(roomId, day.slice(0, 7));
  if (pending) return `A settle-up for ${monthName(day.slice(0, 7))} is waiting for approval — withdraw it first, then change who is sharing.`;
  return null;
}

function publicParticipationRequest(r) {
  return {
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    memberAvatar: r.member_avatar,
    effectiveFrom: r.effective_from,
    status: r.status,
    state: r.state,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

function pendingRequests(roomId) {
  return db
    .prepare(
      `SELECT r.*, m.name as member_name, m.avatar as member_avatar
       FROM participation_requests r JOIN members m ON m.id = r.member_id
       WHERE r.room_id = ? AND r.state = 'pending'
       ORDER BY r.effective_from ASC, r.id ASC`
    )
    .all(roomId)
    .map(publicParticipationRequest);
}

// Writing a change is idempotent on (member, day): setting the same day twice
// replaces it rather than stacking two contradictory rows.
function writeParticipationChange(roomId, memberId, day, status, setBy) {
  db.prepare(
    `INSERT INTO participation_changes (room_id, member_id, effective_from, status, set_by)
     VALUES (?,?,?,?,?)
     ON CONFLICT(room_id, member_id, effective_from)
     DO UPDATE SET status = excluded.status, set_by = excluded.set_by, created_at = datetime('now')`
  ).run(roomId, memberId, day, status, setBy);
}

function participationPayload(roomId, month) {
  const { members, segments } = participationSegments(roomId, month);
  const end = monthEndDay(month);
  const today = todayKey();
  const all = db.prepare('SELECT id, name, avatar FROM members WHERE room_id = ? ORDER BY name COLLATE NOCASE').all(roomId);

  const upcoming = db
    .prepare(
      `SELECT member_id, effective_from, status FROM participation_changes
       WHERE room_id = ? AND effective_from > ? ORDER BY effective_from ASC, id ASC`
    )
    .all(roomId, today);

  return {
    month,
    members: all.map((m) => ({
      memberId: m.id,
      name: m.name,
      avatar: m.avatar,
      // Where they stand right now, and where they stand at the end of the
      // month being viewed — those differ the moment a pause is scheduled.
      statusNow: statusOn(roomId, m.id, today),
      statusAtMonthEnd: statusOn(roomId, m.id, end),
      onRoster: members.some((x) => x.id === m.id),
      scheduled: upcoming
        .filter((c) => c.member_id === m.id)
        .map((c) => ({ effectiveFrom: c.effective_from, status: c.status })),
    })),
    segments: segments.map((seg) => ({ from: seg.from, to: seg.to, memberIds: seg.memberIds })),
    requests: pendingRequests(roomId),
  };
}

app.get('/api/participation', authenticate, (req, res) => {
  // resolveMonth returns { month, months } — the month is the string half.
  const { month } = resolveMonth(req.roomId, req.query.month);
  res.json(participationPayload(req.roomId, month));
});

// A member asks the host to pause or resume them.
app.post('/api/participation/request', authenticate, (req, res) => {
  const { status, effectiveFrom } = req.body || {};
  if (status !== 'in' && status !== 'out') return res.status(400).json({ error: 'status must be in or out' });
  const err = participationDateError(req.roomId, effectiveFrom);
  if (err) return res.status(400).json({ error: err });

  if (statusOn(req.roomId, req.member.id, effectiveFrom) === status) {
    return res.status(400).json({
      error: status === 'out'
        ? `You are already paused from ${effectiveFrom}.`
        : `You are already sharing from ${effectiveFrom}.`,
    });
  }

  // One live ask per member. A new one supersedes whatever was outstanding,
  // rather than leaving the host two contradictory requests to choose between.
  db.prepare(`UPDATE participation_requests SET state = 'cancelled' WHERE room_id = ? AND member_id = ? AND state = 'pending'`)
    .run(req.roomId, req.member.id);

  const info = db
    .prepare('INSERT INTO participation_requests (room_id, member_id, effective_from, status) VALUES (?,?,?,?)')
    .run(req.roomId, req.member.id, effectiveFrom, status);

  const activity = logActivity(
    req.roomId, req.member.id, 'participation_request',
    `${req.member.name} asked to ${status === 'out' ? 'pause their share' : 'start sharing again'} from ${effectiveFrom}`
  );
  broadcast(req.roomId, { type: 'participation_changed', activity, participation: participationPayload(req.roomId, currentMonthKey()) });
  res.status(201).json({ id: Number(info.lastInsertRowid), ...participationPayload(req.roomId, currentMonthKey()) });
});

// The requester can withdraw their own ask while it is still pending.
app.delete('/api/participation/request/:id', authenticate, (req, res) => {
  const row = db.prepare('SELECT * FROM participation_requests WHERE id = ? AND room_id = ?').get(req.params.id, req.roomId);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.member_id !== req.member.id) return res.status(403).json({ error: 'That is not your request' });
  if (row.state !== 'pending') return res.status(400).json({ error: 'That request has already been decided' });

  db.prepare(`UPDATE participation_requests SET state = 'cancelled' WHERE id = ?`).run(row.id);
  const activity = logActivity(req.roomId, req.member.id, 'participation_request', `${req.member.name} withdrew their request`);
  broadcast(req.roomId, { type: 'participation_changed', activity, participation: participationPayload(req.roomId, currentMonthKey()) });
  res.json({ ok: true });
});

// The host decides. Approving is what actually writes the change.
app.post('/api/participation/request/:id/:decision', authenticate, requireHost, (req, res) => {
  const decision = req.params.decision;
  if (decision !== 'approve' && decision !== 'decline') return res.status(404).json({ error: 'Unknown decision' });

  const row = db
    .prepare(
      `SELECT r.*, m.name as member_name FROM participation_requests r JOIN members m ON m.id = r.member_id
       WHERE r.id = ? AND r.room_id = ?`
    )
    .get(req.params.id, req.roomId);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.state !== 'pending') return res.status(400).json({ error: 'That request has already been decided' });

  // Re-check the window: a request raised in August must not be approvable in
  // October, when the month it names has closed.
  if (decision === 'approve') {
    const err = participationDateError(req.roomId, row.effective_from);
    if (err) return res.status(400).json({ error: err });
  }

  db.transaction(() => {
    db.prepare(`UPDATE participation_requests SET state = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`)
      .run(decision === 'approve' ? 'approved' : 'declined', req.member.id, row.id);
    if (decision === 'approve') {
      writeParticipationChange(req.roomId, row.member_id, row.effective_from, row.status, req.member.id);
    }
  })();

  const verb = row.status === 'out' ? 'paused' : 'sharing again';
  const activity = logActivity(
    req.roomId, req.member.id, 'participation_change',
    decision === 'approve'
      ? `${req.member.name} approved: ${row.member_name} is ${verb} from ${row.effective_from}`
      : `${req.member.name} declined ${row.member_name}'s request to be ${verb} from ${row.effective_from}`
  );
  broadcast(req.roomId, { type: 'participation_changed', activity, participation: participationPayload(req.roomId, currentMonthKey()) });
  res.json(participationPayload(req.roomId, currentMonthKey()));
});

// The host sets someone directly, with no request in between.
app.post('/api/participation/set', authenticate, requireHost, (req, res) => {
  const { memberId, status, effectiveFrom } = req.body || {};
  if (status !== 'in' && status !== 'out') return res.status(400).json({ error: 'status must be in or out' });
  const target = db.prepare('SELECT * FROM members WHERE id = ? AND room_id = ?').get(memberId, req.roomId);
  if (!target) return res.status(404).json({ error: 'Member not found' });
  const err = participationDateError(req.roomId, effectiveFrom);
  if (err) return res.status(400).json({ error: err });
  if (statusOn(req.roomId, target.id, effectiveFrom) === status) {
    return res.status(400).json({ error: `${target.name} is already ${status === 'out' ? 'paused' : 'sharing'} from ${effectiveFrom}.` });
  }

  db.transaction(() => {
    writeParticipationChange(req.roomId, target.id, effectiveFrom, status, req.member.id);
    // A direct decision answers any outstanding ask from that member.
    db.prepare(`UPDATE participation_requests SET state = 'approved', decided_by = ?, decided_at = datetime('now')
                WHERE room_id = ? AND member_id = ? AND state = 'pending' AND effective_from = ? AND status = ?`)
      .run(req.member.id, req.roomId, target.id, effectiveFrom, status);
    db.prepare(`UPDATE participation_requests SET state = 'cancelled' WHERE room_id = ? AND member_id = ? AND state = 'pending'`)
      .run(req.roomId, target.id);
  })();

  const who = target.id === req.member.id ? 'themselves' : target.name;
  const activity = logActivity(
    req.roomId, req.member.id, 'participation_change',
    `${req.member.name} set ${who} to ${status === 'out' ? 'paused' : 'sharing'} from ${effectiveFrom}`
  );
  broadcast(req.roomId, { type: 'participation_changed', activity, participation: participationPayload(req.roomId, currentMonthKey()) });
  res.json(participationPayload(req.roomId, currentMonthKey()));
});

// ---------------------------------------------------------------------------
// Handing over the host
//
// Exactly one host per room, always. Both writes happen in one transaction so
// there is no instant where a room has two hosts or none — a room with no host
// can never appoint one, which would be unrecoverable without DB access.
// ---------------------------------------------------------------------------
app.post('/api/room/host', authenticate, requireHost, (req, res) => {
  const { memberId } = req.body || {};
  const target = db.prepare('SELECT * FROM members WHERE id = ? AND room_id = ?').get(memberId, req.roomId);
  if (!target) return res.status(404).json({ error: 'Member not found' });
  if (target.id === req.member.id) return res.status(400).json({ error: 'You are already the host' });

  db.transaction(() => {
    db.prepare('UPDATE members SET is_host = 0 WHERE room_id = ?').run(req.roomId);
    db.prepare('UPDATE members SET is_host = 1 WHERE id = ?').run(target.id);
  })();

  const activity = logActivity(
    req.roomId, req.member.id, 'host_changed',
    `${req.member.name} handed the host over to ${target.name}`
  );
  const members = db.prepare('SELECT * FROM members WHERE room_id = ? ORDER BY name COLLATE NOCASE').all(req.roomId);
  broadcast(req.roomId, { type: 'host_changed', hostId: target.id, members: members.map(publicMember), activity });
  res.json({ ok: true, hostId: target.id, members: members.map(publicMember) });
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

// Scoped by *when the line was written*, not by the date of whatever it
// describes — it is a log of what the room did, in the order it did it. A
// backdated August receipt entered on 3 September is September's activity.
app.get('/api/activity', authenticate, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const month = isMonthKey(req.query.month) ? req.query.month : null;
  const sql =
    `SELECT a.*, m.name as member_name, m.avatar as member_avatar FROM activity_logs a LEFT JOIN members m ON m.id = a.member_id
     WHERE a.room_id = ?` + (month ? ' AND substr(a.created_at,1,7) = ?' : '') + ' ORDER BY a.id DESC LIMIT ?';
  const params = month ? [req.roomId, month, limit] : [req.roomId, limit];
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(publicActivity));
});

// ---------------------------------------------------------------------------
// Settle up — split the month's spending evenly across everyone in the room
// and work out the smallest set of payments that makes everyone even again.
// ---------------------------------------------------------------------------

function computeSettleUp(balances) {
  // balances: [{ memberId, name, avatar, balance }], balance = paid - fairShare
  // Positive balance = overpaid (is owed money). Negative = underpaid (owes money).
  const creditors = balances.filter((b) => b.balance > 0.005).map((b) => ({ ...b })).sort((a, b) => b.balance - a.balance);
  const debtors = balances.filter((b) => b.balance < -0.005).map((b) => ({ ...b, balance: -b.balance })).sort((a, b) => b.balance - a.balance);

  const transactions = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor = debtors[di];
    const amount = fmtMoney(Math.min(creditor.balance, debtor.balance));
    if (amount > 0) {
      transactions.push({
        from: { id: debtor.memberId, name: debtor.name, avatar: debtor.avatar },
        to: { id: creditor.memberId, name: creditor.name, avatar: creditor.avatar },
        amount,
      });
    }
    creditor.balance = fmtMoney(creditor.balance - amount);
    debtor.balance = fmtMoney(debtor.balance - amount);
    if (creditor.balance <= 0.005) ci++;
    if (debtor.balance <= 0.005) di++;
  }
  return transactions;
}

// The people a month's spending is split across: everyone who was in the room
// that month, plus anyone who paid into it.
//
// Membership is checked against the month being viewed, not against today.
// Splitting a past month across whoever happens to be in the room now bills
// people for months they had not joined yet — a real instruction to pay real
// money, for spending they were never part of.
//
// The `OR paid > 0` half is what keeps the arithmetic sound: an expense can be
// backdated to before its author joined, and dropping a member who paid would
// leave the balances failing to net to zero. Anyone who paid into the month is
// in the split by definition.
//
// For the current month this is a no-op — every member joined on or before
// today — so the live view is unchanged.
function monthParticipants(roomId, month) {
  return db
    .prepare(
      `SELECT m.id as memberId, m.name, m.avatar as avatar,
              COALESCE(SUM(CASE WHEN substr(e.date,1,7) = ? THEN e.amount ELSE 0 END), 0) as paid
       FROM members m LEFT JOIN expenses e ON e.member_id = m.id AND e.room_id = m.room_id
       WHERE m.room_id = ? GROUP BY m.id
       HAVING substr(m.created_at,1,7) <= ? OR paid > 0
       ORDER BY m.name COLLATE NOCASE`
    )
    .all(month, roomId, month)
    .map((r) => ({ ...r, paid: fmtMoney(r.paid) }));
}

// ---------------------------------------------------------------------------
// Participation — who is sharing the bill, and from when
//
// A member can pause: they stay in the room, keep their history, but stop
// sharing the food bill and stop being able to add spending. The pause is
// effective from a *day*, because that is how it happens in a real flat —
// "Dan stopped eating with us on the 15th", not "Dan is out for September".
//
// So a month is not one split. It is a run of segments, cut at every day
// somebody's status changed:
//
//     Sep 1 - Sep 14   total T1   4 sharing   each owes T1/4
//     Sep 15 - Sep 30  total T2   3 sharing   each owes T2/3
//
// and a member's fair share for the month is the sum of their segments.
// Because the segments partition the month exactly, the shares still sum to
// the month total to the penny, so the balances still net to zero — which is
// the invariant the whole settle-up rests on.
// ---------------------------------------------------------------------------

function monthEndDay(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

function addDaysKey(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The status a member is in on a given day: the latest change effective on or
// before it, defaulting to sharing.
function statusOn(roomId, memberId, day) {
  const row = db
    .prepare(
      `SELECT status FROM participation_changes
       WHERE room_id = ? AND member_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC, id DESC LIMIT 1`
    )
    .get(roomId, memberId, day);
  return row ? row.status : 'in';
}

// Cut a month into segments at every day a status changed inside it, and work
// out who was sharing in each. The roster is exactly monthParticipants' —
// joined by that month, *or* paid in it — so nothing about an untouched room
// changes. Dropping the "or paid" half would let someone who joined in the
// grace week and backdated a receipt into the old month escape its split.
function participationSegments(roomId, month) {
  const start = `${month}-01`;
  const end = monthEndDay(month);

  const members = db
    .prepare(
      `SELECT id, name, avatar, created_at FROM members m
       WHERE m.room_id = ?
         AND (substr(m.created_at,1,7) <= ?
              OR EXISTS (SELECT 1 FROM expenses e
                         WHERE e.member_id = m.id AND e.room_id = m.room_id
                           AND substr(e.date,1,7) = ? AND e.amount > 0))
       ORDER BY name COLLATE NOCASE`
    )
    .all(roomId, month, month);

  // Where everyone stood on the first of the month.
  const status = new Map(members.map((m) => [m.id, statusOn(roomId, m.id, start)]));

  const changes = db
    .prepare(
      `SELECT member_id, effective_from, status FROM participation_changes
       WHERE room_id = ? AND effective_from > ? AND effective_from <= ?
       ORDER BY effective_from ASC, id ASC`
    )
    .all(roomId, start, end);

  const cuts = [...new Set(changes.map((c) => c.effective_from))].sort();
  const boundaries = [start, ...cuts];

  const segments = [];
  boundaries.forEach((from, i) => {
    if (i > 0) {
      // Apply every change effective on this boundary before the segment opens.
      for (const c of changes.filter((c) => c.effective_from === from)) {
        if (status.has(c.member_id)) status.set(c.member_id, c.status);
      }
    }
    const to = i + 1 < boundaries.length ? addDaysKey(boundaries[i + 1], -1) : end;
    segments.push({
      from,
      to,
      memberIds: members.filter((m) => status.get(m.id) === 'in').map((m) => m.id),
    });
  });
  return { members, segments };
}

// Split a month evenly across its participants and work out who owes who.
//
// A naive "round the fair share, then subtract it from everyone" split doesn't
// divide evenly in cents — e.g. £20 / 3 people rounds to £6.67 each, but
// 3 × £6.67 = £20.01, a cent more than was actually spent. That phantom cent
// then gets silently dropped by the settle-up matching instead of being
// assigned to anyone. Splitting the total in whole cents (largest-remainder
// method) guarantees every member's share sums exactly back to the total, so
// balances always net to zero with no leftover.
//
// One function, called by both the analytics payload and the settle-up routes,
// so what a member is asked to agree to is exactly what they were shown.
// Split one segment's spend across the people sharing in it, in whole cents,
// by largest remainder. Returns cents per member id.
function splitSegmentCents(totalCents, memberIds) {
  const n = memberIds.length;
  const out = new Map();
  if (!n) return out;
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  memberIds.forEach((id, i) => out.set(id, base + (i < remainder ? 1 : 0)));
  return out;
}

// The month split, segment by segment.
//
// `participants` is the month's roster with what each of them paid, exactly as
// monthParticipants returns it. `segments` says who was sharing when. Each
// segment's spend is split only across the people sharing in it, and a
// member's fair share is the sum of their segments — so somebody who paused on
// the 15th pays for the first half and nothing after it.
//
// Every expense in the month falls in exactly one segment, so the segment
// shares sum to the month total to the penny and the balances still net to
// zero. The one hole to guard is a segment where *nobody* is sharing but money
// was still spent: with no one to charge, those pennies would vanish from the
// split and the balances would stop netting. They fall back to whoever paid in
// that segment, which is both arithmetically closed and the fair answer — you
// bought it, nobody else was eating, it is yours.
function computeMonthSplit(participants, segments) {
  const monthTotal = fmtMoney(participants.reduce((sum, m) => sum + m.paid, 0));
  const byId = new Map(participants.map((m) => [m.memberId, m]));
  const shareCents = new Map(participants.map((m) => [m.memberId, 0]));

  const segs = (segments || []).map((seg) => {
    const rows = db
      .prepare(
        `SELECT member_id, COALESCE(SUM(amount),0) as paid FROM expenses
         WHERE room_id = ? AND date >= ? AND date <= ? GROUP BY member_id`
      )
      .all(seg.roomId, seg.from, seg.to);
    const segTotalCents = rows.reduce((sum, r) => sum + Math.round(fmtMoney(r.paid) * 100), 0);

    // Only people actually on this month's roster can be charged.
    let sharing = seg.memberIds.filter((id) => byId.has(id));
    if (!sharing.length) sharing = rows.map((r) => r.member_id).filter((id) => byId.has(id));

    const cents = splitSegmentCents(segTotalCents, sharing);
    for (const [id, c] of cents) shareCents.set(id, (shareCents.get(id) || 0) + c);

    return {
      from: seg.from,
      to: seg.to,
      total: fmtMoney(segTotalCents / 100),
      memberIds: sharing,
      memberCount: sharing.length,
      perHead: sharing.length ? fmtMoney(segTotalCents / 100 / sharing.length) : 0,
    };
  });

  const balances = participants.map((m) => {
    const c = shareCents.get(m.memberId) || 0;
    return { ...m, fairShare: fmtMoney(c / 100), balance: fmtMoney(m.paid - c / 100) };
  });

  // The headline "each" figure. With no pauses this is the plain even split it
  // always was; with pauses there is no single number, so the segments carry
  // the detail and this stays the average across the people still sharing at
  // the end of the month.
  const finalSeg = segs.length ? segs[segs.length - 1] : null;
  const memberCount = finalSeg ? finalSeg.memberCount : participants.length;
  const isSegmented = segs.length > 1;
  const fairShare = isSegmented
    ? (memberCount ? fmtMoney(monthTotal / memberCount) : 0)
    : (participants.length ? fmtMoney(monthTotal / participants.length) : 0);

  return {
    memberCount: isSegmented ? memberCount : participants.length,
    totalSpend: monthTotal,
    fairShare,
    balances,
    segments: segs,
    isSegmented,
    transactions: monthTotal > 0 ? computeSettleUp(balances) : [],
  };
}

// The one way to ask for a month's split. Both the analytics payload and the
// settle-up routes go through here, so what a member is asked to agree to is
// exactly what they were shown.
function monthSplit(roomId, month) {
  const participants = monthParticipants(roomId, month);
  const { segments } = participationSegments(roomId, month);
  return computeMonthSplit(participants, segments.map((seg) => ({ ...seg, roomId })));
}

// ---------------------------------------------------------------------------
// Settle-up agreements
//
// Settling is a *statement about the real world* — "we have paid each other" —
// so it is recorded, never calculated. The debts themselves always come from
// the expenses, which means agreeing to settle can't move a penny and can't
// corrupt a month's figures. The worst a bug here can do is show the wrong
// badge.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Fixed English names rather than toLocaleString: these strings go into the
// permanent activity log, which must read the same for every member.
function monthName(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function openSettlement(roomId, month) {
  return db
    .prepare(`SELECT * FROM settlements WHERE room_id = ? AND month = ? AND status IN ('pending','settled')`)
    .get(roomId, month);
}

// The month's live total, used only to detect that spending changed after an
// agreement was made. Never fed back into the split.
function monthTotalSpend(roomId, month) {
  return fmtMoney(
    db.prepare('SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE room_id = ? AND substr(date,1,7) = ?').get(roomId, month).t
  );
}

function publicSettlement(row, roomId) {
  if (!row) return null;
  const participants = db
    .prepare(
      `SELECT p.member_id as memberId, p.approved_at as approvedAt, m.name, m.avatar
       FROM settlement_participants p JOIN members m ON m.id = p.member_id
       WHERE p.settlement_id = ? ORDER BY m.name COLLATE NOCASE`
    )
    .all(row.id)
    .map((p) => ({ memberId: p.memberId, name: p.name, avatar: p.avatar, approved: !!p.approvedAt, approvedAt: p.approvedAt }));

  const requester = db.prepare('SELECT id, name, avatar FROM members WHERE id = ?').get(row.requested_by);

  return {
    id: row.id,
    month: row.month,
    status: row.status,
    requestedBy: requester ? { id: requester.id, name: requester.name, avatar: requester.avatar } : null,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    totalSpendAtRequest: fmtMoney(row.total_spend),
    // Spending moved after the agreement was made, so it no longer covers the
    // month. Surfaced rather than auto-voided: quietly cancelling an agreement
    // people already acted on would be worse than telling them it went stale.
    stale: Math.abs(fmtMoney(row.total_spend) - monthTotalSpend(roomId, row.month)) > 0.005,
    participants,
    approvedCount: participants.filter((p) => p.approved).length,
    participantCount: participants.length,
  };
}

// Settle-up requests waiting on *this* member, in any month. Drives the badge
// on the Analytics tab — a request raised for last month is invisible on the
// month you happen to be looking at, and would otherwise never be seen.
function pendingSettleRequestsFor(memberId, roomId) {
  return db
    .prepare(
      `SELECT s.id, s.month FROM settlements s
       JOIN settlement_participants p ON p.settlement_id = s.id AND p.member_id = ?
       WHERE s.room_id = ? AND s.status = 'pending' AND p.approved_at IS NULL
       ORDER BY s.month DESC`
    )
    .all(memberId, roomId);
}

// Mutations are strict about the month where reads are forgiving: a stale
// bookmark should land on a sensible month, but a settle-up must never be
// silently recorded against a month nobody asked for.
function requireMonth(roomId, requested) {
  if (!isMonthKey(requested)) return null;
  return browsableMonths(roomId).includes(requested) ? requested : null;
}

app.post('/api/settlement', authenticate, (req, res) => {
  const month = requireMonth(req.roomId, (req.body || {}).month);
  if (!month) return res.status(400).json({ error: 'Unknown month' });

  const split = monthSplit(req.roomId, month);
  const participants = split.balances;

  if (split.totalSpend <= 0) return res.status(400).json({ error: `Nothing was spent in ${monthName(month)}` });
  if (!split.transactions.length) return res.status(400).json({ error: `Everyone is already even in ${monthName(month)}` });
  if (!participants.some((p) => p.memberId === req.member.id)) {
    return res.status(403).json({ error: `You were not part of ${monthName(month)}` });
  }

  const existing = openSettlement(req.roomId, month);
  if (existing) {
    return res.status(409).json({
      error: existing.status === 'settled'
        ? `${monthName(month)} is already settled up`
        : `A settle-up request is already open for ${monthName(month)}`,
    });
  }

  const settlementId = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO settlements (room_id, month, requested_by, status, total_spend) VALUES (?,?,?,?,?)')
      .run(req.roomId, month, req.member.id, 'pending', split.totalSpend);
    const addParticipant = db.prepare('INSERT INTO settlement_participants (settlement_id, member_id) VALUES (?,?)');
    for (const p of participants) addParticipant.run(info.lastInsertRowid, p.memberId);
    // Raising the request is itself an agreement — asking the requester to
    // then tick their own box is a step that means nothing. Stamped by SQLite
    // so it matches the format every other timestamp in the schema uses.
    db.prepare("UPDATE settlement_participants SET approved_at = datetime('now') WHERE settlement_id = ? AND member_id = ?")
      .run(info.lastInsertRowid, req.member.id);
    return info.lastInsertRowid;
  })();

  const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId);
  const settlement = publicSettlement(row, req.roomId);
  const activity = logActivity(
    req.roomId,
    req.member.id,
    'settle_requested',
    `${req.member.name} asked everyone to settle up ${monthName(month)} (${money(split.totalSpend)} split ${participants.length} ways)`
  );
  broadcast(req.roomId, { type: 'settlement_changed', month, status: 'pending', by: req.member.name, byId: req.member.id, activity });
  res.status(201).json(settlement);
});

app.post('/api/settlement/:id/approve', authenticate, (req, res) => {
  const row = db.prepare('SELECT * FROM settlements WHERE id = ? AND room_id = ?').get(req.params.id, req.roomId);
  if (!row) return res.status(404).json({ error: 'Settle-up request not found' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'That settle-up request is no longer open' });

  const mine = db
    .prepare('SELECT * FROM settlement_participants WHERE settlement_id = ? AND member_id = ?')
    .get(row.id, req.member.id);
  if (!mine) return res.status(403).json({ error: `You were not part of ${monthName(row.month)}` });

  if (!mine.approved_at) {
    db.prepare("UPDATE settlement_participants SET approved_at = datetime('now') WHERE settlement_id = ? AND member_id = ?")
      .run(row.id, req.member.id);
  }

  const stillWaiting = db
    .prepare('SELECT COUNT(*) as c FROM settlement_participants WHERE settlement_id = ? AND approved_at IS NULL')
    .get(row.id).c;

  let activity;
  if (stillWaiting === 0) {
    db.prepare("UPDATE settlements SET status = 'settled', settled_at = datetime('now') WHERE id = ?").run(row.id);
    activity = logActivity(
      req.roomId,
      req.member.id,
      'settle_done',
      `${req.member.name} agreed — ${monthName(row.month)} is now settled up`
    );
  } else {
    activity = logActivity(
      req.roomId,
      req.member.id,
      'settle_agreed',
      `${req.member.name} agreed the ${monthName(row.month)} settle-up (${stillWaiting} still to agree)`
    );
  }

  const updated = db.prepare('SELECT * FROM settlements WHERE id = ?').get(row.id);
  const settlement = publicSettlement(updated, req.roomId);
  broadcast(req.roomId, { type: 'settlement_changed', month: row.month, status: updated.status, by: req.member.name, byId: req.member.id, activity });
  res.json(settlement);
});

// Cancel a request, or reopen a settled month. Restricted to the person who
// raised it and the host — a settle-up is an agreement between people, so any
// one member must not be able to erase what the others agreed to.
app.delete('/api/settlement/:id', authenticate, (req, res) => {
  const row = db.prepare('SELECT * FROM settlements WHERE id = ? AND room_id = ?').get(req.params.id, req.roomId);
  if (!row) return res.status(404).json({ error: 'Settle-up request not found' });
  if (row.status === 'cancelled') return res.status(400).json({ error: 'That settle-up request is already closed' });
  if (row.requested_by !== req.member.id && !req.member.is_host) {
    return res.status(403).json({ error: 'Only the person who asked, or the host, can do that' });
  }

  const wasSettled = row.status === 'settled';
  db.prepare("UPDATE settlements SET status = 'cancelled' WHERE id = ?").run(row.id);

  const activity = logActivity(
    req.roomId,
    req.member.id,
    wasSettled ? 'settle_reopened' : 'settle_cancelled',
    wasSettled
      ? `${req.member.name} reopened ${monthName(row.month)} — it is no longer marked settled`
      : `${req.member.name} cancelled the ${monthName(row.month)} settle-up request`
  );
  broadcast(req.roomId, { type: 'settlement_changed', month: row.month, status: 'cancelled', by: req.member.name, byId: req.member.id, activity });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

app.get('/api/analytics', authenticate, (req, res) => {
  // One month drives the whole payload. Everything below is scoped to it, so
  // browsing history and viewing the live month run the exact same code path.
  const { month: currentMonth, months: availableMonths } = resolveMonth(req.roomId, req.query.month);

  const memberTotals = db
    .prepare(
      `SELECT m.id as memberId, m.name, m.avatar as avatar, COALESCE(SUM(e.amount),0) as total, COUNT(e.id) as count
       FROM members m LEFT JOIN expenses e
         ON e.member_id = m.id AND e.room_id = m.room_id AND substr(e.date,1,7) = ?
       WHERE m.room_id = ? GROUP BY m.id ORDER BY total DESC`
    )
    .all(currentMonth, req.roomId)
    .map((r) => ({ ...r, total: fmtMoney(r.total) }));

  const topSpender = memberTotals.length && memberTotals[0].total > 0 ? memberTotals[0] : null;

  // The trend is context for the selected month, so it ends there rather than
  // always at today — stepping back through history walks the chart with you.
  const monthly = db
    .prepare(
      `SELECT substr(date,1,7) as month, COALESCE(SUM(amount),0) as total
       FROM expenses WHERE room_id = ? AND substr(date,1,7) <= ?
       GROUP BY month ORDER BY month DESC LIMIT 6`
    )
    .all(req.roomId, currentMonth)
    .map((r) => ({ ...r, total: fmtMoney(r.total) }))
    .reverse();

  const categoryTotals = db
    .prepare(
      `SELECT category, COALESCE(SUM(amount),0) as total, COUNT(*) as count
       FROM expenses WHERE room_id = ? AND substr(date,1,7) = ?
       GROUP BY category ORDER BY total DESC`
    )
    .all(req.roomId, currentMonth)
    .map((r) => ({ ...r, total: fmtMoney(r.total) }));

  // Places are free text, so group case-insensitively and keep the spelling
  // of whichever entry spent the most under that name.
  const topLocations = db
    .prepare(
      `SELECT location, COALESCE(SUM(amount),0) as total, COUNT(*) as count
       FROM expenses
       WHERE room_id = ? AND substr(date,1,7) = ?
         AND location IS NOT NULL AND TRIM(location) <> ''
       GROUP BY location COLLATE NOCASE
       ORDER BY total DESC LIMIT 6`
    )
    .all(req.roomId, currentMonth)
    .map((r) => ({ ...r, total: fmtMoney(r.total) }));

  // Settle up: split the selected month's spend evenly across the people who
  // were actually in the room that month, and work out who owes who. Both the
  // participant set and the split come from the same helpers the settle-up
  // routes use, so the figures a member agrees to are the figures they saw.
  const split = monthSplit(req.roomId, currentMonth);
  const monthTotal = split.totalSpend;
  const settleUp = {
    month: currentMonth,
    totalSpend: monthTotal,
    fairShare: split.fairShare,
    balances: split.balances,
    transactions: split.transactions,
    // How the month was cut up, and who was sharing in each stretch. One
    // segment covering the whole month means nobody paused and this is the
    // plain even split it has always been — the client hides the breakdown in
    // that case rather than explaining something that did not happen.
    segments: split.segments,
    isSegmented: split.isSegmented,
    // Whether the room has agreed this month is settled. Purely a record —
    // it never changes a balance above.
    settlement: publicSettlement(openSettlement(req.roomId, currentMonth), req.roomId),
  };

  // Month-on-month is measured against the calendar month before the selected
  // one, not against whatever the previous row in `monthly` happens to be — a
  // room with a quiet month has a gap there, and comparing across it would
  // silently report the wrong baseline.
  const prevMonthTotal = db
    .prepare('SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE room_id = ? AND substr(date,1,7) = ?')
    .get(req.roomId, addMonths(currentMonth, -1)).t;
  // A month with nothing in it gets no percentage. The arithmetic would say
  // "−100% vs last month", which reads as a dramatic collapse when the truth
  // is simply that nothing was recorded — and on a month that has not happened
  // yet it is meaningless. The headline £0.00 already says everything.
  const momChange =
    monthTotal > 0 && prevMonthTotal > 0
      ? fmtMoney(((monthTotal - prevMonthTotal) / prevMonthTotal) * 100)
      : null;

  // ---- The selected month in detail ---------------------------------------
  // Day-level totals drive the daily bar chart. Days with no spending must
  // still occupy a column, otherwise the chart silently compresses a quiet
  // week into nothing and misrepresents the shape of the month.
  const [curYear, curMonthNum] = currentMonth.split('-').map(Number);
  const daysInMonth = new Date(curYear, curMonthNum, 0).getDate();
  const now = new Date();
  const isCurrentRealMonth = now.toISOString().slice(0, 7) === currentMonth;
  const daysElapsed = isCurrentRealMonth ? now.getDate() : daysInMonth;

  const dailyRows = db
    .prepare(
      `SELECT CAST(substr(date, 9, 2) AS INTEGER) as day, COALESCE(SUM(amount),0) as total
       FROM expenses WHERE room_id = ? AND substr(date,1,7) = ? GROUP BY day`
    )
    .all(req.roomId, currentMonth);
  const dailyByDay = new Map(dailyRows.map((r) => [r.day, fmtMoney(r.total)]));
  const daily = [];
  for (let d = 1; d <= daysInMonth; d++) daily.push({ day: d, total: dailyByDay.get(d) || 0 });

  const monthStats = db
    .prepare(
      `SELECT COUNT(*) as count, COALESCE(MAX(amount),0) as maxAmount
       FROM expenses WHERE room_id = ? AND substr(date,1,7) = ?`
    )
    .get(req.roomId, currentMonth);

  const largest = monthStats.count
    ? db
        .prepare(
          `SELECT description, amount, category FROM expenses
           WHERE room_id = ? AND substr(date,1,7) = ? ORDER BY amount DESC, id DESC LIMIT 1`
        )
        .get(req.roomId, currentMonth)
    : null;

  const thisMonthStats = {
    month: currentMonth,
    total: monthTotal,
    count: monthStats.count,
    daysElapsed,
    daysInMonth,
    avgPerDay: daysElapsed ? fmtMoney(monthTotal / daysElapsed) : 0,
    largest: largest ? { description: largest.description, amount: fmtMoney(largest.amount), category: largest.category } : null,
    daily,
  };

  res.json({
    month: currentMonth,
    availableMonths,
    isCurrentMonth: isCurrentRealMonth,
    // The months still open for entry, and the picker bounds that follow from
    // them. Sent from here so the UI draws the server's rules, not its own
    // reading of the device clock.
    writeWindow: writeWindow(),
    topSpender,
    memberTotals,
    monthly,
    categoryTotals,
    topLocations,
    momChange,
    settleUp,
    participation: participationPayload(req.roomId, currentMonth),
    // Requests waiting on the caller in *any* month, not just this one.
    pendingSettleRequests: pendingSettleRequestsFor(req.member.id, req.roomId),
    thisMonth: thisMonthStats,
  });
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get(/^(?!\/api\/|\/ws).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = app.listen(PORT, HOST, () => {
  console.log(`Finledge backend listening on http://${HOST}:${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });
const roomSockets = new Map(); // roomId -> Set<ws>

function broadcast(roomId, payload) {
  const sockets = roomSockets.get(roomId);
  if (!sockets) return;
  const data = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://internal');
  const token = url.searchParams.get('token');
  const session = token
    ? db
        .prepare(
          `SELECT s.room_id, m.name FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.token = ?`
        )
        .get(token)
    : null;

  if (!session) {
    ws.close(4001, 'Invalid session token');
    return;
  }

  ws.roomId = session.room_id;
  if (!roomSockets.has(ws.roomId)) roomSockets.set(ws.roomId, new Set());
  roomSockets.get(ws.roomId).add(ws);

  ws.on('close', () => {
    const set = roomSockets.get(ws.roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) roomSockets.delete(ws.roomId);
    }
  });

  ws.on('error', () => ws.close());
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
