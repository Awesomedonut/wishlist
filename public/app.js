(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const form = $("#compose");
  const nameInput = $("#name");
  const textInput = $("#text");
  const fileInput = $("#file");
  const tray = $("#tray");
  const submitBtn = $("#submit");
  const statusEl = $("#status");
  const board = $("#board");
  const sentinel = $("#sentinel");
  const tpl = $("#note-tpl");

  const MAX_MEDIA = 8;
  const NAME_KEY = "wishlist.name";

  // ------------------------------------------------------------------
  // Compose: pending uploads
  // ------------------------------------------------------------------
  /** @type {Array<{id:string, kind:string, url:string, name:string|null, el:HTMLElement}>} */
  const pending = [];
  let uploading = 0;

  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) nameInput.value = saved;
  } catch {}

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("error", !!isError);
  }

  function refreshTray() {
    tray.hidden = pending.length === 0 && uploading === 0;
    submitBtn.disabled = uploading > 0;
    submitBtn.textContent = uploading > 0 ? "…" : "📌";
  }

  function trayItem(kind, label) {
    const el = document.createElement("div");
    el.className = `tray-item ${kind}`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "tray-rm";
    rm.title = "remove";
    rm.textContent = "×";
    el.append(rm);
    const cap = document.createElement("div");
    cap.className = "tray-cap";
    cap.textContent = label;
    el.append(cap);
    return el;
  }

  async function uploadFile(file) {
    if (pending.length + uploading >= MAX_MEDIA) {
      setStatus(`max ${MAX_MEDIA} files per wish`, true);
      return;
    }
    const kind = file.type.split("/")[0];
    if (!["image", "video", "audio"].includes(kind)) {
      setStatus(`can't attach ${file.type || "that"} — images, video and audio only`, true);
      return;
    }
    const label = file.name && file.name !== "image.png" ? file.name : `${kind} from clipboard`;
    const el = trayItem(kind, label);
    el.classList.add("busy");
    const preview = previewFor(kind, URL.createObjectURL(file));
    el.prepend(preview);
    tray.append(el);
    uploading++;
    refreshTray();
    setStatus("");

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "X-File-Name": encodeURIComponent(file.name || ""),
        },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
      const item = { ...data, el };
      pending.push(item);
      el.classList.remove("busy");
      el.querySelector(".tray-rm").addEventListener("click", () => {
        pending.splice(pending.indexOf(item), 1);
        el.remove();
        refreshTray();
      });
    } catch (err) {
      el.remove();
      setStatus(err.message, true);
    } finally {
      uploading--;
      refreshTray();
    }
  }

  function previewFor(kind, url) {
    let node;
    if (kind === "image") {
      node = document.createElement("img");
      node.src = url;
      node.alt = "";
    } else if (kind === "video") {
      node = document.createElement("video");
      node.src = url;
      node.muted = true;
      node.playsInline = true;
      node.preload = "metadata";
    } else {
      node = document.createElement("div");
      node.className = "audio-glyph";
      node.textContent = "♫";
    }
    node.classList.add("tray-preview");
    return node;
  }

  function addFiles(files) {
    for (const f of files) uploadFile(f);
  }

  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });

  // Paste: files (screenshots, copied images) go to uploads, text goes in as text.
  form.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [];
    for (const item of cd.items || []) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
      return;
    }
    // Plain-text paste into the textarea is left to the browser.
    if (e.target !== textInput && e.target !== nameInput) {
      const text = cd.getData("text/plain");
      if (text) {
        e.preventDefault();
        insertText(text);
      }
    }
  });

  function insertText(text) {
    const s = textInput.selectionStart ?? textInput.value.length;
    const en = textInput.selectionEnd ?? s;
    const before = textInput.value.slice(0, s);
    const after = textInput.value.slice(en);
    const sep = before && !before.endsWith("\n") ? "\n" : "";
    textInput.value = before + sep + text + after;
    textInput.focus();
  }

  // Drag & drop anywhere on the note.
  ["dragenter", "dragover"].forEach((ev) =>
    form.addEventListener(ev, (e) => {
      e.preventDefault();
      form.classList.add("dragging");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    form.addEventListener(ev, (e) => {
      if (ev === "dragleave" && form.contains(e.relatedTarget)) return;
      form.classList.remove("dragging");
    })
  );
  form.addEventListener("drop", (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) return addFiles(dt.files);
    const uri = dt.getData("text/uri-list") || dt.getData("text/plain");
    if (uri) insertText(uri.trim());
  });

  // Submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (uploading > 0) return;
    const name = nameInput.value.trim();
    const text = textInput.value.trim();
    if (!text && pending.length === 0) {
      setStatus("write something or add a file", true);
      textInput.focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "…";
    textInput.readOnly = true;
    setStatus("");
    try {
      const res = await fetch("/api/wishes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text, media: pending.map((p) => p.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `couldn't pin (${res.status})`);
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {}
      textInput.value = "";
      pending.splice(0).forEach((p) => p.el.remove());
      refreshTray();
      prependWish(data);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "📌";
      textInput.readOnly = false;
    }
  });

  // Ctrl/Cmd + Enter submits
  textInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") form.requestSubmit();
  });

  // ------------------------------------------------------------------
  // Rendering wishes
  // ------------------------------------------------------------------
  let oldestId = null;

  const URL_RE = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;

  function renderText(container, text) {
    container.textContent = "";
    if (!text) {
      container.hidden = true;
      return [];
    }
    container.hidden = false;
    const urls = [];
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      if (m.index > last) container.append(text.slice(last, m.index));
      const a = document.createElement("a");
      a.href = m[0];
      a.textContent = prettyUrl(m[0]);
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      container.append(a);
      urls.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < text.length) container.append(text.slice(last));
    return urls;
  }

  function prettyUrl(u) {
    try {
      const x = new URL(u);
      const s = x.host.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname) + x.search;
      return s.length > 48 ? s.slice(0, 45) + "…" : s;
    } catch {
      return u;
    }
  }

  // Detect embeddable URLs.
  function embedFor(raw) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^(www|m|music)\./, "").toLowerCase();
    const p = u.pathname;

    // YouTube
    if (host === "youtu.be") {
      const id = p.slice(1).split("/")[0];
      if (isId(id)) return { type: "youtube", id, start: u.searchParams.get("t") };
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      let id = null;
      if (p === "/watch") id = u.searchParams.get("v");
      else {
        const m = p.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
        if (m) id = m[1];
      }
      if (isId(id)) return { type: "youtube", id, start: u.searchParams.get("t") };
    }

    // TikTok
    if (host === "tiktok.com") {
      const m = p.match(/\/video\/(\d{6,})/);
      if (m) return { type: "tiktok", id: m[1] };
    }

    // Vimeo
    if (host === "vimeo.com") {
      const m = p.match(/^\/(?:video\/)?(\d{5,})/);
      if (m) return { type: "vimeo", id: m[1] };
    }
    if (host === "player.vimeo.com") {
      const m = p.match(/^\/video\/(\d{5,})/);
      if (m) return { type: "vimeo", id: m[1] };
    }

    // Spotify
    if (host === "open.spotify.com") {
      const m = p.match(/^\/(?:intl-[a-z]{2}\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,})/);
      if (m) return { type: "spotify", kind: m[1], id: m[2] };
    }

    // SoundCloud
    if (host === "soundcloud.com" && p.split("/").filter(Boolean).length >= 2) {
      return { type: "soundcloud", url: u.href };
    }

    // Direct media files
    const ext = (p.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase();
    if (ext) {
      if (["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return { type: "video", url: u.href };
      if (["mp3", "m4a", "wav", "ogg", "oga", "flac", "aac", "weba", "opus"].includes(ext)) return { type: "audio", url: u.href };
      if (["jpg", "jpeg", "png", "gif", "webp", "avif"].includes(ext)) return { type: "image", url: u.href };
    }
    return null;
  }

  function isId(id) {
    return typeof id === "string" && /^[\w-]{6,}$/.test(id);
  }

  function iframe(src, cls, extra = {}) {
    const f = document.createElement("iframe");
    f.src = src;
    f.className = cls;
    f.loading = "lazy";
    f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";
    f.allowFullscreen = true;
    f.referrerPolicy = "strict-origin-when-cross-origin";
    Object.assign(f, extra);
    return f;
  }

  function renderEmbed(e) {
    switch (e.type) {
      case "youtube": {
        // Click-to-play poster keeps the board light.
        const wrap = document.createElement("button");
        wrap.type = "button";
        wrap.className = "embed yt-poster";
        wrap.setAttribute("aria-label", "play video");
        const img = document.createElement("img");
        img.src = `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`;
        img.alt = "";
        img.loading = "lazy";
        const play = document.createElement("span");
        play.className = "play";
        play.textContent = "▶";
        wrap.append(img, play);
        wrap.addEventListener("click", () => {
          const start = parseStart(e.start);
          const f = iframe(
            `https://www.youtube-nocookie.com/embed/${e.id}?autoplay=1&rel=0${start ? `&start=${start}` : ""}`,
            "embed yt"
          );
          wrap.replaceWith(f);
        }, { once: true });
        return wrap;
      }
      case "tiktok":
        return iframe(`https://www.tiktok.com/embed/v2/${e.id}`, "embed tiktok");
      case "vimeo":
        return iframe(`https://player.vimeo.com/video/${e.id}?dnt=1`, "embed vimeo");
      case "spotify":
        return iframe(
          `https://open.spotify.com/embed/${e.kind}/${e.id}`,
          `embed spotify ${e.kind === "track" || e.kind === "episode" ? "short" : ""}`
        );
      case "soundcloud":
        return iframe(
          `https://w.soundcloud.com/player/?url=${encodeURIComponent(e.url)}&color=%23c0552a&auto_play=false&show_comments=false&visual=false`,
          "embed soundcloud"
        );
      case "video": {
        const v = document.createElement("video");
        v.src = e.url;
        v.controls = true;
        v.preload = "metadata";
        v.playsInline = true;
        v.className = "embed native";
        return v;
      }
      case "audio": {
        const a = document.createElement("audio");
        a.src = e.url;
        a.controls = true;
        a.preload = "metadata";
        a.className = "embed native audio";
        return a;
      }
      case "image": {
        const a = document.createElement("a");
        a.href = e.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        a.className = "embed img";
        const img = document.createElement("img");
        img.src = e.url;
        img.alt = "";
        img.loading = "lazy";
        a.append(img);
        return a;
      }
    }
    return null;
  }

  function parseStart(t) {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m) return 0;
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  }

  function renderMedia(container, media) {
    container.textContent = "";
    container.hidden = !media || media.length === 0;
    for (const m of media || []) {
      let node;
      if (m.kind === "image") {
        const a = document.createElement("a");
        a.href = m.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "media img";
        const img = document.createElement("img");
        img.src = m.url;
        img.alt = m.name || "";
        img.loading = "lazy";
        a.append(img);
        node = a;
      } else if (m.kind === "video") {
        node = document.createElement("video");
        node.src = m.url;
        node.controls = true;
        node.preload = "metadata";
        node.playsInline = true;
        node.className = "media video";
      } else {
        node = document.createElement("div");
        node.className = "media audio";
        const label = document.createElement("div");
        label.className = "audio-name";
        label.textContent = "♫ " + (m.name || "audio");
        const a = document.createElement("audio");
        a.src = m.url;
        a.controls = true;
        a.preload = "metadata";
        node.append(label, a);
      }
      container.append(node);
    }
  }

  function renderWish(w) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = w.id;
    node.style.setProperty("--tilt", `${((w.id * 7919) % 5) - 2}deg`);
    node.querySelector(".who").textContent = w.name || "anon";
    const t = node.querySelector(".note-time");
    const d = new Date(w.created_at);
    t.dateTime = d.toISOString();
    t.textContent = relTime(d);
    t.title = d.toLocaleString();

    const urls = renderText(node.querySelector(".note-text"), w.text);
    const embeds = node.querySelector(".note-embeds");
    const seen = new Set();
    let n = 0;
    for (const u of urls) {
      const e = embedFor(u);
      if (!e) continue;
      const key = JSON.stringify(e);
      if (seen.has(key)) continue;
      seen.add(key);
      const el = renderEmbed(e);
      if (el) {
        embeds.append(el);
        n++;
      }
    }
    embeds.hidden = n === 0;
    renderMedia(node.querySelector(".note-media"), w.media);
    return node;
  }

  function relTime(d) {
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }

  function prependWish(w) {
    const el = renderWish(w);
    el.classList.add("fresh");
    board.prepend(el);
    if (oldestId === null) oldestId = w.id;
  }

  let loading = false;
  let done = false;

  async function loadPage() {
    if (loading || done) return;
    loading = true;
    try {
      const qs = oldestId ? `?before=${oldestId}` : "";
      const res = await fetch(`/api/wishes${qs}`);
      if (!res.ok) throw new Error(`couldn't load (${res.status})`);
      const data = await res.json();
      for (const w of data.wishes) {
        board.append(renderWish(w));
        oldestId = w.id;
      }
      done = !data.has_more;
      if (done) observer.disconnect();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      loading = false;
      // If the sentinel is still on screen (short page), keep filling.
      if (!done && sentinel.getBoundingClientRect().top < window.innerHeight + 600) loadPage();
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadPage();
    },
    { rootMargin: "800px 0px" }
  );
  observer.observe(sentinel);
})();