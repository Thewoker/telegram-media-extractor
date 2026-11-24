// Telegram Media Extractor - content script (web.telegram.org /k/ y /a/)
(() => {
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

  const isUiImage = (img) => {
    // descarta avatares, emojis e íconos pequeños
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

  function scan() {
    const found = new Map();
    const add = (url, type, el) => {
      if (!url || url.startsWith("data:image/svg") || found.has(url)) return;
      if (!/^(blob:|https?:|data:)/.test(url)) return;
      const msg = el.closest("[data-mid], .message, .Message, .bubble");
      found.set(url, {
        url,
        type,
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

    document.querySelectorAll("audio").forEach((a) => add(a.currentSrc || a.src || a.querySelector("source")?.src, "audio", a));

    document.querySelectorAll("img").forEach((img) => {
      if (isUiImage(img)) return;
      const src = img.currentSrc || img.src;
      const sticker = !!img.closest(".sticker, .media-sticker, .StickerView");
      add(src, sticker ? "sticker" : kindFromUrl(src, "image"), img);
    });

    // imágenes servidas como background (Telegram A usa a veces canvas/backgrounds)
    document.querySelectorAll(".media-photo, .thumbnail, .full-media, [style*='background-image']").forEach((el) => {
      const m = getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      if (m && el.offsetWidth >= 80) add(m[1], "image", el);
    });

    // visor de medios abierto (máxima calidad)
    document.querySelectorAll(".media-viewer-whole img, .media-viewer-whole video, #MediaViewer img, #MediaViewer video").forEach((el) => {
      const src = el.currentSrc || el.src;
      add(src, el.tagName === "VIDEO" ? "video" : "image", el);
    });

    return [...found.values()];
  }

  // Los videos de Telegram Web se sirven por streaming (respuestas 206 parciales): se piden todos los trozos
  // Pide el archivo desde la página (pasa por el service worker de Telegram)
  function fetchViaPage(url) {
    return new Promise((resolve, reject) => {
      const id = url + "#" + Math.random();
      let timer;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { done(); reject(new Error("tiempo agotado (página)")); }, 60000); };
      const done = () => { clearTimeout(timer); window.removeEventListener("message", onMsg); };
      const onMsg = (e) => {
        if (e.source !== window || !e.data?.tme) return;
        if (e.data.tme === "progress" && e.data.id === url) {
          arm();
          if (typeof setPanel === "function" && e.data.total) {
            setPanel(`Descargando video… ${Math.round(e.data.loaded / 1048576)} / ${Math.round(e.data.total / 1048576)} MB`);
          }
        }
        if (e.data.tme === "result" && e.data.id === id) {
          done();
          e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.blob);
        }
      };
      window.addEventListener("message", onMsg);
      arm();
      window.postMessage({ tme: "fetch", id, url }, location.origin);
    });
  }

  async function fetchFull(url) {
    if (!url) throw new Error("Sin URL");
    if (url.startsWith(location.origin + "/") || url.startsWith("blob:")) {
      try { return await fetchViaPage(url); }
      catch (e) { console.warn("[TME] fetch desde la página falló:", e.message); }
    }
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      const r = await fetch(url);
      return r.blob();
    }
    const parts = [];
    let offset = 0, total = Infinity, type = "";
    while (offset < total) {
      let r = await fetch(url, { headers: { Range: `bytes=${offset}-` } });
      if (!r.ok && offset === 0) r = await fetch(url); // algunos servidores no aceptan Range
      if (!r.ok) throw new Error("HTTP " + r.status);
      type = type || r.headers.get("content-type") || "";
      const buf = await r.arrayBuffer();
      if (r.status !== 206) return new Blob([buf], { type });
      const cr = r.headers.get("content-range"); // bytes a-b/total
      const m = cr && cr.match(/\/(\d+)/);
      total = m ? +m[1] : offset + buf.byteLength;
      if (!buf.byteLength) break;
      parts.push(buf);
      offset += buf.byteLength;
    }
    return new Blob(parts, { type });
  }

  let dlFrame = null;
  function getDlFrame() {
    if (dlFrame && dlFrame.isConnected && dlFrame.contentDocument?.body) return dlFrame;
    dlFrame = document.createElement("iframe");
    dlFrame.style.cssText = "display:none";
    document.documentElement.appendChild(dlFrame);
    if (!dlFrame.contentDocument.body) dlFrame.contentDocument.write("<body></body>");
    return dlFrame;
  }

  async function download(item, index = 0) {
    const blob = await fetchFull(item.url);
    const ext = MIME_EXT[blob.type?.split(";")[0]] ||
      (item.type === "audio" ? "ogg" : item.type === "image" ? "jpg" : item.type === "sticker" ? "webp" : "mp4");
    const chat = (document.querySelector(".chat-info .peer-title, .ChatInfo .fullName, .top .peer-title")?.textContent || "telegram")
      .replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 40);
    const name = `${chat}_${item.type}_${item.mid || Date.now()}_${index}.${ext}`;
    if (!blob.size) throw new Error("Archivo vacío");
    const objUrl = URL.createObjectURL(blob);
    // El clic se hace dentro de un iframe propio: Telegram intercepta los clics en enlaces del
    // documento principal (cancelaba la descarga y cerraba el visor).
    const frame = getDlFrame();
    const a = frame.contentDocument.createElement("a");
    a.href = objUrl;
    a.download = name;
    frame.contentDocument.body.appendChild(a);
    a.click();
    a.remove();
    console.log("[TME] descargado", name, blob.size, "bytes");
    setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
    return { name, size: blob.size };
  }

  // ---------- Botón flotante único (sirve para cada foto/video, también en álbumes) ----------
  const MEDIA_BOX = ".album-item, .grouped-item, .media-container, .media-photo, .media-video, .attachment, " +
    ".media-inner, .media-viewer-aspecter, .media-viewer-mover, #MediaViewer .media-viewer-content, .audio, .Audio, " +
    ".Message .media-inner, .Message .Album > *";
  const srcOf = (el) => el && (el.currentSrc || el.src || el.querySelector?.("source")?.src || "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function mediaAt(target) {
    if (!(target instanceof Element) || target.closest(".tme-dl")) return null;
    let el = null;
    if (/^(IMG|VIDEO|AUDIO)$/.test(target.tagName)) el = target;
    const box = target.closest(MEDIA_BOX);
    if (!el && box) {
      el = box.querySelector("video, audio") ||
        [...box.querySelectorAll("img")].filter((i) => !isUiImage(i))
          .sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
    }
    if (!el && target.closest(".audio, .Audio, .voice")) {
      el = { tagName: "AUDIO_PLACEHOLDER", box: target.closest(".audio, .Audio, .voice") };
    }
    if (!el || (el.tagName === "IMG" && isUiImage(el))) return null;
    const holder = (el.box || box || el);
    const isVideoBox = !!holder.closest?.(".media-video, .video, [class*='video'], .is-video") ||
      !!holder.querySelector?.(".video-time, .message-media-duration, .VideoPlayer, .icon-play");
    return { el, holder, isVideoBox };
  }

  const btn = document.createElement("button");
  btn.className = "tme-dl";
  btn.title = "Descargar";
  btn.textContent = "⬇";
  document.documentElement.appendChild(btn);
  let current = null;

  function place(hit) {
    current = hit;
    if (!hit) { btn.style.display = "none"; return; }
    const r = hit.holder.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) { btn.style.display = "none"; return; }
    btn.style.display = "block";
    btn.style.top = `${Math.max(r.top + 6, 4)}px`;
    btn.style.left = `${r.right - 36}px`;
  }

  document.addEventListener("mouseover", (e) => {
    if (e.target === btn) return;
    place(mediaAt(e.target));
  }, true);
  document.addEventListener("scroll", () => current && place(current), true);

  // Evita que Telegram abra el visor al tocar el botón
  ["pointerdown", "mousedown", "mouseup", "pointerup", "touchstart"].forEach((t) =>
    btn.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }, true));

  // El visor de /a/ tiene montados varios slides (anterior/actual/siguiente): elegir el visible
  function activeVideo() {
    const v = document.querySelector(".media-viewer-whole, #MediaViewer");
    if (!v) return null;
    const act = v.querySelector(".MediaViewerSlide--active video, .media-viewer-aspecter video");
    if (act) return act;
    const vids = [...v.querySelectorAll("video")];
    const vis = (x) => { const r = x.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.width > 50 ? r.width * r.height : 0; };
    return vids.sort((a, b) => vis(b) - vis(a))[0] || null;
  }

  // Imagen del slide visible en máxima resolución (en /a/ primero aparece una miniatura borrosa)
  function activeImage() {
    const v = document.querySelector(".media-viewer-whole, #MediaViewer");
    if (!v) return null;
    const scope = v.querySelector(".MediaViewerSlide--active, .media-viewer-aspecter") || v;
    const vis = (x) => { const r = x.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth ? r.width * r.height : 0; };
    return [...scope.querySelectorAll("img")]
      .filter((i) => { const s = i.currentSrc || i.src; return s && !s.startsWith("data:") && vis(i) > 0 && !i.closest(".avatar, .Avatar, .media-viewer-author, .SenderInfo"); })
      .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0] || null;
  }

  async function activeImageFull() {
    let best = null, last = 0;
    for (let i = 0; i < 30; i++) { // hasta ~6 s esperando que cargue la versión grande
      const img = activeImage();
      const px = img ? img.naturalWidth * img.naturalHeight : 0;
      if (img && img.complete && px > 0 && px === last && i >= 3) return img;
      if (img) best = img;
      last = px;
      await sleep(200);
    }
    return best;
  }

  const findViewerMedia = () =>
    activeVideo() ||
    document.querySelector(".media-viewer-whole .media-viewer-aspecter img, #MediaViewer .MediaViewerSlide--active img, .media-viewer-whole img.thumbnail");

  const viewerOpen = () => document.querySelector(".media-viewer-whole, #MediaViewer");

  // Botón "Descargar" nativo del visor de Telegram (funciona con cualquier formato y tamaño)
  function findNativeDownload() {
    const v = viewerOpen();
    if (!v) return null;
    const icon = v.querySelector(".tgico-download, .icon-download, [class*='icon-download']");
    if (icon) return icon.closest("button, .btn-icon, [role='button']") || icon;
    return [...v.querySelectorAll("button, .btn-icon, [role='button']")].find((b) =>
      /download|descarg/i.test((b.getAttribute("aria-label") || "") + (b.title || "") + b.className)) || null;
  }

  async function openViewer(holder) {
    if (viewerOpen()) return;
    const target = holder.querySelector?.("img, video, canvas") || holder;
    target.click();
    for (let i = 0; i < 20 && !viewerOpen(); i++) await sleep(150);
    if (!viewerOpen()) { // algunos medios necesitan el clic en el contenedor
      (holder.closest?.(".media-inner, .media-container, .album-item, .grouped-item") || holder).click();
      for (let i = 0; i < 20 && !viewerOpen(); i++) await sleep(150);
    }
    if (!viewerOpen()) throw new Error("No se abrió el visor");
  }

  // Abre el visor, usa su botón de descarga nativo; si no existe, toma el archivo del visor
  async function downloadViaViewer(holder, mid, wasOpen, expectVideo) {
    await openViewer(holder);
    if (!wasOpen) {
      await sleep(700); // animación de apertura
      // si en el chat era un video, esperar a que el visor monte el <video>
      for (let i = 0; i < 40 && expectVideo && !activeVideo(); i++) await sleep(150);
    }
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      
      // misma lógica verificada que el backup: no da por hecha la descarga hasta que Chrome la recibe
      if (findNativeDownload() || (i > 8 && findViewerMedia())) {
        const how = await backupCurrent(mid || Date.now());
        console.log("[TME v1.9] individual ok:", how);
        return how;
      }
      const m = findViewerMedia();
      const s = srcOf(m);
      if (i > 8 && m && s && !s.startsWith("data:")) {
        await download({ url: s, type: m.tagName === "VIDEO" ? "video" : "image", mid });
        return "fetch";
      }
    }
    // Diagnóstico para ajustar los selectores
    const v = viewerOpen();
    console.log("[TME] URL:", location.pathname, "| visor:", v?.tagName, v?.id, v?.className);
    console.log("[TME] botones:", JSON.stringify([...(v?.querySelectorAll("button, .btn-icon, [role='button']") || [])].map((b) => ({
      cls: String(b.className).slice(0, 80), aria: b.getAttribute("aria-label"), title: b.title,
      icon: [...(b.textContent || "")].map((c) => c.codePointAt(0).toString(16)).join(" "),
      inner: b.innerHTML.slice(0, 120),
    }))));
    console.log("[TME] medios:", JSON.stringify([...(v?.querySelectorAll("img, video, canvas") || [])].map((m) => ({
      tag: m.tagName, cls: String(m.className).slice(0, 60), src: (srcOf(m) || "").slice(0, 100),
    }))));
    throw new Error("No se encontró el archivo en el visor");
  }
  const closeViewer = () => {
    const close = document.querySelector(".media-viewer-whole .btn-icon.tgico-close, .media-viewer-whole [class*='close'], #MediaViewer button[title*='Close'], #MediaViewer button[aria-label*='Close']");
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
  };

  btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const hit = current;
    if (!hit) return;
    const mid = hit.holder.closest?.("[data-mid]")?.dataset.mid || hit.holder.closest?.("[id^='message']")?.id || "";
    btn.textContent = "…";
    try {
      const el = hit.el;
      const wasOpen = !!viewerOpen();
      if (el.tagName === "AUDIO" || el.tagName === "AUDIO_PLACEHOLDER") {
        const s = srcOf(el.tagName === "AUDIO" ? el : el.box.querySelector("audio"));
        if (!s) throw new Error("Reproducí el audio una vez y volvé a tocar ⬇");
        await download({ url: s, type: "audio", mid });
      } else {
        try {
          await downloadViaViewer(hit.holder, mid, wasOpen, hit.isVideoBox || el.tagName === "VIDEO");
          if (!wasOpen) { await sleep(400); closeViewer(); }
        } catch (viewerErr) {
          // Último recurso: clic derecho en el mensaje → "Descargar" (no depende del reproductor)
          console.warn("[TME] el visor falló, pruebo menú contextual:", viewerErr.message);
          if (viewerOpen()) { closeViewer(); await sleep(500); }
          try { await downloadViaContextMenu(hit.holder); }
          catch (menuErr) { throw new Error(viewerErr.message + " || menú: " + menuErr.message); }
        }
      }
      btn.textContent = "✓";
      if (!backup?.running) setPanel("", false);
    } catch (err) {
      console.error("[TME] individual ERROR:", err);
      btn.textContent = "✕";
      btn.title = String(err.message || err);
      const em = String(err.message || err);
      setPanel("No se pudo descargar: " + em);
      setTimeout(() => !backup?.running && setPanel("", false), 8000);
    }
    setTimeout(() => { btn.textContent = "⬇"; btn.title = "Descargar"; }, 2000);
  }, true);

  // ---------- Modo backup: recorre todo el chat desde el visor (más reciente → más antiguo) ----------
  let backup = null; // { running, done, failed, stop }
  const panel = document.createElement("div");
  panel.className = "tme-panel";
  panel.innerHTML = '<div class="tme-txt"></div><button class="tme-stop">Detener</button>';
  document.documentElement.appendChild(panel);
  panel.querySelector(".tme-stop").addEventListener("click", (e) => {
    e.stopPropagation();
    if (backup) backup.stop = true;
  }, true);
  const setPanel = (t, show = true) => {
    panel.style.display = show ? "flex" : "none";
    panel.querySelector(".tme-txt").textContent = t;
  };

  // Identifica el medio que muestra el visor ahora (src del medio o, en su defecto, la fecha/autor del pie)
  function slideKey() {
    const v = viewerOpen();
    if (!v) return "";
    const m = findViewerMedia();
    const info = v.querySelector(".media-viewer-date, .media-viewer-name, .SenderInfo, .media-viewer-author")?.textContent || "";
    const s = srcOf(m) || "";
    const media = s.startsWith("data:") ? "" : s;
    // con pie de foto (fecha/autor) basta; la URL del video cambia al reproducirse
    const vid = v.querySelector("video");
    const thumb = vid ? (vid.poster || v.querySelector("img")?.src || "") : media;
    if (!m) return "";
    return (info.trim() || "?") + "|" + (thumb && !thumb.startsWith("data:") ? thumb : media || "1");
  }

  function goPrevious() {
    const v = viewerOpen();
    const prev = v?.querySelector(".media-viewer-switcher-left, .navigation.prev, [class*='navigation'][class*='prev'], button[aria-label*='revious'], button[aria-label*='nterior']");
    if (prev && getComputedStyle(prev).display !== "none") { prev.click(); return true; }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, bubbles: true }));
    return false;
  }

  function lastChatMedia() {
    const boxes = [...document.querySelectorAll(
      ".bubbles .media-photo, .bubbles .media-video, .bubbles .album-item, .MessageList .media-inner, .MessageList .Album > *"
    )].filter((b) => b.offsetWidth >= 40 && !b.closest(".media-sticker, .sticker, .StickerView"));
    return boxes[boxes.length - 1] || null;
  }

  // ¿Chrome empezó alguna descarga desde el instante t?
  async function downloadStartedSince(t, waitMs) {
    for (let waited = 0; waited <= waitMs; waited += 500) {
      try {
        const { items } = await chrome.runtime.sendMessage({ cmd: "downloadsSince", t });
        if (items?.length) return items[items.length - 1];
      } catch (_) { return null; } // sin background: no se puede verificar
      await sleep(500);
    }
    return null;
  }

  // Espera a que el video del visor tenga una URL utilizable (Telegram la asigna al empezar a reproducir)
  // Videos que Telegram no reproduce por partes se bajan enteros antes de mostrarse: hasta 90 s
  async function viewerVideoSrc() {
    const t0 = Date.now();
    let played = false;
    while (Date.now() - t0 < 90000 && viewerOpen()) {
      const v = activeVideo(); // puede desmontarse y volver a montarse: no abandonar
      const s = srcOf(v);
      if (s && !s.startsWith("data:")) return s;
      if (v && !played && Date.now() - t0 > 1200) { played = true; v.play?.().catch(() => {}); }
      const secs = Math.round((Date.now() - t0) / 1000);
      if (secs >= 3 && typeof setPanel === "function") {
        const pct = viewerOpen()?.querySelector("[class*='progress'], [class*='Progress']")?.textContent?.trim() || "";
        setPanel(`Esperando que Telegram cargue el video… ${secs}s ${pct}`);
      }
      await sleep(300);
    }
    return "";
  }

  function viewerDiag() {
    const v = viewerOpen();
    if (!v) return "visor cerrado";
    const vids = [...v.querySelectorAll("video")].map((x) => (x.currentSrc || x.src || "SIN-SRC").slice(0, 50) + "@" + Math.round(x.getBoundingClientRect().width));
    const btns = [...v.querySelectorAll("button, [role='button']")].map((b) => b.getAttribute("aria-label") || b.title || String(b.className).split(" ")[0]).filter(Boolean).slice(0, 12);
    const spinner = !!v.querySelector("[class*='spinner'], [class*='Spinner'], [class*='loading'], [class*='progress']");
    return "videos=" + JSON.stringify(vids) + " botones=" + JSON.stringify(btns) + " cargando=" + spinner;
  }

  // Descarga el medio actual del visor, verificando que la descarga realmente ocurra
  async function backupCurrent(n) {
    const isVideo = !!activeVideo();
    const mid = "bk" + n;
    let directErr = "";

    // 1) Videos: capturar la URL ANTES de tocar el botón de Telegram (en /a/ el reproductor
    //    se desmonta al iniciar la descarga nativa) y bajarlo directo, pidiendo todos los trozos.
    if (isVideo) {
      const s = await viewerVideoSrc();
      if (s) {
        try {
          const r = await download({ url: s, type: "video", mid });
          return "directa (" + Math.round(r.size / 1048576) + " MB)";
        } catch (e) {
          directErr = (s.startsWith("blob:") ? "blob/streaming: " : "") + (e.message || e);
          console.warn("[TME] descarga directa falló, pruebo la nativa:", directErr, s.slice(0, 80));
        }
      } else directErr = "sin URL";
    }

    // 1b) Imágenes: bajar directo la versión grande que muestra el visor
    if (!isVideo) {
      const img = await activeImageFull();
      const s = img && (img.currentSrc || img.src);
      if (s) {
        try {
          const r = await download({ url: s, type: "image", mid });
          return "directa (" + img.naturalWidth + "x" + img.naturalHeight + ", " + Math.round(r.size / 1024) + " KB)";
        } catch (e) {
          directErr = e.message || String(e);
          console.warn("[TME] imagen directa falló, pruebo la nativa:", directErr, s.slice(0, 80));
        }
      } else directErr = "no se encontró la imagen en el visor";
    }

    // 2) Botón nativo de Telegram, verificando que Chrome reciba el archivo
    let nat = findNativeDownload();
    for (let i = 0; i < 10 && !nat; i++) { await sleep(300); nat = findNativeDownload(); }
    if (nat) {
      const t0 = Date.now();
      nat.click();
      // Telegram baja el video entero antes de entregarlo: los largos tardan
      const d = await downloadStartedSince(t0, isVideo ? 90000 : 20000);
      if (d) return "nativo";
    }

    // 3) Imágenes: tomar el archivo del visor
    if (!isVideo) {
      const s = srcOf(findViewerMedia());
      if (s && !s.startsWith("data:")) { await download({ url: s, type: "image", mid }); return "directa"; }
    }

    throw new Error((isVideo ? "no se pudo bajar el video" : "no se pudo bajar la imagen") +
      " [v1.9 | url=" + location.pathname + " | directa=" + (directErr || "-") +
      " | nativo=" + (nat ? "sin respuesta" : "NO ENCONTRADO") + " | " + viewerDiag() + "]");
  }

  // Clic derecho sobre el mensaje y opción "Descargar" del menú de Telegram
  async function downloadViaContextMenu(holder) {
    const target = holder.querySelector?.("img, video, canvas") || holder;
    const r = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 2, buttons: 2,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new MouseEvent("contextmenu", opts));
    let item = null, menu = null;
    for (let i = 0; i < 20 && !item; i++) {
      await sleep(150);
      menu = document.querySelector(".MessageContextMenu, .ContextMenu .bubble.open, [role='menu'], .btn-menu.active, .contextmenu");
      item = menu && [...menu.querySelectorAll("[role='menuitem'], .MenuItem, .btn-menu-item, button, div")]
        .find((x) => x.children.length <= 3 && /^s*(download|descargar|guardar|save to downloads)/i.test(x.textContent || ""));
    }
    if (!item) {
      const opciones = menu ? [...menu.querySelectorAll("[role='menuitem'], .MenuItem, .btn-menu-item")].map((x) => x.textContent.trim()).slice(0, 15) : [];
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      throw new Error(menu ? "el menú no tiene 'Descargar' " + JSON.stringify(opciones) : "no se abrió el menú contextual");
    }
    const t0 = Date.now();
    item.click();
    setPanel("Telegram está bajando el archivo… (hasta 2 min)");
    const d = await downloadStartedSince(t0, 120000);
    if (!d) throw new Error("se eligió 'Descargar' pero Chrome no recibió nada en 2 min");
    console.log("[TME v1.9] individual ok: menú contextual", d.name);
    return "menú";
  }

  async function runBackup() {
    if (backup?.running) return { ok: false, error: "Ya hay un backup en curso" };
    backup = { running: true, done: 0, failed: 0, stop: false };
    try {
      if (!viewerOpen()) {
        const start = lastChatMedia();
        if (!start) throw new Error("No hay fotos/videos visibles en el chat. Abrí el grupo y probá de nuevo.");
        await openViewer(start);
      }
      let seen = new Set();
      while (!backup.stop) {
        // espera a que el visor cargue el medio actual
        let key = "";
        for (let i = 0; i < 30 && !(key = slideKey()).split("|")[1]; i++) await sleep(200);
        
        if (!seen.has(key)) {
          seen.add(key);
          try {
            const how = await backupCurrent(backup.done);
            backup.done++;
            console.log("[TME backup] ok", how, key);
          } catch (e) {
            backup.failed++;
            backup.lastError = String(e.message || e);
            console.error("[TME backup] ERROR", key, e);
          }
          setPanel(`Backup: ${backup.done} descargados${backup.failed ? ` · ${backup.failed} errores (último: ${backup.lastError})` : ""}`);
        }

        // pasa al medio anterior; si no cambia tras varios intentos, llegamos al primero
        let moved = false;
        for (let t = 0; t < 4 && !moved && !backup.stop; t++) {
          goPrevious();
          for (let i = 0; i < 25; i++) {
            await sleep(200);
            const k = slideKey();
            if (k && k !== key) { moved = true; break; }
          }
        }
        if (!moved) break;
      }
      const msg = backup.stop ? "Backup detenido" : "Backup completo";
      setPanel(`${msg}: ${backup.done} descargados${backup.failed ? ` · ${backup.failed} errores` : ""}`);
      return { ok: true, done: backup.done, failed: backup.failed };
    } catch (e) {
      setPanel("Backup: " + (e.message || e));
      return { ok: false, error: String(e.message || e) };
    } finally {
      backup.running = false;
      setTimeout(() => !backup?.running && setPanel("", false), 15000);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.cmd === "scan") { reply({ items: scan() }); return; }
    if (msg.cmd === "backup") { runBackup(); reply({ started: true }); return; }
    if (msg.cmd === "download") {
      (async () => {
        const results = [];
        for (let i = 0; i < msg.items.length; i++) {
          try { results.push({ ok: true, ...(await download(msg.items[i], i)) }); }
          catch (e) { results.push({ ok: false, url: msg.items[i].url, error: String(e) }); }
          await new Promise((r) => setTimeout(r, 300)); // evita bloqueo de descargas múltiples
        }
        reply({ results });
      })();
      return true;
    }
  });
})();
