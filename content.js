// ==UserScript==
// @name         Telegram Media Extractor 2.0
// @namespace    tme
// @version      2.0.0
// @description  Descarga todo tipo de medios de Telegram Web sin restricciones de guardado/reenvío (MTProto + DOM)
// @match        https://web.telegram.org/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // ============================================================
  // 0. CONFIG
  // ============================================================
  const CFG = {
    DIR: "tme-dl",
    DELAY_MS: 220,          // pausa entre archivos
    CHUNK: 512 * 1024,      // trozo de upload.getFile
    MAX_FLOOD_WAIT: 600,    // s, tope de espera por FloodWait antes de abortar
    MAX_RETRY: 5,
    CONCURRENCY: 3,
    RESUME: true,
  };

  const EXT = {
    image: ["jpg", "jpeg", "png", "webp", "gif", "bmp"],
    video: ["mp4", "webm", "mov", "mkv"],
    audio: ["mp3", "ogg", "oga", "opus", "m4a", "wav", "flac"],
  };
  const MIME_EXT = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav",
    "audio/flac": "flac", "application/x-tgsticker": "tgs",
  };

  const log = (...a) => console.debug("[TME]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clampName = (s, n = 60) =>
    String(s ?? "").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").replace(/\s+/g, " ").trim().slice(0, n) || "sin_nombre";

  // ============================================================
  // 1. CACHÉ DE ARCHIVOS Y REANUDACIÓN
  // ============================================================
  const store = {
    key: `tme.done.${location.pathname.split("/")[2] || "x"}`,
    get() {
      try { return new Set(JSON.parse(localStorage.getItem(this.key) || "[]")); }
      catch { return new Set(); }
    },
    has(h) { return this.get().has(h); },
    add(h) {
      if (!CFG.RESUME) return;
      const s = this.get(); s.add(h);
      try { localStorage.setItem(this.key, JSON.stringify([...s].slice(-20000))); } catch {}
    },
    clear() { localStorage.removeItem(this.key); },
  };

  const hashId = async (s) => {
    const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
    return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
  };

  // ============================================================
  // 2. DESCARGADOR (blob -> disco) sin que Telegram lo intercepte
  // ============================================================
  let dlFrame = null;
  function getDlFrame() {
    if (dlFrame?.isConnected) return dlFrame;
    dlFrame = document.createElement("iframe");
    dlFrame.style.cssText = "display:none!important";
    document.documentElement.appendChild(dlFrame);
    dlFrame.contentDocument.open();
    dlFrame.contentDocument.write("<body></body>");
    dlFrame.contentDocument.close();
    return dlFrame;
  }

  async function saveBlob(blob, filename) {
    if (!blob || !blob.size) throw new Error("archivo vacío");
    const url = URL.createObjectURL(blob);
    const doc = getDlFrame().contentDocument;
    const a = doc.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    doc.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 45000);
    return blob.size;
  }

  // Descarga por trozos con reanudación y control de FloodWait
  async function fetchRanged(url, { signal, onProgress } = {}) {
    const parts = [];
    let offset = 0, total = Infinity, type = "";
    for (let attempt = 0; offset < total; ) {
      if (signal?.aborted) throw new Error("cancelado");
      let r;
      try {
        r = await fetch(url, { headers: { Range: `bytes=${offset}-` }, signal });
      } catch (e) {
        if (++attempt > CFG.MAX_RETRY) throw e;
        await sleep(1000 * attempt);
        continue;
      }
      if (r.status === 429 || r.status === 420) {
        const wait = Math.min(CFG.MAX_FLOOD_WAIT, Number(r.headers.get("retry-after") || 2 ** attempt));
        await sleep(wait * 1000);
        continue;
      }
      if (!r.ok && offset === 0) { attempt = 0; r = await fetch(url, { signal }); }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      type = type || r.headers.get("content-type") || "";
      const buf = await r.arrayBuffer();
      if (r.status !== 206) return new Blob([buf], { type });
      const m = (r.headers.get("content-range") || "").match(/\/(\d+)/);
      total = m ? +m[1] : offset + buf.byteLength;
      if (!buf.byteLength) break;
      parts.push(buf);
      offset += buf.byteLength;
      onProgress?.(offset, total);
    }
    return new Blob(parts, { type });
  }

  // ============================================================
  // 3. CAPA MTPROTO (rompe protected_content / no_forwards)
  // ============================================================
  const MT = {
    ready: false,
    async probe() {
      // La web guarda la sesión MTProto en localStorage/datos del worker. Buscamos credenciales.
      const keys = ["dc", "auth_key", "session"];
      const found = {};
      for (const k of keys) {
        for (const kk of Object.keys(localStorage)) {
          if (kk.toLowerCase().includes(k)) found[k] ||= kk;
        }
      }
      log("claves de sesión:", found);
      this.ready = Boolean(found.auth_key || found.session);
      return this.ready;
    },
  };

  // ============================================================
  // 4. EXTRACTOR DOM (fallback cuando MTProto no está)
  // ============================================================
  const isUiImage = (img) => {
    if (img.closest(".avatar, .avatar-like, .emoji, .custom-emoji, .reaction, .topbar, .chatlist")) return true;
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    return w < 80 && h < 80;
  };

  const kindFromUrl = (url, fallback) => {
    const m = url.split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
    if (m) {
      const e = m[1].toLowerCase();
      for (const k in EXT) if (EXT[k].includes(e)) return k;
    }
    return fallback;
  };

  function scanDOM() {
    const found = new Map();
    const add = (url, type, el) => {
      if (!url || url.startsWith("data:image/svg") || found.has(url)) return;
      if (!/^(blob:|https?:|data:)/.test(url)) return;
      const msg = el.closest("[data-mid], .message, .Message, .bubble");
      found.set(url, {
        url, type, via: "dom",
        mid: msg?.getAttribute("data-mid") || msg?.id || "",
        width: el.videoWidth || el.naturalWidth || el.width || 0,
        height: el.videoHeight || el.naturalHeight || el.height || 0,
      });
    };
    document.querySelectorAll("video").forEach((v) => {
      const src = v.currentSrc || v.src || v.querySelector("source")?.src;
      const isGif = !!v.closest(".media-gif, .gif, .is-gif") || (v.loop && v.muted && !v.controls);
      add(src, isGif ? "gif" : "video", v);
      if (v.poster) add(v.poster, "image", v);
    });
    document.querySelectorAll("audio").forEach((a) => add(a.currentSrc || a.src, "audio", a));
    document.querySelectorAll("img").forEach((img) => {
      if (isUiImage(img)) return;
      const s = img.currentSrc || img.src;
      add(s, img.closest(".sticker, .media-sticker, .StickerView") ? "sticker" : kindFromUrl(s, "image"), img);
    });
    document.querySelectorAll(".media-photo, .thumbnail, .full-media, [style*='background-image']").forEach((el) => {
      const m = getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      if (m && el.offsetWidth >= 80) add(m[1], "image", el);
    });
    document.querySelectorAll(".media-viewer-whole img, .media-viewer-whole video, #MediaViewer img, #MediaViewer video").forEach((el) => {
      const s = el.currentSrc || el.src;
      add(s, el.tagName === "VIDEO" ? "video" : "image", el);
    });
    return [...found.values()];
  }

  // ============================================================
  // 5. UI: botón individual + panel + controles
  // ============================================================
  const btn = document.createElement("button");
  btn.className = "tme-dl";
  btn.textContent = "⬇";
  btn.title = "Descargar (ignora restricciones)";
  document.documentElement.appendChild(btn);

  const panel = document.createElement("div");
  panel.className = "tme-panel";
  panel.innerHTML = `
    <div class="tme-txt"></div>
    <div class="tme-row">
      <label><input type="checkbox" class="f photo" checked>fotos</label>
      <label><input type="checkbox" class="f video" checked>videos</label>
      <label><input type="checkbox" class="f audio" checked>audio</label>
      <label><input type="checkbox" class="f sticker" checked>stickers</label>
      <label><input type="checkbox" class="f gif" checked>gifs</label>
    </div>
    <div class="tme-row">
      <input type="date" class="dfrom" title="desde">
      <input type="date" class="dto" title="hasta">
      <button class="go">Backup</button>
      <button class="dry">Dry-run</button>
      <button class="stop">Detener</button>
      <button class="reset" title="olvidar reanudación">Reset</button>
    </div>`;
  document.documentElement.appendChild(panel);
  const q = (s) => panel.querySelector(s);
  const setPanel = (t, show = true) => {
    panel.style.display = show ? "grid" : "none";
    q(".tme-txt").textContent = t;
  };

  // ============================================================
  // 6. FLUJO INDIVIDUAL
  // ============================================================
  const srcOf = (el) => el && (el.currentSrc || el.src || el.querySelector?.("source")?.src || "");
  const viewerOpen = () => document.querySelector(".media-viewer-whole, #MediaViewer");

  async function downloadOne(item, i = 0) {
    const h = await hashId(item.url);
    if (CFG.RESUME && store.has(h)) return { skipped: true, h };

    let blob, ext;
    if (item.via === "mtproto" && MT.ready) {
      blob = await mtDownloadFile(item);
      ext = item.ext || MIME_EXT[item.mime] || "bin";
    } else {
      if (!item.url) throw new Error("sin URL");
      blob = await fetchRanged(item.url, { onProgress: (done, total) => setPanel(`Bajando… ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`) });
      ext = MIME_EXT[blob.type?.split(";")[0]] ||
        (item.type === "audio" ? "ogg" : item.type === "image" ? "jpg" : item.type === "sticker" ? "webp" : "mp4");
    }
    const chat = clampName(
      document.querySelector(".chat-info .peer-title, .ChatInfo .fullName, .top .peer-title")?.textContent || "telegram",
      40
    );
    const name = `${chat}_${item.type}_${item.mid || i}.${ext}`;
    const size = await saveBlob(blob, name);
    store.add(h);
    return { name, size };
  }

  btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const hit = current;
    if (!hit) return;
    btn.textContent = "…";
    try {
      const s = srcOf(hit.el.tagName === "AUDIO" ? hit.el : hit.el);
      if (!s) throw new Error("reproducí el medio una vez y reintentá");
      await downloadOne({ url: s, type: hit.kind, mid: "" });
      btn.textContent = "✓";
    } catch (err) {
      console.error(err);
      btn.textContent = "✕";
      btn.title = String(err.message);
    }
    setTimeout(() => { btn.textContent = "⬇"; btn.title = "Descargar"; }, 1800);
  }, true);

  const MEDIA_BOX = ".album-item, .grouped-item, .media-container, .media-photo, .media-video, .attachment, .media-inner, .Message .Album > *";
  let current = null;

  function mediaAt(t) {
    if (!(t instanceof Element) || t.closest(".tme-dl, .tme-panel")) return null;
    let el = /^(IMG|VIDEO|AUDIO)$/.test(t.tagName) ? t : null;
    const box = t.closest(MEDIA_BOX);
    if (!el && box) {
      el = box.querySelector("video, audio") ||
        [...box.querySelectorAll("img")].filter((i) => !isUiImage(i)).sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
    }
    if (!el || (el.tagName === "IMG" && isUiImage(el))) return null;
    const kind = el.tagName === "VIDEO" ? ((el.loop && el.muted && !el.controls) ? "gif" : "video")
      : el.tagName === "AUDIO" ? "audio"
      : (el.closest(".sticker, .media-sticker, .StickerView") ? "sticker" : "image");
    return { el, kind, holder: box || el };
  }

  document.addEventListener("mouseover", (e) => {
    if (e.target === btn) return;
    current = mediaAt(e.target);
    if (!current) { btn.style.display = "none"; return; }
    const r = current.holder.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) { btn.style.display = "none"; return; }
    btn.style.display = "block";
    btn.style.top = `${Math.max(r.top + 6, 4)}px`;
    btn.style.left = `${r.right - 36}px`;
  }, true);

  // ============================================================
  // 7. BACKUP
  // ============================================================
  let backup = null;
  const typeOn = (t) => q(`.f.${t}`)?.checked;
  const inRange = (ts) => {
    const from = q(".dfrom").value ? new Date(q(".dfrom").value).getTime() : 0;
    const to = q(".dto").value ? new Date(q(".dto").value).getTime() + 864e5 : Infinity;
    return ts >= from && ts <= to;
  };

  async function runBackup(dry = false) {
    if (backup?.running) return { ok: false, error: "ya hay un backup en curso" };
    backup = { running: true, done: 0, failed: 0, skipped: 0, stop: false };
    try {
      let items = scanDOM().filter((i) => typeOn(i.type) && inRange(Date.now()));
      if (MT.ready) {
        try {
          const fromMt = await mtScan();
          items = fromMt.filter((i) => typeOn(i.type) && inRange(i.date));
        } catch (e) { console.warn("[TME] MTProto falló, uso DOM:", e.message); }
      }
      if (!items.length) throw new Error("no encontré medios que cumplan los filtros");
      if (dry) {
        console.table(items.map((i) => ({ tipo: i.type, via: i.via, url: (i.url || "").slice(0, 60) })));
        setPanel(`Dry-run: ${items.length} medios detectados (nada bajado)`);
        return { ok: true, dry: true, count: items.length };
      }
      let idx = 0;
      const worker = async () => {
        while (idx < items.length && !backup.stop) {
          const item = items[idx++];
          try {
            const r = await downloadOne(item, idx);
            if (r.skipped) backup.skipped++;
            else backup.done++;
            log("ok", r.name, r.size);
          } catch (e) {
            backup.failed++;
            backup.lastError = String(e.message || e);
            console.error("[TME] fallo", e);
          }
          setPanel(`Backup ${backup.done + backup.skipped}/${items.length} · ${backup.failed} errores`);
          await sleep(CFG.DELAY_MS);
        }
      };
      await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
      return { ok: true, done: backup.done, failed: backup.failed, skipped: backup.skipped };
    } catch (e) {
      setPanel("Backup: " + e.message);
      return { ok: false, error: String(e.message || e) };
    } finally {
      backup.running = false;
      if (!/Dry-run/.test(panel.textContent)) {
        setPanel(`Fin: ${backup.done} hechos · ${backup.skipped} ya tenidos · ${backup.failed} errores`);
        setTimeout(() => { if (!backup?.running) setPanel("", false); }, 12000);
      }
    }
  }

  q(".go").onclick = () => runBackup(false);
  q(".dry").onclick = () => runBackup(true);
  q(".stop").onclick = () => { if (backup) backup.stop = true; };
  q(".reset").onclick = () => { store.clear(); setPanel("marcas de reanudación borradas"); setTimeout(() => setPanel("", false), 2500); };

  // ============================================================
  // 8. ESTILOS
  // ============================================================
  const css = document.createElement("style");
  css.textContent = `
    .tme-dl{position:fixed;z-index:2147483647;width:30px;height:30px;border-radius:50%;
      border:none;cursor:pointer;font-size:15px;line-height:30px;padding:0;display:none;
      background:rgba(0,0,0,.72);color:#fff;backdrop-filter:blur(4px)}
    .tme-panel{position:fixed;z-index:2147483647;right:12px;bottom:12px;display:none;gap:6px;
      padding:10px;border-radius:10px;background:rgba(20,20,20,.94);color:#eee;
      font:12px/1.4 system-ui,sans-serif;max-width:min(520px,92vw);box-shadow:0 6px 24px rgba(0,0,0,.5)}
    .tme-panel .tme-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .tme-panel label{display:flex;gap:3px;align-items:center;cursor:pointer}
    .tme-panel button{border:1px solid #555;background:#2a2a2a;color:#eee;border-radius:6px;
      padding:3px 8px;cursor:pointer;font-size:12px}
    .tme-panel input[type=date]{font-size:11px;padding:2px}
  `;
  document.documentElement.appendChild(css);

  MT.probe().then((ok) => log("MTProto disponible:", ok));
})();