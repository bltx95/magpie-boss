const byId = (id) => document.getElementById(id);
const embedToken = document.documentElement.dataset.embedToken;
const hosted = document.documentElement.dataset.hosted === "true";
const viewerPattern = /^web_[a-f0-9]{64}$/;
const viewerToken = hosted ? browserIdentity() : null;
const format = new Intl.NumberFormat("zh-CN");
const attackTime = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const outcomeLabels = {
  hit: "命中", critical: "暴击", dodge: "Boss 闪避", counter: "Boss 反击",
  overpower: "重暴击", followUp: "追击", execute: "斩杀", instant: "秒杀",
};
const pendingAnimations = [];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let displayedRoom;
let lastAttackId = 0;
let visibleBossLevel;
let lobbyRevision;
let displayedNickname;
let playing = false;

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
  try {
    while (pendingAnimations.length) {
      const { damage, outcome, kind, hp, skillName, bossLevel, comboBonus, killXp } = pendingAnimations.shift();
      if (reducedMotion.matches || document.hidden || byId("battle-view").hidden) continue;
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
  for (const id of ["open-join", "open-create", "open-profile"]) byId(id).disabled = !roomOnline || !room;
  if (!room) return;
  renderLobby(rooms, room, player, localLobby);
  byId("room-name").textContent = room.name;
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
  renderHistory(room, player);
  byId("open-share").hidden = Boolean(localLobby);
  byId("public-invite").hidden = Boolean(room.code) || localLobby;
  byId("room-invite").hidden = !room.code || localLobby;
  byId("invite-code").textContent = room.code ?? "";
  byId("invite-link-label").hidden = !inviteUrl;
  byId("invite-link-row").hidden = !inviteUrl;
  byId("invite-link").value = inviteUrl ?? "";
  byId("copy").disabled = !inviteUrl;
  byId("members").replaceChildren(...room.members.map((member) => {
    const item = document.createElement("li");
    item.textContent = `${member.name}${member.id === player.id ? "（你）" : ""} · Lv.${member.level}`;
    return item;
  }));
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
  const battle = view === "battle";
  byId("lobby-view").hidden = battle;
  byId("battle-view").hidden = !battle;
  byId("show-lobby").setAttribute("aria-pressed", String(!battle));
  byId("show-battle").setAttribute("aria-pressed", String(battle));
  if (!battle) {
    pendingAnimations.length = 0;
    for (const id of ["monster", "impact"]) byId(id).getAnimations().forEach((animation) => animation.cancel());
  }
  window.scrollTo(0, 0);
  byId(battle ? "room-name" : "lobby-title").focus({ preventScroll: true });
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
for (const id of ["show-battle", "open-battle"]) byId(id).addEventListener("click", () => showView("battle"));
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
  const fromLink = new URLSearchParams(location.search).get("invite");
  if (/^\d{8}$/.test(fromLink || "")) {
    byId("join-code").value = fromLink;
    const dialog = openDialog("join-dialog");
    try {
      const { name, owner } = await request("/api/invite", { code: fromLink });
      if (dialog.open && byId("join-code").value === fromLink) message(`${owner} 邀请你加入「${name}」。`, dialog);
    } catch (error) {
      if (dialog.open && byId("join-code").value === fromLink) message(error.message, dialog);
    }
  }
  setInterval(refresh, 3000);
}

void init();
