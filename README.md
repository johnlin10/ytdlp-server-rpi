# yt-dlp 家庭下載伺服器

在 Raspberry Pi 4 上執行，透過區域網路網頁介面輸入 YouTube 網址即可下載 mp4，
下載完的原始檔保留在 Pi 上，並以 SQLite 記錄歷史（含原始連結），
之後可直接重新下載已存在的檔案，不必再次呼叫 yt-dlp。

## 架構

- **後端**：Python + FastAPI（`backend/main.py`），呼叫 `yt-dlp` 套件下載，
  進度透過記憶體工作狀態 + 前端輪詢（每秒）呈現。
- **資料庫**：SQLite（`backend/history.db`，首次啟動自動建立），
  以 `video_id` 為唯一鍵避免重複下載。
- **檔案儲存**：`backend/downloads/{video_id}.mp4`
- **前端**：純 HTML/CSS/JS 靜態頁面（`frontend/`），由 FastAPI 直接掛載服務，
  不需要額外的 Node.js 建置流程，適合長時間在 Pi 上運行。

## 部署步驟（在 Raspberry Pi 上）

### 1. 安裝系統相依套件

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip ffmpeg
```

`ffmpeg` 是必要的，yt-dlp 需要它來合併分離的影像/音訊串流並輸出 mp4。

### 2. 傳輸專案並建立虛擬環境

將整個 `ytdlp-server-rpi` 資料夾放到 `/home/pi/ytdlp-server-rpi`（可用 `scp` 或隨身碟）：

```bash
cd /home/pi/ytdlp-server-rpi
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
```

### 3. 手動測試啟動

```bash
cd backend
../venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

接著在同一區域網路內，用手機或電腦瀏覽器開啟：
`http://<樹莓派的區域網路IP>:8000`
（可用 `hostname -I` 查詢 Pi 的 IP）

確認可以貼上網址、看到下載進度、下載完成後出現在紀錄列表，即代表運作正常。
按 `Ctrl+C` 停止測試伺服器。

### 4. 設定開機自動啟動（systemd）

```bash
sudo cp /home/pi/ytdlp-server-rpi/ytdlp-server-rpi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ytdlp-server-rpi
```

之後可用以下指令管理：

```bash
sudo systemctl status ytdlp-server-rpi   # 查看狀態
sudo systemctl restart ytdlp-server-rpi  # 重啟
journalctl -u ytdlp-server-rpi -f        # 查看即時日誌
```

## 重要維運提醒

- **yt-dlp 需要定期更新**：YouTube 常改動介面導致 yt-dlp 失效。
  建議每隔一兩週手動更新一次：
  ```bash
  source /home/pi/ytdlp-server-rpi/venv/bin/activate
  pip install -U yt-dlp
  sudo systemctl restart ytdlp-server-rpi
  ```
- **儲存空間**：mp4 原始檔會持續累積在 `backend/downloads/`，
  請留意 SD 卡或外接硬碟的剩餘空間，必要時手動清理較舊的檔案
  （刪除檔案後，也記得從 `history.db` 移除對應紀錄，或之後可以請我幫你加一個清理/刪除功能）。
- **僅限區域網路使用**：目前程式沒有帳號驗證機制，預設只透過家中路由器的 NAT
  隔絕外部連線。**請勿**直接把 8000 port 對外開放（port forwarding）到公網，
  否則任何人都能透過你的 Pi 下載影片。若之後想從外部存取，建議透過 VPN
  （例如 Tailscale）連回家中網路，而不是直接曝露此服務。

## API 一覽

| Method | 路徑                     | 說明                                   |
|--------|--------------------------|----------------------------------------|
| POST   | `/api/download`          | 送出 `{ "url": "..." }`，開始下載或回傳已存在的紀錄 |
| GET    | `/api/status/{job_id}`   | 查詢下載進度                            |
| GET    | `/api/history`           | 取得歷史下載清單                        |
| GET    | `/api/file/{video_id}`   | 下載/重新下載已存在的 mp4 檔案          |
