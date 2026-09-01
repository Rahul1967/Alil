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
  head.textContent = `Alil wants to run ${a.tool} · ${a.effect} · ${a.risk} risk`;
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
  };
  approve.addEventListener("click", () => answer(true));
  reject.addEventListener("click", () => answer(false));
  btns.appendChild(approve);
  btns.appendChild(reject);
  card.appendChild(btns);
  log.appendChild(card);
  scrollDown();
}

async function pollApprovals() {
  try {
    const { items } = await (await fetch("/api/approvals")).json();
    for (const a of items || []) {
      if (shownApprovals.has(a.id)) continue;
      shownApprovals.add(a.id);
      renderApproval(a);
    }
  } catch {
    /* transient — try again next tick */
  }
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
  const approvalPoll = setInterval(pollApprovals, 1000);
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, attachments }),
    });
    const j = await r.json();
    clearInterval(approvalPoll);
    typing.remove();
    if (!r.ok) {
      addNote("error: " + (j.error || r.status));
    } else {
      if (j.reply) addMessage("bot", j.reply, j.trace);
      else addMessage("bot", "(no answer)", j.trace);
      if (j.stopReason && j.stopReason !== "complete") addNote("turn " + j.stopReason);
    }
  } catch (e) {
    clearInterval(approvalPoll);
    typing.remove();
    addNote("network error: " + e.message);
  } finally {
    clearInterval(approvalPoll);
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
const tabMemory = document.getElementById("tabMemory");
const dossierView = document.getElementById("dossierView");
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
  memoryView.classList.toggle("show", which === "memory");
  tabChat.classList.toggle("active", which === "chat");
  tabPlan.classList.toggle("active", which === "plan");
  tabLater.classList.toggle("active", which === "later");
  tabDossier.classList.toggle("active", which === "dossier");
  tabMemory.classList.toggle("active", which === "memory");
}
tabChat.addEventListener("click", () => setView("chat"));
tabPlan.addEventListener("click", () => setView("plan"));
tabDossier.addEventListener("click", () => { setView("dossier"); loadDossier(); });
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

health();
