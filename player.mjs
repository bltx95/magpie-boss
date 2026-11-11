import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { localDay, readUsagePage, toUsage } from "./usage.mjs";

export function createPlayer({ directory, roomServer, nickname, magpieUrl, fetcher = fetch, localLobby = false }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new Database(join(directory, "player.sqlite"), { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS identity (
      id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, enabled_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, tokens INTEGER NOT NULL,
      attack INTEGER NOT NULL CHECK (attack BETWEEN 0 AND 2)
    );
    CREATE INDEX IF NOT EXISTS usage_by_day ON usage(day, attack);
    CREATE TABLE IF NOT EXISTS codex_responses (id TEXT PRIMARY KEY);
  `);
  db.query("INSERT OR IGNORE INTO identity VALUES (1, ?, ?)").run(randomBytes(32).toString("hex"), Date.now());
  const { token, enabled_at: enabledAt } = db.query("SELECT token, enabled_at FROM identity").get();

  const addUsage = db.transaction((rows) => {
    const existing = db.query("SELECT 1 FROM usage WHERE id = ?");
    const insert = db.query("INSERT INTO usage VALUES (?, ?, ?, ?)");
    const claimResponse = db.query("INSERT OR IGNORE INTO codex_responses VALUES (?)");
    for (const row of rows) {
      if (!row) continue;
      if (row.responseKey && !claimResponse.run(row.responseKey).changes) continue;
      if (existing.get(row.id)) continue;
      insert.run(row.id, row.day, row.tokens, Number(row.success));
    }
  });

  let lastDay;
  let roomState;
  let usageOnline = false;
  let roomOnline = false;
  let inProgress = Promise.resolve();

  async function roomRequest(path, body) {
    const options = {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    };
    if (body !== undefined) {
      options.method = "POST";
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetcher(new URL(path, roomServer), options);
    return { response, body: await response.json() };
  }

  async function requireRoom(path, body) {
    const result = await roomRequest(path, body);
    if (!result.response.ok) {
      const error = new Error(result.body.error || "房间服务请求失败");
      error.status = result.response.status;
      throw error;
    }
    return result.body;
  }

  async function collect() {
    const today = localDay(Date.now());
    const period = lastDay === today ? "today" : "7d";
    let offset = 0;
    const logRows = [];
    while (true) {
      const page = await readUsagePage(magpieUrl, period, offset, fetcher);
      const gatewayRows = [];
      for (const source of page.rows) {
        const row = toUsage(source, enabledAt);
        if (!row) continue;
        (source.source === "log" ? logRows : gatewayRows).push(row);
      }
      addUsage.immediate(gatewayRows);
      if (!page.hasMore) break;
      offset += page.rows.length;
    }
    addUsage.immediate(logRows);
    lastDay = today;
  }

  async function syncRoom() {
    const result = await roomRequest("/api/state");
    if (result.response.ok) {
      roomState = result.body;
    } else if (result.response.status === 404) {
      roomState = await requireRoom("/api/player", { nickname });
    } else {
      throw new Error("房间服务暂不可用");
    }
    while (true) {
      const events = db.query("SELECT id, day FROM usage WHERE attack = 1 ORDER BY day, rowid LIMIT 100").all();
      if (!events.length) break;
      roomState = await requireRoom("/api/attacks", { events });
      db.transaction(() => {
        const mark = db.query("UPDATE usage SET attack = 2 WHERE id = ?");
        for (const event of events) mark.run(event.id);
      }).immediate();
    }
  }

  function serial(run) {
    const next = inProgress.then(run);
    inProgress = next.catch(() => {});
    return next;
  }

  function moveTo(path, body) {
    return serial(async () => {
      // Attribute requests already recorded by Magpie to the old room before moving.
      try {
        await collect();
        usageOnline = true;
      } catch {
        usageOnline = false;
      }
      await syncRoom();
      roomState = await requireRoom(path, body);
      roomOnline = true;
      return roomState;
    });
  }

  return {
    snapshot() {
      const usage = db.query(`
        SELECT COUNT(*) AS calls, COALESCE(SUM(tokens), 0) AS tokens,
          COUNT(CASE WHEN attack > 0 THEN 1 END) AS attacks
        FROM usage WHERE day = ?
      `).get(localDay(Date.now()));
      const pending = db.query("SELECT COUNT(*) AS count FROM usage WHERE attack = 1").get().count;
      const code = roomState?.room.code;
      const inviteUrl = code && !localLobby ? new URL(`/invite/${code}`, roomServer).href : null;
      return { ...roomState, usage, usageOnline, roomOnline, inviteUrl, pending, localLobby };
    },
    tick() {
      return serial(async () => {
        try {
          await collect();
          usageOnline = true;
        } catch {
          usageOnline = false;
        }
        try {
          await syncRoom();
          roomOnline = true;
        } catch {
          roomOnline = false;
        }
      });
    },
    preview(code) {
      return requireRoom("/api/invite", { code });
    },
    changeRoom(code) {
      return code ? moveTo("/api/join", { code }) : moveTo("/api/home", {});
    },
    chooseRoom(roomId) {
      return moveTo("/api/rooms/join", { roomId });
    },
    createRoom(name, visibility) {
      return moveTo("/api/rooms", { name, visibility });
    },
    rename(nickname) {
      return serial(async () => {
        roomState = await requireRoom("/api/profile", { nickname });
        return roomState;
      });
    },
    close: () => db.close(),
  };
}
