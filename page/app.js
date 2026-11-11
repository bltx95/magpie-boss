const DEFAULT_PORT = 3468;
const OPTIONS_TIMEOUT_MS = 1500;
const NAVIGATION_TIMEOUT_MS = 4000;

const status = document.getElementById("lobby-status");
const address = document.getElementById("lobby-address");
const retry = document.getElementById("retry");
const hostedLobby = document.documentElement?.dataset?.hostedLobby;

async function withTimeout(run) {
  let timer;
  try {
    return await Promise.race([
      run(),
      new Promise((resolve) => { timer = setTimeout(resolve, OPTIONS_TIMEOUT_MS); }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function cloudOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password &&
        url.pathname === "/" && !url.search && !url.hash) return url.origin;
  } catch {
    return null;
  }
  return null;
}

async function cloudPage(origin, options) {
  const target = new URL("/", origin);
  if (!options || !globalThis.magpie?.options?.set) return target.href;
  let token = options.viewerOrigin === origin ? options.viewerToken : null;
  if (!/^web_[a-f0-9]{64}$/.test(token ?? "")) {
    token = "web_" + Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    const saved = await withTimeout(async () => {
      await magpie.options.set({ ...options, viewerOrigin: origin, viewerToken: token });
      return true;
    });
    if (!saved) return target.href;
  }
  target.hash = new URLSearchParams({ viewer: token }).toString();
  return target.href;
}

function showFallback() {
  status.textContent = "未能在 Magpie 内打开 Boss 大厅。可以重试，或将下方地址复制到浏览器。";
  retry.disabled = false;
}

async function openLobby() {
  retry.disabled = true;
  status.textContent = "正在打开 Boss 大厅…";
  const options = await withTimeout(async () => {
    if (!globalThis.magpie?.options?.get) return undefined;
    await magpie.ready;
    return (await magpie.options.get()) ?? {};
  });
  const port = options?.localPort;
  const cloud = cloudOrigin(options?.roomServer || hostedLobby);
  const localPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
  const origin = cloud ?? `http://127.0.0.1:${localPort}`;
  address.textContent = `${origin}/`;
  const timer = setTimeout(showFallback, NAVIGATION_TIMEOUT_MS);
  try {
    location.replace(cloud ? await cloudPage(cloud, options) : `${origin}/embedded`);
  } catch {
    clearTimeout(timer);
    showFallback();
  }
}

retry.hidden = false;
retry.addEventListener("click", () => { void openLobby(); });
void openLobby();
