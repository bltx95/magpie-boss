import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createPlayer } from "./player.mjs";
import { createRoomService } from "./room-server.mjs";
import { findLobby, lobbyFetch } from "./lobby-network.mjs";
import { webAsset } from "./web-assets.mjs";
import manifest from "./package.json";

const DEFAULT_PORT = 3468;
const INTERVAL_MS = 5000;
const INVITE = /^\d{8}$/;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function createLocalHandler(player, origin) {
  const expectedHost = new URL(origin).host;
  const embedToken = randomBytes(32).toString("hex");
  const cors = {
    "Access-Control-Allow-Origin": "null",
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Allow-Headers": "content-type, x-boss-embed",
    Vary: "Origin",
  };
  return async (request) => {
    const url = new URL(request.url);
    const { pathname, host } = url;
    if (request.headers.get("host") !== expectedHost || host !== expectedHost) {
      return json({ error: "请从本机地址打开房间" }, 403);
    }
    const requestOrigin = request.headers.get("origin");
    if (request.method === "GET" && pathname === "/embedded") {
      return webAsset("/", `default-src ${origin}; base-uri 'none'; form-action 'none'; frame-ancestors wails:`, {
        "embed-token": embedToken,
      });
    }
    if (request.method === "GET") {
      const asset = webAsset(pathname, "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      if (asset) return asset;
    }
    if (requestOrigin === "null" && pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (request.headers.get("x-boss-embed") !== embedToken) return json({ error: "页面会话已失效" }, 403);
      const response = await handleAction(request, url);
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    }
    if (request.method === "POST" && requestOrigin !== origin) return json({ error: "请求来源无效" }, 403);
    return handleAction(request, url);
  };

  async function handleAction(request, { pathname, searchParams }) {
    try {
      if (request.method === "GET" && pathname === "/api/state") return json(player.snapshot());
      if (request.method === "GET" && pathname === "/api/leaderboard") {
        return json(await player.leaderboard(searchParams.get("day") ?? ""));
      }
      if (request.method === "GET" && pathname === "/api/member-damage") return json(await player.memberDamage());
      if (request.method === "GET" && pathname === "/api/rankings") return json(await player.rankings(searchParams.get("board") ?? "today"));
      if (request.method === "GET" && pathname === "/api/kills") return json(await player.kills(searchParams.get("before")));
      if (request.method !== "POST") return json({ error: "找不到此页面" }, 404);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "请求格式无效" }, 400);
      }
      const code = body?.code;
      if (["/api/invite", "/api/join"].includes(pathname) && (typeof code !== "string" || !INVITE.test(code))) {
        return json({ error: "请输入 8 位数字邀请码" }, 400);
      }
      if (pathname === "/api/home") return json(await player.changeRoom());
      if (pathname === "/api/invite") return json(await player.preview(code));
      if (pathname === "/api/join") return json(await player.changeRoom(code));
      if (pathname === "/api/rooms") return json(await player.createRoom(body?.name, body?.visibility));
      if (pathname === "/api/rooms/join") return json(await player.chooseRoom(body?.roomId));
      if (pathname === "/api/profile") return json(await player.rename(body?.nickname));
      return json({ error: "找不到此页面" }, 404);
    } catch (error) {
      if ([400, 403, 404].includes(error.status)) return json({ error: error.message }, error.status);
      if (error.message === "找不到这个邀请码") return json({ error: error.message }, 404);
      return json({ error: "暂时无法连接，请稍后重试" }, 503);
    }
  }
}

function roomOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash) throw new Error("房间服务地址无效");
  return url.origin;
}

function gatewayOrigin(value) {
  const address = value || "127.0.0.1:3425";
  const url = new URL(address.includes("://") ? address : `http://${address}`);
  const loopback = url.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
  return `${url.protocol}//${loopback}:${url.port || 3425}`;
}

async function start({ directory }, options) {
  options ??= {};
  const port = options.localPort ?? DEFAULT_PORT;
  const origin = `http://127.0.0.1:${port}`;
  let config;
  try {
    const roomServer = options.roomServer || manifest.magpie.sharedLobby;
    config = {
      directory: join(directory, "magpie-boss"),
      roomServer: roomServer ? roomOrigin(roomServer) : null,
      magpieUrl: gatewayOrigin(options.magpieUrl || process.env.MAGPIE_ADDR),
      nickname: typeof options.nickname === "string" ? options.nickname : "",
    };
  } catch {
    console.warn("Magpie Boss 配置无效，请检查房间地址和本机端口。");
    return {};
  }
  if (config.roomServer?.startsWith("https:")) {
    try {
      const player = createPlayer({
        ...config, fetcher: lobbyFetch,
        viewerToken: options.viewerOrigin === config.roomServer ? options.viewerToken : undefined,
        pairingCode: options.pairingCode,
      });
      poll(player);
      console.info("Magpie Boss 已启动云端用量同步。");
    } catch {
      console.warn("Magpie Boss 无法启动云端用量同步，请检查插件目录。");
    }
    return {};
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.warn("Magpie Boss 本机房间端口无效。");
    return {};
  }
  let portBusy = false;
  const launch = async () => {
    let server;
    let player;
    let handle;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        maxRequestBodySize: 4096,
        fetch: (request) => handle ? handle(request) : json({ error: "正在启动大厅" }, 503),
      });
      mkdirSync(config.directory, { recursive: true, mode: 0o700 });
      const shared = config.roomServer || await findLobby(config.directory);
      const local = shared ? null : createRoomService(join(config.directory, "local-lobby.sqlite"));
      const localOrigin = "http://boss-local.invalid";
      player = createPlayer({
        ...config,
        roomServer: shared || localOrigin,
        localLobby: Boolean(local),
        fetcher: (url, init) => local && url.origin === localOrigin
          ? local.fetch(new Request(url, init)) : lobbyFetch(url, init),
      });
      handle = createLocalHandler(player, origin);
      console.info(`Magpie Boss 本机大厅已启动 · ${origin}/`);
    } catch (error) {
      server?.stop(true);
      if (error.code === "EADDRINUSE") {
        // Magpie can finish retiring the previous plugin host after starting the next one.
        if (!portBusy) console.warn(`Magpie Boss 本机端口 ${port} 被占用，正在重试。`);
        portBusy = true;
        setTimeout(launch, 2000).unref();
      } else {
        console.warn("Magpie Boss 无法启动本机房间，请检查插件目录和端口。");
      }
      return;
    }
    poll(player);
  };
  await launch();
  return {};
}

function poll(player) {
  const tick = async () => {
    await player.tick();
    setTimeout(tick, INTERVAL_MS).unref();
  };
  void tick();
}

export const _internal = { createLocalHandler, start };
export default { id: "magpie-boss", server: start };
