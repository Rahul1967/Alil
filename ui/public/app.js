// Browser chat client. Plain JS (no bundler in the repo) — talks to the TypeScript server
// at /api/chat, which runs the same Brain + shared memory as the terminal REPL.
"use strict";

const log = document.getElementById("log");
const empty = document.getElementById("empty");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const attach = document.getElementById("attach");
const fileInput = document.getElementById("fileInput");
const attachTray = document.getElementById("attachTray");
// Files uploaded (placed in the sandbox by /api/upload) and pending on the next chat turn.
let pendingAttachments = [];

function renderTray() {
  attachTray.innerHTML = "";
  attachTray.hidden = pendingAttachments.length === 0;
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const kb = a.bytes >= 1000 ? Math.round(a.bytes / 1000) + " KB" : a.bytes + " B";
    chip.textContent = `📄 ${a.filename} (${kb})`;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "✕";
    x.addEventListener("click", () => { pendingAttachments.splice(i, 1); renderTray(); });
    chip.appendChild(x);
    attachTray.appendChild(chip);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

attach.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  for (const file of Array.from(fileInput.files || [])) {
    try {
      const contentBase64 = await fileToBase64(file);
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentBase64 }),
      });
      const j = await r.json();
      if (r.ok && j.attachment) { pendingAttachments.push(j.attachment); renderTray(); }
      else addNote("upload failed: " + (j.error || r.status));
    } catch (e) {
      addNote("upload error: " + e.message);
    }
  }
  fileInput.value = "";
});
const dot = document.getElementById("dot");
const status = document.getElementById("status");

function scrollDown() {
  document.querySelector("main").scrollTop = document.querySelector("main").scrollHeight;
}

// ── Markdown beautifier ────────────────────────────────────────────────────────
// Small, dependency-free, and safe-by-construction: every scrap of source text is
// HTML-escaped BEFORE any tag is emitted, so model output (untrusted) can never inject
// markup. We only render a pragmatic subset — headings, bold/italic, inline+fenced
// code, links, lists, blockquotes, hr — which covers what the model actually writes.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Inline spans, applied to already-escaped text. Order matters: code first so its
// contents are shielded from emphasis/link rules.
function renderInline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  // [label](url) — only http(s)/mailto to keep hrefs harmless.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\b__([^_]+)__\b/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

// Block-level pass over escaped source lines.
function renderMarkdown(src) {
  const lines = escapeHtml(src).split("\n");
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${renderInline(para.join(" "))}</p>`); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) { // fenced code block — verbatim until the closing fence
      flushPara();
      i++;
      const body = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // consume closing fence
      out.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { flushPara(); const n = heading[1].length; out.push(`<h${n}>${renderInline(heading[2])}</h${n}>`); i++; continue; }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) { flushPara(); out.push("<hr>"); i++; continue; }
    // '>' has already been escaped to '&gt;' by escapeHtml, so match that form.
    if (/^\s*&gt;\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
      out.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join("");
}

function addMessage(role, text, trace) {
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "msg " + role;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "bot") {
    bubble.classList.add("md");
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }
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

// The typing row for the in-flight turn, so pollers can flip it to a "waiting on you" state
// when the turn parks on an approval (otherwise the page just looks stuck "loading").
let activeTyping = null;
function setTurnWaiting(waiting) {
  if (!activeTyping) return;
  const bubble = activeTyping.querySelector(".bubble");
  if (!bubble) return;
  const already = bubble.classList.contains("awaiting");
  if (waiting === already) return; // idempotent: don't rewrite the DOM every poll tick
  if (waiting) {
    bubble.classList.add("awaiting");
    bubble.innerHTML = '<span class="await-approval">⏳ waiting for your approval below ↓</span>';
  } else {
    bubble.classList.remove("awaiting");
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  }
}

// ── Lens switcher: an operator action (this page), recorded in the audit ledger ─────────────
const lensSelect = document.getElementById("lensSelect");
async function loadLenses() {
  try {
    const j = await (await fetch("/api/lens")).json();
    lensSelect.replaceChildren(new Option("none", ""));
    for (const l of j.lenses || []) lensSelect.appendChild(new Option(l.title + (l.policyRules ? " 🔒" : ""), l.id));
    lensSelect.value = j.active || "";
    lensSelect.title = (j.errors || []).map((e) => e.error).join("\n") || "";
  } catch { /* server unreachable — health() reports it */ }
}
lensSelect.addEventListener("change", async () => {
  const r = await fetch("/api/lens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: lensSelect.value || null }) });
  if (!r.ok) alert((await r.json()).error || "could not switch lens");
  await loadLenses();
});
loadLenses();

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

// ── HITL approvals ────────────────────────────────────────────────────────────
// While a turn is in flight the server may park an approval; we poll for it and render
// Approve/Reject buttons inline. Answered by POST /api/approval.
const shownApprovals = new Set();

function renderApproval(a) {
  if (empty) empty.remove();
  const card = document.createElement("div");
  card.className = "approval";
  card.dataset.id = a.id;
  const head = document.createElement("div");
  head.className = "approval-head";
  head.textContent = a.tool === "plan" ? "Alil wants to run this plan" : `Alil wants to run ${a.tool} · ${a.effect} · ${a.risk} risk`;
  card.appendChild(head);
  if (a.reason) card.appendChild(Object.assign(document.createElement("div"), { className: "approval-reason", textContent: a.reason }));
  card.appendChild(Object.assign(document.createElement("div"), { className: "approval-args", textContent: a.args }));
  const btns = document.createElement("div");
  btns.className = "approval-btns";
  const approve = Object.assign(document.createElement("button"), { className: "approve", textContent: "Approve & run" });
  const reject = Object.assign(document.createElement("button"), { className: "reject", textContent: "Reject" });
  const answer = async (approved) => {
    approve.disabled = reject.disabled = true;
    try {
      await fetch("/api/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: a.id, approved }),
      });
    } catch (e) {
      addNote("approval failed: " + e.message);
    }
    card.classList.add("resolved");
    head.textContent = (approved ? "Approved — running" : "Rejected — not run") + ` · ${a.tool}`;
    btns.remove();
    // The turn resumes now — flip the indicator back to "thinking" until the reply lands (or the
    // next approval parks). Without this the "waiting for approval" note would linger misleadingly.
    setTurnWaiting(false);
  };
  approve.addEventListener("click", () => answer(true));
  reject.addEventListener("click", () => answer(false));
  btns.appendChild(approve);
  btns.appendChild(reject);
  card.appendChild(btns);
  // Render where the operator is looking: a plan run is watched from the Plan tab.
  const planView = document.getElementById("planView");
  if (planView && planView.classList.contains("show")) {
    document.getElementById("planApprovals").appendChild(card);
  } else {
    log.appendChild(card);
    scrollDown();
  }
}

async function pollApprovals() {
  try {
    const { items } = await (await fetch("/api/approvals")).json();
    const pending = new Set((items || []).map((a) => a.id));
    for (const a of items || []) {
      if (shownApprovals.has(a.id)) continue;
      shownApprovals.add(a.id);
      renderApproval(a);
    }
    // Reconcile: any on-screen card the server no longer lists as pending has been resolved
    // elsewhere or timed out server-side (the approval has a 5-min ceiling). Mark it resolved so a
    // dead card can't sit there looking actionable, and so the banner clears with it.
    for (const card of document.querySelectorAll(".approval:not(.resolved)")) {
      if (!pending.has(card.dataset.id)) {
        card.classList.add("resolved");
        const head = card.querySelector(".approval-head");
        if (head) head.textContent = "No longer pending (answered elsewhere or timed out)";
        card.querySelector(".approval-btns")?.remove();
      }
    }
    // The banner tracks what the user can ACT on — a rendered, still-unanswered card — never the
    // raw server count. Derive it from the DOM so banner and card can never disagree.
    setTurnWaiting(hasActionableApproval());
  } catch {
    /* transient — try again next tick */
  }
}

/** True iff at least one approval card is on screen and not yet resolved (awaiting the user). */
function hasActionableApproval() {
  return document.querySelector(".approval:not(.resolved)") !== null;
}

async function submit(text) {
  const attachments = pendingAttachments;
  pendingAttachments = [];
  renderTray();
  const shown = attachments.length > 0 ? `${text}${text ? "\n" : ""}📎 ${attachments.map((a) => a.filename).join(", ")}` : text;
  addMessage("user", shown);
  send.disabled = true;
  input.disabled = true;
  const typing = addTyping();
  activeTyping = typing;
  // Approvals are polled by the always-on poller (bottom of file), so a parked approval renders
  // even if it lands before this turn's first tick — no per-turn interval needed here.
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, attachments }),
    });
    const j = await r.json();
    typing.remove();
    activeTyping = null;
    if (!r.ok) {
      addNote("error: " + (j.error || r.status));
    } else {
      if (j.reply) addMessage("bot", j.reply, j.trace);
      else addMessage("bot", "(no answer)", j.trace);
      if (j.stopReason === "command") loadLenses(); // a /lens command — keep the header picker in sync
      else if (j.stopReason && j.stopReason !== "complete") addNote("turn " + j.stopReason);
    }
  } catch (e) {
    typing.remove();
    activeTyping = null;
    addNote("network error: " + e.message);
  } finally {
    activeTyping = null;
    send.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && pendingAttachments.length === 0) return;
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
const planView = document.getElementById("planView");
const laterView = document.getElementById("laterView");
const memoryView = document.getElementById("memoryView");
const footer = document.querySelector("footer");
const tabChat = document.getElementById("tabChat");
const tabPlan = document.getElementById("tabPlan");
const tabLater = document.getElementById("tabLater");
const tabDossier = document.getElementById("tabDossier");
const tabMcp = document.getElementById("tabMcp");
const tabMemory = document.getElementById("tabMemory");
const dossierView = document.getElementById("dossierView");
const mcpView = document.getElementById("mcpView");
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

function setView(which) {
  chatView.style.display = which === "chat" ? "" : "none";
  footer.style.display = which === "chat" ? "" : "none";
  planView.classList.toggle("show", which === "plan");
  laterView.classList.toggle("show", which === "later");
  dossierView.classList.toggle("show", which === "dossier");
  mcpView.classList.toggle("show", which === "mcp");
  memoryView.classList.toggle("show", which === "memory");
  tabChat.classList.toggle("active", which === "chat");
  tabPlan.classList.toggle("active", which === "plan");
  tabLater.classList.toggle("active", which === "later");
  tabDossier.classList.toggle("active", which === "dossier");
  tabMcp.classList.toggle("active", which === "mcp");
  tabMemory.classList.toggle("active", which === "memory");
  // Stop any running graph animation when leaving the dossier view (avoids a background RAF loop).
  if (which !== "dossier" && typeof graphSim !== "undefined" && graphSim && graphSim.raf) {
    cancelAnimationFrame(graphSim.raf);
    graphSim.raf = null;
  }
}
tabChat.addEventListener("click", () => setView("chat"));
tabPlan.addEventListener("click", () => setView("plan"));
tabDossier.addEventListener("click", () => { setView("dossier"); loadDossier(); });
tabMcp.addEventListener("click", () => { setView("mcp"); loadMcp(); });
tabLater.addEventListener("click", () => { setView("later"); loadLater(); });
tabMemory.addEventListener("click", () => { setView("memory"); loadStats(); loadMemory(memView); });

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
  meta.appendChild(el("span", "muted", "v" + p.version + " · used " + p.uses + "×" + (p.successes + p.failures > 0 ? " · " + p.successes + " worked / " + p.failures + " failed" : "")));
  if (p.status === "deprecated") meta.appendChild(el("span", "tag tainted", "deprecated"));
  if (p.lens) meta.appendChild(el("span", "tag", "lens: " + p.lens));
  meta.appendChild(provTag(p.provenance));
  card.appendChild(meta);
  if (p.tags && p.tags.length) card.appendChild(el("div", "meta muted", "tags: " + p.tags.join(", ")));
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

// ── Later view (prospective memory) ─────────────────────────────────────────────
const laterContent = document.getElementById("laterContent");
let laterStatus = "live";
const KIND_ORDER = ["reminder", "watch", "fact", "decision", "aspiration"];
const KIND_SECTION = { reminder: "Reminders", watch: "Watches", fact: "Facts for later", decision: "Decisions", aspiration: "Someday" };
const STATUS_BUCKET = { pending: "live", firing: "live", done: "archived", cancelled: "archived", expired: "archived" };

document.querySelectorAll("#laterStatus button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#laterStatus button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    laterStatus = b.getAttribute("data-status");
    loadLater();
  });
});

function shortDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return iso; }
}

function renderIntention(i) {
  const card = el("div", "icard " + (i.tainted ? "tainted" : i.kind));
  const top = el("div", "top");
  top.appendChild(el("span", "sdot " + i.status));
  top.appendChild(el("span", "kindtag " + i.kind, i.kind));
  if (i.tainted) top.appendChild(el("span", "tag tainted", i.provenance.origin + " ⚠"));
  top.appendChild(el("span", "title", i.title));
  card.appendChild(top);
  if (i.action) card.appendChild(el("div", "act", "“" + i.action + "”"));
  // The trigger's leading emoji is data from the server; render as text.
  card.appendChild(el("div", "when", i.when));
  const foot = el("div", "foot");
  foot.appendChild(el("span", null, i.status));
  if (i.expiresAt) foot.appendChild(el("span", null, "expires " + shortDate(i.expiresAt)));
  foot.appendChild(el("span", null, "added " + shortDate(i.createdAt)));
  card.appendChild(foot);

  // Lifecycle actions for live items (each is a gated write → in-page Approve/Reject).
  if (i.status === "pending" || i.status === "firing") {
    const acts = el("div", "iacts");
    const mk = (label, cls, fn) => { const b = el("button", cls, label); b.addEventListener("click", fn); return b; };
    acts.appendChild(mk("Snooze 1h", "ghost", () => laterAction(i.id, "snooze", new Date(Date.now() + 3600e3).toISOString())));
    acts.appendChild(mk("Snooze 1d", "ghost", () => laterAction(i.id, "snooze", new Date(Date.now() + 86400e3).toISOString())));
    acts.appendChild(mk("Done", "primary", () => laterAction(i.id, "done")));
    acts.appendChild(mk("✕", "danger", () => laterAction(i.id, "cancel")));
    card.appendChild(acts);
  }
  laterContent.appendChild(card);
}

async function laterAction(id, op, until) {
  // The write parks for approval, which surfaces in the chat stream — switch there so it's visible.
  setView("chat");
  const poll = setInterval(pollApprovals, 1000);
  try {
    const r = await fetch("/api/prospective/" + encodeURIComponent(id) + "/" + op, {
      method: "POST", headers: { "content-type": "application/json" },
      body: op === "snooze" ? JSON.stringify({ until }) : "{}",
    });
    clearInterval(poll);
    const j = await r.json();
    addNote(op + ": " + (j.summary || j.outcome || j.error || "done"));
  } catch (e) {
    clearInterval(poll);
    addNote(op + " failed: " + e.message);
  }
}

async function loadLater() {
  laterContent.innerHTML = "";
  laterContent.appendChild(el("div", "empty-tab", "loading…"));
  let items;
  try {
    items = (await (await fetch("/api/prospective")).json()).items || [];
  } catch (e) {
    laterContent.innerHTML = ""; laterContent.appendChild(el("div", "empty-tab", "error: " + e.message)); return;
  }
  const filtered = items.filter((i) => laterStatus === "all" || STATUS_BUCKET[i.status] === laterStatus);
  laterContent.innerHTML = "";
  if (filtered.length === 0) {
    laterContent.appendChild(el("div", "empty-tab", laterStatus === "live"
      ? "Nothing scheduled. Ask Alil to “remind me…”, “save this for later”, or “add to my someday list.”"
      : "nothing here"));
    return;
  }
  for (const kind of KIND_ORDER) {
    const group = filtered.filter((i) => i.kind === kind);
    if (group.length === 0) continue;
    laterContent.appendChild(el("div", "later-section", KIND_SECTION[kind] + " · " + group.length));
    group.sort((a, b) => (a.nextFireAt || "9999").localeCompare(b.nextFireAt || "9999"));
    group.forEach(renderIntention);
  }
}

// ── Dossier view (operator model) ────────────────────────────────────────────
const dossierContent = document.getElementById("dossierContent");
const dossierSearch = document.getElementById("dossierSearch");
let dossierTypeFilter = "";
let dossierSearchTimer = null;

document.querySelectorAll("#dossierType button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#dossierType button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    dossierTypeFilter = b.getAttribute("data-type");
    loadDossier();
  });
});
dossierSearch.addEventListener("input", () => {
  clearTimeout(dossierSearchTimer);
  dossierSearchTimer = setTimeout(loadDossier, 200);
});

const DTYPE_LABEL = {
  identity: "Identity", preferences: "Preferences", person: "People", account: "Accounts",
  loan: "Loans", note: "Notes", document: "Documents", event: "Timeline", index: "Indexes",
};
const DTYPE_ORDER = ["identity", "preferences", "person", "account", "loan", "note", "document", "event", "index"];

function renderDossierCard(item) {
  const card = el("div", "dcard " + (item.status === "superseded" ? "superseded" : ""));
  card.appendChild(el("div", "dtitle", item.title));
  const meta = el("div", "dmeta");
  meta.appendChild(el("span", "dtype", item.type));
  (item.tags || []).forEach((t) => meta.appendChild(el("span", "dchip", t)));
  if (item.status && item.status !== "active") meta.appendChild(el("span", "dchip", item.status));
  meta.appendChild(el("span", "", "updated " + item.updated));
  card.appendChild(meta);
  if (item.snippet) card.appendChild(el("div", "dsnip", item.snippet));
  const body = el("div", "dbody");
  card.appendChild(body);
  let loaded = false;
  card.addEventListener("click", async () => {
    const opening = !card.classList.contains("open");
    card.classList.toggle("open");
    if (opening && !loaded) {
      loaded = true;
      body.textContent = "loading…";
      try {
        const f = await (await fetch("/api/dossier/" + encodeURIComponent(item.slug))).json();
        body.textContent = "";
        if (f.frontmatter && f.frontmatter.description) body.appendChild(el("div", "ddesc", f.frontmatter.description));
        body.appendChild(el("div", "", f.body || "(empty)"));
      } catch (e) { body.textContent = "error: " + e.message; }
    }
  });
  return card;
}

async function loadDossier() {
  dossierContent.innerHTML = "";
  dossierContent.appendChild(el("div", "empty-tab", "loading…"));
  const params = new URLSearchParams();
  if (dossierTypeFilter) params.set("type", dossierTypeFilter);
  if (dossierSearch.value.trim()) params.set("text", dossierSearch.value.trim());
  let items;
  try {
    items = (await (await fetch("/api/dossier?" + params.toString())).json()).items || [];
  } catch (e) {
    dossierContent.innerHTML = ""; dossierContent.appendChild(el("div", "empty-tab", "error: " + e.message)); return;
  }
  dossierContent.innerHTML = "";
  if (items.length === 0) {
    dossierContent.appendChild(el("div", "empty-tab",
      "Nothing here yet. As you talk to Alil it builds a model of you — who you are, what you prefer, what you own — one markdown file per thing, each proposed for your approval."));
    return;
  }
  // Known types first (in a sensible order), then any Alil-invented types, alphabetically.
  const invented = [...new Set(items.map((i) => i.type))].filter((t) => !DTYPE_ORDER.includes(t)).sort();
  for (const type of [...DTYPE_ORDER, ...invented]) {
    const group = items.filter((i) => i.type === type);
    if (group.length === 0) continue;
    const label = DTYPE_LABEL[type] || (type.charAt(0).toUpperCase() + type.slice(1));
    dossierContent.appendChild(el("div", "later-section", label + " · " + group.length));
    group.forEach((i) => dossierContent.appendChild(renderDossierCard(i)));
  }
}

// ── Dossier view modes: Files / Timeline / Graph ─────────────────────────────
const dModeEls = {
  files: document.getElementById("dossierFiles"),
  timeline: document.getElementById("dossierTimeline"),
  graph: document.getElementById("dossierGraph"),
};
let dossierMode = "files";
document.querySelectorAll("#dossierModes button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#dossierModes button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    dossierMode = b.getAttribute("data-mode");
    for (const [k, node] of Object.entries(dModeEls)) node.classList.toggle("show", k === dossierMode);
    if (dossierMode === "files") loadDossier();
    else if (dossierMode === "timeline") loadTimeline();
    else if (dossierMode === "graph") loadGraph();
  });
});

/** Fetch one dossier file's body as text (shared by timeline + graph detail panels). */
async function fetchDossierBody(slug) {
  try {
    const f = await (await fetch("/api/dossier/" + encodeURIComponent(slug))).json();
    if (!f || f.error) return null;
    return f;
  } catch { return null; }
}

// ── Timeline mode (vertical life-arc, grouped by domain) ─────────────────────
const timelineContent = document.getElementById("timelineContent");
const timelineDomains = document.getElementById("timelineDomains");
let timelineDomainFilter = "";

async function loadTimeline() {
  timelineContent.innerHTML = "";
  timelineContent.appendChild(el("div", "empty-tab", "loading…"));
  let data;
  try {
    const params = new URLSearchParams();
    if (timelineDomainFilter) params.set("domain", timelineDomainFilter);
    data = await (await fetch("/api/dossier/timeline?" + params.toString())).json();
  } catch (e) {
    timelineContent.innerHTML = ""; timelineContent.appendChild(el("div", "empty-tab", "error: " + e.message)); return;
  }
  // Domain filter chips (built once from the full domain set the API reports).
  if (!timelineDomains.dataset.built && data.domains) {
    timelineDomains.dataset.built = "1";
    const mk = (dom, label) => {
      const btn = el("button", dom === "" ? "active" : "", label);
      btn.addEventListener("click", () => {
        timelineDomains.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        btn.classList.add("active"); timelineDomainFilter = dom; loadTimeline();
      });
      timelineDomains.appendChild(btn);
    };
    mk("", "All");
    data.domains.forEach((d) => mk(d, d));
  }

  timelineContent.innerHTML = "";
  const rows = data.rows || [];
  if (rows.length === 0) {
    timelineContent.appendChild(el("div", "empty-tab",
      "No transitions recorded yet. As facts are created, changed, or superseded, Alil logs each one here as a life-arc."));
    return;
  }
  // Group by domain, preserving the newest-first order the API already applied.
  const byDomain = {};
  for (const r of rows) (byDomain[r.domain || "general"] ||= []).push(r);
  for (const domain of Object.keys(byDomain).sort()) {
    timelineContent.appendChild(el("div", "tl-domain", domain));
    for (const r of byDomain[domain]) {
      const item = el("div", "tl-item");
      item.appendChild(el("div", "tl-date", r.when));
      const title = el("div", "tl-title", r.title);
      const sub = el("div", "tl-sub", "");
      let loaded = false;
      title.addEventListener("click", async () => {
        const opening = !item.classList.contains("open");
        item.classList.toggle("open");
        if (opening && !loaded) {
          loaded = true; sub.textContent = "loading…";
          const f = await fetchDossierBody(r.slug);
          sub.textContent = f ? (f.body || "(empty)") : "(could not load)";
          if (r.subject) {
            const link = el("div", "tl-date", "subject: " + r.subject);
            sub.appendChild(link);
          }
        }
      });
      item.appendChild(title);
      item.appendChild(sub);
      timelineContent.appendChild(item);
    }
  }
}

// ── Graph mode (operator-centred node-link, tiny hand-rolled force layout) ────
const graphCanvas = document.getElementById("graphCanvas");
const graphLegend = document.getElementById("graphLegend");
const graphDetail = document.getElementById("graphDetail");
const GRAPH_COLORS = {
  identity: "#7c5cff", person: "#2bb673", account: "#e0a030", loan: "#e0a030",
  document: "#3a9bdc", note: "#8a8f98", event: "#8a8f98", index: "#8a8f98",
};
const graphColor = (type) => GRAPH_COLORS[type] || "#c0563a"; // invented types → accent
let graphSim = null; // { nodes, edges, raf } so we can cancel a running simulation on tab switch

async function loadGraph() {
  graphDetail.classList.remove("show");
  if (graphSim && graphSim.raf) cancelAnimationFrame(graphSim.raf);
  let data;
  try {
    data = await (await fetch("/api/dossier/graph")).json();
  } catch (e) {
    graphLegend.textContent = "error: " + e.message; return;
  }
  const nodes = data.nodes || [];
  const edges = data.edges || [];

  // Legend from the distinct node types present.
  graphLegend.innerHTML = "";
  [...new Set(nodes.map((n) => n.type))].forEach((t) => {
    const lg = el("span", "lg");
    const dot = el("span", "dot"); dot.style.background = graphColor(t); lg.appendChild(dot);
    lg.appendChild(document.createTextNode(t)); graphLegend.appendChild(lg);
  });
  if (nodes.length <= 1) {
    graphLegend.innerHTML = "";
    graphLegend.appendChild(el("span", "", "The graph fills in as Alil records people, accounts, and other facts about you."));
  }

  runForceGraph(nodes, edges);
}

/** A minimal force-directed layout on <canvas>: repulsion between nodes, springs along edges, and
 *  gravity toward the center (the operator anchor is pinned). No dependencies — a few hundred ticks
 *  settle a personal-scale graph (tens of nodes). Click a node to open its file detail. */
function runForceGraph(rawNodes, edges) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = graphCanvas.clientWidth || 700;
  const cssH = 460;
  graphCanvas.width = cssW * dpr; graphCanvas.height = cssH * dpr;
  const ctx = graphCanvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const cx = cssW / 2, cy = cssH / 2;

  // Seed positions in a ring around the center; the anchor sits at the middle and stays pinned.
  const nodes = rawNodes.map((n, i) => {
    const a = (i / Math.max(1, rawNodes.length)) * Math.PI * 2;
    return { ...n, x: n.central ? cx : cx + Math.cos(a) * 140, y: n.central ? cy : cy + Math.sin(a) * 140, vx: 0, vy: 0 };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = edges.map((e) => ({ s: byId.get(e.source), t: byId.get(e.target), kind: e.kind, label: e.label })).filter((l) => l.s && l.t);

  const REPULSION = 5200, SPRING = 0.015, SPRING_LEN = 96, GRAVITY = 0.012, DAMPING = 0.85;
  let ticks = 0;

  function step() {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (a.central) continue;
      let fx = 0, fy = 0;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const f = REPULSION / d2;
        const d = Math.sqrt(d2);
        fx += (dx / d) * f; fy += (dy / d) * f;
      }
      fx += (cx - a.x) * GRAVITY; fy += (cy - a.y) * GRAVITY; // center gravity
      a.vx = (a.vx + fx) * DAMPING; a.vy = (a.vy + fy) * DAMPING;
    }
    for (const l of links) {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - SPRING_LEN) * SPRING;
      const ux = dx / d, uy = dy / d;
      if (!l.s.central) { l.s.vx += ux * f; l.s.vy += uy * f; }
      if (!l.t.central) { l.t.vx -= ux * f; l.t.vy -= uy * f; }
    }
    for (const n of nodes) {
      if (n.central) continue;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(20, Math.min(cssW - 20, n.x));
      n.y = Math.max(20, Math.min(cssH - 20, n.y));
    }
    draw();
    if (++ticks < 400) graphSim.raf = requestAnimationFrame(step);
  }

  function draw() {
    ctx.clearRect(0, 0, cssW, cssH);
    // Edges
    ctx.lineWidth = 1;
    for (const l of links) {
      ctx.strokeStyle = l.kind === "relation" ? "#2bb67366" : l.kind === "ownership" ? "#e0a03066" : "#8a8f9855";
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
    }
    // Nodes
    ctx.font = "600 11px 'IBM Plex Sans', sans-serif";
    for (const n of nodes) {
      const r = n.central ? 13 : 7;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = graphColor(n.type);
      ctx.globalAlpha = n.status === "superseded" ? 0.4 : 1;
      ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = "#c9ccd1";
      const label = n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title;
      ctx.fillText(label, n.x + r + 3, n.y + 3);
    }
  }

  graphSim = { nodes, links, raf: null };
  step();

  // Click → find nearest node and open its detail.
  graphCanvas.onclick = async (ev) => {
    const rect = graphCanvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    let best = null, bestD = 18 * 18;
    for (const n of nodes) {
      const dx = n.x - mx, dy = n.y - my, d = dx * dx + dy * dy;
      if (d < bestD) { best = n; bestD = d; }
    }
    if (!best) { graphDetail.classList.remove("show"); return; }
    graphDetail.classList.add("show");
    graphDetail.innerHTML = "";
    graphDetail.appendChild(el("div", "gd-title", best.title + "  (" + best.type + ")"));
    const bodyDiv = el("div", "", "loading…");
    graphDetail.appendChild(bodyDiv);
    if (best.id === "__operator__") { bodyDiv.textContent = "The operator anchor. Add an identity file to give it content."; return; }
    const f = await fetchDossierBody(best.id);
    bodyDiv.textContent = f ? (f.body || "(empty)") : "(could not load)";
  };
}

// ── MCP view (external tools, read-only) ─────────────────────────────────────
const mcpServers = document.getElementById("mcpServers");
const mcpResults = document.getElementById("mcpResults");
const mcpSearch = document.getElementById("mcpSearch");
let mcpSearchTimer = null;

async function loadMcp() {
  mcpServers.innerHTML = "";
  mcpServers.appendChild(el("div", "empty-tab", "loading…"));
  let data;
  try {
    data = await (await fetch("/api/mcp/status")).json();
  } catch (e) {
    mcpServers.innerHTML = ""; mcpServers.appendChild(el("div", "empty-tab", "error: " + e.message)); return;
  }
  mcpServers.innerHTML = "";
  if (!data.enabled || !data.servers || data.servers.length === 0) {
    mcpServers.appendChild(el("div", "empty-tab",
      "No MCP servers configured. Add servers to config/mcp.json ({ \"servers\": [...] }) and restart. External tools are discovered on demand — never injected into context."));
    return;
  }
  for (const s of data.servers) {
    const row = el("div", "mcp-srv");
    row.appendChild(el("span", "name", s.server));
    row.appendChild(el("span", "", s.transport));
    const grow = el("span", "grow"); row.appendChild(grow);
    if (s.circuitOpen) row.appendChild(el("span", "badge open", "circuit open"));
    if (s.enabled === false) {
      row.appendChild(el("span", "badge down", "disabled"));
    } else {
      row.appendChild(el("span", "badge " + (s.connected ? "up" : "down"), s.connected ? "connected" : "idle"));
      if (s.toolCount) row.appendChild(el("span", "badge", s.toolCount + " tools"));
    }
    // Enable/disable toggle — a disabled server is fully invisible to the model.
    const toggle = el("button", "mcp-toggle", s.enabled === false ? "Enable" : "Disable");
    toggle.addEventListener("click", async (e) => {
      e.stopPropagation();
      toggle.disabled = true;
      try {
        await fetch("/api/mcp/toggle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ server: s.server, enabled: s.enabled === false }),
        });
        await loadMcp();       // refresh status
        if (s.enabled !== false) { mcpResults.innerHTML = ""; mcpSearch.value = ""; } // clear stale hits after a disable
      } catch (err) { toggle.disabled = false; toggle.textContent = "error"; }
    });
    row.appendChild(toggle);
    mcpServers.appendChild(row);
  }
}

mcpSearch.addEventListener("input", () => {
  clearTimeout(mcpSearchTimer);
  mcpSearchTimer = setTimeout(runMcpSearch, 250);
});

async function runMcpSearch() {
  const q = mcpSearch.value.trim();
  mcpResults.innerHTML = "";
  if (!q) return;
  mcpResults.appendChild(el("div", "empty-tab", "searching…"));
  let data;
  try {
    data = await (await fetch("/api/mcp/search?q=" + encodeURIComponent(q))).json();
  } catch (e) {
    mcpResults.innerHTML = ""; mcpResults.appendChild(el("div", "empty-tab", "error: " + e.message)); return;
  }
  mcpResults.innerHTML = "";
  const hits = data.hits || [];
  if (hits.length === 0) {
    mcpResults.appendChild(el("div", "empty-tab", data.error ? ("error: " + data.error) : "No matching external tools."));
    return;
  }
  for (const h of hits) mcpResults.appendChild(renderMcpTool(h));
}

function renderMcpTool(hit) {
  const card = el("div", "dcard");
  card.appendChild(el("div", "dtitle", hit.name));
  const meta = el("div", "dmeta");
  meta.appendChild(el("span", "dtype", hit.server));
  meta.appendChild(el("span", "", hit.description || ""));
  card.appendChild(meta);
  const body = el("div", "dbody");
  card.appendChild(body);
  let loaded = false;
  card.addEventListener("click", async () => {
    const opening = !card.classList.contains("open");
    card.classList.toggle("open");
    if (opening && !loaded) {
      loaded = true;
      body.textContent = "loading schema…";
      try {
        const d = await (await fetch("/api/mcp/tool?server=" + encodeURIComponent(hit.server) + "&name=" + encodeURIComponent(hit.name))).json();
        body.textContent = "";
        if (d.error) { body.textContent = "error: " + d.error; return; }
        body.appendChild(el("div", "ddesc", d.description || ""));
        body.appendChild(el("div", "dmeta", "effect: " + d.effect + " · risk: " + d.risk + " · " + (d.reversible ? "reversible" : "irreversible")));
        const pre = el("div", "", JSON.stringify(d.inputSchema, null, 2));
        pre.style.whiteSpace = "pre-wrap"; pre.style.fontFamily = "'IBM Plex Mono', monospace"; pre.style.fontSize = "12px"; pre.style.marginTop = "8px";
        body.appendChild(pre);
      } catch (e) { body.textContent = "error: " + e.message; }
    }
  });
  return card;
}

// ── Plan view ──────────────────────────────────────────────────────────────────
const planGoal = document.getElementById("planGoal");
const planPreview = document.getElementById("planPreview");
const planRun = document.getElementById("planRun");
const planNodes = document.getElementById("planNodes");

function renderPlanNodes(nodes, status, replans) {
  planNodes.innerHTML = "";
  if (status) {
    const head = el("div", "panel-sub");
    head.textContent = status === "planned" ? `preview — ${nodes.length} steps (nothing executed)` : `plan ${status} · ${replans} replan${replans === 1 ? "" : "s"}`;
    planNodes.appendChild(head);
  }
  nodes.forEach((n) => {
    const card = el("div", "pnode " + (n.status || "pending"));
    const st = el("span", "st", n.status || "pending");
    card.appendChild(st);
    card.appendChild(el("span", "id", n.id + " "));
    card.appendChild(document.createTextNode(n.description));
    if (n.deps && n.deps.length) card.appendChild(el("div", "deps", "after: " + n.deps.join(", ")));
    if (n.summary) card.appendChild(el("div", "deps", "→ " + n.summary));
    planNodes.appendChild(card);
  });
}

async function runPlan(execute) {
  const goal = planGoal.value.trim();
  if (!goal) return;
  planPreview.disabled = planRun.disabled = true;
  planNodes.innerHTML = "";
  document.getElementById("planApprovals").replaceChildren();
  planNodes.appendChild(el("div", "empty-tab", execute ? "running…" : "planning…"));
  const approvalPoll = execute ? setInterval(pollApprovals, 1000) : null;
  try {
    const r = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal, execute }) });
    const j = await r.json();
    if (approvalPoll) clearInterval(approvalPoll);
    if (!r.ok) { planNodes.innerHTML = ""; planNodes.appendChild(el("div", "empty-tab", "error: " + (j.error || r.status))); return; }
    renderPlanNodes(j.nodes || [], j.status, j.replans);
  } catch (e) {
    if (approvalPoll) clearInterval(approvalPoll);
    planNodes.innerHTML = ""; planNodes.appendChild(el("div", "empty-tab", "network error: " + e.message));
  } finally {
    planPreview.disabled = planRun.disabled = false;
  }
}
planPreview.addEventListener("click", () => runPlan(false));
planRun.addEventListener("click", () => runPlan(true));

// ── Event inject ─────────────────────────────────────────────────────────────
const evtInject = document.getElementById("evtInject");
const evtResult = document.getElementById("evtResult");
evtInject.addEventListener("click", async () => {
  const body = {
    channel: (document.getElementById("evtChannel").value.trim() || "manual"),
    from: document.getElementById("evtFrom").value.trim() || undefined,
    subject: document.getElementById("evtSubject").value.trim() || undefined,
    text: document.getElementById("evtText").value.trim() || undefined,
  };
  evtInject.disabled = true;
  evtResult.textContent = "ingesting…";
  const approvalPoll = setInterval(pollApprovals, 1000);
  try {
    const r = await fetch("/api/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    clearInterval(approvalPoll);
    evtResult.textContent = r.ok ? "event ingested — if it matched a watch, the 🔔 reply appears in Chat." : ("error: " + (j.error || r.status));
  } catch (e) {
    clearInterval(approvalPoll);
    evtResult.textContent = "network error: " + e.message;
  } finally {
    evtInject.disabled = false;
  }
});

// ── Proactive (scheduled + ambient) messages → surfaced in the chat stream ──────
let lastProactive = 0;
async function pollProactive() {
  try {
    const { items } = await (await fetch("/api/proactive?since=" + lastProactive)).json();
    for (const p of items || []) {
      lastProactive = Math.max(lastProactive, p.id);
      const icon = p.source === "scheduled" ? "⏰" : "🔔";
      if (empty && empty.parentNode) empty.remove();
      const n = el("div", "note proactive");
      n.textContent = `${icon} ${p.label ? p.label + " · " : ""}${p.text}`;
      log.appendChild(n);
      scrollDown();
    }
  } catch { /* transient */ }
}
setInterval(pollProactive, 3000);
// Approvals are polled ALWAYS, not only while a turn is in flight. A turn can park on an approval
// the instant it starts (before the first per-turn tick), and a page reload mid-turn would
// otherwise never render the pending card. An always-on poller means a parked approval is always
// surfaced — the fix for "the turn is waiting but no Approve/Reject card appeared".
setInterval(pollApprovals, 1000);

health();
