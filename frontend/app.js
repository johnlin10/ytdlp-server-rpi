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

// 觸發瀏覽器把檔案下載到使用者的裝置
function triggerBrowserDownload(videoId) {
  const a = document.createElement("a");
  a.href = `/api/file/${videoId}`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- 進度卡片（支援多個並行任務）----------
function createJobCard(title) {
  const card = document.createElement("div");
  card.className = "job-card";
  card.innerHTML = `
    <div class="job-title"></div>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <div class="job-meta">準備中…</div>
  `;
  card.querySelector(".job-title").textContent = title;
  jobsContainer.prepend(card);
  return card;
}

function setCardTitle(card, title) {
  card.querySelector(".job-title").textContent = title;
}

function setCardMeta(card, text, isError = false) {
  const meta = card.querySelector(".job-meta");
  if (isError) {
    meta.innerHTML = `<span class="error-text">${text}</span>`;
  } else {
    meta.textContent = text;
  }
}

function setCardProgress(card, percent) {
  card.querySelector(".progress-fill").style.width = `${percent}%`;
}

function retireCard(card, delay = 4000) {
  setTimeout(() => {
    card.classList.add("retiring");
    setTimeout(() => card.remove(), 400);
  }, delay);
}

function updateCard(card, job) {
  if (job.status === "downloading") {
    setCardProgress(card, job.percent || 0);
    setCardMeta(card, `下載中… ${job.percent || 0}%`);
  } else if (job.status === "processing") {
    setCardProgress(card, 100);
    setCardMeta(card, "處理中（合併音軌/轉檔）…");
  } else if (job.status === "done") {
    setCardProgress(card, 100);
    setCardMeta(card, "完成，開始下載到你的裝置…");
  } else if (job.status === "error") {
    setCardMeta(card, `失敗：${job.error}`, true);
  } else {
    setCardMeta(card, "準備中…");
  }
}

// 每個任務各自輪詢，互不干擾，可同時進行多筆下載
function pollJob(card, jobId) {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      if (!res.ok) throw new Error("查無此工作");
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
      setCardMeta(card, "連線中斷，無法取得進度", true);
    }
  }, 1000);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  // 只在送出請求（解析影片資訊）期間短暫鎖住按鈕，避免重複送出同一筆；
  // 拿到 job 後立即解鎖，讓你能接著貼下一個網址並行下載。
  submitBtn.disabled = true;
  const card = createJobCard("解析影片資訊中…");

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setCardMeta(card, err.detail || "下載請求失敗", true);
      submitBtn.disabled = false;
      return;
    }

    const data = await res.json();
    submitBtn.disabled = false;
    urlInput.value = "";

    if (data.status === "exists") {
      setCardTitle(card, data.title);
      setCardProgress(card, 100);
      setCardMeta(card, "此影片先前已下載過，開始下載到你的裝置…");
      triggerBrowserDownload(data.video_id);
      await loadHistory();
      retireCard(card);
      return;
    }

    setCardTitle(card, data.title);
    pollJob(card, data.job_id);
  } catch (err) {
    setCardMeta(card, "連線失敗，請確認伺服器是否運作中", true);
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
            <button class="del-btn" data-id="${item.video_id}" title="刪除紀錄與影片檔案">刪除</button>
          </div>
        </div>
      `;
    })
    .join("");
}

// 事件委派：處理歷史清單中的刪除按鈕
historyLog.addEventListener("click", async (e) => {
  const btn = e.target.closest(".del-btn");
  if (!btn) return;

  const videoId = btn.dataset.id;
  if (!confirm("確定要刪除這筆紀錄與影片檔案嗎？此動作無法復原。")) return;

  btn.disabled = true;
  try {
    const res = await fetch(`/api/history/${videoId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("刪除失敗");
    await loadHistory();
  } catch (err) {
    alert("刪除失敗，請稍後再試。");
    btn.disabled = false;
  }
});

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
