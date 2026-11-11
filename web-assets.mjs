const assets = new Map([
  ["/", new URL("./web/index.html", import.meta.url)],
  ["/app.js", new URL("./web/app.js", import.meta.url)],
  ["/format.js", new URL("./page/format.js", import.meta.url)],
  ["/style.css", new URL("./web/style.css", import.meta.url)],
]);

export function webAsset(path, policy, attributes = {}) {
  const asset = assets.get(path);
  if (!asset) return null;
  const file = Bun.file(asset);
  const headers = {
    "Content-Type": file.type,
    "Content-Security-Policy": policy,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  if (path !== "/") return new Response(file, { headers });
  return file.text().then((html) => {
    for (const [name, value] of Object.entries(attributes)) {
      html = html.replace(`data-${name}=""`, `data-${name}="${value}"`);
    }
    return new Response(html, { headers });
  });
}
