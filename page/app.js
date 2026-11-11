const DEFAULT_PORT = 3468;
const OPTIONS_TIMEOUT_MS = 1500;
const NAVIGATION_TIMEOUT_MS = 4000;

const status = document.getElementById("lobby-status");
const address = document.getElementById("lobby-address");
const retry = document.getElementById("retry");

async function configuredPort() {
  let timer;
  try {
    const options = await Promise.race([
      (async () => {
        await globalThis.magpie?.ready;
        return globalThis.magpie?.options?.get();
      })(),
      new Promise((resolve) => { timer = setTimeout(resolve, OPTIONS_TIMEOUT_MS); }),
    ]);
    const port = options?.localPort;
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  } finally {
    clearTimeout(timer);
  }
}

function showFallback() {
  status.textContent = "未能在 Magpie 内打开 Boss 大厅。可以重试，或将下方地址复制到浏览器。";
  retry.disabled = false;
}

async function openLobby() {
  retry.disabled = true;
  status.textContent = "正在打开 Boss 大厅…";
  const port = await configuredPort();
  const origin = `http://127.0.0.1:${port}`;
  address.textContent = `${origin}/`;
  const timer = setTimeout(showFallback, NAVIGATION_TIMEOUT_MS);
  try {
    location.replace(`${origin}/embedded`);
  } catch {
    clearTimeout(timer);
    showFallback();
  }
}

retry.hidden = false;
retry.addEventListener("click", () => { void openLobby(); });
void openLobby();
