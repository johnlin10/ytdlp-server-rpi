const form = document.getElementById("download-form");
const urlInput = document.getElementById("url-input");
const submitBtn = document.getElementById("submit-btn");

const jobsContainer = document.getElementById("jobs");
const historyLog = document.getElementById("history-log");

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
  card.className = "job-card";
  card.innerHTML = `
    <div class="job-title"></div>
    <div class="job-meta">booting…</div>
  `;
  card.querySelector(".job-title").textContent = title;
  jobsContainer.prepend(card);
  return card;
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
    setTimeout(() => card.remove(), 400);
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
        triggerBrowserDownload(job.video_id);
        await loadHistory();
        loadStorage();
        retireCard(card);
      } else if (job.status === "error") {
        clearInterval(timer);
      }
    } catch (e) {
      clearInterval(timer);
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
      setCardMeta(card, `<span class="error-text">${err.detail || "request failed"}</span>`);
      return;
    }

    const data = await res.json();

    if (data.status === "exists") {
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
    setCardMeta(card, `<span class="error-text">connection failed — is the server running?</span>`);
  }
}

// Split on commas (and newlines, for convenience) into a de-duplicated list.
function parseUrls(raw) {
  const seen = new Set();
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const urls = parseUrls(urlInput.value);
  if (!urls.length) return;

  // Lock the button only while we kick off the requests, then clear the input
  // and unlock so more can be queued right away.
  submitBtn.disabled = true;
  urlInput.value = "";

  // Fire them all off; each manages its own card and polling.
  urls.forEach((url) => submitOne(url));

  submitBtn.disabled = false;
});

function renderHistory(items) {
  if (!items.length) {
    historyLog.innerHTML = `<p class="empty-state">no downloads yet — paste a url above to begin.</p>`;
    return;
  }

  historyLog.innerHTML = items
    .map((item) => {
      const thumb = item.thumbnail
        ? `<img class="log-thumb" src="${item.thumbnail}" alt="" loading="lazy" />`
        : `<div class="log-thumb"></div>`;
      return `
        <div class="log-entry">
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
}

// Event delegation: handle the delete buttons in the history list
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
    settingsStatusEl.textContent = "saved ✓ · applies to new downloads";
    setTimeout(() => (settingsStatusEl.textContent = ""), 4000);
  } catch (err) {
    settingsStatusEl.textContent = "save failed — try again";
  }
});

loadSettings();
loadHistory();
loadStorage();
