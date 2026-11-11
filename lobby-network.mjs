import { lookup } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

export const LOCAL_ROOM_SERVER = "http://127.0.0.1:8787";
export const LAN_ROOM_SERVER = "http://magpie-boss.local:8787";

export function advertiseLobby(port) {
  const dnsSd = Bun.which("dns-sd");
  if (!dnsSd || port !== 8787) return null;
  const interfaces = networkInterfaces();
  const candidates = [interfaces.en0, interfaces.en1, ...Object.values(interfaces)].flat().filter(Boolean);
  const address = process.env.BOSS_ADVERTISE_IP ||
    candidates.find(({ family, internal }) => family === "IPv4" && !internal)?.address;
  if (!address) return null;
  return Bun.spawn([dnsSd, "-P", "Magpie Boss", "_magpie-boss._tcp", "local",
    String(port), "magpie-boss.local.", address], { stdout: "ignore", stderr: "ignore" });
}

export async function lobbyFetch(url, options) {
  const target = new URL(url);
  if (target.hostname === "magpie-boss.local") {
    const { address } = await lookup(target.hostname, { family: 4 });
    target.hostname = address;
  }
  return fetch(target, options);
}

async function isLobby(origin) {
  const controller = AbortSignal.timeout(1250);
  try {
    const response = await Promise.race([
      lobbyFetch(new URL("/health", origin), { signal: controller, redirect: "error" }),
      new Promise((_, reject) => controller.addEventListener("abort", () => reject(controller.reason), { once: true })),
    ]);
    return response.ok && (await response.json()).service === "magpie-boss";
  } catch {
    return false;
  }
}

export async function findLobby(directory, probe = isLobby) {
  const selection = join(directory, "shared-lobby");
  const previous = await readFile(selection, "utf8").catch(() => "");
  if (previous === LAN_ROOM_SERVER) return previous;
  const [local, lan] = await Promise.all([probe(LOCAL_ROOM_SERVER), probe(LAN_ROOM_SERVER)]);
  if (local) return LOCAL_ROOM_SERVER;
  if (!lan) return null;
  await writeFile(selection, LAN_ROOM_SERVER, { mode: 0o600 });
  return LAN_ROOM_SERVER;
}
