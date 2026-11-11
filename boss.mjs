const BOSSES = [
  { name: "缓存怪", skin: "cache", hue: 287, skill: "缓存护盾", interval: 4, minimum: 2 },
  { name: "延迟幽灵", skin: "ghost", hue: 186, skill: "相位闪避", interval: 5, minimum: 3 },
  { name: "栈甲巨像", skin: "golem", hue: 28, skill: "棘甲反震", interval: 4, minimum: 2 },
  { name: "回滚史莱姆", skin: "slime", hue: 116, skill: "回滚再生", interval: 3, minimum: 2 },
  { name: "镜像双子", skin: "mirror", hue: 234, skill: "镜面折射" },
];

const FORMS = ["超频", "裂隙", "觉醒", "深渊"];
export const COMBO_TARGET = 5;
export const MIN_DAMAGE = 7;
export const DAMAGE_VARIATIONS = 7;

export function bossForLevel(level) {
  const index = level - 1;
  const cycle = Math.floor(index / BOSSES.length);
  const { name, skin, hue, skill, interval, minimum } = BOSSES[index % BOSSES.length];
  const form = cycle ? FORMS[(cycle - 1) % FORMS.length] : "";
  const power = Math.floor(24 + 60 * (level / (level + 9)));
  const skillInterval = interval ? Math.max(minimum, interval - cycle) : null;
  const recovery = Math.floor(4 + 16 * (level / (level + 12)));
  const effects = {
    cache: `削弱这次攻击 ${power}% 的伤害`,
    ghost: "闪避整次攻击",
    golem: `削弱 ${power}% 的伤害，并扣减本次获得的经验`,
    slime: `在受到伤害后恢复最多 ${recovery} HP`,
    mirror: `每次受到暴击时，削弱 ${power + 12}% 的暴击伤害`,
  };
  return {
    name: form ? `${form}·${name}（第 ${cycle + 1} 形态）` : name,
    skin,
    hue: (hue + (cycle % 360) * 23) % 360,
    evolved: cycle > 0,
    skill: {
      name: form ? `${form}·${skill}` : skill,
      description: skillInterval ? `每 ${skillInterval} 次攻击，${effects[skin]}。` : `${effects[skin]}。`,
      interval: skillInterval,
      power,
      recovery,
    },
  };
}

function attackProfile(roll) {
  if (roll < 10) return { outcome: "dodge", multiplier: 0, xp: 0 };
  if (roll < 25) return { outcome: "critical", multiplier: 2, xp: 10 };
  if (roll < 35) return { outcome: "counter", multiplier: 1, xp: 5 };
  if (roll < 40) return { outcome: "critical", kind: "overpower", multiplier: 3, xp: 15 };
  if (roll < 50) return { outcome: "hit", kind: "followUp", multiplier: 1.5, xp: 10 };
  return { outcome: "hit", multiplier: 1, xp: 10 };
}

export function resolveAttack(boss, turn, roll, hp, maxHp, {
  baseDamage = 10, finisherRoll = 999, combo = 0,
} = {}) {
  const { skill, skin } = boss;
  const profile = attackProfile(roll);
  const triggered = skill.interval ? turn % skill.interval === 0 : profile.outcome === "critical";
  if (triggered && skin === "ghost") {
    return {
      outcome: "dodge", kind: null, damage: 0, xp: 0, hp, baseDamage: null, comboBonus: 0, combo: 0,
      skillName: skill.name, skillDetail: "闪避了这次攻击",
    };
  }

  const { outcome, kind = null, multiplier } = profile;
  const landed = outcome !== "dodge";
  const instant = landed && finisherRoll < 5;
  const execute = landed && hp <= maxHp / 4 && finisherRoll < 105;
  if (instant || execute) {
    return {
      outcome: "critical", kind: instant ? "instant" : "execute", damage: hp, xp: instant ? 30 : 20,
      hp: 0, baseDamage: null, comboBonus: 0, combo: 0, skillName: null, skillDetail: null,
    };
  }

  const streak = landed ? combo + 1 : 0;
  const comboBonus = streak === COMBO_TARGET ? Math.ceil(baseDamage / 2) : 0;
  const strike = Math.round(baseDamage * multiplier) + comboBonus;
  let damage = Math.min(hp, strike);
  let xp = profile.xp;
  let skillName = null;
  let skillDetail = null;
  let recovered = 0;

  if (triggered) {
    skillName = skill.name;
    if (skin === "slime") {
      recovered = Math.min(skill.recovery, maxHp - (hp - damage));
      skillDetail = recovered ? `恢复 ${recovered} HP` : "血量已满";
    } else {
      const percent = skin === "mirror" ? skill.power + 12 : skill.power;
      const reducedStrike = strike - Math.floor(strike * percent / 100);
      const blocked = damage - Math.min(hp, reducedStrike);
      damage -= blocked;
      skillDetail = `抵消 ${blocked} 点伤害`;
      if (skin === "golem" && xp > 0) {
        const lost = Math.ceil(xp * skill.power / 100);
        xp -= lost;
        skillDetail += `，本次经验减少 ${lost} XP`;
      }
    }
  }

  return {
    outcome, kind, damage, xp, hp: hp - damage + recovered, skillName, skillDetail,
    baseDamage: landed ? baseDamage : null, comboBonus, combo: streak % COMBO_TARGET,
  };
}
