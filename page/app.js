async function openLobby() {
  let port = 3468;
  try {
    await magpie.ready;
    const options = await magpie.options.get();
    if (Number.isInteger(options?.localPort) && options.localPort >= 1024 && options.localPort <= 65535) {
      port = options.localPort;
    }
  } catch {
    // Older hosts can use the default port.
  }
  const target = `http://127.0.0.1:${port}/embedded`;
  const retry = document.getElementById("retry");
  retry.addEventListener("click", () => location.replace(target));
  setTimeout(() => { retry.hidden = false; }, 3000);
  location.replace(target);
}

void openLobby();
