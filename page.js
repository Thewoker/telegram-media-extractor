// Corre en el contexto de la página (world: MAIN) para que los pedidos pasen por el
// service worker de Telegram (las URLs /a/progressive/... solo existen ahí).
(() => {
  async function fetchFull(url) {
    const parts = [];
    let offset = 0, total = Infinity, type = "";
    while (offset < total) {
      const r = await fetch(url, { headers: { Range: `bytes=${offset}-` } });
      if (!r.ok) throw new Error("HTTP " + r.status + " (página)");
      type = type || r.headers.get("content-type") || "";
      const buf = await r.arrayBuffer();
      if (r.status !== 206) return new Blob([buf], { type });
      const m = (r.headers.get("content-range") || "").match(/\/(\d+)/);
      total = m ? +m[1] : offset + buf.byteLength;
      if (!buf.byteLength) break;
      parts.push(buf);
      offset += buf.byteLength;
      window.postMessage({ tme: "progress", id: url, loaded: offset, total }, location.origin);
    }
    return new Blob(parts, { type });
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.tme !== "fetch") return;
    const { id, url } = e.data;
    try {
      const blob = await fetchFull(url);
      window.postMessage({ tme: "result", id, blob }, location.origin);
    } catch (err) {
      window.postMessage({ tme: "result", id, error: String(err.message || err) }, location.origin);
    }
  });
})();
