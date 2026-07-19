const form = document.getElementById("download-form");
const urlInput = document.getElementById("url-input");
const submitBtn = document.getElementById("submit-btn");

const jobsContainer = document.getElementById("jobs");
const historyLog = document.getElementById("history-log");

// ---------- tab navigation ----------
// A vertical, terminal-style list (see .tabs in the CSS): click or use the ↑/↓
// keys to move the selection between views. The active view is mirrored to the
// URL (?tab=…) so a refresh restores it.
const tabButtons = Array.from(document.querySelectorAll(".tab"));
const tabPanels = document.querySelectorAll(".tab-panel");
const TAB_NAMES = tabButtons.map((b) => b.dataset.tab);

function activeTabName() {
  const active = tabButtons.find((b) => b.classList.contains("is-active"));
  return active ? active.dataset.tab : TAB_NAMES[0];
}

function switchTab(name, { focus = false, updateUrl = true } = {}) {
  if (!TAB_NAMES.includes(name)) name = TAB_NAMES[0];

  tabButtons.forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
    // Roving tabindex: only the selected tab stays in the tab order.
    b.tabIndex = active ? 0 : -1;
    if (active && focus) b.focus();
  });
  tabPanels.forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });

  if (updateUrl) {
    const params = new URLSearchParams(location.search);
    params.set("tab", name);
    history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
  }
  refreshJobsUi();
}

// Move the selection `delta` steps (clamped to the ends), like moving up/down a
// terminal menu.
function moveTab(delta, opts) {
  const current = TAB_NAMES.indexOf(activeTabName());
  const next = Math.min(TAB_NAMES.length - 1, Math.max(0, current + delta));
  if (next !== current) switchTab(TAB_NAMES[next], opts);
}

tabButtons.forEach((b) =>
  b.addEventListener("click", () => switchTab(b.dataset.tab))
);

// ↑/↓ switch views. Left alone while typing in a field or with a modifier held,
// so normal text editing and browser/OS shortcuts still work.
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
            t.tagName === "SELECT" || t.isContentEditable)) return;
  e.preventDefault();
  moveTab(e.key === "ArrowDown" ? 1 : -1, { focus: true });
});

// Restore the tab named in ?tab= on load (called from the init block at the
// bottom, once refreshJobsUi's dependencies exist).
function initTabFromUrl() {
  const wanted = new URLSearchParams(location.search).get("tab");
  switchTab(TAB_NAMES.includes(wanted) ? wanted : activeTabName(), { updateUrl: false });
}

// Badge on the download tab: how many jobs are still running while you're on
// another tab, so progress isn't invisible after you switch away.
const tabBadge = document.getElementById("tab-badge");
const jobsEmpty = document.getElementById("jobs-empty");

function refreshJobsUi() {
  const cards = jobsContainer.querySelectorAll(".job-card");
  if (jobsEmpty) jobsEmpty.hidden = cards.length > 0;

  // "Active" = not yet in a terminal (done/error) state.
  const active = jobsContainer.querySelectorAll(".job-card.is-active").length;
  const onDownloadTab = document
    .querySelector('.tab[data-tab="download"]')
    .classList.contains("is-active");
  if (active > 0 && !onDownloadTab) {
    tabBadge.textContent = active;
    tabBadge.hidden = false;
  } else {
    tabBadge.hidden = true;
  }
}

function fmtBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb > 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(1) + " MB";
}

function clampPct(p) {
  return Math.max(0, Math.min(100, Math.round(p || 0)));
}

// ASCII progress bar, e.g. [██████████░░░░░░░░░░░░]
function asciiBar(percent) {
  const width = 22;
  const p = clampPct(percent);
  const filled = Math.round((p / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

// Ask the browser to download the mp4 to the user's device
function triggerBrowserDownload(videoId) {
  const a = document.createElement("a");
  a.href = `/api/file/${videoId}`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- job cards (support multiple concurrent downloads) ----------
function createJobCard(title) {
  const card = document.createElement("div");
  card.className = "job-card is-active";
  card.innerHTML = `
    <div class="job-title"></div>
    <div class="job-meta">booting…</div>
  `;
  card.querySelector(".job-title").textContent = title;
  jobsContainer.prepend(card);
  refreshJobsUi();
  return card;
}

// Mark a job as finished (drops it from the active count / tab badge).
function settleCard(card) {
  card.classList.remove("is-active");
  refreshJobsUi();
}

function setCardTitle(card, title) {
  card.querySelector(".job-title").textContent = title;
}

function setCardMeta(card, html) {
  card.querySelector(".job-meta").innerHTML = html;
}

function retireCard(card, delay = 4000) {
  setTimeout(() => {
    card.classList.add("retiring");
    setTimeout(() => {
      card.remove();
      refreshJobsUi();
    }, 400);
  }, delay);
}

function updateCard(card, job) {
  if (job.status === "queued") {
    setCardMeta(card, "queued · waiting for a free slot…");
  } else if (job.status === "downloading") {
    const p = clampPct(job.percent);
    setCardMeta(card, `downloading <span class="bar">${asciiBar(p)}</span> ${p}%`);
  } else if (job.status === "processing") {
    setCardMeta(card, "processing · merging audio/video…");
  } else if (job.status === "transcoding") {
    const tgt = job.target ? job.target.toUpperCase() : "";
    setCardMeta(
      card,
      `transcoding${tgt ? ` → ${tgt}` : ""} · re-encoding for ios/macos… <span class="spin"></span>`
    );
  } else if (job.status === "done") {
    setCardMeta(card, "done · saving to your device");
  } else if (job.status === "error") {
    setCardMeta(card, `<span class="error-text">error: ${job.error}</span>`);
  } else {
    setCardMeta(card, "booting…");
  }
}

// Each job polls on its own so downloads run independently in parallel
function pollJob(card, jobId) {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      if (!res.ok) throw new Error("job not found");
      const job = await res.json();
      updateCard(card, job);

      if (job.status === "done") {
        clearInterval(timer);
        settleCard(card);
        triggerBrowserDownload(job.video_id);
        await loadHistory();
        loadStorage();
        retireCard(card);
      } else if (job.status === "error") {
        clearInterval(timer);
        settleCard(card);
      }
    } catch (e) {
      clearInterval(timer);
      settleCard(card);
      setCardMeta(card, `<span class="error-text">connection lost — cannot read progress</span>`);
    }
  }, 1000);
}

// Submit a single URL: spins up its own job card and polls independently, so
// every url in a batch downloads in parallel.
async function submitOne(url) {
  const card = createJobCard("resolving video info…");

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      settleCard(card);
      setCardMeta(card, `<span class="error-text">${err.detail || "request failed"}</span>`);
      return;
    }

    const data = await res.json();

    if (data.status === "exists") {
      settleCard(card);
      setCardTitle(card, data.title);
      setCardMeta(card, "already downloaded · saving to your device");
      triggerBrowserDownload(data.video_id);
      await loadHistory();
      loadStorage();
      retireCard(card);
      return;
    }

    setCardTitle(card, data.title);
    pollJob(card, data.job_id);
  } catch (err) {
    settleCard(card);
    setCardMeta(card, `<span class="error-text">connection failed — is the server running?</span>`);
  }
}

// ---------- tracking-param stripping ----------
// Whether to auto-remove tracking params from URLs. Mirrors the persisted
// `strip_tracking_params` setting; updated once settings load / are saved.
let stripTracking = false;

// Known tracking query keys to drop. Deliberately conservative: only params
// that carry no playback meaning, so functional ones (YouTube v=/list=/t=,
// etc.) are always preserved.
const TRACKING_PARAMS = new Set([
  "igsh", "igshid",                 // Instagram
  "si",                             // YouTube / Spotify share id
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_name",
  "fbclid", "gclid", "dclid", "msclkid", "yclid", // ad click ids
  "mc_cid", "mc_eid",               // Mailchimp
  "ref_src", "ref_url",             // Twitter / X
]);

// Strip tracking params from one URL string. Operates only on the query part
// (splitting on the first '?'), so it works on scheme-less/partial input too
// and never disturbs the path, hash, or any param we don't recognise.
function stripTrackingFromUrl(token) {
  const hashIdx = token.indexOf("#");
  const hash = hashIdx >= 0 ? token.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? token.slice(0, hashIdx) : token;
  const qIdx = noHash.indexOf("?");
  if (qIdx < 0) return token;

  const base = noHash.slice(0, qIdx);
  const kept = noHash
    .slice(qIdx + 1)
    .split("&")
    .filter((pair) => pair && !TRACKING_PARAMS.has(pair.split("=")[0].toLowerCase()));

  return base + (kept.length ? "?" + kept.join("&") : "") + hash;
}

// Apply the strip across a whole input value while preserving the user's
// separators (commas / newlines) so multi-URL input keeps its layout.
function stripTrackingFromText(text) {
  return text
    .split(/([\n,]+)/) // keep the separators as captured groups
    .map((part) => (/[\n,]/.test(part) ? part : stripTrackingFromUrl(part)))
    .join("");
}

// Strip tracking params from the box's current value in place, preserving the
// caret when it sits at the end. Shared by the live `input` handler and the
// programmatic paste path (setting .value doesn't fire `input`).
function applyStripTrackingLive() {
  if (!stripTracking) return;
  const before = urlInput.value;
  const after = stripTrackingFromText(before);
  if (after === before) return;
  const wasAtEnd = urlInput.selectionStart === before.length;
  urlInput.value = after;
  if (wasAtEnd) urlInput.setSelectionRange(after.length, after.length);
}

// Clean tracking params live as the user types, when the pref is on.
urlInput.addEventListener("input", applyStripTrackingLive);

// ---------- url extraction ----------
// Social-media "share" text often wraps the link in a caption/title, e.g.
// "看看這個影片！ https://www.instagram.com/reel/…". Feeding that whole blob to
// yt-dlp fails, so we pull out just the http(s) link(s). Commas and whitespace
// end a match (commas are our multi-url separator), and trailing sentence
// punctuation is trimmed so "…/abc." doesn't keep the period.
const URL_RE = /https?:\/\/[^\s,]+/gi;

function extractUrls(text) {
  const matches = text.match(URL_RE);
  if (!matches) return null;
  return matches.map((u) => u.replace(/[.,;!?)\]}'"]+$/, "")).join(", ");
}

// Replace the current selection (or insert at the caret) with text.
function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
}

// On paste, keep only the url(s) when the clipboard carried extra noise around
// them. A clean paste (a bare url, or scheme-less text we can't recognise as a
// link) falls through to the browser's default so we never mangle real input.
urlInput.addEventListener("paste", (e) => {
  const pasted = (e.clipboardData || window.clipboardData)?.getData("text") ?? "";
  const urls = extractUrls(pasted);
  if (!urls || urls === pasted.trim()) return;
  e.preventDefault();
  insertAtCursor(urlInput, urls);
  applyStripTrackingLive();
});

// Split on commas (and newlines, for convenience) into a de-duplicated list.
function parseUrls(raw) {
  const seen = new Set();
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .map((s) => (stripTracking ? stripTrackingFromUrl(s) : s))
    .filter((s) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
}

// Kick off downloads for whatever's in the box. parseUrls applies the
// tracking-param strip per token, so "strip then download" happens here for
// both the run button and the paste button. Returns true if anything was
// queued.
function runDownload() {
  const urls = parseUrls(urlInput.value);
  if (!urls.length) return false;

  // Lock the button only while we kick off the requests, then clear the input
  // and unlock so more can be queued right away.
  submitBtn.disabled = true;
  urlInput.value = "";

  // Fire them all off; each manages its own card and polling.
  urls.forEach((url) => submitOne(url));

  submitBtn.disabled = false;
  return true;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runDownload();
});

// ---------- paste button ----------
// One tap: read the clipboard, keep only the url, strip tracking params and
// start the download. The click is the user gesture Safari (and iOS) require to
// read the clipboard — a `focus`/`visibilitychange` handler isn't a gesture and
// would be rejected without even prompting, which is why this is a button.
const pasteBtn = document.getElementById("paste-btn");

// Clipboard reads need a secure context (https/localhost); hide the button
// where the API is unavailable so it never looks broken.
if (!navigator.clipboard || !navigator.clipboard.readText) {
  pasteBtn.hidden = true;
}

// Briefly show a status on the button itself (no url / denied), then restore.
function flashPaste(label) {
  pasteBtn.textContent = label;
  setTimeout(() => (pasteBtn.textContent = "paste"), 1500);
}

pasteBtn.addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    flashPaste("denied"); // permission refused / not allowed
    return;
  }

  const urls = extractUrls(text);
  if (!urls) {
    flashPaste("no url");
    return;
  }

  urlInput.value = urls; // replace whatever was in the box
  runDownload(); // parseUrls strips tracking params before the request
});

function renderHistory(items) {
  if (!items.length) {
    historyLog.innerHTML = `<p class="empty-state">no downloads yet — paste a url above to begin.</p>`;
    historyToolbar.hidden = true;
    updateSelection();
    return;
  }

  historyToolbar.hidden = false;
  historyLog.innerHTML = items
    .map((item) => {
      const thumb = item.thumbnail
        ? `<img class="log-thumb" src="${item.thumbnail}" alt="" loading="lazy" />`
        : `<div class="log-thumb"></div>`;
      return `
        <div class="log-entry">
          <input type="checkbox" class="row-check" data-id="${item.video_id}" aria-label="select" />
          ${thumb}
          <div class="log-body">
            <div class="log-title" title="${item.title}">${item.title}</div>
            <div class="log-meta">${item.downloaded_at} · ${fmtBytes(item.filesize)}</div>
          </div>
          <div class="log-actions">
            <a href="${item.url}" target="_blank" rel="noopener">[ src ]</a>
            <a href="/api/file/${item.video_id}" download>[ save ]</a>
            <button class="del-btn" data-id="${item.video_id}" title="delete record and file">[ rm ]</button>
          </div>
        </div>
      `;
    })
    .join("");

  updateSelection();
}

// ---------- history selection / batch actions ----------
const historyToolbar = document.getElementById("history-toolbar");
const selectAllEl = document.getElementById("select-all");
const selCountEl = document.getElementById("sel-count");
const batchDownloadEl = document.getElementById("batch-download");
const batchDeleteEl = document.getElementById("batch-delete");

function rowChecks() {
  return Array.from(historyLog.querySelectorAll(".row-check"));
}

function selectedIds() {
  return rowChecks()
    .filter((c) => c.checked)
    .map((c) => c.dataset.id);
}

// Keep the count, buttons and the select-all tri-state in sync with the rows.
function updateSelection() {
  const checks = rowChecks();
  const sel = checks.filter((c) => c.checked);
  const n = sel.length;

  selCountEl.textContent = `${n} selected`;
  batchDownloadEl.disabled = n === 0;
  batchDeleteEl.disabled = n === 0;

  selectAllEl.checked = n > 0 && n === checks.length;
  selectAllEl.indeterminate = n > 0 && n < checks.length;
}

historyLog.addEventListener("change", (e) => {
  if (e.target.classList.contains("row-check")) updateSelection();
});

selectAllEl.addEventListener("change", () => {
  rowChecks().forEach((c) => (c.checked = selectAllEl.checked));
  updateSelection();
});

// Batch download: hand the browser one GET so it streams a single videos.zip
// (see the /api/download-zip note in the backend).
batchDownloadEl.addEventListener("click", () => {
  const ids = selectedIds();
  if (!ids.length) return;
  const a = document.createElement("a");
  a.href = `/api/download-zip?ids=${ids.map(encodeURIComponent).join(",")}`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

batchDeleteEl.addEventListener("click", async () => {
  const ids = selectedIds();
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} record(s) and their video files? This cannot be undone.`)) return;

  batchDeleteEl.disabled = true;
  batchDownloadEl.disabled = true;
  try {
    const res = await fetch("/api/history/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: ids }),
    });
    if (!res.ok) throw new Error("batch delete failed");
    await loadHistory();
    loadStorage();
  } catch (err) {
    alert("Delete failed. Please try again.");
    updateSelection();
  }
});

// Event delegation: handle the per-row delete buttons in the history list
historyLog.addEventListener("click", async (e) => {
  const btn = e.target.closest(".del-btn");
  if (!btn) return;

  const videoId = btn.dataset.id;
  if (!confirm("Delete this record and its video file? This cannot be undone.")) return;

  btn.disabled = true;
  try {
    const res = await fetch(`/api/history/${videoId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("delete failed");
    await loadHistory();
    loadStorage();
  } catch (err) {
    alert("Delete failed. Please try again.");
    btn.disabled = false;
  }
});

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const items = await res.json();
    renderHistory(items);
  } catch (e) {
    // fail silently, keep the current view
  }
}

// ---------- storage / disk usage ----------
const storageFigures = document.getElementById("storage-figures");
const storageBar = document.getElementById("storage-bar");

// A block-character gauge showing the disk usage, with the slice taken up by
// our own downloads highlighted, e.g. [####----················]
function storageGauge(usedFrac, downloadsFrac) {
  const width = 30;
  const used = Math.round(clampPct(usedFrac * 100) / 100 * width);
  const mine = Math.min(used, Math.round(clampPct(downloadsFrac * 100) / 100 * width));
  const other = used - mine;
  const free = width - used;
  return (
    `<span class="g-mine">${"█".repeat(mine)}</span>` +
    `<span class="g-other">${"▓".repeat(other)}</span>` +
    `<span class="g-free">${"░".repeat(free)}</span>`
  );
}

function renderStorage(s) {
  const total = s.disk_total || 0;
  const usedFrac = total ? s.disk_used / total : 0;
  const downloadsFrac = total ? s.downloads_bytes / total : 0;
  const pct = Math.round(usedFrac * 100);

  storageFigures.textContent =
    `downloads ${fmtBytes(s.downloads_bytes)} · ` +
    `disk ${fmtBytes(s.disk_used)} / ${fmtBytes(s.disk_total)} (${pct}%)`;
  storageBar.innerHTML =
    `[${storageGauge(usedFrac, downloadsFrac)}] ` +
    `<span class="g-legend">█ dl · ▓ other · ░ free</span>`;
}

async function loadStorage() {
  try {
    const res = await fetch("/api/storage");
    if (!res.ok) return;
    renderStorage(await res.json());
  } catch (e) {
    // fail silently
  }
}

// ---------- preferences ----------
const settingsForm = document.getElementById("settings-form");
const codecPriorityEl = document.getElementById("codec-priority");
const autoTranscodeEl = document.getElementById("auto-transcode");
const transcodeTargetEl = document.getElementById("transcode-target");
const maxHeightEl = document.getElementById("max-height");
const stripTrackingEl = document.getElementById("strip-tracking");
const settingsStatusEl = document.getElementById("settings-status");

// The codec order lives here and is rendered as a reorderable list; the backend
// only strongly honours the first entry (the rest is the transcode fallback).
let codecOrder = [];

function renderCodecPriority() {
  codecPriorityEl.innerHTML = codecOrder
    .map((codec, i) => {
      const primary = i === 0 ? ' <span class="codec-tag">preferred</span>' : "";
      return `
        <div class="codec-item">
          <span class="codec-rank">${i + 1}.</span>
          <span class="codec-name">${codec}${primary}</span>
          <span class="codec-move">
            <button type="button" class="codec-btn" data-dir="up" data-i="${i}" ${i === 0 ? "disabled" : ""}>[↑]</button>
            <button type="button" class="codec-btn" data-dir="down" data-i="${i}" ${i === codecOrder.length - 1 ? "disabled" : ""}>[↓]</button>
          </span>
        </div>`;
    })
    .join("");
}

codecPriorityEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".codec-btn");
  if (!btn) return;
  const i = Number(btn.dataset.i);
  const j = btn.dataset.dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= codecOrder.length) return;
  [codecOrder[i], codecOrder[j]] = [codecOrder[j], codecOrder[i]];
  renderCodecPriority();
});

function applySettings(settings, options) {
  codecOrder = settings.video_codec_priority.slice();
  // Append any codec the server knows about but isn't in the saved list, so a
  // newer option still shows up (at the bottom).
  options.video_codecs.forEach((c) => {
    if (!codecOrder.includes(c)) codecOrder.push(c);
  });
  renderCodecPriority();

  autoTranscodeEl.checked = settings.auto_transcode;

  stripTrackingEl.checked = settings.strip_tracking_params;
  stripTracking = settings.strip_tracking_params;

  transcodeTargetEl.innerHTML = options.transcode_targets
    .map((t) => `<option value="${t}">${t}</option>`)
    .join("");
  transcodeTargetEl.value = settings.transcode_target;

  maxHeightEl.value = settings.max_height || 0;
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = await res.json();
    applySettings(data.settings, data.options);
  } catch (e) {
    // fail silently; the panel just stays empty
  }
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  settingsStatusEl.textContent = "saving…";
  const payload = {
    video_codec_priority: codecOrder,
    auto_transcode: autoTranscodeEl.checked,
    transcode_target: transcodeTargetEl.value,
    max_height: Math.max(0, parseInt(maxHeightEl.value, 10) || 0),
    strip_tracking_params: stripTrackingEl.checked,
  };
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("save failed");
    const data = await res.json();
    // Re-apply what the server actually stored (it clamps/validates).
    codecOrder = data.settings.video_codec_priority.slice();
    renderCodecPriority();
    maxHeightEl.value = data.settings.max_height || 0;
    stripTracking = data.settings.strip_tracking_params;
    settingsStatusEl.textContent = "saved ✓ · applies to new downloads";
    setTimeout(() => (settingsStatusEl.textContent = ""), 4000);
  } catch (err) {
    settingsStatusEl.textContent = "save failed — try again";
  }
});

// ---------- version footer ----------
// The backend's APP_VERSION is the source of truth; refresh the footer from it
// so the displayed version always matches the running server.
async function loadVersion() {
  try {
    const res = await fetch("/api/version");
    if (!res.ok) return;
    const { version } = await res.json();
    if (version) document.getElementById("app-version").textContent = `v${version}`;
  } catch (e) {
    // keep the HTML fallback version
  }
}

initTabFromUrl();
loadSettings();
loadHistory();
loadStorage();
loadVersion();
