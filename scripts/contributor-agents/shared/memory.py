"""SQLite-based agent memory — tracks contributions, research, and discussions."""

import sqlite3
import json
import logging
from pathlib import Path
from datetime import datetime, timezone

log = logging.getLogger(__name__)


class AgentMemory:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self._init_tables()

    def _init_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS contributions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic_id TEXT NOT NULL,
                topic_title TEXT,
                chunk_id TEXT,
                action TEXT NOT NULL,
                content_preview TEXT,
                sources TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS discussions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic_id TEXT NOT NULL,
                topic_title TEXT,
                message_preview TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS research (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query TEXT NOT NULL,
                results TEXT NOT NULL,
                used_for TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        """)
        self.conn.commit()

    def log_contribution(self, topic_id: str, topic_title: str, action: str,
                         chunk_id: str = None, content_preview: str = None,
                         sources: list = None):
        self.conn.execute(
            "INSERT INTO contributions (topic_id, topic_title, chunk_id, action, content_preview, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (topic_id, topic_title, chunk_id, action, content_preview,
             json.dumps(sources) if sources else None,
             datetime.now(timezone.utc).isoformat()),
        )
        self.conn.commit()

    def log_discussion(self, topic_id: str, topic_title: str, message_preview: str):
        self.conn.execute(
            "INSERT INTO discussions (topic_id, topic_title, message_preview, created_at) VALUES (?, ?, ?, ?)",
            (topic_id, topic_title, message_preview[:200],
             datetime.now(timezone.utc).isoformat()),
        )
        self.conn.commit()

    def log_research(self, query: str, results: list, used_for: str = None):
        self.conn.execute(
            "INSERT INTO research (query, results, used_for, created_at) VALUES (?, ?, ?, ?)",
            (query, json.dumps(results), used_for,
             datetime.now(timezone.utc).isoformat()),
        )
        self.conn.commit()

    def get_recent_contributions(self, limit: int = 20) -> list:
        rows = self.conn.execute(
            "SELECT * FROM contributions ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_recent_discussions(self, topic_id: str = None, limit: int = 10) -> list:
        if topic_id:
            rows = self.conn.execute(
                "SELECT * FROM discussions WHERE topic_id = ? ORDER BY created_at DESC LIMIT ?",
                (topic_id, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM discussions ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def has_discussed_topic(self, topic_id: str) -> bool:
        row = self.conn.execute(
            "SELECT COUNT(*) FROM discussions WHERE topic_id = ?", (topic_id,)
        ).fetchone()
        return row[0] > 0

    def has_contributed_to_topic(self, topic_id: str) -> bool:
        row = self.conn.execute(
            "SELECT COUNT(*) FROM contributions WHERE topic_id = ?", (topic_id,)
        ).fetchone()
        return row[0] > 0

    def get_state(self, key: str, default: str = None) -> str | None:
        row = self.conn.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    def set_state(self, key: str, value: str):
        self.conn.execute(
            "INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, ?)",
            (key, value, datetime.now(timezone.utc).isoformat()),
        )
        self.conn.commit()

    def contribution_count_today(self) -> int:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        row = self.conn.execute(
            "SELECT COUNT(*) FROM contributions WHERE created_at LIKE ?", (f"{today}%",)
        ).fetchone()
        return row[0]

    def discussion_count_today(self) -> int:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        row = self.conn.execute(
            "SELECT COUNT(*) FROM discussions WHERE created_at LIKE ?", (f"{today}%",)
        ).fetchone()
        return row[0]

    def close(self):
        self.conn.close()
