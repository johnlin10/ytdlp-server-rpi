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
  if (job.status === "downloading") {
    const p = clampPct(job.percent);
    setCardMeta(card, `downloading <span class="bar">${asciiBar(p)}</span> ${p}%`);
  } else if (job.status === "processing") {
    setCardMeta(card, "processing · merging audio/video…");
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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  // Lock the button only while the request (metadata parse) is in flight, to
  // avoid double-submitting the same url; unlock as soon as we have a job so
  // you can immediately queue another and download in parallel.
  submitBtn.disabled = true;
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
      submitBtn.disabled = false;
      return;
    }

    const data = await res.json();
    submitBtn.disabled = false;
    urlInput.value = "";

    if (data.status === "exists") {
      setCardTitle(card, data.title);
      setCardMeta(card, "already downloaded · saving to your device");
      triggerBrowserDownload(data.video_id);
      await loadHistory();
      retireCard(card);
      return;
    }

    setCardTitle(card, data.title);
    pollJob(card, data.job_id);
  } catch (err) {
    setCardMeta(card, `<span class="error-text">connection failed — is the server running?</span>`);
    submitBtn.disabled = false;
  }
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

loadHistory();
