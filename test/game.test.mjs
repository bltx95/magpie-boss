import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createRoomService } from "../room-server.mjs";
import { bossForLevel, DAMAGE_VARIATIONS, resolveAttack } from "../boss.mjs";
import { _internal } from "../plugin.mjs";
import { findLobby, LAN_ROOM_SERVER, LOCAL_ROOM_SERVER } from "../lobby-network.mjs";
import { createPlayer } from "../player.mjs";
import { toUsage } from "../usage.mjs";

const token = (number) => String(number).repeat(64);
const { createLocalHandler } = _internal;
const event = (number, day = "2026-11-11") => ({ id: number.toString(16).padStart(64, "0"), day });

function useRoom(roll = () => 99, path = ":memory:") {
  const service = createRoomService(path, {
    roll: (max) => max === 100 ? roll() : max === DAMAGE_VARIATIONS ? 3 : 999,
  });
  const send = (path, player, body) => service.fetch(new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: player ? { Authorization: `Bearer ${token(player)}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { ...service, send };
}

test("gives each early boss a distinct appearance and an actual combat skill", () => {
  const bosses = Array.from({ length: 5 }, (_, index) => bossForLevel(index + 1));
  expect(new Set(bosses.map((boss) => boss.name)).size).toBe(5);
  expect(new Set(bosses.map((boss) => boss.skin)).size).toBe(5);
  expect(new Set(bosses.map((boss) => boss.skill.name)).size).toBe(5);
  expect(resolveAttack(bosses[0], 4, 99, 60, 60)).toMatchObject({
    damage: 7, hp: 53, skillName: "缓存护盾",
  });
  expect(resolveAttack(bosses[1], 5, 10, 80, 80)).toMatchObject({
    damage: 0, hp: 80, xp: 0, skillName: "相位闪避",
  });
  expect(resolveAttack(bosses[2], 4, 99, 100, 100)).toMatchObject({
    damage: 7, hp: 93, xp: 6, skillName: "棘甲反震",
  });
  expect(resolveAttack(bosses[3], 3, 99, 30, 120)).toMatchObject({
    damage: 10, hp: 28, skillName: "回滚再生", skillDetail: "恢复 8 HP",
  });
  expect(resolveAttack(bosses[4], 1, 10, 140, 140)).toMatchObject({
    damage: 9, hp: 131, skillName: "镜面折射",
  });
  expect(resolveAttack(bosses[4], 2, 99, 140, 140)).toMatchObject({ damage: 10, skillName: null });
});

test("later forms change their look and strengthen skills without nullifying all damage", () => {
  const initial = bossForLevel(1);
  const evolved = bossForLevel(6);
  expect(evolved.name).not.toBe(initial.name);
  expect(evolved.hue).not.toBe(initial.hue);
  expect(evolved.evolved).toBe(true);
  expect(evolved.skill.interval).toBeLessThan(initial.skill.interval);
  expect(evolved.skill.power).toBeGreaterThan(initial.skill.power);
  expect(bossForLevel(12).skill.interval).toBe(3);
  expect(resolveAttack(bossForLevel(100_000), 1, 10, 1_000_000, 1_000_000).damage).toBeGreaterThan(0);
});

test("evolved bosses change the timing and payoff of combos, criticals and finishing rolls", () => {
  const cache = bossForLevel(6);
  expect(resolveAttack(cache, 3, 99, 100, 171, { combo: 4 })).toMatchObject({
    combo: 0, comboBonus: 0, damage: 6,
  });
  const lateCache = bossForLevel(16);
  expect([3, 4, 5].map((turn) => resolveAttack(lateCache, turn, 99, 200, 200).damage)).toEqual([4, 4, 10]);
  expect(resolveAttack(bossForLevel(7), 4, 99, 100, 200, { combo: 4 })).toMatchObject({
    outcome: "dodge", hp: 100, combo: 0,
  });
  expect(resolveAttack(bossForLevel(7), 5, 99, 100, 200)).toMatchObject({ damage: 5, hp: 95 });
  expect(resolveAttack(bossForLevel(8), 3, 99, 100, 200)).toMatchObject({ damage: 5, xp: 4, hp: 97 });
  expect(resolveAttack(bossForLevel(9), 2, 99, 100, 250, { combo: 4 })).toMatchObject({
    damage: 10, hp: 102, combo: 0, comboBonus: 0,
  });
  expect(resolveAttack(bossForLevel(10), 1, 40, 100, 250, { combo: 4 })).toMatchObject({
    kind: "followUp", damage: 5, combo: 0, comboBonus: 0,
  });
  expect(resolveAttack(cache, 1, 99, 41, 200, { finisherRoll: 0 }).kind).toBeNull();
  expect(resolveAttack(cache, 1, 99, 40, 200, { finisherRoll: 0 }).kind).toBe("instant");
  expect(resolveAttack(cache, 3, 99, 40, 200, { finisherRoll: 0 }).kind).toBeNull();
  expect([6, 11, 16, 101].map((level) => bossForLevel(level).finisherThreshold)).toEqual([20, 15, 10, 10]);
});

test("rolls damage tiers, preserves skill mitigation, and gates finishers on health and dodges", () => {
  const cache = bossForLevel(1);
  expect(resolveAttack(cache, 1, 99, 60, 60, { baseDamage: 7 })).toMatchObject({ damage: 7, baseDamage: 7 });
  expect(resolveAttack(cache, 1, 10, 60, 60, { baseDamage: 13 })).toMatchObject({ outcome: "critical", damage: 26 });
  expect(resolveAttack(cache, 1, 35, 60, 60, { baseDamage: 13 })).toMatchObject({
    outcome: "critical", kind: "overpower", damage: 39, xp: 15,
  });
  expect(resolveAttack(cache, 1, 40, 60, 60, { baseDamage: 7 })).toMatchObject({
    outcome: "hit", kind: "followUp", damage: 11,
  });
  expect(resolveAttack(cache, 4, 99, 60, 60, { combo: 4 })).toMatchObject({
    combo: 0, comboBonus: 5, damage: 11, skillName: "缓存护盾",
  });
  expect(resolveAttack(cache, 4, 99, 60, 60, { finisherRoll: 4 })).toMatchObject({
    outcome: "critical", kind: "instant", damage: 60, hp: 0, xp: 30, skillName: null,
  });
  expect(resolveAttack(cache, 1, 99, 16, 60, { finisherRoll: 5 })).toMatchObject({ kind: null, hp: 6 });
  expect(resolveAttack(cache, 1, 99, 15, 60, { finisherRoll: 104 })).toMatchObject({
    kind: "execute", damage: 15, hp: 0, xp: 20,
  });
  expect(resolveAttack(cache, 1, 99, 15, 60, { finisherRoll: 105 })).toMatchObject({ kind: null, hp: 5 });
  expect(resolveAttack(cache, 1, 0, 60, 60, { finisherRoll: 0, combo: 4 })).toMatchObject({
    outcome: "dodge", kind: null, damage: 0, combo: 0,
  });
  expect(resolveAttack(bossForLevel(2), 5, 99, 80, 80, { finisherRoll: 0, combo: 4 })).toMatchObject({
    outcome: "dodge", kind: null, hp: 80, combo: 0, skillName: "相位闪避",
  });
});

test("defaults to public lobby, protects private rooms, and keeps a renamed profile", async () => {
  const { close, send } = useRoom();
  try {
    const publicA = await (await send("/api/player", 1, { nickname: "<A>" })).json();
    const publicB = await (await send("/api/player", 2, { nickname: "B" })).json();
    expect(publicA.room.id).toBe("lobby");
    expect(publicB.room.id).toBe(publicA.room.id);
    expect(publicB.room.members).toHaveLength(2);
    const a = await (await send("/api/rooms", 1, { name: "项目组", visibility: "private" })).json();
    const b = await (await send("/api/home", 2, {})).json();
    expect(a.room.code).toMatch(/^\d{8}$/);
    expect(a.room.id).not.toBe(b.room.id);
    expect(a.room.members).toEqual([a.player]);
    const landing = await (await send(`/invite/${a.room.code}`)).text();
    expect(landing).toContain(`/?invite=${a.room.code}`);
    expect(landing).toContain("&lt;A&gt;");
    expect((await (await send("/api/state", 2)).json()).rooms.some((room) => room.id === a.room.id)).toBe(false);
    expect((await send("/api/rooms/join", 2, { roomId: a.room.id })).status).toBe(404);
    expect((await send("/api/join", 2, { code: "nope" })).status).toBe(404);
    const joined = await (await send("/api/join", 2, { code: a.room.code })).json();
    expect(joined.room.id).toBe(a.room.id);
    expect(joined.room.members.map((member) => member.name)).toEqual(["<A>", "B"]);
    const renamed = await (await send("/api/profile", 2, { nickname: "新昵称" })).json();
    expect(renamed.player.id).toBe(b.player.id);
    expect(renamed.player.name).toBe("新昵称");
    expect((await (await send("/api/state", 1)).json()).room.members).toContainEqual(renamed.player);
    expect((await send("/api/profile", 2, { nickname: " " })).status).toBe(400);
    const home = await (await send("/api/home", 2, {})).json();
    expect(home.room.id).toBe(b.room.id);
    const again = await (await send("/api/player", 2, {})).json();
    expect(again.room.code).toBe(b.room.code);
    const open = await (await send("/api/rooms", 1, { name: "公开组", visibility: "public" })).json();
    expect((await (await send("/api/state", 2)).json()).rooms.map((room) => room.id)).toContain(open.room.id);
    expect((await (await send("/api/rooms/join", 2, { roomId: open.room.id })).json()).room.id).toBe(open.room.id);
    expect((await send("/api/rooms", 2, { name: "", visibility: "public" })).status).toBe(400);
  } finally {
    close();
  }
});

test("players can attack without a daily cap and share stronger successive bosses", async () => {
  const { close, send } = useRoom();
  try {
    const a = await (await send("/api/player", 1, {})).json();
    await send("/api/player", 2, {});
    await send("/api/join", 2, { code: a.room.code });
    const events = [event(1), event(1), event(2), event(3), event(4)];
    const first = await (await send("/api/attacks", 1, { events })).json();
    expect(first.room).toMatchObject({ hp: 23, bossLevel: 1, maxHp: 60, nextSkillIn: 4 });
    expect(first.room.attacks[0]).toMatchObject({ skillName: "缓存护盾", damage: 7 });
    expect(first.player.xp).toBe(40);
    const second = await (await send("/api/attacks", 2, { events })).json();
    expect(second.room).toMatchObject({ hp: 60, defeated: 1, bossLevel: 2, maxHp: 80, nextSkillIn: 3 });
    expect(second.room.attacks).toHaveLength(8);
    const replay = await (await send("/api/attacks", 2, { events })).json();
    expect(replay.room).toEqual(second.room);
    const next = await (await send("/api/attacks", 2, { events: Array.from({ length: 7 }, (_, index) => event(index + 5)) })).json();
    expect(next.room).toMatchObject({ hp: 100, defeated: 2, bossLevel: 3, maxHp: 100 });
    expect(next.room.attacks[0]).toMatchObject({ bossLevel: 2, hp: 0 });
    expect(next.room.attacks.find((attack) => attack.skillName === "相位闪避")).toMatchObject({ outcome: "dodge", damage: 0 });
    expect(next.player).toMatchObject({ xp: 143, level: 1, levelXp: 143, nextLevelXp: 250 });
    expect((await (await send("/api/state", 1)).json()).room).toEqual(next.room);
    expect((await (await send("/api/home", 2, {})).json()).player.level).toBe(1);
  } finally {
    close();
  }
});

test("raises level thresholds for new players and preserves existing levels and remaining XP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-level-upgrade-"));
  const path = join(directory, "room.sqlite");
  try {
    const old = useRoom(() => 99, path);
    try {
      await old.send("/api/player", 1, { nickname: "老玩家" });
      await old.send("/api/home", 1, {});
    } finally {
      old.close();
    }
    const db = new Database(path);
    try {
      db.exec("ALTER TABLE players DROP COLUMN level_start_xp; UPDATE players SET starting_level = 3, xp = 259;");
    } finally {
      db.close();
    }
    const current = useRoom(() => 99, path);
    try {
      const before = await (await current.send("/api/state", 1)).json();
      expect(before.player).toMatchObject({ xp: 259, level: 4, levelXp: 9, nextLevelXp: 550 });

      const fresh = await (await current.send("/api/player", 2, {})).json();
      expect(fresh.player).toMatchObject({ xp: 0, level: 1, levelXp: 0, nextLevelXp: 250 });
      await current.send("/api/home", 2, {});
      const db = new Database(path);
      try {
        db.query("UPDATE players SET xp = ? WHERE id = ?").run(799, before.player.id);
        db.query("UPDATE players SET xp = ? WHERE id = ?").run(240, fresh.player.id);
      } finally {
        db.close();
      }
      const almost = await (await current.send("/api/state", 1)).json();
      expect(almost.player).toMatchObject({ xp: 799, level: 4, levelXp: 549, nextLevelXp: 550 });
      const next = await (await current.send("/api/attacks", 1, { events: [event(1)] })).json();
      expect(next.player).toMatchObject({ xp: 809, level: 5, levelXp: 9, nextLevelXp: 650 });
      const firstLevelUp = await (await current.send("/api/attacks", 2, { events: [event(1)] })).json();
      expect(firstLevelUp.player).toMatchObject({ xp: 250, level: 2, levelXp: 0, nextLevelXp: 350 });
    } finally {
      current.close();
    }
    const restarted = useRoom(() => 99, path);
    try {
      const state = await (await restarted.send("/api/state", 1)).json();
      expect(state.player).toMatchObject({ xp: 809, level: 5, levelXp: 9, nextLevelXp: 650 });
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("room service validates auth and attack payloads", async () => {
  const { close, send } = useRoom();
  try {
    expect((await send("/api/state")).status).toBe(401);
    expect((await send("/api/state", 1)).status).toBe(404);
    await send("/api/player", 1, {});
    expect((await send("/api/attacks", 1, { events: [{ id: "x" }] })).status).toBe(400);
    expect((await send("/api/attacks", 1, { events: Array(101).fill(event(1)) })).status).toBe(400);
  } finally {
    close();
  }
});

test("ranks full daily damage in the current room using Beijing time, including players who left", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-leaderboard-"));
  const path = join(directory, "room.sqlite");
  const { close, send } = useRoom(() => 99, path);
  try {
    const players = [];
    for (const [index, nickname] of ["Alice", "Bob", "Carol", "Drew", "Eve"].entries()) {
      const { player } = await (await send("/api/player", index + 1, { nickname })).json();
      players.push(player.id);
    }
    const { room } = await (await send("/api/rooms", 1, { name: "组内测试", visibility: "private" })).json();
    for (const number of [2, 3, 5]) await send("/api/join", number, { code: room.code });
    await send("/api/home", 3, {});
    const db = new Database(path);
    try {
      const record = db.query(`INSERT INTO attack_results (room_id, player_id, outcome, damage, xp, hp, settled_at)
        VALUES (?, ?, 'hit', ?, 0, 60, ?)`);
      const add = (player, damage, at, roomId = room.id) => record.run(roomId, players[player - 1], damage, at);
      const start = "2026-11-10T16:00:00.000Z";
      for (let attack = 0; attack < 35; attack++) add(1, 1, start);
      add(1, 2, "2026-11-11T15:59:59.999Z");
      add(1, 9, "2026-11-10T15:59:59.999Z");
      add(2, 20, start);
      add(2, 4, "2026-11-11T16:00:00.000Z");
      add(3, 20, start);
      add(5, 1, start);
      add(5, 0, "2026-11-08T16:00:00.000Z");
      add(4, 0, start);
      add(4, 500, start, "lobby");
    } finally {
      db.close();
    }

    const api = "/api/leaderboard?day=";
    expect((await send(api + "2026-11-11")).status).toBe(401);
    expect((await send(api + "2026-11-11", 9)).status).toBe(404);
    expect((await send(api + "2026-02-30", 1)).status).toBe(400);
    expect((await send(api, 1)).status).toBe(400);
    const rank = async (day, number = 1) => (await send(api + day, number)).json();
    const current = await rank("2026-11-11");
    expect(current).toMatchObject({ day: "2026-11-11", roomId: room.id });
    expect(current.rows.map(({ playerName, damage, rank }) => [playerName, damage, rank])).toEqual([
      ["Alice", 37, 1], ["Bob", 20, 2], ["Carol", 20, 2], ["Eve", 1, 4],
    ]);
    expect((await rank("2026-11-10")).rows).toMatchObject([{ playerName: "Alice", damage: 9 }]);
    expect((await rank("2026-11-12")).rows).toMatchObject([{ playerName: "Bob", damage: 4 }]);
    expect((await rank("2026-11-09")).rows).toEqual([]);
    expect(await rank(`2026-11-11&roomId=${room.id}`, 4)).toMatchObject({
      roomId: "lobby", rows: [{ playerName: "Drew", damage: 500 }],
    });
    expect((await rank("2026-11-11", 3)).rows).toEqual([]);
    const members = await (await send("/api/member-damage", 1)).json();
    expect(members.roomId).toBe(room.id);
    expect(members.rows.map(({ playerId, averageDamage }) => [players.indexOf(playerId) + 1, averageDamage]).sort()).toEqual([
      [1, 23], [2, 12], [5, .5],
    ]);
  } finally {
    close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rewards tied daily leaders and records the last hit on each boss beyond the recent combat feed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-kill-history-"));
  const path = join(directory, "room.sqlite");
  const { close, send } = useRoom(() => 99, path);
  try {
    const { player: alice } = await (await send("/api/player", 1, { nickname: "Alice" })).json();
    const { player: bob } = await (await send("/api/player", 2, { nickname: "Bob" })).json();
    await send("/api/player", 3, {});
    const { room } = await (await send("/api/rooms", 1, { name: "研发组", visibility: "private" })).json();
    await send("/api/join", 2, { code: room.code });
    await send("/api/attacks", 1, { events: [event(1)] });
    await send("/api/attacks", 2, { events: [event(2)] });
    const stats = await (await send("/api/member-damage", 1)).json();
    expect(stats.rows).toHaveLength(2);
    expect(stats.rows.every(({ todayMvp, averageDamage }) => todayMvp && averageDamage === 10)).toBe(true);
    await send("/api/attacks", 1, { events: [event(3), event(4), event(5)] });
    const first = await (await send("/api/attacks", 2, { events: [event(6), event(6)] })).json();
    expect(first.room.defeated).toBe(1);
    const after = await (await send("/api/member-damage", 1)).json();
    expect(after.rows.filter(({ todayMvp }) => todayMvp).map(({ playerId }) => playerId)).toEqual([alice.id]);
    const history = await (await send("/api/kills", 1)).json();
    expect(history).toMatchObject({ roomId: room.id, nextBefore: null, rows: [
      { bossLevel: 1, bossName: "缓存怪", playerId: bob.id, playerName: "Bob" },
    ] });
    const db = new Database(path);
    try {
      db.query("UPDATE attack_results SET boss_level = NULL WHERE room_id = ? AND hp = 0").run(room.id);
      const add = db.query(`INSERT INTO attack_results (room_id, player_id, outcome, damage, xp, hp, settled_at, boss_level)
        VALUES (?, ?, 'hit', 10, 10, ?, '2026-11-09T16:00:00.000Z', ?)`);
      for (let level = 2; level <= 22; level++) add.run(room.id, alice.id, 0, level);
      add.run(room.id, bob.id, 1, 23);
      db.query("UPDATE rooms SET defeated = 22 WHERE id = ?").run(room.id);
    } finally {
      db.close();
    }
    expect((await send("/api/kills", null)).status).toBe(401);
    expect((await send("/api/kills?before=-1", 1)).status).toBe(400);
    const page = await (await send("/api/kills", 1)).json();
    expect(page.rows).toHaveLength(20);
    expect(page.rows[0].bossLevel).toBe(22);
    expect(page.rows.at(-1).bossLevel).toBe(3);
    const tail = await (await send(`/api/kills?before=${page.nextBefore}`, 1)).json();
    expect(tail.nextBefore).toBeNull();
    expect(tail.rows.map(({ bossLevel, playerName }) => [bossLevel, playerName])).toEqual([[2, "Alice"], [1, "Bob"]]);
    const outsider = await (await send(`/api/kills?roomId=${room.id}`, 3)).json();
    expect(outsider).toEqual({ roomId: "lobby", rows: [], nextBefore: null });
    await send("/api/home", 2, {});
    const stillRecorded = await (await send(`/api/kills?before=${page.nextBefore}`, 1)).json();
    expect(stillRecorded.rows.at(-1)).toMatchObject({ playerId: bob.id, playerName: "Bob" });
  } finally {
    close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the hosted lobby works independently and binds its browser to an existing Magpie player", async () => {
  const origin = "https://boss.example.test";
  const { fetch, close } = createRoomService(":memory:", { hosted: true, publicOrigin: origin });
  const viewer = "web_" + "a".repeat(64);
  const secondViewer = "web_" + "b".repeat(64);
  const stranger = token(2);
  const collector = token(1);
  function request(path, auth, body, requestOrigin) {
    const headers = new Headers();
    if (auth) headers.set("Authorization", `Bearer ${auth}`);
    if (requestOrigin) headers.set("Origin", requestOrigin);
    return fetch(new Request(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }
  try {
    const page = await request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(`default-src ${origin}`);
    expect(await page.text()).toContain('data-hosted="true"');
    expect((await request("/app.js")).status).toBe(200);
    expect((await request("/format.js")).status).toBe(200);
    const preflight = await fetch(new Request(`${origin}/api/state`, { method: "OPTIONS", headers: { Origin: "null" } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    expect((await request("/api/state", viewer, undefined, "null")).status).toBe(404);
    const guest = await (await request("/api/player", viewer, {}, "null")).json();
    const device = await (await request("/api/player", collector, { nickname: "已有角色" })).json();
    await request("/api/attacks", collector, { events: [event(1)] });
    const { room } = await (await request("/api/rooms", viewer, { name: "云端测试", visibility: "private" })).json();
    const invite = await (await request(`/invite/${room.code}`)).text();
    expect(invite).toContain(`href="/?invite=${room.code}"`);
    expect(invite).not.toContain("127.0.0.1");
    expect((await request("/api/attacks", viewer, { events: [event(2)] })).status).toBe(403);
    expect((await request("/api/state", collector, undefined, "null")).status).toBe(403);
    expect((await request("/api/browser/link", collector, { token: viewer })).status).toBe(200);
    expect((await request("/api/browser/link", collector, { token: viewer })).status).toBe(200);
    await request("/api/player", stranger, {});
    expect((await request("/api/browser/link", stranger, { token: viewer })).status).toBe(409);
    const response = await request("/api/state?day=2026-11-11", viewer, undefined, "null");
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    const bound = await response.json();
    expect(bound).toMatchObject({ bound: true, todayAttacks: 1, player: { id: device.player.id, name: "已有角色" } });
    expect(bound.room.id).toBe(room.id);
    expect(bound.room.members.some((member) => member.id === guest.player.id)).toBe(false);
    const rank = await request("/api/leaderboard?day=2026-01-01", viewer, undefined, "null");
    expect(rank.headers.get("access-control-allow-origin")).toBe("null");
    expect(await rank.json()).toMatchObject({ roomId: room.id, rows: [] });
    for (const path of ["/api/member-damage", "/api/kills"]) {
      const result = await request(path, viewer, undefined, "null");
      expect(result.headers.get("access-control-allow-origin")).toBe("null");
      expect(await result.json()).toMatchObject({ roomId: room.id, rows: [] });
    }
    expect((await request("/api/attacks", viewer, { events: [event(2)] })).status).toBe(403);
    await request("/api/attacks", collector, { events: [event(2)] });
    expect((await (await request("/api/state", viewer)).json()).room.attacks).toHaveLength(1);
    await request("/api/player", secondViewer, {});
    const { code } = await (await request("/api/browser/code", secondViewer, {})).json();
    expect(code).toMatch(/^[a-f0-9]{24}$/);
    expect((await request("/api/browser/pair", collector, { code })).status).toBe(200);
    expect((await request("/api/browser/pair", stranger, { code })).status).toBe(404);
    expect((await (await request("/api/state", secondViewer)).json()).player.id).toBe(device.player.id);
  } finally {
    close();
  }
});

test("stores each combat outcome once, with actual damage and shared history", async () => {
  const rolls = [0, 10, 25, 99, 99, 10];
  const { close, send } = useRoom(() => rolls.shift());
  try {
    const a = await (await send("/api/player", 1, { nickname: "Alice" })).json();
    await send("/api/player", 2, { nickname: "Bob" });
    await send("/api/join", 2, { code: a.room.code });
    const events = [event(1), event(1), event(2), event(3)];
    const first = await (await send("/api/attacks", 1, { events })).json();
    expect(first.room.attacks.map(({ outcome, damage, xp, hp }) => [outcome, damage, xp, hp])).toEqual([
      ["counter", 10, 5, 30], ["critical", 20, 10, 40], ["dodge", 0, 0, 60],
    ]);
    expect(first.player.xp).toBe(15);
    const second = await (await send("/api/attacks", 2, { events })).json();
    expect(second.room.attacks[0]).toMatchObject({
      outcome: "critical", playerName: "Bob", damage: 13, hp: 0, xp: 30, killXp: 20,
    });
    expect(second.room.attacks).toHaveLength(6);
    expect(second.room).toMatchObject({ defeated: 1, bossLevel: 2, hp: 80 });
    expect((await (await send("/api/state", 1)).json()).room.attacks).toEqual(second.room.attacks);
    const replay = await (await send("/api/attacks", 2, { events })).json();
    expect(replay.room.attacks).toEqual(second.room.attacks);
    expect(replay.player.xp).toBe(50);
    expect(rolls).toEqual([]);
  } finally {
    close();
  }
});

test("upgrades the previous room database without losing progress or repeating older attacks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-room-upgrade-"));
  const path = join(directory, "room.sqlite");
  const old = useRoom(() => 99, path);
  try {
    const before = await (await old.send("/api/player", 1, { nickname: "Alice" })).json();
    await old.send("/api/attacks", 1, { events: [event(1)] });
    old.close();
    const db = new Database(path);
    db.exec(`
      ALTER TABLE rooms DROP COLUMN boss_turn;
      ALTER TABLE rooms DROP COLUMN combo;
      ALTER TABLE rooms DROP COLUMN max_hp;
      ALTER TABLE players DROP COLUMN starting_level;
      ALTER TABLE players DROP COLUMN level_start_xp;
      ALTER TABLE attack_results DROP COLUMN skill_detail;
      ALTER TABLE attack_results DROP COLUMN skill_name;
      ALTER TABLE attack_results DROP COLUMN boss_level;
      ALTER TABLE attack_results DROP COLUMN attack_kind;
      ALTER TABLE attack_results DROP COLUMN base_damage;
      ALTER TABLE attack_results DROP COLUMN combo_bonus;
      ALTER TABLE attack_results DROP COLUMN kill_xp;
    `);
    db.close();
    const upgraded = useRoom(() => 10, path);
    try {
      const state = await (await upgraded.send("/api/state", 1)).json();
      expect(state.room).toMatchObject({ code: before.room.code, hp: 50, bossLevel: 1, nextSkillIn: 4 });
      expect(state.room.attacks).toHaveLength(1);
      expect(state.room.attacks[0]).toMatchObject({ damage: 10, bossLevel: null, kind: null, baseDamage: null, killXp: 0 });
      expect(state.player).toMatchObject({ xp: 10, level: 1, levelXp: 10 });
      const next = await (await upgraded.send("/api/attacks", 1, { events: [event(1), event(2)] })).json();
      expect(next.room.hp).toBe(30);
      expect(next.room.attacks).toHaveLength(2);
      expect(next.room.attacks[0]).toMatchObject({ outcome: "critical", damage: 20, bossLevel: 1 });
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves an active boss's original maximum and applies the steeper curve to the next boss", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-hp-upgrade-"));
  const path = join(directory, "room.sqlite");
  try {
    const old = useRoom(() => 99, path);
    try {
      await old.send("/api/player", 1, {});
    } finally {
      old.close();
    }
    const db = new Database(path);
    try {
      db.exec("ALTER TABLE rooms DROP COLUMN max_hp; UPDATE rooms SET defeated = 5, hp = 1 WHERE id = 'lobby';");
    } finally {
      db.close();
    }
    const upgraded = useRoom(() => 99, path);
    try {
      const before = await (await upgraded.send("/api/state", 1)).json();
      expect(before.room).toMatchObject({ bossLevel: 6, hp: 1, maxHp: 160 });
      const after = await (await upgraded.send("/api/attacks", 1, { events: [event(1)] })).json();
      expect(after.room).toMatchObject({ bossLevel: 7, hp: 204, maxHp: 204 });
      expect(after.room.attacks[0]).toMatchObject({ bossLevel: 6, damage: 1, killXp: 35, xp: 45 });
    } finally {
      upgraded.close();
    }
    const restarted = useRoom(() => 99, path);
    try {
      const state = await (await restarted.send("/api/state", 1)).json();
      expect(state.room).toMatchObject({ bossLevel: 7, hp: 204, maxHp: 204 });
      expect(state.player.xp).toBe(45);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resumes shared skill and combo progress across room service instances", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-shared-skill-"));
  const path = join(directory, "room.sqlite");
  const a = useRoom(() => 99, path);
  const b = useRoom(() => 99, path);
  try {
    const { room } = await (await a.send("/api/player", 1, {})).json();
    await b.send("/api/player", 2, {});
    await b.send("/api/join", 2, { code: room.code });
    await a.send("/api/attacks", 1, { events: [event(1), event(2), event(3)] });
    const first = await (await b.send("/api/state", 2)).json();
    expect(first.room).toMatchObject({ nextSkillIn: 1, combo: 3, comboTarget: 5 });
    await a.send("/api/attacks", 1, { events: [event(3)] });
    const next = await (await b.send("/api/attacks", 2, { events: [event(4)] })).json();
    expect(next.room.nextSkillIn).toBe(4);
    expect(next.room.attacks[0]).toMatchObject({ skillName: "缓存护盾", damage: 7 });
    expect(next.room.attacks).toHaveLength(4);
    expect(next.room.combo).toBe(4);
    const combo = await (await a.send("/api/attacks", 1, { events: [event(5)] })).json();
    expect(combo.room).toMatchObject({ hp: 8, combo: 0 });
    expect(combo.room.attacks[0]).toMatchObject({ damage: 15, baseDamage: 10, comboBonus: 5 });
  } finally {
    a.close();
    b.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses final requests only, counts billed cache, and distinguishes failures", () => {
  const t = "2026-11-11T05:00:00.000Z";
  const row = { t, rid: "one", in: 2, out: 3, cache_read: 5, cache_write: 7, reasoning: 19, status: 200 };
  const usage = toUsage(row, 0);
  expect(usage).toMatchObject({ tokens: 17, success: true });
  expect(usage.id).toMatch(/^[a-f0-9]{64}$/);
  expect(toUsage({ ...row, status: 429 }, 0)).toMatchObject({ tokens: 17, success: false });
  expect(toUsage({ ...row, handed_on: true }, 0)).toBeNull();
  expect(toUsage({ ...row, purpose: "title" }, 0)).toBeNull();
  expect(toUsage(row, Date.parse(t) + 1)).toBeNull();
  expect(toUsage({ ...row, rid: "" }, 0)).toBeNull();
  expect(toUsage({ ...row, rid: undefined, route_id: 1794371930841 }, 0)).toMatchObject({ tokens: 17, success: true });
});

test("reads local Codex completion records while requiring real usage and a response ID", () => {
  const log = {
    t: "2026-11-11T05:00:00.000Z", source: "log", agent: "codex", session: "test-session",
    response_id: "resp_test", status: 0, in: 12, out: 7, cache_read: 4,
  };
  const row = toUsage(log, 0);
  expect(row).toMatchObject({ tokens: 23, success: true, id: row.responseKey });
  expect(toUsage({ ...log, response_id: "" }, 0)).toBeNull();
  expect(toUsage({ ...log, source: undefined }, 0)).toBeNull();
  expect(toUsage({ ...log, in: 0, out: 0, cache_read: 0 }, 0)).toBeNull();
  expect(toUsage({ ...log, source: undefined, route_id: 99, status: 200 }, 0).responseKey).toBe(row.responseKey);
});

test("local helper refuses foreign hosts and cross-origin joins", async () => {
  const origin = "http://127.0.0.1:3468";
  const handler = createLocalHandler({ snapshot: () => ({ calls: 0 }) }, origin);
  expect((await handler(new Request(`${origin}/api/state`, { headers: { host: "office.test:3468" } }))).status).toBe(403);
  const response = await handler(new Request(`${origin}/api/join`, {
    method: "POST", headers: { host: "127.0.0.1:3468", origin: "http://office.test" },
    body: JSON.stringify({ code: "12345678" }),
  }));
  expect(response.status).toBe(403);
  const accepted = await handler(new Request(`${origin}/api/state`, { headers: { host: "127.0.0.1:3468" } }));
  expect(await accepted.json()).toEqual({ calls: 0 });
});

test("collects requests while offline, syncs every eligible attack, and retains progress on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-player-test-"));
  const { close, fetch: handleRoom, send } = useRoom();
  let online = false;
  let readable = true;
  let rows = [];
  const attackPayloads = [];
  const options = {
    directory,
    magpieUrl: "http://magpie.test",
    roomServer: "http://rooms.test",
    nickname: "Local player",
    fetcher: async (url, init) => {
      if (url.hostname === "magpie.test") {
        if (!readable) return new Response(null, { status: 503 });
        const offset = Number(url.searchParams.get("offset"));
        return Response.json({ rows: rows.slice(offset, offset + 2), total: rows.length });
      }
      if (!online) throw new Error("network unavailable");
      if (url.pathname === "/api/attacks") attackPayloads.push(JSON.parse(init.body));
      return handleRoom(new Request(url, init));
    },
  };
  let player = createPlayer(options);
  try {
    const t = new Date().toISOString();
    const codex = { t, agent: "codex", session: "test-session", status: 0, source: "log", in: 17, out: 3 };
    rows = [
      { ...codex, response_id: "resp_direct" },
      { ...codex, response_id: "resp_gateway" },
      { ...codex, response_id: "resp_gateway", source: undefined, route_id: 99, status: 200 },
      { t, rid: "two", status: 200, in: 17, out: 3 },
      { t, rid: "three", status: 200, in: 17, out: 3 },
      { t, rid: "failed", status: 429, in: 1 },
    ];
    await player.tick();
    expect(player.snapshot()).toMatchObject({
      pending: 4, roomOnline: false, usageOnline: true, usage: { calls: 5, tokens: 81, attacks: 4 },
    });
    online = true;
    await player.tick();
    const first = player.snapshot();
    expect(first).toMatchObject({ pending: 0, room: { hp: 23 }, player: { xp: 40 } });
    const rankDayFor = ({ settledAt }) => new Date(Date.parse(settledAt) + 8 * 3600000).toISOString().slice(0, 10);
    const rankDay = rankDayFor(first.room.attacks[0]);
    const damage = first.room.attacks.filter((attack) => rankDayFor(attack) === rankDay).reduce((sum, attack) => sum + attack.damage, 0);
    expect(await player.leaderboard(rankDay)).toMatchObject({
      roomId: first.room.id, rows: [{ playerId: first.player.id, playerName: "Local player", damage, rank: 1 }],
    });
    expect(attackPayloads).toHaveLength(1);
    expect(attackPayloads[0].events).toHaveLength(4);
    expect(Object.keys(attackPayloads[0].events[0]).sort()).toEqual(["day", "id"]);

    await send("/api/player", 5, { nickname: "Host" });
    const host = await (await send("/api/home", 5, {})).json();
    expect(await player.preview(host.room.code)).toMatchObject({ owner: "Host" });
    await player.changeRoom(host.room.code);
    expect(player.snapshot().room.hp).toBe(60);
    expect(player.snapshot().player.xp).toBe(40);

    player.close();
    player = createPlayer(options);
    readable = false;
    await player.tick();
    expect(player.snapshot()).toMatchObject({
      player: first.player, room: { id: host.room.id, hp: 60 }, usageOnline: false, usage: first.usage,
    });
    readable = true;
    await player.chooseRoom(first.room.id);
    expect(player.snapshot().room).toMatchObject({ id: first.room.id, hp: 23 });
    await player.createRoom("我的新房间", "private");
    expect(player.snapshot().room.name).toBe("我的新房间");
    await player.rename("可以改名");
    expect(player.snapshot().player.name).toBe("可以改名");
    await player.changeRoom();
    expect(player.snapshot().room.id).toBe(player.snapshot().player.id);
  } finally {
    player.close();
    close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses K for thousands of API calls and M for millions of tokens", () => {
  const script = readFileSync(new URL("../page/format.js", import.meta.url), "utf8");
  const compact = runInNewContext(`${script}\nformatCompactCount;`);
  expect(compact(999, 1000, "K")).toBe("999");
  expect(compact(1234, 1000, "K")).toBe("1.23K");
  expect(compact(999_999, 1_000_000, "M")).toBe("999,999");
  expect(compact(8_466_623, 1_000_000, "M")).toBe("8.47M");
});

test("the Magpie page uses its configured port and falls back when the host bridge hangs", async () => {
  const script = readFileSync(new URL("../page/app.js", import.meta.url), "utf8");
  function launch(magpie, hostedLobby = "") {
    const status = { textContent: "" };
    const address = { textContent: "" };
    const retry = { hidden: true, disabled: false, addEventListener() {} };
    const elements = { "lobby-status": status, "lobby-address": address, retry };
    const timers = new Map();
    const redirects = [];
    runInNewContext(script, {
      magpie,
      URL,
      URLSearchParams,
      crypto,
      document: { documentElement: { dataset: { hostedLobby } }, getElementById: (id) => elements[id] },
      location: { replace: (target) => redirects.push(target) },
      setTimeout: (callback, delay) => {
        timers.set(delay, callback);
        return delay;
      },
      clearTimeout: (delay) => timers.delete(delay),
    });
    return { status, address, retry, timers, redirects };
  }

  const custom = launch({ ready: Promise.resolve(), options: { get: async () => ({ localPort: 4567 }) } });
  await Bun.sleep(0);
  expect(custom.redirects).toEqual(["http://127.0.0.1:4567/embedded"]);
  expect(custom.address.textContent).toBe("http://127.0.0.1:4567/");
  expect(custom.timers.has(1500)).toBe(false);

  for (const bridge of [
    { ready: new Promise(() => {}), options: { get: async () => ({}) } },
    { ready: Promise.resolve(), options: { get: () => new Promise(() => {}) } },
  ]) {
    const stalled = launch(bridge);
    expect(stalled.redirects).toEqual([]);
    stalled.timers.get(1500)();
    await Bun.sleep(0);
    expect(stalled.redirects).toEqual(["http://127.0.0.1:3468/embedded"]);
    expect(stalled.address.textContent).toBe("http://127.0.0.1:3468/");
    stalled.timers.get(4000)();
    expect(stalled.status.textContent).toContain("复制到浏览器");
    expect(stalled.retry).toMatchObject({ disabled: false, hidden: false });
  }

  const origin = "https://boss.example.test";
  let saved;
  const cloud = launch({
    ready: Promise.resolve(),
    options: {
      get: async () => ({ nickname: "小队" }),
      set: async (options) => { saved = options; },
    },
  }, origin);
  await Bun.sleep(0);
  expect(saved).toMatchObject({ nickname: "小队", viewerOrigin: origin });
  expect(saved.viewerToken).toMatch(/^web_[a-f0-9]{64}$/);
  expect(cloud.redirects).toEqual([`${origin}/#viewer=${saved.viewerToken}`]);
  expect(cloud.address.textContent).toBe(`${origin}/`);
  const guest = launch({ options: { get: () => new Promise(() => {}) } }, origin);
  guest.timers.get(1500)();
  await Bun.sleep(0);
  expect(guest.redirects).toEqual([`${origin}/`]);
});

test("local room serves browser assets and validates invitation actions", async () => {
  const origin = "http://127.0.0.1:3468";
  const player = {
    preview: async (code) => {
      if (code === "11111111") throw new Error("找不到这个邀请码");
      return { code };
    },
    changeRoom: async (code) => {
      if (code === "22222222") throw new Error("offline");
      return { code: code ?? "home" };
    },
  };
  const handler = createLocalHandler(player, origin);
  const request = (path, body) => handler(new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: "127.0.0.1:3468", origin },
    body,
  }));
  const home = await request("/");
  expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await home.text()).toContain("magpie-boss");
  expect((await request("/api/join", "invalid json")).status).toBe(400);
  expect((await request("/api/join", '{"code":12345678}')).status).toBe(400);
  expect(await (await request("/api/invite", '{"code":"12345678"}')).json()).toEqual({ code: "12345678" });
  expect((await request("/api/invite", '{"code":"11111111"}')).status).toBe(404);
  expect((await request("/api/join", '{"code":"22222222"}')).status).toBe(503);
  expect(await (await request("/api/join", '{"code":"12345678"}')).json()).toEqual({ code: "12345678" });
  expect(await (await request("/api/home", "{}")).json()).toEqual({ code: "home" });
  expect((await request("/unknown", "{}")).status).toBe(404);
  expect((await request("/unknown")).status).toBe(404);
});

test("Magpie iframe requests need the per-page token before CORS permits local actions", async () => {
  const origin = "http://127.0.0.1:3468";
  const player = {
    snapshot: () => ({ online: true }), rename: async (nickname) => ({ nickname }),
    leaderboard: async (day) => ({ day, rows: [] }),
  };
  const handler = createLocalHandler(player, origin);
  const request = (path, init = {}) => handler(new Request(origin + path, {
    ...init, headers: { host: "127.0.0.1:3468", ...init.headers },
  }));
  const boot = await request("/embedded");
  expect(boot.headers.get("content-security-policy")).toContain("frame-ancestors wails:");
  const token = (await boot.text()).match(/data-embed-token="([a-f0-9]{64})"/)?.[1];
  expect(token).toBeTruthy();
  expect((await request("/api/state", { headers: { origin: "null" } })).status).toBe(403);
  const rankPath = "/api/leaderboard?day=2026-11-11";
  expect((await request(rankPath, { headers: { origin: "null" } })).status).toBe(403);
  const rank = await request(rankPath, { headers: { origin: "null", "x-boss-embed": token } });
  expect(rank.headers.get("access-control-allow-origin")).toBe("null");
  expect(await rank.json()).toEqual({ day: "2026-11-11", rows: [] });
  const preflight = await request("/api/profile", { method: "OPTIONS", headers: { origin: "null" } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
  const renamed = await request("/api/profile", {
    method: "POST", headers: { origin: "null", "x-boss-embed": token }, body: '{"nickname":"测试"}',
  });
  expect(await renamed.json()).toEqual({ nickname: "测试" });
  expect(renamed.headers.get("access-control-allow-origin")).toBe("null");
  expect((await request("/api/profile", {
    method: "POST", headers: { origin: "http://foreign.test", "x-boss-embed": token }, body: '{"nickname":"测试"}',
  })).status).toBe(403);
});

test("lobby discovery finds an existing local server or remembers the shared server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-discovery-"));
  try {
    expect(await findLobby(directory, async () => false)).toBeNull();
    expect(await findLobby(directory, async () => true)).toBe(LOCAL_ROOM_SERVER);
    expect(await findLobby(directory, async (origin) => origin === LAN_ROOM_SERVER)).toBe(LAN_ROOM_SERVER);
    expect(await findLobby(directory, async () => false)).toBe(LAN_ROOM_SERVER);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
