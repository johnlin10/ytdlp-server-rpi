# ytdlp-server-rpi

一個為 Raspberry Pi 設計的自架 yt-dlp 下載伺服器。在區域網路內提供網頁介面，
貼上 YouTube 網址即可下載 mp4；下載完成的檔案保留在裝置上，並以 SQLite 記錄歷史，
之後可直接重新下載已存在的檔案，不必再次呼叫 yt-dlp。

雖然針對 Raspberry Pi（Pi 4 / Pi 5）調校，但本專案是標準的 Python 應用，
可在任何具備 Python 3 與 ffmpeg 的 Linux / macOS 系統上執行。

## 功能特色

- 網頁介面：貼上網址、即時顯示下載進度、完成後列入歷史清單。
- 去重：以影片的 `video_id` 為唯一鍵，已下載過的影片直接回傳既有檔案，不重複下載。
- 歷史紀錄：SQLite 保存標題、原始連結、檔名、大小、縮圖與下載時間。
- 免建置前端：純 HTML/CSS/JS 靜態頁面，由 FastAPI 直接掛載，適合長時間運行。

## 架構

- **後端**：Python + FastAPI（`backend/main.py`），呼叫 `yt-dlp` 套件下載，
  下載於背景執行緒進行，進度以記憶體工作狀態儲存，前端每秒輪詢一次。
- **資料庫**：SQLite（`backend/history.db`，首次啟動自動建立），
  以 `video_id` 為唯一鍵避免重複下載。
- **檔案儲存**：`backend/downloads/{video_id}.mp4`
- **前端**：純 HTML/CSS/JS 靜態頁面（`frontend/`），由 FastAPI 掛載於根路徑。

## 系統需求

- Python 3.9 以上，以及 `python3-venv`、`python3-pip`
- `ffmpeg`（必要）：yt-dlp 需要它合併分離的影像/音訊串流並輸出 mp4

## 安裝與部署

以下步驟以 Raspberry Pi OS（使用者 `pi`）為例，將專案安裝到 `/home/pi/ytdlp-server-rpi`。
若使用其他使用者或路徑，請一併調整 `ytdlp-server-rpi.service` 中的設定。

### 1. 安裝系統相依套件

```bash
sudo apt update
sudo apt install -y git python3-venv python3-pip ffmpeg
```

### 2. 取得專案並建立虛擬環境

```bash
cd /home/pi
git clone https://github.com/johnlin10/ytdlp-server-rpi.git
cd ytdlp-server-rpi
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
```

### 3. 手動測試啟動

```bash
cd backend
../venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

在同一區域網路內，用瀏覽器開啟 `http://<裝置的區域網路IP>:8000`
（可用 `hostname -I` 查詢 IP）。確認能貼上網址、看到下載進度、
完成後出現在歷史清單，即代表運作正常。按 `Ctrl+C` 停止測試伺服器。

### 4. 設定開機自動啟動（systemd）

```bash
sudo cp /home/pi/ytdlp-server-rpi/ytdlp-server-rpi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ytdlp-server-rpi
```

常用管理指令：

```bash
sudo systemctl status ytdlp-server-rpi    # 查看狀態
sudo systemctl restart ytdlp-server-rpi   # 重啟
journalctl -u ytdlp-server-rpi -f         # 查看即時日誌
```

## 維運須知

### 定期更新 yt-dlp

YouTube 常改動介面而導致舊版 yt-dlp 失效，建議定期更新：

```bash
source /home/pi/ytdlp-server-rpi/venv/bin/activate
pip install -U yt-dlp
sudo systemctl restart ytdlp-server-rpi
```

### 儲存空間

mp4 原始檔會持續累積在 `backend/downloads/`，請留意 SD 卡或外接硬碟的剩餘空間。
手動刪除檔案後，也需從 `history.db` 移除對應紀錄，否則歷史清單中的重新下載會失敗。

### 安全性

本服務不含帳號驗證機制，設計上僅供區域網路使用，預設倚賴路由器 NAT 阻擋外部連線。
請勿將 8000 port 透過 port forwarding 直接對外開放，否則任何人都能藉此下載影片並存取你的裝置。
若需從外部存取，建議透過 VPN（例如 Tailscale）連回家中網路，而非直接曝露此服務。

## API

| Method | 路徑                     | 說明                                                  |
|--------|--------------------------|-------------------------------------------------------|
| POST   | `/api/download`          | 送出 `{ "url": "..." }`，開始下載，或回傳已存在的紀錄 |
| GET    | `/api/status/{job_id}`   | 查詢下載進度                                          |
| GET    | `/api/history`           | 取得歷史下載清單                                      |
| GET    | `/api/file/{video_id}`   | 下載/重新下載已存在的 mp4 檔案                        |
| DELETE | `/api/history/{video_id}`| 刪除一筆歷史紀錄，並移除硬碟上的影片檔案              |

## 授權

本專案僅供個人在自有裝置上下載合法內容使用。請遵守 YouTube 服務條款與當地法律，
並尊重內容創作者的著作權。
