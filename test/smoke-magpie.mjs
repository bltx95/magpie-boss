import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoomService } from "../room-server.mjs";
import { DAMAGE_VARIATIONS } from "../boss.mjs";
import { toUsage } from "../usage.mjs";

const binary = process.argv[2] || "magpie";
const plugin = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "magpie-boss-smoke-"));
const processes = [];
const rooms = createRoomService(join(root, "rooms.sqlite"), {
  roll: (max) => max === 100 ? 99 : max === DAMAGE_VARIATIONS ? 3 : 999,
});
const roomServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: rooms.fetch });
const upstream = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [{ id: "smoke" }] });
    const body = await request.json();
    const completion = {
      id: "chatcmpl-smoke", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
    };
    if (body.stream) {
      const chunk = { ...completion, object: "chat.completion.chunk", usage: undefined };
      const events = [
        { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { ...chunk, choices: [], usage: completion.usage },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return Response.json(completion);
  },
});

async function checked(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned ${response.status}: ${await response.text()}`);
  return response;
}

async function until(run, check = Boolean) {
  let last;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      last = await run();
      if (check(last)) return last;
    } catch (error) {
      last = error.message;
    }
    await Bun.sleep(350);
  }
  throw new Error(`Timed out waiting for Magpie Boss: ${JSON.stringify(last)}`);
}

function freePort() {
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = socket;
  socket.stop(true);
  return port;
}

async function boot(nickname, profile, settings) {
  const env = {
    ...process.env,
    HOME: profile,
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_CACHE_HOME: join(profile, "cache"),
    MAGPIE_ADDR: `127.0.0.1:${settings.gatewayPort}`,
    MAGPIE_BUN: process.execPath,
    MAGPIE_PLUGIN_MARKET: "off",
  };
  const cli = async (...args) => {
    const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [status, output, errors] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    assert.equal(status, 0, `${args.join(" ")}: ${output}\n${errors}`);
  };
  if (settings.install) {
    await cli("plugin", "add", plugin);
    await cli("plugin", "options", "magpie-boss", JSON.stringify({
      nickname, localPort: settings.localPort, roomServer: roomServer.url.origin,
    }));
    await cli("provider", "add", "Boss Smoke", `url=${upstream.url.origin}/v1`, "key=sk-smoke", "models=smoke", "list=off");
  }
  const child = Bun.spawn([binary, "serve"], { env, stdout: "ignore", stderr: "pipe" });
  const errors = new Response(child.stderr).text();
  processes.push({ child, errors });
  const local = `http://127.0.0.1:${settings.localPort}`;
  const gateway = `http://${env.MAGPIE_ADDR}`;
  const snapshot = async () => (await checked(`${local}/api/state`)).json();
  const invoke = async (path, body) => (await checked(`${local}${path}`, {
    method: "POST", headers: { Origin: local, "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json();
  const call = async (stream = false) => (await checked(`${gateway}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer magpie" },
    body: JSON.stringify({
      model: "boss-smoke/smoke", messages: [{ role: "user", content: "Reply OK." }],
      stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
    }),
  })).text();
  await until(snapshot, (state) => state.roomOnline && state.usageOnline);
  return { child, local, gateway, snapshot, invoke, call };
}

async function checkBrowser(url, ...texts) {
  const chrome = process.env.BOSS_SMOKE_CHROME;
  if (!chrome) return;
  const child = Bun.spawn([chrome, "--headless", "--disable-gpu", "--disable-background-networking",
    "--no-first-run", `--user-data-dir=${join(root, "chrome")}`, "--virtual-time-budget=4000", "--dump-dom", url],
  { stdout: "pipe", stderr: "ignore" });
  const html = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0);
  for (const text of texts) assert.ok(html.includes(text), `Browser did not render: ${text}`);
}

try {
  const aSettings = { localPort: freePort(), gatewayPort: freePort(), install: true };
  const bSettings = { localPort: freePort(), gatewayPort: freePort(), install: true };
  const a = await boot("Alice", join(root, "alice"), aSettings);
  const b = await boot("Bob", join(root, "bob"), bSettings);
  const aDefault = await a.snapshot();
  const bStart = await b.snapshot();
  assert.equal(aDefault.room.id, "lobby");
  assert.equal(bStart.room.id, aDefault.room.id);
  assert.equal(bStart.room.members.length, 2);
  await a.invoke("/api/rooms", { name: "联调房间", visibility: "private" });
  const aStart = await a.snapshot();
  assert.equal(aStart.room.hp, 60);
  assert.equal(aStart.room.members.length, 1);
  assert.notEqual(aStart.room.id, bStart.room.id);
  console.log("两个真实 Magpie 实例在首次 AI 调用前自动进入公共大厅。");

  const invitePage = await (await checked(aStart.inviteUrl)).text();
  const inviteUrl = invitePage.match(/http:\/\/127\.0\.0\.1:\d+\/\?invite=\d{8}/)?.[0];
  assert.ok(inviteUrl);
  const inviteCode = new URL(inviteUrl).searchParams.get("invite");
  assert.equal(inviteCode, aStart.room.code);
  await checkBrowser(`${b.local}/?invite=${inviteCode}`, "Alice 邀请你加入「联调房间」。");
  assert.equal((await b.invoke("/api/invite", { code: inviteCode })).owner, "Alice");
  assert.equal((await b.invoke("/api/profile", { nickname: "Bobby" })).player.name, "Bobby");
  assert.equal((await b.invoke("/api/join", { code: inviteCode })).room.id, aStart.room.id);
  const app = await checked(b.local);
  assert.match(await app.text(), /id="join-form"/);
  assert.match((await checked(`${b.local}/app.js`)).headers.get("content-type"), /javascript/);

  const [, stream] = await Promise.all([a.call(), b.call(true)]);
  assert.match(stream, /data: \[DONE\]/);
  const usageLog = await (await checked(`${a.gateway}/v1/magpie/usage/requests?period=today&limit=10`)).json();
  const row = usageLog.rows.find((item) => item.model === "smoke");
  assert.ok(row, `No model request recorded: ${JSON.stringify(usageLog.rows)}`);
  assert.ok(toUsage(row, 0)?.success, `Unexpected final usage row: ${JSON.stringify(row)}`);
  const joinedA = await until(a.snapshot, (state) => state.room.hp === 40);
  const joinedB = await until(b.snapshot, (state) => state.room.hp === 40);
  assert.equal(joinedA.room.id, joinedB.room.id);
  assert.equal(joinedA.room.members.length, 2);
  assert.deepEqual(joinedA.usage, { calls: 1, tokens: 100, attacks: 1 });
  assert.deepEqual(joinedB.usage, { calls: 1, tokens: 100, attacks: 1 });
  assert.equal(joinedA.room.attacks.length, 2);
  assert.deepEqual(joinedA.room.attacks, joinedB.room.attacks);
  const rankDays = joinedB.room.attacks.map(({ settledAt }) => new Date(Date.parse(settledAt) + 8 * 3600000).toISOString().slice(0, 10));
  for (const day of new Set(rankDays)) {
    const ranks = await (await checked(`${b.local}/api/leaderboard?day=${day}`)).json();
    assert.equal(ranks.roomId, joinedB.room.id);
    assert.deepEqual(ranks.rows.map(({ rank, damage }) => [rank, damage]), rankDays.filter((value) => value === day).map(() => [1, 10]));
  }
  const memberDamage = await (await checked(`${b.local}/api/member-damage`)).json();
  assert.equal(memberDamage.roomId, joinedB.room.id);
  const beijingToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  assert.deepEqual(memberDamage.rows.map(({ todayDamage }) => todayDamage), rankDays.filter((day) => day === beijingToday).map(() => 10));
  await checkBrowser(b.local, "命中 · 10 点伤害", "10 / 250 XP", 'id="open-guide"', "玩法指引", "今日伤害", "房间排行榜");
  console.log("没有打开房间页面时，两次真实网关请求让同一只 Boss 从 60 HP 降到 40 HP。");

  for (let attack = 0; attack < 3; attack++) await a.call();
  const shielded = await until(a.snapshot, (state) => state.room.hp === 8);
  assert.equal(shielded.room.attacks.find((attack) => attack.skillName === "缓存护盾")?.damage, 7);
  assert.equal(shielded.room.attacks[0].comboBonus, 5);
  await checkBrowser(a.local, "团队连击 +5");
  await a.call();
  const levelTwo = await until(a.snapshot, (state) => state.room.bossLevel === 2);
  assert.equal(levelTwo.usage.attacks, 5);
  assert.equal(levelTwo.room.hp, 80);
  assert.equal(levelTwo.room.maxHp, 80);
  assert.equal(levelTwo.room.attacks[0].hp, 0);
  assert.equal(levelTwo.room.attacks[0].bossLevel, 1);
  assert.equal(levelTwo.room.attacks[0].killXp, 20);
  const kills = await (await checked(`${a.local}/api/kills`)).json();
  assert.equal(kills.rows.length, 1);
  assert.equal(kills.rows[0].bossLevel, 1);
  assert.equal(kills.rows[0].playerId, levelTwo.player.id);
  const killRanks = await (await checked(`${a.local}/api/rankings?board=kills`)).json();
  assert.deepEqual(killRanks.rows.map(({ playerId, score }) => [playerId, score]), [[levelTwo.player.id, 1]]);
  await a.call();
  const progressed = await until(a.snapshot, (state) => state.room.hp === 70);
  assert.equal(progressed.room.attacks[0].bossLevel, 2);
  await checkBrowser(a.local, "延迟幽灵 · 第 2 关", "相位闪避", 'data-skin="ghost"', "最后一击 +20 XP");
  console.log("缓存护盾实际抵消了伤害，击败缓存怪后立即出现会相位闪避的延迟幽灵。");

  b.child.kill();
  await b.child.exited;
  const restarted = await boot("Bob", join(root, "bob"), { ...bSettings, install: false });
  const state = await restarted.snapshot();
  assert.equal(state.player.id, bStart.player.id);
  assert.equal(state.player.name, "Bobby");
  assert.equal(state.room.hp, 70);
  assert.equal(state.room.bossLevel, 2);
  assert.equal(state.room.nextSkillIn, progressed.room.nextSkillIn);
  assert.deepEqual(state.usage, joinedB.usage);
  assert.deepEqual(state.room.attacks, progressed.room.attacks);
  console.log("重启后保留房间和用量，攻击未重复结算。");
} catch (error) {
  for (const { child } of processes) child.kill();
  for (const { errors } of processes) console.error((await errors).split("\n").filter((line) => /Boss|listen tcp|plugin.*failed/.test(line)).join("\n"));
  throw error;
} finally {
  for (const { child } of processes) child.kill();
  await Promise.all(processes.map(({ child }) => child.exited));
  upstream.stop(true);
  roomServer.stop(true);
  rooms.close();
  await rm(root, { recursive: true, force: true });
}
