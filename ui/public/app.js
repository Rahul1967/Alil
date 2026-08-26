// Browser chat client. Plain JS (no bundler in the repo) — talks to the TypeScript server
// at /api/chat, which runs the same Brain + shared memory as the terminal REPL.
"use strict";

const log = document.getElementById("log");
const empty = document.getElementById("empty");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const dot = document.getElementById("dot");
const status = document.getElementById("status");

function scrollDown() {
  document.querySelector("main").scrollTop = document.querySelector("main").scrollHeight;
}

function addMessage(role, text, trace) {
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "msg " + role;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  if (trace && trace.length) {
    const t = document.createElement("div");
    t.className = "trace";
    t.textContent = trace.join("\n");
    bubble.appendChild(t);
  }
  row.appendChild(bubble);
  log.appendChild(row);
  scrollDown();
  return bubble;
}

function addNote(text) {
  if (empty) empty.remove();
  const n = document.createElement("div");
  n.className = "note";
  n.textContent = text;
  log.appendChild(n);
  scrollDown();
}

function addTyping() {
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "msg bot";
  row.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
  log.appendChild(row);
  scrollDown();
  return row;
}

async function health() {
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    dot.classList.toggle("on", !!j.ok);
    status.textContent = `${j.model} · memory ${j.memory}`;
  } catch {
    status.textContent = "server unreachable";
  }
}

async function submit(text) {
  addMessage("user", text);
  send.disabled = true;
  input.disabled = true;
  const typing = addTyping();
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const j = await r.json();
    typing.remove();
    if (!r.ok) {
      addNote("error: " + (j.error || r.status));
    } else {
      if (j.reply) addMessage("bot", j.reply, j.trace);
      else addMessage("bot", "(no answer)", j.trace);
      if (j.stopReason && j.stopReason !== "complete") addNote("turn " + j.stopReason);
    }
  } catch (e) {
    typing.remove();
    addNote("network error: " + e.message);
  } finally {
    send.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  submit(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});

// ── Memory dashboard ──────────────────────────────────────────────────────────
const chatView = document.getElementById("chatView");
const memoryView = document.getElementById("memoryView");
const footer = document.querySelector("footer");
const tabChat = document.getElementById("tabChat");
const tabMemory = document.getElementById("tabMemory");
const memContent = document.getElementById("memContent");
let memView = "timeline";
// Page sizes for the paginated views; other views return a plain array.
const PAGE_SIZE = { timeline: 50, episodes: 20 };
const memOffset = { timeline: 0, episodes: 0 };
const RENDERERS = {
  timeline: renderTimeline,
  episodes: renderEpisode,
  canonical: renderCanonical,
  procedures: renderProcedure,
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function provTag(p) {
  const tainted = p && (p.origin === "ingested" || (p.taintedBy && p.taintedBy.length));
  const t = el("span", "tag " + (tainted ? "tainted" : (p ? p.origin : "system")));
  t.textContent = tainted ? (p.origin + " ⚠") : (p ? p.origin : "system");
  return t;
}
function shortTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function showChat() {
  memView && (memoryView.classList.remove("show"));
  chatView.style.display = "";
  footer.style.display = "";
  tabChat.classList.add("active"); tabMemory.classList.remove("active");
}
function showMemory() {
  chatView.style.display = "none";
  footer.style.display = "none";
  memoryView.classList.add("show");
  tabMemory.classList.add("active"); tabChat.classList.remove("active");
  loadStats();
  loadMemory(memView);
}
tabChat.addEventListener("click", showChat);
tabMemory.addEventListener("click", showMemory);

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    memView = b.getAttribute("data-view");
    if (memView in memOffset) memOffset[memView] = 0; // restart paginated views at the top
    loadMemory(memView);
  });
});

async function loadStats() {
  try {
    const s = await (await fetch("/api/memory/stats")).json();
    document.getElementById("c-timeline").textContent = s.timeline ?? "";
    document.getElementById("c-episodes").textContent = s.episodes ?? "";
    document.getElementById("c-canonical").textContent = s.canonical ?? "";
    document.getElementById("c-procedures").textContent = s.procedures ?? "";
  } catch {}
}

async function loadMemory(view) {
  const paged = view in memOffset;
  memContent.innerHTML = "";
  memContent.appendChild(el("div", "empty-tab", "loading…"));

  let url = "/api/memory/" + view;
  if (paged) url += "?limit=" + PAGE_SIZE[view] + "&offset=" + memOffset[view];

  let body;
  try {
    body = await (await fetch(url)).json();
  } catch (e) {
    memContent.innerHTML = "";
    memContent.appendChild(el("div", "empty-tab", "error: " + e.message));
    return;
  }

  // Paginated views return { items, total, limit, offset }; others a plain array.
  const items = paged ? (body.items || []) : body;
  memContent.innerHTML = "";
  if (!Array.isArray(items) || items.length === 0) {
    memContent.appendChild(el("div", "empty-tab", "nothing here yet"));
    if (paged && memOffset[view] > 0) renderPager(view, body); // let the user page back
    return;
  }
  const render = RENDERERS[view];
  if (render) items.forEach(render);
  if (paged) renderPager(view, body);
}

function renderProcedure(p) {
  const card = el("div", "card");
  const meta = el("div", "meta");
  meta.appendChild(el("span", "tag operator", "procedure"));
  meta.appendChild(el("span", "key", p.name));
  meta.appendChild(el("span", "muted", "v" + p.version + " · used " + p.uses + "×"));
  meta.appendChild(provTag(p.provenance));
  card.appendChild(meta);
  card.appendChild(el("div", "meta muted", "when: " + p.trigger));
  card.appendChild(el("div", "body", p.method));
  if (p.steps) card.appendChild(el("div", "meta muted", "steps: " + p.steps));
  if (p.evidence) card.appendChild(el("div", "meta muted", "evidence: " + p.evidence));
  memContent.appendChild(card);
}

function renderPager(view, body) {
  const total = body.total ?? 0;
  const limit = body.limit ?? PAGE_SIZE[view];
  const offset = body.offset ?? 0;
  if (total <= limit && offset === 0) return; // single page — no controls needed
  const shownFrom = total === 0 ? 0 : offset + 1;
  const shownTo = Math.min(offset + limit, total);

  const bar = el("div", "pager");
  const prev = el("button", null, "‹ Newer");
  prev.disabled = offset === 0;
  prev.addEventListener("click", () => { memOffset[view] = Math.max(0, offset - limit); loadMemory(view); });

  const label = el("span", "pager-label", shownFrom + "–" + shownTo + " of " + total);

  const next = el("button", null, "Older ›");
  next.disabled = offset + limit >= total;
  next.addEventListener("click", () => { memOffset[view] = offset + limit; loadMemory(view); });

  bar.appendChild(prev);
  bar.appendChild(label);
  bar.appendChild(next);
  memContent.appendChild(bar);
}

function renderTimeline(r) {
  const card = el("div", "card");
  const meta = el("div", "meta");
  meta.appendChild(el("span", null, "#" + r.seq));
  meta.appendChild(el("span", null, r.channel + " / " + r.role));
  meta.appendChild(provTag(r.provenance));
  meta.appendChild(el("span", "muted", shortTime(r.at)));
  card.appendChild(meta);
  card.appendChild(el("div", "body", r.text || "(no text)"));
  memContent.appendChild(card);
}

function renderEpisode(e) {
  const card = el("div", "card");
  const meta = el("div", "meta");
  meta.appendChild(el("span", "muted", e.id.slice(0, 16) + "…"));
  meta.appendChild(el("span", null, "seq " + e.startSeq + "–" + (e.endSeq ?? "…")));
  meta.appendChild(el("span", e.open ? "tag tainted" : "tag system", e.open ? "OPEN" : "closed"));
  card.appendChild(meta);
  card.appendChild(el("div", "body", e.summary || (e.open ? "(open — not yet distilled)" : "(no summary)")));
  if (e.salientFacts && e.salientFacts.length) {
    card.appendChild(el("div", "meta muted", "salient: " + e.salientFacts.join(" · ")));
  }
  memContent.appendChild(card);
}

const KIND_LABEL = {
  preference: "preference",
  memory_instruction: "memory instruction",
  rule: "rule",
  procedural: "procedural",
};
function renderCanonical(f) {
  const card = el("div", "card");
  const meta = el("div", "meta");
  const kind = el("span", "tag " + (f.kind === "memory_instruction" ? "system" : f.kind === "rule" ? "user_channel" : "operator"));
  kind.textContent = KIND_LABEL[f.kind] || f.kind || "preference";
  meta.appendChild(kind);
  if (f.key) meta.appendChild(el("span", "key", f.key));
  meta.appendChild(provTag(f.provenance));
  card.appendChild(meta);
  card.appendChild(el("div", "body", f.text));
  memContent.appendChild(card);
}

health();
