import asyncio
import json
import os
import re
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None
    dict_row = None


APP_ROOT = Path(__file__).resolve().parent
DB_PATH = APP_ROOT / "citadel.db"
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))
APP_HOST = os.getenv("HOST", "127.0.0.1")
APP_PORT = int(os.getenv("PORT", "8000"))
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "*").strip()

MAX_CIPHERTEXT_LENGTH = 8192
MAX_IV_LENGTH = 128
MAX_SIGNATURE_LENGTH = 2048
MAX_TTL_SECONDS = 86400
DEFAULT_TTL_SECONDS = 3600
RATE_LIMIT_BURST = 8
RATE_LIMIT_WINDOW_SECONDS = 10
LAUNCH_TOKEN_TTL_SECONDS = 120
USERNAME_RE = re.compile(r"^[\w.\- ]{2,24}$", re.UNICODE)

DEFAULT_ROOMS = [
    {
        "id": "zero-access",
        "title": "Zero-Access",
        "description": "Ciphertext-only relay. The server never sees message plaintext.",
        "accent": "#00f0ff",
    },
    {
        "id": "ghost-protocol",
        "title": "Ghost Protocol",
        "description": "Short-lived traffic with self-destruct timers and manual burn.",
        "accent": "#7c3aed",
    },
    {
        "id": "decentralized-hub",
        "title": "Decentralized Hub",
        "description": "Relay-ready room for multi-node expansion and routing experiments.",
        "accent": "#818cf8",
    },
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def normalize_user(raw_name: str) -> str:
    name = re.sub(r"\s+", " ", (raw_name or "").strip())
    if not USERNAME_RE.fullmatch(name):
        raise ValueError("Nickname must be 2-24 chars and contain only letters, numbers, spaces, dots, dashes or underscores.")
    return name


def slugify_room(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    slug = slug[:32]
    if slug:
        return slug
    return f"room-{uuid.uuid4().hex[:6]}"


db_lock = Lock()

if IS_POSTGRES:
    if psycopg is None:
        raise RuntimeError("psycopg is required when DATABASE_URL points to PostgreSQL.")
    conn = psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row)
else:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")


def sql(query: str) -> str:
    if not IS_POSTGRES:
        return query
    return query.replace("?", "%s")


def fetch_all(query: str, params: tuple = ()) -> list[Any]:
    with db_lock:
        cur = conn.execute(sql(query), params)
        return cur.fetchall()


def fetch_one(query: str, params: tuple = ()) -> Any | None:
    with db_lock:
        cur = conn.execute(sql(query), params)
        return cur.fetchone()


def execute(query: str, params: tuple = ()) -> None:
    with db_lock:
        conn.execute(sql(query), params)
        if not IS_POSTGRES:
            conn.commit()


def execute_many(query: str, params: list[tuple]) -> None:
    with db_lock:
        conn.executemany(sql(query), params)
        if not IS_POSTGRES:
            conn.commit()


def execute_script(statements: list[str]) -> None:
    with db_lock:
        for statement in statements:
            clean = statement.strip()
            if clean:
                conn.execute(sql(clean))
        if not IS_POSTGRES:
            conn.commit()


def init_db() -> None:
    execute_script(
        [
            """
            CREATE TABLE IF NOT EXISTS users (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                device_id TEXT,
                public_key TEXT,
                status_text TEXT,
                status_emoji TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                accent TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """,
            """
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
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS reactions (
                message_id TEXT NOT NULL,
                room_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (message_id, sender, emoji),
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS pins (
                room_id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                pinned_by TEXT NOT NULL,
                pinned_at TEXT NOT NULL,
                FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at)",
        ]
    )

    timestamp = to_iso(utc_now())
    for room in DEFAULT_ROOMS:
        execute(
            """
            INSERT INTO rooms (id, title, description, accent, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
            """,
            (room["id"], room["title"], room["description"], room["accent"], timestamp),
        )
    ensure_column("users", "device_id", "TEXT")
    ensure_column("users", "public_key", "TEXT")
    ensure_column("users", "status_text", "TEXT")
    ensure_column("users", "status_emoji", "TEXT")
    ensure_column("messages", "signature", "TEXT")
    ensure_column("messages", "device_id", "TEXT")
    ensure_column("messages", "edited_at", "TEXT")


def ensure_column(table: str, column: str, definition: str) -> None:
    with db_lock:
        if IS_POSTGRES:
            existing_rows = conn.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = %s
                """,
                (table,),
            ).fetchall()
            existing = {row["column_name"] for row in existing_rows}
        else:
            existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            if not IS_POSTGRES:
                conn.commit()


def touch_user(name: str) -> None:
    timestamp = to_iso(utc_now())
    with db_lock:
        conn.execute(
            """
            INSERT INTO users (name, created_at, last_seen)
            VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET last_seen=excluded.last_seen
            """,
            (name, timestamp, timestamp),
        )
        conn.commit()


def register_identity(name: str, device_id: str, public_key: str) -> dict:
    clean_device_id = (device_id or "").strip()[:128]
    clean_public_key = (public_key or "").strip()
    if not clean_device_id:
        raise HTTPException(status_code=422, detail="Device id is required.")
    if not clean_public_key or len(clean_public_key) > MAX_SIGNATURE_LENGTH:
        raise HTTPException(status_code=422, detail="Public key payload is invalid.")

    touch_user(name)
    with db_lock:
        conn.execute(
            """
            UPDATE users
            SET device_id = ?, public_key = ?
            WHERE name = ?
            """,
            (clean_device_id, clean_public_key, name),
        )
        conn.commit()
    return {
        "name": name,
        "device_id": clean_device_id,
        "public_key": clean_public_key,
        "status_text": fetch_one("SELECT status_text FROM users WHERE name = ?", (name,))["status_text"] or "",
        "status_emoji": fetch_one("SELECT status_emoji FROM users WHERE name = ?", (name,))["status_emoji"] or "",
    }


def update_profile(name: str, status_text: str, status_emoji: str) -> dict:
    touch_user(name)
    clean_status_text = re.sub(r"\s+", " ", (status_text or "").strip())[:120]
    clean_status_emoji = (status_emoji or "").strip()[:8]
    with db_lock:
        conn.execute(
            """
            UPDATE users
            SET status_text = ?, status_emoji = ?
            WHERE name = ?
            """,
            (clean_status_text, clean_status_emoji, name),
        )
        conn.commit()

    row = fetch_one(
        "SELECT name, device_id, public_key, status_text, status_emoji FROM users WHERE name = ?",
        (name,),
    )
    return {
        "name": row["name"],
        "device_id": row["device_id"] or "",
        "public_key": row["public_key"] or "",
        "status_text": row["status_text"] or "",
        "status_emoji": row["status_emoji"] or "",
    }


def serialize_room(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "accent": row["accent"],
        "created_at": row["created_at"],
    }


def ensure_room(room_id: str) -> dict:
    room = fetch_one("SELECT * FROM rooms WHERE id = ?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="Room not found.")
    return serialize_room(room)


def serialize_reactions(message_id: str) -> list[dict]:
    rows = fetch_all(
        "SELECT emoji, sender FROM reactions WHERE message_id = ? ORDER BY emoji, sender",
        (message_id,),
    )
    grouped: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        grouped[row["emoji"]].append(row["sender"])
    return [
        {"emoji": emoji, "count": len(users), "users": users}
        for emoji, users in grouped.items()
    ]


def serialize_message(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "room_id": row["room_id"],
        "sender": row["sender"],
        "ciphertext": row["ciphertext"],
        "iv": row["iv"],
        "signature": row["signature"] or "",
        "device_id": row["device_id"] or "",
        "reply_to": row["reply_to"],
        "ttl_seconds": row["ttl_seconds"],
        "created_at": row["created_at"],
        "edited_at": row["edited_at"],
        "expires_at": row["expires_at"],
        "reactions": serialize_reactions(row["id"]),
    }


def list_rooms() -> list[dict]:
    rows = fetch_all("SELECT * FROM rooms ORDER BY created_at ASC, title ASC")
    return [serialize_room(row) for row in rows]


def list_messages(limit: int = 300) -> list[dict]:
    rows = fetch_all(
        """
        SELECT *
        FROM messages
        WHERE expires_at IS NULL OR expires_at > ?
        ORDER BY created_at ASC
        LIMIT ?
        """,
        (to_iso(utc_now()), limit),
    )
    return [serialize_message(row) for row in rows]


def list_identities() -> dict[str, dict]:
    rows = fetch_all(
        """
        SELECT name, device_id, public_key, status_text, status_emoji
        FROM users
        WHERE device_id IS NOT NULL AND public_key IS NOT NULL
        ORDER BY LOWER(name) ASC
        """
    )
    return {
        row["name"]: {
            "name": row["name"],
            "device_id": row["device_id"],
            "public_key": row["public_key"],
            "status_text": row["status_text"] or "",
            "status_emoji": row["status_emoji"] or "",
        }
        for row in rows
    }


def get_pin(room_id: str) -> dict | None:
    row = fetch_one(
        """
        SELECT p.room_id, p.message_id, p.pinned_by, p.pinned_at
        FROM pins p
        JOIN messages m ON m.id = p.message_id
        WHERE p.room_id = ?
          AND (m.expires_at IS NULL OR m.expires_at > ?)
        """,
        (room_id, to_iso(utc_now())),
    )
    if not row:
        return None
    return {
        "room_id": row["room_id"],
        "message_id": row["message_id"],
        "pinned_by": row["pinned_by"],
        "pinned_at": row["pinned_at"],
    }


def list_pins() -> dict[str, dict]:
    pins: dict[str, dict] = {}
    for room in list_rooms():
        pin = get_pin(room["id"])
        if pin:
            pins[room["id"]] = pin
    return pins


def create_room(title: str, description: str) -> dict:
    clean_title = re.sub(r"\s+", " ", (title or "").strip())
    clean_description = re.sub(r"\s+", " ", (description or "").strip())
    if not clean_title or len(clean_title) > 42:
        raise HTTPException(status_code=422, detail="Room title must be between 1 and 42 characters.")
    if len(clean_description) > 160:
        raise HTTPException(status_code=422, detail="Room description is too long.")

    room_id = slugify_room(clean_title)
    while fetch_one("SELECT 1 FROM rooms WHERE id = ?", (room_id,)):
        room_id = f"{room_id[:24]}-{uuid.uuid4().hex[:4]}"

    room = {
        "id": room_id,
        "title": clean_title,
        "description": clean_description or "Local-key room. Share the passphrase out of band.",
        "accent": DEFAULT_ROOMS[len(list_rooms()) % len(DEFAULT_ROOMS)]["accent"],
        "created_at": to_iso(utc_now()),
    }
    execute(
        """
        INSERT INTO rooms (id, title, description, accent, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (room["id"], room["title"], room["description"], room["accent"], room["created_at"]),
    )
    return room


def create_message(user: str, payload: dict) -> dict:
    room = ensure_room(payload.get("room_id", ""))
    ciphertext = (payload.get("ciphertext") or "").strip()
    iv = (payload.get("iv") or "").strip()
    signature = (payload.get("signature") or "").strip()
    device_id = (payload.get("device_id") or "").strip()
    reply_to = payload.get("reply_to") or None
    ttl_seconds = int(payload.get("ttl_seconds") or DEFAULT_TTL_SECONDS)

    if not ciphertext or len(ciphertext) > MAX_CIPHERTEXT_LENGTH:
        raise HTTPException(status_code=422, detail="Invalid ciphertext payload size.")
    if not iv or len(iv) > MAX_IV_LENGTH:
        raise HTTPException(status_code=422, detail="Invalid IV payload size.")
    if not signature or len(signature) > MAX_SIGNATURE_LENGTH:
        raise HTTPException(status_code=422, detail="Signature is required.")
    if not device_id:
        raise HTTPException(status_code=422, detail="Device id is required.")
    if ttl_seconds < 0 or ttl_seconds > MAX_TTL_SECONDS:
        raise HTTPException(status_code=422, detail="TTL is outside the allowed range.")
    if reply_to:
        reply_row = fetch_one("SELECT room_id FROM messages WHERE id = ?", (reply_to,))
        if not reply_row or reply_row["room_id"] != room["id"]:
            raise HTTPException(status_code=404, detail="Reply target not found in this room.")

    identity = fetch_one("SELECT device_id FROM users WHERE name = ?", (user,))
    if not identity or not identity["device_id"]:
        raise HTTPException(status_code=403, detail="Announce device identity before sending messages.")
    if identity["device_id"] != device_id:
        raise HTTPException(status_code=403, detail="Device identity mismatch for this user.")

    created_at = utc_now()
    expires_at = None
    if ttl_seconds:
        expires_at = to_iso(created_at + timedelta(seconds=ttl_seconds))

    message = {
        "id": uuid.uuid4().hex,
        "room_id": room["id"],
        "sender": user,
        "ciphertext": ciphertext,
        "iv": iv,
        "signature": signature,
        "device_id": device_id,
        "reply_to": reply_to,
        "ttl_seconds": ttl_seconds,
        "created_at": to_iso(created_at),
        "edited_at": None,
        "expires_at": expires_at,
        "reactions": [],
    }
    execute(
        """
        INSERT INTO messages (id, room_id, sender, ciphertext, iv, signature, device_id, reply_to, ttl_seconds, created_at, edited_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            message["id"],
            message["room_id"],
            message["sender"],
            message["ciphertext"],
            message["iv"],
            message["signature"],
            message["device_id"],
            message["reply_to"],
            message["ttl_seconds"],
            message["created_at"],
            message["edited_at"],
            message["expires_at"],
        ),
    )
    return message


def delete_message(message_id: str, actor: str) -> dict:
    row = fetch_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Message not found.")
    if row["sender"] != actor:
        raise HTTPException(status_code=403, detail="Only the sender can burn this message.")

    payload = {"id": row["id"], "room_id": row["room_id"]}
    execute("DELETE FROM messages WHERE id = ?", (message_id,))
    return payload


def set_pin(room_id: str, message_id: str, actor: str) -> dict | None:
    ensure_room(room_id)
    row = fetch_one("SELECT room_id FROM messages WHERE id = ?", (message_id,))
    if not row or row["room_id"] != room_id:
        raise HTTPException(status_code=404, detail="Message not found in this room.")

    current = get_pin(room_id)
    if current and current["message_id"] == message_id:
        execute("DELETE FROM pins WHERE room_id = ?", (room_id,))
        return None

    pin = {
        "room_id": room_id,
        "message_id": message_id,
        "pinned_by": actor,
        "pinned_at": to_iso(utc_now()),
    }
    execute(
        """
        INSERT INTO pins (room_id, message_id, pinned_by, pinned_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
            message_id=excluded.message_id,
            pinned_by=excluded.pinned_by,
            pinned_at=excluded.pinned_at
        """,
        (pin["room_id"], pin["message_id"], pin["pinned_by"], pin["pinned_at"]),
    )
    return pin


def toggle_reaction(user: str, room_id: str, message_id: str, emoji: str) -> dict:
    clean_emoji = (emoji or "").strip()[:8]
    if not clean_emoji:
        raise HTTPException(status_code=422, detail="Reaction emoji is required.")

    row = fetch_one("SELECT room_id FROM messages WHERE id = ?", (message_id,))
    if not row or row["room_id"] != room_id:
        raise HTTPException(status_code=404, detail="Message not found in this room.")

    existing = fetch_one(
        "SELECT 1 FROM reactions WHERE message_id = ? AND sender = ? AND emoji = ?",
        (message_id, user, clean_emoji),
    )
    if existing:
        execute(
            "DELETE FROM reactions WHERE message_id = ? AND sender = ? AND emoji = ?",
            (message_id, user, clean_emoji),
        )
    else:
        execute(
            """
            INSERT INTO reactions (message_id, room_id, sender, emoji, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (message_id, room_id, user, clean_emoji, to_iso(utc_now())),
        )
    return {
        "room_id": room_id,
        "message_id": message_id,
        "reactions": serialize_reactions(message_id),
    }


def purge_expired_messages() -> list[dict]:
    rows = fetch_all(
        """
        SELECT id, room_id
        FROM messages
        WHERE expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC
        """,
        (to_iso(utc_now()),),
    )
    if not rows:
        return []

    payloads = [{"id": row["id"], "room_id": row["room_id"]} for row in rows]
    execute_many("DELETE FROM messages WHERE id = ?", [(row["id"],) for row in rows])
    return payloads


def purge_expired_launch_tokens() -> None:
    now = time.time()
    expired = [token for token, payload in launch_tokens.items() if payload.get("expires_at", 0) <= now]
    for token in expired:
        launch_tokens.pop(token, None)


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self.socket_to_user: dict[WebSocket, str] = {}
        self.user_sockets: defaultdict[str, set[WebSocket]] = defaultdict(set)
        self.rate_limits: defaultdict[str, deque[float]] = defaultdict(deque)

    def online_users(self) -> list[str]:
        return sorted(self.user_sockets.keys(), key=str.casefold)

    async def send(self, ws: WebSocket, payload: dict) -> None:
        await ws.send_text(json.dumps(payload))

    async def connect(self, ws: WebSocket, user: str) -> None:
        await ws.accept()
        touch_user(user)
        self.connections.add(ws)
        self.socket_to_user[ws] = user
        self.user_sockets[user].add(ws)
        await self.broadcast_presence()

    async def disconnect(self, ws: WebSocket) -> None:
        user = self.socket_to_user.pop(ws, None)
        self.connections.discard(ws)
        if not user:
            return

        sockets = self.user_sockets.get(user)
        if sockets:
            sockets.discard(ws)
            if not sockets:
                self.user_sockets.pop(user, None)
                touch_user(user)
        await self.broadcast_presence()

    def allow_message(self, user: str) -> bool:
        now = time.monotonic()
        window = self.rate_limits[user]
        while window and now - window[0] > RATE_LIMIT_WINDOW_SECONDS:
            window.popleft()
        if len(window) >= RATE_LIMIT_BURST:
            return False
        window.append(now)
        return True

    async def broadcast(self, payload: dict) -> None:
        dead: list[WebSocket] = []
        for ws in list(self.connections):
            try:
                await self.send(ws, payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(ws)

    async def broadcast_presence(self) -> None:
        await self.broadcast({"type": "PRESENCE", "online": self.online_users()})


app = FastAPI(title="Senpixel")
manager = ConnectionManager()
cleanup_task: asyncio.Task | None = None
launch_tokens: dict[str, dict] = {}
init_db()
allowed_origins = [origin.strip() for origin in FRONTEND_ORIGIN.split(",") if origin.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=allowed_origins != ["*"],
)


async def expiration_loop() -> None:
    while True:
        await asyncio.sleep(2)
        expired = purge_expired_messages()
        if not expired:
            continue

        affected_rooms = {item["room_id"] for item in expired}
        for item in expired:
            await manager.broadcast(
                {"type": "MESSAGE_DELETED", "message_id": item["id"], "room_id": item["room_id"]}
            )
        for room_id in affected_rooms:
            await manager.broadcast({"type": "PIN_UPDATED", "room_id": room_id, "pin": get_pin(room_id)})


@app.on_event("startup")
async def on_startup() -> None:
    global cleanup_task
    cleanup_task = asyncio.create_task(expiration_loop())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    if cleanup_task:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(APP_ROOT / "index.html")


@app.get("/messenger")
async def messenger() -> FileResponse:
    return FileResponse(APP_ROOT / "index.html")


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "database": "postgres" if IS_POSTGRES else "sqlite",
            "hosted": APP_HOST != "127.0.0.1",
        }
    )


@app.post("/api/launch")
async def create_launch(request: Request) -> JSONResponse:
    purge_expired_launch_tokens()
    payload = await request.json()
    nickname = payload.get("nickname") or ""
    room_id = (payload.get("room_id") or "").strip()
    room_secret = payload.get("room_secret") or ""
    remember_secret = bool(payload.get("remember_secret"))
    auto_start = bool(payload.get("auto_start", True))

    normalized = ""
    if nickname:
        try:
            normalized = normalize_user(nickname)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    token = uuid.uuid4().hex
    launch_tokens[token] = {
        "nickname": normalized,
        "room_id": room_id,
        "room_secret": room_secret,
        "remember_secret": remember_secret,
        "auto_start": auto_start,
        "expires_at": time.time() + LAUNCH_TOKEN_TTL_SECONDS,
    }
    return JSONResponse({"token": token})


@app.get("/api/launch/{token}")
async def consume_launch(token: str) -> JSONResponse:
    purge_expired_launch_tokens()
    payload = launch_tokens.pop(token, None)
    if not payload:
        raise HTTPException(status_code=404, detail="Launch token expired or not found.")
    payload.pop("expires_at", None)
    return JSONResponse(payload)


@app.get("/api/bootstrap/{user}")
async def bootstrap(user: str) -> JSONResponse:
    try:
        normalized = normalize_user(user)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    touch_user(normalized)
    return JSONResponse(
        {
            "brand": {
                "name": "Senpixel",
                "protocol": "The Silence Protocol",
                "architecture": "Citadel v2.0",
            },
            "backend": {
                "database": "postgres" if IS_POSTGRES else "sqlite",
                "deployment": "fly" if os.getenv("FLY_APP_NAME") else "local",
            },
            "user": normalized,
            "rooms": list_rooms(),
            "messages": list_messages(),
            "pins": list_pins(),
            "identities": list_identities(),
            "online": manager.online_users(),
            "limits": {
                "max_ttl_seconds": MAX_TTL_SECONDS,
                "default_ttl_seconds": DEFAULT_TTL_SECONDS,
                "max_ciphertext_length": MAX_CIPHERTEXT_LENGTH,
            },
        }
    )


@app.websocket("/ws/{user}")
async def ws_endpoint(ws: WebSocket, user: str) -> None:
    try:
        normalized = normalize_user(user)
    except ValueError:
        await ws.close(code=1008)
        return

    await manager.connect(ws, normalized)
    try:
        await manager.send(
            ws,
            {
                "type": "BOOTSTRAP_HINT",
                "message": "Use /api/bootstrap/{user} for the initial encrypted room snapshot.",
            },
        )
        while True:
            try:
                data = json.loads(await ws.receive_text())
            except json.JSONDecodeError:
                await manager.send(ws, {"type": "ERROR", "message": "Malformed JSON payload."})
                continue

            event_type = data.get("type")

            try:
                if event_type == "PING":
                    await manager.send(ws, {"type": "PONG", "ts": to_iso(utc_now())})
                    continue

                if event_type == "ANNOUNCE_IDENTITY":
                    identity = register_identity(
                        normalized,
                        data.get("device_id", ""),
                        data.get("public_key", ""),
                    )
                    await manager.broadcast({"type": "IDENTITY_UPDATED", "identity": identity})
                    continue

                if event_type == "CREATE_ROOM":
                    room = create_room(data.get("title", ""), data.get("description", ""))
                    await manager.broadcast({"type": "ROOM_CREATED", "room": room})
                    continue

                if event_type == "TYPING":
                    room_id = (data.get("room_id") or "").strip()
                    if not room_id:
                        raise HTTPException(status_code=422, detail="Room id is required for typing events.")
                    ensure_room(room_id)
                    await manager.broadcast(
                        {
                            "type": "TYPING_STATUS",
                            "room_id": room_id,
                            "user": normalized,
                            "active": bool(data.get("active")),
                        }
                    )
                    continue

                if event_type == "SEND_MESSAGE":
                    if not manager.allow_message(normalized):
                        await manager.send(
                            ws,
                            {
                                "type": "ERROR",
                                "message": "Rate limit exceeded. Slow down before sending more traffic.",
                            },
                        )
                        continue
                    message = create_message(normalized, data)
                    await manager.broadcast({"type": "MESSAGE_CREATED", "message": message})
                    continue

                if event_type == "REACT":
                    reaction = toggle_reaction(
                        normalized,
                        data.get("room_id", ""),
                        data.get("message_id", ""),
                        data.get("emoji", ""),
                    )
                    await manager.broadcast({"type": "REACTION_UPDATED", **reaction})
                    continue

                if event_type == "PIN_MESSAGE":
                    pin = set_pin(data.get("room_id", ""), data.get("message_id", ""), normalized)
                    await manager.broadcast({"type": "PIN_UPDATED", "room_id": data.get("room_id", ""), "pin": pin})
                    continue

                if event_type == "BURN_MESSAGE":
                    deleted = delete_message(data.get("message_id", ""), normalized)
                    await manager.broadcast(
                        {"type": "MESSAGE_DELETED", "message_id": deleted["id"], "room_id": deleted["room_id"]}
                    )
                    await manager.broadcast(
                        {"type": "PIN_UPDATED", "room_id": deleted["room_id"], "pin": get_pin(deleted["room_id"])}
                    )
                    continue

                await manager.send(ws, {"type": "ERROR", "message": f"Unsupported event: {event_type}"})
            except HTTPException as exc:
                await manager.send(ws, {"type": "ERROR", "message": str(exc.detail)})
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(ws)


if __name__ == "__main__":
    uvicorn.run(app, host=APP_HOST, port=APP_PORT)
