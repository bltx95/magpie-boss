import { Database } from "bun:sqlite";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { advertiseLobby } from "./lobby-network.mjs";
import { bossForLevel, COMBO_TARGET, DAMAGE_VARIATIONS, MIN_DAMAGE, resolveAttack } from "./boss.mjs";

const CODE = /^\d{8}$/;
const PLAYER_TOKEN = /^[a-f0-9]{64}$/;
const EVENT_ID = /^[a-f0-9]{64}$/;
const FIRST_BOSS_HP = 60;
const HP_PER_LEVEL = 20;
const HISTORY_LIMIT = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PUBLIC_ROOM = "lobby";

const bossMaxHp = (defeated) => FIRST_BOSS_HP + defeated * HP_PER_LEVEL;

function invitePage(room, code) {
  const escape = (value) => value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Boss 房间邀请</title>
    <style>
      body{margin:0;background:#151321;color:#f7f4ff;font:1.05rem/1.6 Inter,system-ui,sans-serif}
      main{max-width:34rem;margin:12vh auto;padding:2rem}
      a{color:#f5ce78} strong{letter-spacing:.15em}
    </style>
    <main><h1>${escape(room.name)}</h1>
    <p>房主 ${escape(room.owner)} 邀请你一起打 Boss。</p>
    <p>邀请码 <strong>${code}</strong></p>
    <p><a href="http://127.0.0.1:3468/?invite=${code}">在这台电脑上加入</a></p>
    <p>请先在本机启用 Magpie Boss。你也可以在自己的 Boss 房间输入邀请码。</p>
    </main></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
    },
  });
}

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});

export function createRoomService(path, { roll = (max) => randomInt(max) } = {}) {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      hp INTEGER NOT NULL DEFAULT ${FIRST_BOSS_HP}, defeated INTEGER NOT NULL DEFAULT 0,
      boss_turn INTEGER NOT NULL DEFAULT 0, combo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY REFERENCES rooms(id), name TEXT NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id), xp INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS players_by_room ON players(room_id);
    CREATE TABLE IF NOT EXISTS attacks (
      player_id TEXT NOT NULL REFERENCES players(id), event_id TEXT NOT NULL,
      day TEXT NOT NULL, PRIMARY KEY (player_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS attack_results (
      id INTEGER PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
      player_id TEXT NOT NULL REFERENCES players(id), outcome TEXT NOT NULL,
      damage INTEGER NOT NULL, xp INTEGER NOT NULL, hp INTEGER NOT NULL,
      settled_at TEXT NOT NULL, boss_level INTEGER, skill_name TEXT, skill_detail TEXT,
      attack_kind TEXT, base_damage INTEGER, combo_bonus INTEGER
    );
    CREATE INDEX IF NOT EXISTS attack_results_by_room ON attack_results(room_id, id DESC);
  `);
  db.transaction(() => {
    const column = db.query("SELECT 1 FROM pragma_table_info(?) WHERE name = ?");
    const addColumn = (table, name, type) => {
      if (!column.get(table, name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    addColumn("rooms", "boss_turn", "INTEGER NOT NULL DEFAULT 0");
    addColumn("rooms", "combo", "INTEGER NOT NULL DEFAULT 0");
    addColumn("rooms", "owner_id", "TEXT");
    addColumn("rooms", "visibility", "TEXT NOT NULL DEFAULT 'private'");
    addColumn("attack_results", "boss_level", "INTEGER");
    addColumn("attack_results", "skill_name", "TEXT");
    addColumn("attack_results", "skill_detail", "TEXT");
    addColumn("attack_results", "attack_kind", "TEXT");
    addColumn("attack_results", "base_damage", "INTEGER");
    addColumn("attack_results", "combo_bonus", "INTEGER");
    db.query("UPDATE rooms SET owner_id = id WHERE owner_id IS NULL AND id IN (SELECT id FROM players)").run();
    db.query("INSERT OR IGNORE INTO rooms (id, code, name, visibility) VALUES (?, ?, ?, 'public')")
      .run(PUBLIC_ROOM, PUBLIC_ROOM, "公共大厅");
  }).immediate();

  const invite = db.query(`
    SELECT rooms.id, rooms.name, players.name AS owner
    FROM rooms JOIN players ON players.id = rooms.owner_id WHERE rooms.code = ?
  `);
  const roomById = db.query("SELECT id, owner_id, visibility FROM rooms WHERE id = ?");
  const player = db.query("SELECT id, name, room_id, xp FROM players WHERE id = ?");
  const state = db.transaction((id) => {
    const self = player.get(id);
    const { boss_turn: turn, owner_id: ownerId, ...room } = db.query(`
      SELECT id, name, code, hp, defeated, boss_turn, combo, owner_id, visibility FROM rooms WHERE id = ?
    `).get(self.room_id);
    const members = db.query("SELECT id, name, xp FROM players WHERE room_id = ? ORDER BY name, id").all(room.id);
    const withLevel = (member) => ({
      id: member.id, name: member.name, xp: member.xp, level: 1 + Math.floor(member.xp / 50),
    });
    const attacks = db.query(`
      SELECT attack_results.id, player_id AS playerId, players.name AS playerName,
        outcome, damage, attack_results.xp, attack_results.hp, settled_at AS settledAt,
        boss_level AS bossLevel, skill_name AS skillName, skill_detail AS skillDetail,
        attack_kind AS kind, base_damage AS baseDamage, combo_bonus AS comboBonus
      FROM attack_results JOIN players ON players.id = attack_results.player_id
      WHERE attack_results.room_id = ? ORDER BY attack_results.id DESC LIMIT ?
    `).all(room.id, HISTORY_LIMIT);
    const maxHp = bossMaxHp(room.defeated);
    const bossLevel = room.defeated + 1;
    const boss = bossForLevel(bossLevel);
    const interval = boss.skill.interval;
    const rooms = db.query(`
      SELECT r.id, r.name, r.visibility, r.defeated + 1 AS bossLevel,
        (SELECT COUNT(*) FROM players p WHERE p.room_id = r.id) AS memberCount
      FROM rooms r WHERE r.visibility = 'public' OR r.owner_id = ? OR r.id = ?
      ORDER BY r.id = 'lobby' DESC, r.id = ? DESC, r.name, r.id
    `).all(id, room.id, room.id);
    return {
      player: withLevel(self),
      room: {
        ...room, code: ownerId ? room.code : null, hp: room.hp || maxHp, maxHp, bossLevel, boss,
        nextSkillIn: interval ? interval - (turn % interval) : null, comboTarget: COMBO_TARGET,
        members: members.map(withLevel), attacks,
      },
      rooms,
    };
  });

  function newCode() {
    const taken = db.query("SELECT 1 FROM rooms WHERE code = ?");
    let code;
    do {
      code = String(randomInt(100_000_000)).padStart(8, "0");
    } while (taken.get(code));
    return code;
  }

  const move = db.query("UPDATE players SET room_id = ? WHERE id = ?");
  const register = db.transaction((id, nickname) => {
    if (!player.get(id)) {
      const name = nickname || `玩家 ${id.slice(0, 4).toUpperCase()}`;
      db.query("INSERT INTO rooms (id, code, name, owner_id) VALUES (?, ?, ?, ?)").run(id, newCode(), `${name}的房间`, id);
      db.query("INSERT INTO players (id, name, room_id) VALUES (?, ?, ?)").run(id, name, PUBLIC_ROOM);
    }
    return state(id);
  });

  const createRoom = db.transaction((id, name, visibility) => {
    const roomId = randomUUID();
    db.query("INSERT INTO rooms (id, code, name, owner_id, visibility) VALUES (?, ?, ?, ?, ?)")
      .run(roomId, newCode(), name, id, visibility);
    move.run(roomId, id);
    return state(id);
  });

  const rename = db.transaction((id, name) => {
    const current = player.get(id);
    db.query("UPDATE players SET name = ? WHERE id = ?").run(name, id);
    db.query("UPDATE rooms SET name = ? WHERE id = ? AND name = ?")
      .run(`${name}的房间`, id, `${current.name}的房间`);
    return state(id);
  });

  const applyAttacks = db.transaction((id, events) => {
    const { room_id: roomId } = player.get(id);
    const reserve = db.query("INSERT OR IGNORE INTO attacks VALUES (?, ?, ?)");
    const room = db.query("SELECT hp, defeated, boss_turn, combo FROM rooms WHERE id = ?").get(roomId);
    const updateRoom = db.query("UPDATE rooms SET hp = ?, defeated = ?, boss_turn = ?, combo = ? WHERE id = ?");
    const updatePlayer = db.query("UPDATE players SET xp = xp + ? WHERE id = ?");
    const record = db.query(`
      INSERT INTO attack_results (room_id, player_id, outcome, damage, xp, hp, settled_at, boss_level,
        skill_name, skill_detail, attack_kind, base_damage, combo_bonus)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let defeated = room.defeated;
    let maxHp = bossMaxHp(defeated);
    let hp = room.hp || maxHp;
    let boss = bossForLevel(defeated + 1);
    let turn = room.boss_turn;
    let combo = room.combo;
    for (const event of events) {
      if (!reserve.run(id, event.id, event.day).changes) continue;
      turn += 1;
      const attack = resolveAttack(boss, turn, roll(100), hp, maxHp, {
        baseDamage: MIN_DAMAGE + roll(DAMAGE_VARIATIONS), finisherRoll: roll(1000), combo,
      });
      hp = attack.hp;
      combo = attack.combo;
      record.run(roomId, id, attack.outcome, attack.damage, attack.xp, hp, new Date().toISOString(),
        defeated + 1, attack.skillName, attack.skillDetail, attack.kind, attack.baseDamage, attack.comboBonus);
      updatePlayer.run(attack.xp, id);
      if (hp === 0) {
        defeated += 1;
        maxHp = bossMaxHp(defeated);
        hp = maxHp;
        boss = bossForLevel(defeated + 1);
        turn = 0;
        combo = 0;
      }
    }
    if (turn !== room.boss_turn || hp !== room.hp || defeated !== room.defeated || combo !== room.combo) {
      updateRoom.run(hp, defeated, turn, combo, roomId);
    }
    return state(id);
  });

  async function fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return json({ service: "magpie-boss" });
    const code = pathname.match(/^\/invite\/(\d{8})$/)?.[1];
    if (request.method === "GET" && code) {
      const room = invite.get(code);
      return room ? invitePage(room, code) : json({ error: "找不到这个房间" }, 404);
    }

    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!token || !PLAYER_TOKEN.test(token)) return json({ error: "玩家身份无效" }, 401);
    const id = createHash("sha256").update(token).digest("hex").slice(0, 24);
    const playerExists = player.get(id);
    if (request.method === "GET" && pathname === "/api/state") {
      return playerExists ? json(state(id)) : json({ error: "玩家尚未注册" }, 404);
    }
    if (request.method !== "POST") return json({ error: "未知接口" }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "请求格式无效" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "请求格式无效" }, 400);

    if (pathname === "/api/player") {
      const nickname = typeof body.nickname === "string" ? body.nickname.trim().slice(0, 24) : "";
      return json(register.immediate(id, nickname));
    }
    if (!playerExists) return json({ error: "玩家尚未注册" }, 404);
    if (pathname === "/api/rooms") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 40 || !["private", "public"].includes(body.visibility)) {
        return json({ error: "请输入 1 到 40 字的房间名，并选择房间类型" }, 400);
      }
      return json(createRoom.immediate(id, name, body.visibility), 201);
    }
    if (pathname === "/api/rooms/join") {
      const room = typeof body.roomId === "string" && roomById.get(body.roomId);
      if (!room || (room.visibility !== "public" && room.owner_id !== id && room.id !== player.get(id).room_id)) {
        return json({ error: "请使用邀请码加入私人房间" }, 404);
      }
      move.run(room.id, id);
      return json(state(id));
    }
    if (pathname === "/api/profile") {
      const name = typeof body.nickname === "string" ? body.nickname.trim() : "";
      if (!name || name.length > 24) return json({ error: "请输入 1 到 24 字的昵称" }, 400);
      return json(rename.immediate(id, name));
    }
    if (pathname === "/api/attacks") {
      const events = body.events;
      if (!Array.isArray(events) || events.length > 100 ||
        events.some((event) => typeof event?.id !== "string" || !EVENT_ID.test(event.id) ||
          typeof event.day !== "string" || !DATE.test(event.day))) {
        return json({ error: "攻击记录格式无效" }, 400);
      }
      return json(applyAttacks.immediate(id, events));
    }
    if (pathname === "/api/join" || pathname === "/api/invite") {
      const room = typeof body.code === "string" && CODE.test(body.code) && invite.get(body.code);
      if (!room) return json({ error: "找不到这个邀请码" }, 404);
      if (pathname === "/api/invite") return json({ name: room.name, owner: room.owner });
      move.run(room.id, id);
      return json(state(id));
    }
    if (pathname === "/api/home") {
      move.run(id, id);
      return json(state(id));
    }
    return json({ error: "未知接口" }, 404);
  }

  return { fetch, close: () => db.close() };
}

if (import.meta.main) {
  const service = createRoomService(process.env.BOSS_DB || "boss-room.sqlite");
  const hostname = process.env.BOSS_HOST || "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: Number(process.env.BOSS_PORT || 8787),
    maxRequestBodySize: 32 * 1024,
    fetch: service.fetch,
  });
  const advertisement = hostname === "0.0.0.0" && advertiseLobby(server.port);
  if (advertisement) {
    process.on("exit", () => advertisement.kill());
    process.on("SIGTERM", () => process.exit(0));
    process.on("SIGINT", () => process.exit(0));
  }
  console.log(`Magpie Boss 房间服务已启动 · ${server.url}`);
}
