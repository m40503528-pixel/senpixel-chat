const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { WebSocketServer } = require("ws");

const APP_ROOT = __dirname;
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8000);
const DB_PATH = path.join(APP_ROOT, "senpixel.db");

const MAX_CIPHERTEXT_LENGTH = 450000;
const MAX_IV_LENGTH = 128;
const MAX_SIGNATURE_LENGTH = 2048;
const MAX_TTL_SECONDS = 86400;
const DEFAULT_TTL_SECONDS = 3600;
const RATE_LIMIT_BURST = 12;
const RATE_LIMIT_WINDOW_MS = 10_000;
const LAUNCH_TOKEN_TTL_MS = 120_000;
const USERNAME_RE = /^(?=.{2,24}$)[\p{L}\p{N}_.\- ]+$/u;

const DEFAULT_ROOMS = [
  {
    id: "zero-access",
    title: "Lobby",
    description: "Main room for live traffic and onboarding.",
    accent: "#00f0ff",
  },
  {
    id: "ghost-protocol",
    title: "Builders",
    description: "Product, experiments and system talk.",
    accent: "#7c3aed",
  },
  {
    id: "signal-core",
    title: "Afterglow",
    description: "Slow mode room for longer threads.",
    accent: "#ff8a5b",
  },
];

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeUser(rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ");
  if (!USERNAME_RE.test(name)) {
    throw new Error("Nickname must be 2-24 chars and use letters, numbers, spaces, dots, dashes or underscores.");
  }
  return name;
}

function slugifyRoom(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || `room-${crypto.randomUUID().slice(0, 6)}`;
}

function queryOne(sql, params = []) {
  return db.prepare(sql).get(...params) || null;
}

function queryAll(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

function execMany(sql, values) {
  const statement = db.prepare(sql);
  const transaction = db.transaction((rows) => {
    for (const row of rows) {
      statement.run(...row);
    }
  });
  transaction(values);
}

function ensureColumn(table, column, definition) {
  const existing = queryAll(`PRAGMA table_info(${table})`).map((row) => row.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      device_id TEXT,
      public_key TEXT,
      status_text TEXT,
      status_emoji TEXT,
      avatar_emoji TEXT,
      supporter_tier TEXT,
      location_visible INTEGER,
      location_lat REAL,
      location_lon REAL,
      location_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      accent TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      signature TEXT,
      device_id TEXT,
      reply_to TEXT,
      ttl_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      expires_at TEXT,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, sender, emoji),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pins (
      room_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      pinned_by TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
  `);

  ensureColumn("users", "device_id", "TEXT");
  ensureColumn("users", "public_key", "TEXT");
  ensureColumn("users", "status_text", "TEXT");
  ensureColumn("users", "status_emoji", "TEXT");
  ensureColumn("users", "avatar_emoji", "TEXT");
  ensureColumn("users", "supporter_tier", "TEXT");
  ensureColumn("users", "location_visible", "INTEGER");
  ensureColumn("users", "location_lat", "REAL");
  ensureColumn("users", "location_lon", "REAL");
  ensureColumn("users", "location_updated_at", "TEXT");
  ensureColumn("messages", "signature", "TEXT");
  ensureColumn("messages", "device_id", "TEXT");
  ensureColumn("messages", "edited_at", "TEXT");

  const timestamp = nowIso();
  for (const room of DEFAULT_ROOMS) {
    run(
      `
      INSERT INTO rooms (id, title, description, accent, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        accent = excluded.accent
      `,
      [room.id, room.title, room.description, room.accent, timestamp]
    );
  }
}

initDb();

function touchUser(name) {
  const timestamp = nowIso();
  run(
    `
    INSERT INTO users (name, created_at, last_seen)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen
    `,
    [name, timestamp, timestamp]
  );
}

function listRooms() {
  return queryAll("SELECT * FROM rooms ORDER BY created_at ASC, title ASC");
}

function ensureRoom(roomId) {
  const room = queryOne("SELECT * FROM rooms WHERE id = ?", [roomId]);
  if (!room) {
    throw new HttpError(404, "Room not found.");
  }
  return room;
}

function serializeReactions(messageId) {
  const rows = queryAll(
    "SELECT emoji, sender FROM reactions WHERE message_id = ? ORDER BY emoji, sender",
    [messageId]
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.emoji)) grouped.set(row.emoji, []);
    grouped.get(row.emoji).push(row.sender);
  }
  return [...grouped.entries()].map(([emoji, users]) => ({
    emoji,
    count: users.length,
    users,
  }));
}

function serializeMessage(row) {
  return {
    id: row.id,
    room_id: row.room_id,
    sender: row.sender,
    ciphertext: row.ciphertext,
    iv: row.iv,
    signature: row.signature || "",
    device_id: row.device_id || "",
    reply_to: row.reply_to,
    ttl_seconds: row.ttl_seconds,
    created_at: row.created_at,
    edited_at: row.edited_at,
    expires_at: row.expires_at,
    reactions: serializeReactions(row.id),
  };
}

function listMessages(limit = 400) {
  const rows = queryAll(
    `
    SELECT *
    FROM messages
    WHERE expires_at IS NULL OR expires_at > ?
    ORDER BY created_at ASC
    LIMIT ?
    `,
    [nowIso(), limit]
  );
  return rows.map(serializeMessage);
}

function getPin(roomId) {
  const row = queryOne(
    `
    SELECT p.room_id, p.message_id, p.pinned_by, p.pinned_at
    FROM pins p
    JOIN messages m ON m.id = p.message_id
    WHERE p.room_id = ?
      AND (m.expires_at IS NULL OR m.expires_at > ?)
    `,
    [roomId, nowIso()]
  );
  return row
    ? {
        room_id: row.room_id,
        message_id: row.message_id,
        pinned_by: row.pinned_by,
        pinned_at: row.pinned_at,
      }
    : null;
}

function listPins() {
  const result = {};
  for (const room of listRooms()) {
    const pin = getPin(room.id);
    if (pin) result[room.id] = pin;
  }
  return result;
}

function listIdentities() {
  const rows = queryAll(
    `
    SELECT name, device_id, public_key, status_text, status_emoji, avatar_emoji, supporter_tier, location_visible, location_lat, location_lon, location_updated_at
    FROM users
    WHERE device_id IS NOT NULL AND public_key IS NOT NULL
    ORDER BY LOWER(name) ASC
    `
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.name,
      {
        name: row.name,
        device_id: row.device_id || "",
        public_key: row.public_key || "",
        status_text: row.status_text || "",
        status_emoji: row.status_emoji || "",
        avatar_emoji: row.avatar_emoji || "",
        supporter_tier: row.supporter_tier || "",
        location_visible: Boolean(row.location_visible),
        location_lat: row.location_lat,
        location_lon: row.location_lon,
        location_updated_at: row.location_updated_at || "",
      },
    ])
  );
}

function registerIdentity(name, deviceId, publicKey) {
  const cleanDeviceId = String(deviceId || "").trim().slice(0, 128);
  const cleanPublicKey = String(publicKey || "").trim();
  if (!cleanDeviceId) throw new HttpError(422, "Device id is required.");
  if (!cleanPublicKey || cleanPublicKey.length > MAX_SIGNATURE_LENGTH) {
    throw new HttpError(422, "Public key payload is invalid.");
  }

  touchUser(name);
  run("UPDATE users SET device_id = ?, public_key = ? WHERE name = ?", [cleanDeviceId, cleanPublicKey, name]);
  const row = queryOne(
    "SELECT name, device_id, public_key, status_text, status_emoji, avatar_emoji, supporter_tier, location_visible, location_lat, location_lon, location_updated_at FROM users WHERE name = ?",
    [name]
  );
  return {
    name: row.name,
    device_id: row.device_id || "",
    public_key: row.public_key || "",
    status_text: row.status_text || "",
    status_emoji: row.status_emoji || "",
    avatar_emoji: row.avatar_emoji || "",
    supporter_tier: row.supporter_tier || "",
    location_visible: Boolean(row.location_visible),
    location_lat: row.location_lat,
    location_lon: row.location_lon,
    location_updated_at: row.location_updated_at || "",
  };
}

function updateProfile(name, statusEmoji, statusText, avatarEmoji, supporterTier, locationVisible, locationLat, locationLon) {
  const cleanEmoji = String(statusEmoji || "").trim().slice(0, 8);
  const cleanText = String(statusText || "").trim().replace(/\s+/g, " ").slice(0, 64);
  const cleanAvatar = String(avatarEmoji || "").trim().slice(0, 8);
  const cleanTier = String(supporterTier || "").trim().slice(0, 24);
  const visible = Boolean(locationVisible);
  const lat = visible && Number.isFinite(Number(locationLat)) ? Number(Number(locationLat).toFixed(3)) : null;
  const lon = visible && Number.isFinite(Number(locationLon)) ? Number(Number(locationLon).toFixed(3)) : null;
  const locationUpdatedAt = visible && lat !== null && lon !== null ? nowIso() : null;
  run(
    `
    UPDATE users
    SET status_emoji = ?, status_text = ?, avatar_emoji = ?, supporter_tier = ?, location_visible = ?, location_lat = ?, location_lon = ?, location_updated_at = ?, last_seen = ?
    WHERE name = ?
    `,
    [cleanEmoji, cleanText, cleanAvatar, cleanTier, visible ? 1 : 0, lat, lon, locationUpdatedAt, nowIso(), name]
  );

  const row = queryOne(
    "SELECT name, device_id, public_key, status_text, status_emoji, avatar_emoji, supporter_tier, location_visible, location_lat, location_lon, location_updated_at FROM users WHERE name = ?",
    [name]
  );

  return {
    name: row.name,
    device_id: row.device_id || "",
    public_key: row.public_key || "",
    status_text: row.status_text || "",
    status_emoji: row.status_emoji || "",
    avatar_emoji: row.avatar_emoji || "",
    supporter_tier: row.supporter_tier || "",
    location_visible: Boolean(row.location_visible),
    location_lat: row.location_lat,
    location_lon: row.location_lon,
    location_updated_at: row.location_updated_at || "",
  };
}

function createRoom(title, description) {
  const cleanTitle = String(title || "").trim().replace(/\s+/g, " ");
  const cleanDescription = String(description || "").trim().replace(/\s+/g, " ");
  if (!cleanTitle || cleanTitle.length > 42) {
    throw new HttpError(422, "Room title must be between 1 and 42 characters.");
  }
  if (cleanDescription.length > 160) {
    throw new HttpError(422, "Room description is too long.");
  }

  let roomId = slugifyRoom(cleanTitle);
  while (queryOne("SELECT 1 FROM rooms WHERE id = ?", [roomId])) {
    roomId = `${roomId.slice(0, 24)}-${crypto.randomUUID().slice(0, 4)}`;
  }

  const room = {
    id: roomId,
    title: cleanTitle,
    description: cleanDescription || "Encrypted room. Share the secret out of band.",
    accent: DEFAULT_ROOMS[listRooms().length % DEFAULT_ROOMS.length].accent,
    created_at: nowIso(),
  };

  run(
    "INSERT INTO rooms (id, title, description, accent, created_at) VALUES (?, ?, ?, ?, ?)",
    [room.id, room.title, room.description, room.accent, room.created_at]
  );
  return room;
}

function createMessage(user, payload) {
  const room = ensureRoom(payload.room_id || "");
  const ciphertext = String(payload.ciphertext || "").trim();
  const iv = String(payload.iv || "").trim();
  const signature = String(payload.signature || "").trim();
  const deviceId = String(payload.device_id || "").trim();
  const replyTo = payload.reply_to || null;
  const ttlSeconds = Number(payload.ttl_seconds || DEFAULT_TTL_SECONDS);

  if (!ciphertext || ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
    throw new HttpError(422, "Invalid ciphertext payload size.");
  }
  if (!iv || iv.length > MAX_IV_LENGTH) {
    throw new HttpError(422, "Invalid IV payload size.");
  }
  if (!signature || signature.length > MAX_SIGNATURE_LENGTH) {
    throw new HttpError(422, "Signature is required.");
  }
  if (!deviceId) {
    throw new HttpError(422, "Device id is required.");
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new HttpError(422, "TTL is outside the allowed range.");
  }

  if (replyTo) {
    const replyRow = queryOne("SELECT room_id FROM messages WHERE id = ?", [replyTo]);
    if (!replyRow || replyRow.room_id !== room.id) {
      throw new HttpError(404, "Reply target not found in this room.");
    }
  }

  const identity = queryOne("SELECT device_id FROM users WHERE name = ?", [user]);
  if (!identity || !identity.device_id) {
    throw new HttpError(403, "Announce device identity before sending messages.");
  }
  if (identity.device_id !== deviceId) {
    throw new HttpError(403, "Device identity mismatch for this user.");
  }

  const createdAt = nowIso();
  const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;

  const message = {
    id: crypto.randomUUID().replace(/-/g, ""),
    room_id: room.id,
    sender: user,
    ciphertext,
    iv,
    signature,
    device_id: deviceId,
    reply_to: replyTo,
    ttl_seconds: ttlSeconds,
    created_at: createdAt,
    edited_at: null,
    expires_at: expiresAt,
    reactions: [],
  };

  run(
    `
    INSERT INTO messages (id, room_id, sender, ciphertext, iv, signature, device_id, reply_to, ttl_seconds, created_at, edited_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      message.id,
      message.room_id,
      message.sender,
      message.ciphertext,
      message.iv,
      message.signature,
      message.device_id,
      message.reply_to,
      message.ttl_seconds,
      message.created_at,
      message.edited_at,
      message.expires_at,
    ]
  );

  return message;
}

function deleteMessage(messageId, actor) {
  const row = queryOne("SELECT * FROM messages WHERE id = ?", [messageId]);
  if (!row) throw new HttpError(404, "Message not found.");
  if (row.sender !== actor) throw new HttpError(403, "Only the sender can burn this message.");

  run("DELETE FROM messages WHERE id = ?", [messageId]);
  return { id: row.id, room_id: row.room_id };
}

function editMessage(actor, payload) {
  const messageId = String(payload.message_id || "").trim();
  if (!messageId) throw new HttpError(422, "Message id is required.");

  const row = queryOne("SELECT * FROM messages WHERE id = ?", [messageId]);
  if (!row) throw new HttpError(404, "Message not found.");
  if (row.sender !== actor) throw new HttpError(403, "Only the sender can edit this message.");
  if (row.expires_at && row.expires_at <= nowIso()) throw new HttpError(410, "Message already expired.");

  const ciphertext = String(payload.ciphertext || "").trim();
  const iv = String(payload.iv || "").trim();
  const signature = String(payload.signature || "").trim();
  const deviceId = String(payload.device_id || "").trim();

  if (!ciphertext || ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
    throw new HttpError(422, "Invalid ciphertext payload size.");
  }
  if (!iv || iv.length > MAX_IV_LENGTH) {
    throw new HttpError(422, "Invalid IV payload size.");
  }
  if (!signature || signature.length > MAX_SIGNATURE_LENGTH) {
    throw new HttpError(422, "Signature is required.");
  }
  if (!deviceId) {
    throw new HttpError(422, "Device id is required.");
  }

  const identity = queryOne("SELECT device_id FROM users WHERE name = ?", [actor]);
  if (!identity || !identity.device_id) {
    throw new HttpError(403, "Announce device identity before editing messages.");
  }
  if (identity.device_id !== deviceId) {
    throw new HttpError(403, "Device identity mismatch for this user.");
  }

  const editedAt = nowIso();
  run(
    `
    UPDATE messages
    SET ciphertext = ?, iv = ?, signature = ?, device_id = ?, edited_at = ?
    WHERE id = ?
    `,
    [ciphertext, iv, signature, deviceId, editedAt, messageId]
  );

  const updatedRow = queryOne("SELECT * FROM messages WHERE id = ?", [messageId]);
  return serializeMessage(updatedRow);
}

function setPin(roomId, messageId, actor) {
  ensureRoom(roomId);
  const row = queryOne("SELECT room_id FROM messages WHERE id = ?", [messageId]);
  if (!row || row.room_id !== roomId) {
    throw new HttpError(404, "Message not found in this room.");
  }

  const current = getPin(roomId);
  if (current && current.message_id === messageId) {
    run("DELETE FROM pins WHERE room_id = ?", [roomId]);
    return null;
  }

  const pin = {
    room_id: roomId,
    message_id: messageId,
    pinned_by: actor,
    pinned_at: nowIso(),
  };

  run(
    `
    INSERT INTO pins (room_id, message_id, pinned_by, pinned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      message_id = excluded.message_id,
      pinned_by = excluded.pinned_by,
      pinned_at = excluded.pinned_at
    `,
    [pin.room_id, pin.message_id, pin.pinned_by, pin.pinned_at]
  );
  return pin;
}

function toggleReaction(user, roomId, messageId, emoji) {
  const cleanEmoji = String(emoji || "").trim().slice(0, 8);
  if (!cleanEmoji) throw new HttpError(422, "Reaction emoji is required.");

  const row = queryOne("SELECT room_id FROM messages WHERE id = ?", [messageId]);
  if (!row || row.room_id !== roomId) {
    throw new HttpError(404, "Message not found in this room.");
  }

  const existing = queryOne(
    "SELECT 1 FROM reactions WHERE message_id = ? AND sender = ? AND emoji = ?",
    [messageId, user, cleanEmoji]
  );

  if (existing) {
    run("DELETE FROM reactions WHERE message_id = ? AND sender = ? AND emoji = ?", [messageId, user, cleanEmoji]);
  } else {
    run(
      "INSERT INTO reactions (message_id, room_id, sender, emoji, created_at) VALUES (?, ?, ?, ?, ?)",
      [messageId, roomId, user, cleanEmoji, nowIso()]
    );
  }

  return {
    room_id: roomId,
    message_id: messageId,
    reactions: serializeReactions(messageId),
  };
}

function purgeExpiredMessages() {
  const rows = queryAll(
    `
    SELECT id, room_id
    FROM messages
    WHERE expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at ASC
    `,
    [nowIso()]
  );
  if (!rows.length) return [];
  execMany("DELETE FROM messages WHERE id = ?", rows.map((row) => [row.id]));
  return rows.map((row) => ({ id: row.id, room_id: row.room_id }));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ConnectionManager {
  constructor() {
    this.connections = new Set();
    this.socketToUser = new Map();
    this.userSockets = new Map();
    this.rateLimits = new Map();
  }

  onlineUsers() {
    return [...this.userSockets.keys()].sort((a, b) => a.localeCompare(b));
  }

  connect(ws, user) {
    touchUser(user);
    this.connections.add(ws);
    this.socketToUser.set(ws, user);
    if (!this.userSockets.has(user)) this.userSockets.set(user, new Set());
    this.userSockets.get(user).add(ws);
    this.broadcastPresence();
  }

  disconnect(ws) {
    const user = this.socketToUser.get(ws);
    this.socketToUser.delete(ws);
    this.connections.delete(ws);
    if (!user) return;
    const bucket = this.userSockets.get(user);
    if (bucket) {
      bucket.delete(ws);
      if (bucket.size === 0) {
        this.userSockets.delete(user);
        touchUser(user);
      }
    }
    this.broadcastPresence();
  }

  allowMessage(user) {
    const now = Date.now();
    const window = this.rateLimits.get(user) || [];
    const filtered = window.filter((stamp) => now - stamp <= RATE_LIMIT_WINDOW_MS);
    if (filtered.length >= RATE_LIMIT_BURST) {
      this.rateLimits.set(user, filtered);
      return false;
    }
    filtered.push(now);
    this.rateLimits.set(user, filtered);
    return true;
  }

  send(ws, payload) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const ws of [...this.connections]) {
      if (ws.readyState !== ws.OPEN) {
        this.disconnect(ws);
        continue;
      }
      ws.send(message);
    }
  }

  broadcastPresence() {
    this.broadcast({ type: "PRESENCE", online: this.onlineUsers() });
  }
}

const manager = new ConnectionManager();
const launchTokens = new Map();

function purgeExpiredLaunchTokens() {
  const now = Date.now();
  for (const [token, payload] of launchTokens.entries()) {
    if (payload.expiresAt <= now) {
      launchTokens.delete(token);
    }
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new HttpError(400, "Malformed JSON payload."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

const indexHtml = fs.readFileSync(path.join(APP_ROOT, "index.html"), "utf8");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/messenger")) {
      sendHtml(res, indexHtml);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        status: "ok",
        database: "sqlite",
        runtime: "node",
        pid: process.pid,
        online: manager.connections.size,
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/bootstrap/")) {
      const user = normalizeUser(decodeURIComponent(url.pathname.split("/").pop() || ""));
      touchUser(user);
      sendJson(res, 200, {
        brand: { name: "Senpixel", protocol: "Senpixel Realtime", architecture: "Local Node Relay" },
        user,
        rooms: listRooms(),
        messages: listMessages(),
        pins: listPins(),
        identities: listIdentities(),
        online: manager.onlineUsers(),
        limits: {
          max_ttl_seconds: MAX_TTL_SECONDS,
          default_ttl_seconds: DEFAULT_TTL_SECONDS,
          max_ciphertext_length: MAX_CIPHERTEXT_LENGTH,
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/launch") {
      purgeExpiredLaunchTokens();
      const payload = await parseJsonBody(req);
      const nickname = payload.nickname ? normalizeUser(payload.nickname) : "";
      const token = crypto.randomUUID().replace(/-/g, "");
      launchTokens.set(token, {
        nickname,
        room_id: String(payload.room_id || "").trim(),
        room_secret: String(payload.room_secret || ""),
        remember_secret: Boolean(payload.remember_secret),
        auto_start: Boolean(payload.auto_start),
        expiresAt: Date.now() + LAUNCH_TOKEN_TTL_MS,
      });
      sendJson(res, 200, { token });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/launch/")) {
      purgeExpiredLaunchTokens();
      const token = decodeURIComponent(url.pathname.split("/").pop() || "");
      const payload = launchTokens.get(token);
      if (!payload) throw new HttpError(404, "Launch token expired or not found.");
      launchTokens.delete(token);
      const { expiresAt, ...safePayload } = payload;
      sendJson(res, 200, safePayload);
      return;
    }

    sendJson(res, 404, { detail: "Not found." });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(res, status, { detail: error.message || "Internal server error." });
  }
});

server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  clientTracking: false,
  maxPayload: 768 * 1024,
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith("/ws/")) {
      socket.destroy();
      return;
    }

    const user = normalizeUser(decodeURIComponent(url.pathname.slice(4)));
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._socket?.setNoDelay(true);
      wss.emit("connection", ws, user);
    });
  } catch {
    socket.destroy();
  }
});

wss.on("connection", (ws, user) => {
  manager.connect(ws, user);
  manager.send(ws, {
    type: "BOOTSTRAP_HINT",
    message: "Use /api/bootstrap/{user} for the initial encrypted snapshot.",
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      manager.send(ws, { type: "ERROR", message: "Malformed JSON payload." });
      return;
    }

    try {
      switch (data.type) {
        case "PING":
          manager.send(ws, { type: "PONG", ts: nowIso() });
          return;

        case "ANNOUNCE_IDENTITY": {
          const identity = registerIdentity(user, data.device_id, data.public_key);
          manager.broadcast({ type: "IDENTITY_UPDATED", identity });
          return;
        }

        case "UPDATE_PROFILE": {
          const identity = updateProfile(
            user,
            data.status_emoji,
            data.status_text,
            data.avatar_emoji,
            data.supporter_tier,
            data.location_visible,
            data.location_lat,
            data.location_lon
          );
          manager.broadcast({ type: "IDENTITY_UPDATED", identity });
          return;
        }

        case "CREATE_ROOM": {
          const room = createRoom(data.title, data.description);
          manager.broadcast({ type: "ROOM_CREATED", room });
          return;
        }

        case "TYPING": {
          const roomId = String(data.room_id || "").trim();
          if (!roomId) throw new HttpError(422, "Room id is required for typing events.");
          ensureRoom(roomId);
          manager.broadcast({
            type: "TYPING_STATUS",
            room_id: roomId,
            user,
            active: Boolean(data.active),
          });
          return;
        }

        case "SEND_MESSAGE": {
          if (!manager.allowMessage(user)) {
            manager.send(ws, { type: "ERROR", message: "Rate limit exceeded. Slow down before sending more traffic." });
            return;
          }
          const message = createMessage(user, data);
          manager.broadcast({ type: "MESSAGE_CREATED", message });
          return;
        }

        case "EDIT_MESSAGE": {
          const message = editMessage(user, data);
          manager.broadcast({ type: "MESSAGE_UPDATED", message });
          return;
        }

        case "REACT": {
          const reaction = toggleReaction(user, data.room_id, data.message_id, data.emoji);
          manager.broadcast({ type: "REACTION_UPDATED", ...reaction });
          return;
        }

        case "PIN_MESSAGE": {
          const pin = setPin(data.room_id, data.message_id, user);
          manager.broadcast({ type: "PIN_UPDATED", room_id: data.room_id, pin });
          return;
        }

        case "BURN_MESSAGE": {
          const deleted = deleteMessage(data.message_id, user);
          manager.broadcast({ type: "MESSAGE_DELETED", message_id: deleted.id, room_id: deleted.room_id });
          manager.broadcast({ type: "PIN_UPDATED", room_id: deleted.room_id, pin: getPin(deleted.room_id) });
          return;
        }

        default:
          manager.send(ws, { type: "ERROR", message: `Unsupported event: ${data.type}` });
      }
    } catch (error) {
      manager.send(ws, { type: "ERROR", message: error.message || "Operation failed." });
    }
  });

  ws.on("close", () => manager.disconnect(ws));
  ws.on("error", () => manager.disconnect(ws));
});

setInterval(() => {
  const expired = purgeExpiredMessages();
  if (!expired.length) return;
  const rooms = new Set();
  for (const item of expired) {
    rooms.add(item.room_id);
    manager.broadcast({ type: "MESSAGE_DELETED", message_id: item.id, room_id: item.room_id });
  }
  for (const roomId of rooms) {
    manager.broadcast({ type: "PIN_UPDATED", room_id: roomId, pin: getPin(roomId) });
  }
}, 2000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Senpixel server running on http://${HOST}:${PORT}`);
});
