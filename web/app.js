const byId = (id) => document.getElementById(id);
const embedToken = document.documentElement.dataset.embedToken;
const hosted = document.documentElement.dataset.hosted === "true";
const inviteFromUrl = new URLSearchParams(location.search).get("invite");
const hasInvite = /^\d{8}$/.test(inviteFromUrl ?? "");
const viewerPattern = /^web_[a-f0-9]{64}$/;
const viewerToken = hosted ? browserIdentity() : null;
const format = new Intl.NumberFormat("zh-CN");
const attackTime = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const beijingDayFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const killTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short",
});
const viewTitles = { lobby: "lobby-title", battle: "room-name", kills: "kills-title", rankings: "rankings-title" };
const rankingBoards = {
  today: ["北京时间今日在本房造成的实际伤害。", "伤害"],
  week: ["北京时间周一零点起，在本房造成的实际伤害。", "伤害"],
  total: ["从有战报记录以来，在本房造成的累计伤害。", "伤害"],
  kills: ["按在本房打出最后一击并击败 Boss 的次数排名。", "击杀"],
  "best-hit": ["在本房单次攻击造成的最高实际伤害。", "伤害"],
};
const outcomeLabels = {
  hit: "命中", critical: "暴击", dodge: "Boss 闪避", counter: "Boss 反击",
  overpower: "重暴击", followUp: "追击", execute: "斩杀", instant: "秒杀",
};
const bossLines = [
  "愿你只在生产复现。",
  "但愿日志刚好没开。",
  "祝你合并时全是冲突。",
  "愿你回滚也要审批。",
  "愿你的索引刚好失效。",
  "愿缓存记住你的旧代码。",
  "愿你的断点永远差一行。",
  "愿提测时依赖刚好挂了。",
  "愿你的工单都写着「偶现」。",
  "愿测试只在 CI 上失败。",
  "愿你的构建卡在最后一步。",
  "愿代码评审赶上周五下班。",
  "愿你找遍日志，只看到重试。",
  "但愿你上线前还能改需求。",
  "愿你每次重启都要清缓存。",
  "祝你一调试，Bug 就消失。",
];
const pendingAnimations = [];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let displayedRoom;
let lastAttackId = 0;
let visibleBossLevel;
let lobbyRevision;
let displayedNickname;
let playing = false;
let openCurrentRoom = !hasInvite;
let currentPlayerId;
let roomMembers = [];
let memberDamage;
let membersRevision;
let killHistory;
let selectedBoard = "today";
let rankingView;

function browserIdentity() {
  const fromMagpie = new URLSearchParams(location.hash.slice(1)).get("viewer");
  if (viewerPattern.test(fromMagpie ?? "")) return fromMagpie;
  try {
    const saved = localStorage.getItem("magpie-boss-viewer");
    if (viewerPattern.test(saved ?? "")) return saved;
  } catch {
    // Magpie's sandbox can block browser storage.
  }
  const token = "web_" + Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem("magpie-boss-viewer", token); } catch { /* Opaque origin. */ }
  return token;
}

function today() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function request(path, body) {
  const headers = new Headers();
  if (embedToken) headers.set("X-Boss-Embed", embedToken);
  if (viewerToken) headers.set("Authorization", `Bearer ${viewerToken}`);
  const options = { headers };
  if (hosted) options.credentials = "omit";
  if (body !== undefined) {
    options.method = "POST";
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function playAttacks() {
  if (playing) return;
  playing = true;
  const monster = byId("monster");
  const impact = byId("impact");
  const stage = impact.parentElement;
  try {
    while (pendingAnimations.length) {
      const { damage, outcome, kind, hp, skillName, bossLevel, comboBonus, killXp } = pendingAnimations.shift();
      if (reducedMotion.matches || document.hidden || byId("battle-view").hidden) continue;
      stage.classList.add("is-attacking");
      const effect = kind ?? outcome;
      impact.dataset.outcome = effect;
      const victory = hp === 0 ? ` · 击败${killXp ? ` +${format.format(killXp)} XP` : ""}` : "";
      const damageText = damage ? `−${format.format(damage)} HP${victory}` : "闪避";
      const earlierBoss = bossLevel && bossLevel !== visibleBossLevel;
      const headline = [
        earlierBoss ? `第 ${format.format(bossLevel)} 关` : "", kind && outcomeLabels[kind],
        comboBonus && "团队连击", skillName,
      ].filter(Boolean).join(" · ");
      impact.textContent = headline ? `${headline}\n${damageText}` : damageText;
      const movement = {
        hit: ["translateX(0)", "translateX(9px) rotate(8deg)", "translateX(-5px)", "translateX(0)"],
        critical: ["scale(1)", "scale(.74) rotate(-14deg)", "scale(1.15)", "scale(1)"],
        dodge: ["translateX(0)", "translateX(24px)", "translateX(0)"],
        counter: ["scale(1)", "translateX(-12px) scale(1.22)", "scale(1)"],
        overpower: ["scale(1)", "scale(.58) rotate(-20deg)", "scale(1.2)", "scale(1)"],
        followUp: ["translateX(0)", "translateX(13px)", "translateX(-9px)", "translateX(10px)", "translateX(0)"],
        execute: ["scale(1)", "translateX(20px) rotate(-28deg) scale(.6)", "scale(1)"],
        instant: ["scale(1)", "scale(.28) rotate(30deg)", "scale(1)"],
      }[effect] ?? ["scale(1)", "scale(.9)", "scale(1)"];
      const hit = earlierBoss ? null : monster.animate(movement.map((transform) => ({ transform })), { duration: 460 });
      const number = impact.animate([
        { opacity: 0, transform: "translateY(10px) scale(.8)" },
        { opacity: 1, transform: "translateY(-4px) scale(1.08)", offset: .2 },
        { opacity: 1, transform: "translateY(-20px)", offset: .65 },
        { opacity: 0, transform: "translateY(-40px)" },
      ], { duration: 700, easing: "ease-out" });
      await Promise.allSettled([hit?.finished, number.finished]);
      impact.textContent = "";
    }
  } finally {
    stage.classList.remove("is-attacking");
    playing = false;
  }
}

function renderHistory(room, player) {
  const attacks = room.attacks ?? [];
  const latestId = attacks[0]?.id ?? 0;
  if (displayedRoom === room.id) {
    if (latestId <= lastAttackId) return;
    pendingAnimations.push(...attacks.filter((attack) => attack.id > lastAttackId).reverse());
    void playAttacks();
  } else {
    displayedRoom = room.id;
    pendingAnimations.length = 0;
    for (const id of ["monster", "impact"]) byId(id).getAnimations().forEach((animation) => animation.cancel());
  }
  lastAttackId = latestId;
  byId("history-empty").hidden = attacks.length > 0;
  byId("attack-history").replaceChildren(...attacks.map((attack) => {
    const item = document.createElement("li");
    const result = document.createElement("strong");
    const time = document.createElement("time");
    const name = attack.playerId === player.id ? "你" : attack.playerName;
    const effect = attack.kind ?? attack.outcome;
    result.dataset.outcome = effect;
    result.textContent = `${name} · ${outcomeLabels[effect] ?? outcomeLabels[attack.outcome] ?? "攻击"} · ${format.format(attack.damage)} 点伤害`;
    time.dateTime = attack.settledAt;
    time.textContent = attackTime.format(new Date(attack.settledAt));
    const details = document.createElement("span");
    const level = attack.bossLevel ? `第 ${attack.bossLevel} 关 · ` : "";
    const reward = attack.killXp ? `（最后一击 +${format.format(attack.killXp)} XP）` : "";
    details.textContent = `${level}+${format.format(attack.xp)} XP${reward} · ${attack.hp ? `Boss 剩 ${format.format(attack.hp)} HP` : "Boss 已击败"}`;
    item.append(result, details, time);
    if (attack.baseDamage != null) {
      const damage = document.createElement("span");
      damage.className = "history-damage";
      const combo = attack.comboBonus ? ` · 团队连击 +${attack.comboBonus}` : "";
      damage.textContent = `基础伤害 ${attack.baseDamage}${combo}`;
      item.append(damage);
    }
    if (attack.skillName) {
      const skill = document.createElement("span");
      skill.className = "history-skill";
      skill.textContent = `${attack.skillName} · ${attack.skillDetail}`;
      item.append(skill);
    }
    return item;
  }));
}

function renderBoss(room) {
  const boss = room.boss;
  const level = room.bossLevel ?? room.defeated + 1;
  byId("boss-name").textContent = `${boss?.name ?? "缓存怪"} · 第 ${format.format(level)} 关`;
  if (visibleBossLevel !== level) byId("monster").getAnimations().forEach((animation) => animation.cancel());
  visibleBossLevel = level;
  const combo = byId("team-combo");
  combo.hidden = !room.comboTarget;
  if (!combo.hidden) combo.textContent = `团队连击 ${room.combo ?? 0}/${room.comboTarget}`;
  for (const id of ["monster", "lobby-monster"]) {
    const sprite = byId(id);
    sprite.dataset.skin = boss?.skin ?? "cache";
    sprite.toggleAttribute("data-evolved", Boolean(boss?.evolved));
    sprite.style.setProperty("--boss-hue", String(boss?.hue ?? 287));
  }
  byId("boss-skill").hidden = !boss;
  if (!boss) return;
  byId("skill-name").textContent = boss.skill.name;
  byId("skill-description").textContent = boss.skill.description;
  const countdown = byId("skill-cooldown");
  countdown.hidden = room.nextSkillIn == null;
  if (!countdown.hidden) {
    if (room.skillTurnsLeft) {
      countdown.textContent = boss.skin === "ghost" ? "残影生效：下一击减伤" : `护盾还持续 ${room.skillTurnsLeft} 次攻击`;
    } else {
      countdown.textContent = room.nextSkillIn === 1 ? "下一击触发" : `还有 ${room.nextSkillIn} 次攻击触发`;
    }
  }
  const protection = byId("finisher-protection");
  protection.hidden = !boss.finisherThreshold;
  if (!protection.hidden) protection.textContent = `斩杀与秒杀只在血量 ≤ ${boss.finisherThreshold}% 且未触发技能时生效。`;
}

function renderMembers(rows) {
  const revision = JSON.stringify([roomMembers, rows, currentPlayerId]);
  if (membersRevision === revision) return;
  membersRevision = revision;
  const stats = new Map((rows ?? []).map((row) => [row.playerId, row]));
  const score = (member) => stats.get(member.id)?.todayDamage ?? 0;
  const sorted = [...roomMembers].sort((a, b) => score(b) - score(a));
  let rank = 0;
  byId("members").replaceChildren(...sorted.map((member, index) => {
    const item = document.createElement("li");
    const self = member.id === currentPlayerId;
    const contribution = stats.get(member.id);
    const points = score(member);
    item.toggleAttribute("data-self", self);
    const position = document.createElement("span");
    position.className = "member-rank";
    if (index === 0 || points !== score(sorted[index - 1])) rank = index + 1;
    position.textContent = points > 0 ? format.format(rank) : "—";
    const person = document.createElement("div");
    person.className = "member-person";
    const name = document.createElement("span");
    name.textContent = `${member.name}${self ? "（你）" : ""}`;
    const level = document.createElement("span");
    level.className = "member-level";
    level.textContent = `Lv.${member.level}`;
    person.append(name, level);
    if (contribution?.todayMvp) {
      const badge = document.createElement("span");
      badge.className = "member-badge";
      badge.textContent = "今日主力";
      badge.title = "今天在本房造成的伤害最高";
      person.append(badge);
    }
    const damage = document.createElement("strong");
    damage.className = "member-damage";
    damage.textContent = rows ? format.format(points) : "—";
    item.append(position, person, damage);
    return item;
  }));
}

async function refreshMemberDamage() {
  if (byId("battle-view").hidden || !displayedRoom) return;
  const status = byId("member-damage-status");
  const day = beijingDayFormat.format(new Date());
  if (memberDamage?.roomId !== displayedRoom || memberDamage.day !== day) {
    memberDamage = { roomId: displayedRoom, day, rows: null };
    status.hidden = true;
  }
  const view = memberDamage;
  renderMembers(view.rows);
  const key = `${lastAttackId}/${roomMembers.map((member) => member.id).join(",")}`;
  if (view.loadedKey === key || view.pendingKey === key) return;
  view.pendingKey = key;
  const stillCurrent = () => view === memberDamage && view.roomId === displayedRoom && view.pendingKey === key;
  try {
    const result = await request("/api/member-damage");
    if (!stillCurrent() || result.roomId !== view.roomId) return;
    view.rows = result.rows;
    view.loadedKey = key;
    status.hidden = true;
    renderMembers(view.rows);
  } catch {
    if (stillCurrent() && !view.rows) status.hidden = false;
  } finally {
    if (view.pendingKey === key) view.pendingKey = null;
  }
}

function rankingStatus(text) {
  const status = byId("ranking-status");
  status.textContent = text;
  status.hidden = !text;
  byId("ranking-results").hidden = Boolean(text);
}

function renderRankings(rows) {
  const [, metric] = rankingBoards[selectedBoard];
  const best = rows[0]?.score ?? 0;
  const cards = rows.map((entry) => {
    const row = document.createElement("li");
    row.className = "ranking-card";
    const self = entry.playerId === currentPlayerId;
    row.toggleAttribute("data-self", self);
    if (entry.rank <= 3) row.dataset.medal = String(entry.rank);
    const position = document.createElement("span");
    position.className = "ranking-position";
    position.textContent = format.format(entry.rank);
    position.title = `第 ${entry.rank} 名`;
    const player = document.createElement("div");
    player.className = "ranking-player";
    const avatar = document.createElement("span");
    avatar.className = "ranking-avatar";
    avatar.textContent = [...entry.playerName][0] ?? "·";
    avatar.setAttribute("aria-hidden", "true");
    const identity = document.createElement("div");
    identity.className = "ranking-identity";
    const name = document.createElement("strong");
    name.textContent = `${entry.playerName}${self ? "（你）" : ""}`;
    name.title = name.textContent;
    identity.append(name);
    if (!entry.isMember) {
      const former = document.createElement("span");
      former.className = "rankings-former";
      former.textContent = "已离房";
      identity.append(former);
    }
    player.append(avatar, identity);
    const score = document.createElement("div");
    score.className = "ranking-score";
    const value = document.createElement("strong");
    value.textContent = format.format(entry.score);
    const unit = document.createElement("span");
    unit.textContent = metric;
    score.append(value, unit);
    row.style.setProperty("--score-share", `${best ? 100 * entry.score / best : 0}%`);
    row.append(position, player, score);
    return row;
  });
  byId("ranking-leaders").replaceChildren(...cards.slice(0, 3));
  byId("ranking-rows").replaceChildren(...cards.slice(3));
  rankingStatus(rows.length ? "" : "这个榜单还没有记录。");
}

async function refreshRankings() {
  if (byId("rankings-view").hidden || !displayedRoom) return;
  if (rankingView?.roomId !== displayedRoom || rankingView.board !== selectedBoard) {
    rankingView = { roomId: displayedRoom, board: selectedBoard };
    rankingStatus("正在加载排行榜…");
  }
  const view = rankingView;
  const day = beijingDayFormat.format(new Date());
  const key = JSON.stringify([day, lastAttackId, currentPlayerId, roomMembers.map(({ id, name }) => [id, name])]);
  if (view.loadedKey === key || view.pendingKey === key) return;
  view.pendingKey = key;
  const stillCurrent = () => view === rankingView && view.pendingKey === key && view.roomId === displayedRoom;
  try {
    const result = await request(`/api/rankings?${new URLSearchParams({ board: view.board })}`);
    if (!stillCurrent() || result.roomId !== view.roomId || result.board !== view.board) return;
    view.loadedKey = key;
    renderRankings(result.rows);
  } catch {
    if (stillCurrent() && !view.loadedKey) rankingStatus("暂时无法加载排行榜，稍后重试。");
  } finally {
    if (view.pendingKey === key) view.pendingKey = null;
  }
}

function selectBoard(board) {
  selectedBoard = board;
  for (const button of document.querySelectorAll("[data-board]")) {
    button.setAttribute("aria-pressed", String(button.dataset.board === board));
  }
  const [description] = rankingBoards[board];
  byId("ranking-description").textContent = description;
  void refreshRankings();
}

function killRow(record) {
  const item = document.createElement("li");
  item.className = "kill-card";
  item.style.setProperty("--portrait-hue", String(record.bossHue ?? 287));
  item.toggleAttribute("data-evolved", Boolean(record.bossEvolved));
  const details = document.createElement("div");
  details.className = "kill-details";
  const name = document.createElement("h2");
  name.textContent = record.bossName;
  const stage = document.createElement("span");
  stage.className = "kill-stage";
  stage.textContent = record.bossLevel ? `第 ${format.format(record.bossLevel)} 关` : "关卡未记录";
  const finisher = document.createElement("p");
  finisher.className = "kill-finisher";
  const player = document.createElement("strong");
  player.textContent = `${record.playerName}${record.playerId === currentPlayerId ? "（你）" : ""}`;
  finisher.append("最后一击 ", player);
  const time = document.createElement("time");
  time.dateTime = record.settledAt;
  time.textContent = killTimeFormat.format(new Date(record.settledAt));
  time.title = "北京时间";
  details.append(stage, name, finisher, time);
  const portrait = document.createElement("div");
  portrait.className = "kill-portrait";
  portrait.dataset.skin = record.bossSkin ?? "unknown";
  portrait.setAttribute("aria-hidden", "true");
  item.append(details, portrait);
  return item;
}

async function loadKills() {
  const view = killHistory;
  if (!view || view.pending || byId("kills-view").hidden) return;
  const button = byId("kills-more");
  const status = byId("kills-status");
  const search = view.before == null ? "" : `?${new URLSearchParams({ before: view.before })}`;
  view.pending = true;
  button.disabled = true;
  try {
    const result = await request(`/api/kills${search}`);
    if (view !== killHistory || result.roomId !== displayedRoom) return;
    byId("kills-list").append(...result.rows.map(killRow));
    if (view.before == null) {
      status.textContent = "这间房还没有击杀记录。";
      status.hidden = result.rows.length > 0;
    } else {
      status.hidden = true;
    }
    view.before = result.nextBefore;
    button.textContent = "查看更早的击杀";
    button.hidden = view.before == null;
  } catch {
    if (view !== killHistory) return;
    status.textContent = "暂时无法加载击杀记录。";
    status.hidden = false;
    button.textContent = "重试";
    button.hidden = false;
  } finally {
    view.pending = false;
    if (view === killHistory) button.disabled = false;
  }
}

function syncKillHistory() {
  if (byId("kills-view").hidden || !displayedRoom || killHistory?.roomId === displayedRoom) return;
  killHistory = { roomId: displayedRoom, before: null, pending: false };
  byId("kills-list").replaceChildren();
  byId("kills-more").hidden = true;
  const status = byId("kills-status");
  status.textContent = "正在加载击杀记录…";
  status.hidden = false;
  void loadKills();
}

function renderLobby(rooms, room, player, localLobby) {
  byId("lobby-scope").hidden = !localLobby;
  byId("current-room").hidden = false;
  byId("lobby-room-name").textContent = room.name;
  byId("lobby-boss").textContent = `${room.boss?.name ?? "Boss"} · 第 ${format.format(room.bossLevel ?? room.defeated + 1)} 关`;
  byId("lobby-hp-label").textContent = `${format.format(room.hp)} / ${format.format(room.maxHp)} HP`;
  byId("lobby-hp").max = room.maxHp;
  byId("lobby-hp").value = room.hp;
  if (displayedNickname !== player.name) {
    byId("profile-name").textContent = player.name;
    byId("profile-initial").textContent = [...player.name][0] ?? "·";
    displayedNickname = player.name;
  }
  const otherRooms = rooms.filter((entry) => entry.id !== room.id);
  const revision = JSON.stringify(otherRooms);
  if (revision === lobbyRevision) return;
  lobbyRevision = revision;
  byId("room-list-empty").hidden = otherRooms.length > 0;
  byId("room-list").replaceChildren(...otherRooms.map((entry) => {
    const item = document.createElement("li");
    const title = document.createElement("div");
    const label = document.createElement("strong");
    const details = document.createElement("small");
    const button = document.createElement("button");
    item.className = "room-card";
    title.className = "room-card-title";
    label.textContent = entry.name;
    details.textContent = `${entry.visibility === "public" ? "公开" : "私人"} · ${entry.memberCount} 人 · 第 ${entry.bossLevel} 关`;
    button.className = "secondary";
    button.type = "button";
    button.textContent = "进入";
    button.setAttribute("aria-label", `进入${entry.name}`);
    button.addEventListener("click", () => { void move("/api/rooms/join", { roomId: entry.id }, button); });
    title.append(label, details);
    item.append(title, button);
    return item;
  }));
}

function render({ room, rooms = [], player, usage, usageOnline, roomOnline, inviteUrl, pending, localLobby, bound, todayAttacks }) {
  byId("local-calls").hidden = hosted;
  byId("local-tokens").hidden = hosted;
  if (hosted) {
    roomOnline = true;
    inviteUrl = room?.code ? new URL(`/invite/${room.code}`, location.href).href : null;
    byId("attacks").textContent = format.format(todayAttacks ?? 0);
    byId("open-pair").hidden = Boolean(bound) || !room;
    const pairing = byId("pair-dialog");
    if (bound && pairing.open) pairing.close();
  } else {
    byId("calls").textContent = formatCompactCount(usage.calls, 1000, "K");
    byId("calls").title = format.format(usage.calls);
    byId("tokens").textContent = formatCompactCount(usage.tokens, 1_000_000, "M");
    byId("tokens").title = format.format(usage.tokens);
    byId("attacks").textContent = format.format(usage.attacks);
  }
  const status = [];
  if (hosted) status.push(bound ? "Magpie 角色已绑定" : "访客 · 可加入房间");
  else if (!usageOnline) status.push("正在等待 Magpie 用量数据");
  if (!roomOnline) status.push("房间服务暂时离线");
  if (pending) status.push(`${pending} 次攻击待同步`);
  byId("status").textContent = status.join(" · ") || "后台结算已开启";
  byId("status").parentElement.dataset.online = String(hosted || (usageOnline && roomOnline));
  for (const id of ["open-join", "open-create", "open-profile", "open-kills", "open-rankings"]) byId(id).disabled = !roomOnline || !room;
  if (!room) return;
  renderLobby(rooms, room, player, localLobby);
  byId("room-name").textContent = room.name;
  byId("kills-room-name").textContent = room.name;
  byId("rankings-room-name").textContent = room.name;
  renderBoss(room);
  byId("level").textContent = format.format(player.level);
  const levelProgress = byId("level-progress");
  levelProgress.hidden = !player.nextLevelXp;
  if (!levelProgress.hidden) {
    levelProgress.textContent = `${format.format(player.levelXp)} / ${format.format(player.nextLevelXp)} XP`;
  }
  byId("hp").max = room.maxHp;
  byId("hp").value = room.hp;
  byId("hp-label").textContent = room.hp ? `${room.hp} / ${room.maxHp} HP` : "Boss 已击败";
  byId("victories").textContent = `累计击败 ${room.defeated} 只`;
  currentPlayerId = player.id;
  roomMembers = room.members;
  renderHistory(room, player);
  byId("open-share").hidden = Boolean(localLobby);
  byId("public-invite").hidden = Boolean(room.code) || localLobby;
  byId("room-invite").hidden = !room.code || localLobby;
  byId("invite-code").textContent = room.code ?? "";
  byId("invite-link-label").hidden = !inviteUrl;
  byId("invite-link-row").hidden = !inviteUrl;
  byId("invite-link").value = inviteUrl ?? "";
  byId("copy").disabled = !inviteUrl;
  // Keep pairing available while an unbound visitor is still in the default lobby.
  if (openCurrentRoom && (!hosted || bound || room.id !== "lobby") && !document.querySelector("dialog[open]")) {
    showView("battle");
  } else {
    void refreshMemberDamage();
    syncKillHistory();
    void refreshRankings();
  }
}

async function refresh() {
  try {
    const path = hosted ? `/api/state?day=${today()}` : "/api/state";
    try {
      render(await request(path));
    } catch (error) {
      if (!hosted || error.status !== 404) throw error;
      await request("/api/player", {});
      render(await request(path));
    }
  } catch {
    byId("status").textContent = hosted ? "云端大厅暂时无法连接，正在重试。" : "本机插件暂时离线，请检查 Magpie 是否正在运行。";
    byId("status").parentElement.dataset.online = "false";
  }
}

function showView(view) {
  openCurrentRoom = false;
  const battle = view === "battle";
  const lobby = view === "lobby";
  for (const page of Object.keys(viewTitles)) byId(`${page}-view`).hidden = page !== view;
  byId("show-lobby").setAttribute("aria-pressed", String(lobby));
  byId("show-battle").setAttribute("aria-pressed", String(battle));
  if (!battle) {
    pendingAnimations.length = 0;
    for (const id of ["monster", "impact"]) byId(id).getAnimations().forEach((animation) => animation.cancel());
  }
  window.scrollTo(0, 0);
  byId(viewTitles[view]).focus({ preventScroll: true });
  if (battle) void refreshMemberDamage();
  if (view === "kills") {
    killHistory = null;
    syncKillHistory();
  }
  if (view === "rankings") {
    rankingView = null;
    selectBoard(selectedBoard);
  }
}

function bindBossSpeech() {
  const bubbles = document.querySelectorAll(".boss-line");
  const announcement = byId("boss-announcement");
  let lastLine = -1;
  let lastHover = -Infinity;
  let idleTimer;
  let hideTimer;

  function scheduleIdle(delay = 13000 + Math.random() * 8000) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (document.hidden || !visibleBossLevel || playing || document.querySelector("dialog[open]")) {
        scheduleIdle();
        return;
      }
      speak();
    }, delay);
  }

  function speak(announce = false) {
    const choices = lastLine < 0 ? bossLines.length : bossLines.length - 1;
    const pick = Math.floor(Math.random() * choices);
    lastLine = lastLine >= 0 && pick >= lastLine ? pick + 1 : pick;
    const line = bossLines[lastLine];
    for (const bubble of bubbles) bubble.textContent = line;
    if (announce) announcement.textContent = line;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      for (const bubble of bubbles) bubble.textContent = "";
      announcement.textContent = "";
    }, 4500);
    scheduleIdle();
  }

  for (const button of document.querySelectorAll(".boss-trigger")) {
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" || performance.now() - lastHover < 2500) return;
      lastHover = performance.now();
      speak();
    });
    button.addEventListener("click", () => speak(true));
  }
  scheduleIdle(4500 + Math.random() * 3500);
}

function message(text, dialog) {
  const target = dialog ? dialog.querySelector(".dialog-message") : byId("action-message");
  target.textContent = text;
}

function openDialog(id) {
  const dialog = byId(id);
  message("", dialog);
  if (!dialog.open) dialog.showModal();
  return dialog;
}

async function move(path, body, button) {
  const dialog = button.closest("dialog");
  button.disabled = true;
  message("", dialog);
  try {
    const { room } = await request(path, body);
    byId("join-code").value = "";
    if (!embedToken && location.search) {
      try { history.replaceState(null, "", `/${location.hash}`); } catch { /* Opaque origin. */ }
    }
    dialog?.close();
    message(`已进入「${room.name}」。`);
    await refresh();
    showView("battle");
    return true;
  } catch (error) {
    message(error.message, dialog?.open ? dialog : null);
    return false;
  } finally {
    button.disabled = false;
  }
}

function bindForm(formId, buttonId, submit) {
  const form = byId(formId);
  const button = byId(buttonId);
  const run = () => {
    if (!button.disabled && form.reportValidity()) void submit(button);
  };
  button.addEventListener("click", run);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "radio") {
      event.preventDefault();
      run();
    }
  });
  form.addEventListener("submit", (event) => { event.preventDefault(); run(); });
}

byId("show-lobby").addEventListener("click", () => showView("lobby"));
for (const id of ["show-battle", "open-battle", "back-to-battle", "rankings-back"]) byId(id).addEventListener("click", () => showView("battle"));
byId("open-kills").addEventListener("click", () => showView("kills"));
byId("kills-more").addEventListener("click", () => { void loadKills(); });
byId("open-rankings").addEventListener("click", () => showView("rankings"));
for (const button of document.querySelectorAll("[data-board]")) {
  button.addEventListener("click", () => selectBoard(button.dataset.board));
}
byId("open-join").addEventListener("click", () => openDialog("join-dialog"));
byId("open-create").addEventListener("click", () => openDialog("create-dialog"));
byId("open-share").addEventListener("click", () => openDialog("share-dialog"));
byId("open-guide").addEventListener("click", () => byId("guide-dialog").showModal());
byId("open-pair").addEventListener("click", async () => {
  const dialog = openDialog("pair-dialog");
  byId("pair-code").value = "";
  byId("copy-pair").disabled = true;
  try {
    byId("pair-code").value = (await request("/api/browser/code", {})).code;
    byId("copy-pair").disabled = false;
  } catch (error) {
    message(error.message, dialog);
  }
});
byId("open-profile").addEventListener("click", () => {
  byId("nickname").value = displayedNickname ?? "";
  openDialog("profile-dialog");
});
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

bindForm("join-form", "join", (button) => move("/api/join", { code: byId("join-code").value.trim() }, button));
bindForm("create-form", "create", async (button) => {
  const name = byId("new-room").value.trim();
  const visibility = new FormData(byId("create-form")).get("room-visibility");
  if (await move("/api/rooms", { name, visibility }, button)) byId("new-room").value = "";
});
bindForm("profile-form", "rename", async (button) => {
  const dialog = byId("profile-dialog");
  button.disabled = true;
  message("", dialog);
  try {
    const { player } = await request("/api/profile", { nickname: byId("nickname").value.trim() });
    dialog.close();
    message(`昵称已更新为「${player.name}」。`);
    await refresh();
  } catch (error) {
    message(error.message, dialog.open ? dialog : null);
  } finally {
    button.disabled = false;
  }
});
byId("join-code").addEventListener("input", () => message("", byId("join-dialog")));

async function copyInvite(source, label, dialog = byId("share-dialog")) {
  try {
    await navigator.clipboard.writeText(source.value ?? source.textContent);
    message(`已复制${label}。`, dialog);
  } catch {
    if (source instanceof HTMLInputElement) source.select();
    else window.getSelection()?.selectAllChildren(source);
    message(`已选中${label}，可直接复制。`, dialog);
  }
}

byId("copy").addEventListener("click", () => copyInvite(byId("invite-link"), "邀请链接"));
byId("copy-code").addEventListener("click", () => copyInvite(byId("invite-code"), "邀请码"));
byId("copy-pair").addEventListener("click", () => copyInvite(byId("pair-code"), "配对码", byId("pair-dialog")));

async function init() {
  await refresh();
  if (hasInvite) {
    byId("join-code").value = inviteFromUrl;
    const dialog = openDialog("join-dialog");
    try {
      const { name, owner } = await request("/api/invite", { code: inviteFromUrl });
      if (dialog.open && byId("join-code").value === inviteFromUrl) message(`${owner} 邀请你加入「${name}」。`, dialog);
    } catch (error) {
      if (dialog.open && byId("join-code").value === inviteFromUrl) message(error.message, dialog);
    }
  }
  setInterval(refresh, 3000);
}

bindBossSpeech();
void init();
