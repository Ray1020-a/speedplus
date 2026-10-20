# Speed+ 網頁賽車

瀏覽器 3D 賽車遊戲（Three.js）。單人挑戰全服排行榜、多人 P2P（WebRTC）最多 16 人、管理後台可用拖拉方式標記起終點／賽道／賽車座位與坐姿。

## 啟動（Mac 開發）

```bash
npm install
npm start            # http://localhost:3000   (開發用 npm run dev 會自動重啟)
```

需要 Node.js ≥ 22.13（使用內建 `node:sqlite`，不需編譯原生模組）。

模型放在 `models/`（已加入 `.gitignore`，**不會進 git**）：

```
models/cars/SF26.glb
models/maps/TSchool.glb
models/characters/*.glb   (可選；內建 4 位程式產生的車手)
```

啟動時會自動掃描資料夾並登記到 SQLite（`data/speedplus.db`）。新增模型也可在後台「上傳 GLB」。
`seed/<模型檔名>.json` 是隨 repo 附上的預設設定（SF26 座位／坐姿／方向、TSchool 賽道與比例），第一次登記該模型時套用。

## 管理後台 `/admin.html`

密碼為環境變數 `ADMIN_PASSWORD`（預設 `admin`，**上線前務必修改**）。

- **賽車**：車頭方向、縮放；拖拉 gizmo 設定座位位置/旋轉、駕駛視角、引擎蓋視角；滑桿調整坐姿（上身、頭、手臂、手肘、大腿、膝蓋）；碰撞箱；馬力／極速／紅線。
- **地圖**：俯視圖上「畫賽道」（按住拖曳或單擊加點）、「起點」「終點」拖曳放置（自動吸附賽道）、拖曳點微調、雙擊刪除點；賽道寬度、圈數、環狀或直線、賽車縮放比例、速度上限、隱藏（天花板）與不碰撞物件的名稱規則。
- **人物**：車衣／頭盔／膚色。
- **紀錄**：檢視並刪除排行榜紀錄。

比例：TSchool 約 19.7 × 36 m，而 SF26 長 5.5 m，所以每張地圖有「賽車縮放」(TSchool = 0.14)；儀表仍以等比放大後的「虛擬 km/h」顯示，「速度上限」避免小地圖一秒衝完。

## 遊戲流程

開始 → 選人物 → 選車 → 選地圖 → 單人（再選 計時賽／繞圈賽 10 分鐘）或多人 → AT／MT → 下載模型（存瀏覽器 Cache Storage，下次不用再下載）→ 開局。

- 計時賽：跑完地圖設定圈數的總時間。繞圈賽：10 分鐘內的圈數（含未完成圈的進度）。破全服第一名時會要求輸入名字登記。
- 直線賽道（非環狀）：每跑完一趟算一圈，車輛會帶著速度回到起點線。
- 多人：房主建立房間得到 5 碼代號（或分享 `/?room=代號` 連結），≥2 人可開局，需輸入名字；房間地圖由房主決定，每位玩家用自己選的車／人物。賽中位置以 WebRTC DataChannel 直連（伺服器只做信令與房間名單）。

## 鍵位（主選單「遊戲鍵位說明」也有）

| 操作 | 鍵盤 | Xbox 手把 |
| --- | --- | --- |
| 加速 / 煞車倒車 | W S 或 ↑ ↓ | RT / LT |
| 轉向 | A D 或 ← → | 左搖桿 / 十字鍵 |
| 手煞車 | Space | A |
| 升檔 / 降檔 (MT) | E(Shift) / Q(Ctrl) | RB / LB |
| 切視角 | C | Y |
| 重置回賽道 | R | X |
| 暫停 | Esc / P | Start |
| 靜音 | M | |

手機／平板會自動偵測並顯示橫向螢幕按鈕（轉向、油門、煞車、手煞車、MT 升降檔、視角、重置、暫停）。力回饋：手把震動（碰撞、紅線、打滑、引擎）；Android 另有觸覺震動。

## 音效

引擎聲為 WebAudio 即時合成（V6 渦輪混動風格，隨轉速/油門變化）。若想換成真實錄音（例如 SF26 聲浪），把可循環播放的檔案放到 `public/audio/engine.mp3`，並在 `public/js/game.js` 的 `setupAudio` 前呼叫 `audio.loadSample('/audio/engine.mp3')`、設定 `audio.sampleRef`（取樣時的轉速）即可；請自行確認音檔授權。

## 部署到 Debian（pm2）

```bash
# 一次性
sudo apt install -y nodejs npm   # 或用 nvm 裝 Node 22+
sudo npm i -g pm2
git clone <repo> && cd speedplus && npm ci --omit=dev
# 把 GLB 放進 models/cars、models/maps（不在 git 內）

# 編輯 ecosystem.config.js 的 ADMIN_PASSWORD（以及選用的 MODELS_DIR / DATA_DIR / ICE_SERVERS）
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
```

注意：

- **一定要 HTTPS**（localhost 除外）：WebRTC、Cache Storage、Web Audio 啟動在非安全環境會受限。用 nginx / Caddy 反向代理，並開啟 WebSocket：

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    client_max_body_size 300m;
  }
  ```
- 房間存在記憶體中，所以 pm2 維持單一 instance。
- 部分對稱型 NAT 需要 TURN：以 `ICE_SERVERS` 環境變數（JSON）提供 STUN/TURN。
- 排行榜與設定存在 `data/speedplus.db`，請備份。
