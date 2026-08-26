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
    loadMemory(memView);
  });
});

async function loadStats() {
  try {
    const s = await (await fetch("/api/memory/stats")).json();
    document.getElementById("c-timeline").textContent = s.timeline ?? "";
    document.getElementById("c-episodes").textContent = s.episodes ?? "";
    document.getElementById("c-canonical").textContent = s.canonical ?? "";
  } catch {}
}

async function loadMemory(view) {
  memContent.innerHTML = "";
  memContent.appendChild(el("div", "empty-tab", "loading…"));
  let data;
  try {
    data = await (await fetch("/api/memory/" + view)).json();
  } catch (e) {
    memContent.innerHTML = "";
    memContent.appendChild(el("div", "empty-tab", "error: " + e.message));
    return;
  }
  memContent.innerHTML = "";
  if (!Array.isArray(data) || data.length === 0) {
    memContent.appendChild(el("div", "empty-tab", "nothing here yet"));
    return;
  }
  if (view === "timeline") data.forEach(renderTimeline);
  else if (view === "episodes") data.forEach(renderEpisode);
  else if (view === "canonical") data.forEach(renderCanonical);
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
