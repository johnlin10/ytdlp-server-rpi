const form = document.getElementById("download-form");
const urlInput = document.getElementById("url-input");
const submitBtn = document.getElementById("submit-btn");

const jobStatus = document.getElementById("job-status");
const jobTitle = document.getElementById("job-title");
const jobMeta = document.getElementById("job-meta");
const progressFill = document.getElementById("progress-fill");

const historyLog = document.getElementById("history-log");

let pollTimer = null;

function fmtBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb > 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(1) + " MB";
}

function showJob(title) {
  jobStatus.classList.remove("hidden");
  jobTitle.textContent = title;
  progressFill.style.width = "0%";
  jobMeta.textContent = "準備中…";
}

function updateJobUI(job) {
  if (job.status === "downloading") {
    progressFill.style.width = `${job.percent || 0}%`;
    jobMeta.textContent = `下載中… ${job.percent || 0}%`;
  } else if (job.status === "processing") {
    progressFill.style.width = "100%";
    jobMeta.textContent = "處理中（合併音軌/轉檔）…";
  } else if (job.status === "done") {
    progressFill.style.width = "100%";
    jobMeta.textContent = "完成，已加入下載紀錄";
  } else if (job.status === "error") {
    jobMeta.innerHTML = `<span class="error-text">失敗：${job.error}</span>`;
  } else {
    jobMeta.textContent = "準備中…";
  }
}

async function pollJob(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      if (!res.ok) throw new Error("查無此工作");
      const job = await res.json();
      updateJobUI(job);

      if (job.status === "done" || job.status === "error") {
        clearInterval(pollTimer);
        submitBtn.disabled = false;
        if (job.status === "done") {
          await loadHistory();
        }
      }
    } catch (e) {
      clearInterval(pollTimer);
      submitBtn.disabled = false;
    }
  }, 1000);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  submitBtn.disabled = true;
  showJob("解析影片資訊中…");

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json();
      jobMeta.innerHTML = `<span class="error-text">${err.detail || "下載請求失敗"}</span>`;
      submitBtn.disabled = false;
      return;
    }

    const data = await res.json();

    if (data.status === "exists") {
      jobTitle.textContent = data.title;
      progressFill.style.width = "100%";
      jobMeta.textContent = "此影片先前已下載過，可直接於下方紀錄重新下載";
      submitBtn.disabled = false;
      await loadHistory();
      return;
    }

    jobTitle.textContent = data.title;
    urlInput.value = "";
    pollJob(data.job_id);
  } catch (err) {
    jobMeta.innerHTML = `<span class="error-text">連線失敗，請確認伺服器是否運作中</span>`;
    submitBtn.disabled = false;
  }
});

function renderHistory(items) {
  if (!items.length) {
    historyLog.innerHTML = `<p class="empty-state">尚無下載紀錄。貼上網址後開始第一筆下載。</p>`;
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
            <div class="log-timestamp">${item.downloaded_at} · ${fmtBytes(item.filesize)}</div>
          </div>
          <div class="log-actions">
            <a href="${item.url}" target="_blank" rel="noopener">原始連結</a>
            <a href="/api/file/${item.video_id}" download>重新下載</a>
          </div>
        </div>
      `;
    })
    .join("");
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const items = await res.json();
    renderHistory(items);
  } catch (e) {
    // 靜默失敗，保留現有畫面
  }
}

loadHistory();
