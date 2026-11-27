# Hướng dẫn Deploy CAP Manager 100% Miễn phí (Không cần thẻ / Cloud Billing)

Ứng dụng giữ nguyên **toàn bộ tính năng** (Bot Telegram + Lịch nhắc tự động + Gemini AI + Firebase Firestore + Đăng nhập Google Sheets) và đã cấu hình sẵn để chạy trên **Render Free** hoặc **Koyeb Free**.

---

## Cách 1: Deploy lên Render (Khuyên dùng – Không yêu cầu thẻ)

1. **Tải mã nguồn & đẩy lên GitHub**
   - Tải/Export ZIP mã nguồn từ Google AI Studio về máy, giải nén và push lên một repo GitHub (Public hoặc Private đều được).
   - **Lưu ý bảo mật:** File `firebase-applet-config.json` được giữ lại bình thường để kết nối Firestore; không đẩy file `.env` chứa key thật lên GitHub.

2. **Tạo Web Service trên Render**
   - Đăng nhập https://render.com bằng GitHub.
   - Chọn **New +** → **Blueprint** (tự động đọc file `render.yaml` đã cấu hình sẵn `plan: free`, `Node 22`, `build`, `start`, `/healthz`), hoặc chọn **New +** → **Web Service** với thông số:
     - **Build Command:** `npm install && npm run build`
     - **Start Command:** `npm start`
     - **Instance Type:** `Free`
     - **Health Check Path:** `/healthz`

3. **Điền biến môi trường (Environment Variables) trên Render**
   - `GEMINI_API_KEY`: API key lấy miễn phí tại Google AI Studio (https://aistudio.google.com/apikey) — dùng cho tính năng AI.
   - `TELEGRAM_BOT_TOKEN` *(tuỳ chọn)*: Token bot từ `@BotFather` (hoặc có thể nhập trực tiếp Bot Token riêng từng nhóm trong giao diện Leader).
   - `SESSION_SECRET`: Đã tự tạo nếu dùng `render.yaml` (nếu tạo tay hãy điền 1 chuỗi ngẫu nhiên dài >= 32 ký tự để không bị đăng xuất khi server khởi động lại).
   - `CRON_SECRET` *(tuỳ chọn)*: Chuỗi bảo vệ nếu dùng dịch vụ cron miễn phí đánh thức bot.

---

## Cách 2: Deploy lên Koyeb Free (Thay thế nếu muốn)

1. Đăng nhập https://app.koyeb.com bằng GitHub → **Create Web Service** → chọn repo GitHub.
2. Chọn instance **Free**, Buildpack **Node.js** (đã có `"engines": { "node": ">=22.18.0" }` và `.node-version`):
   - **Build command:** `npm install && npm run build`
   - **Run command:** `npm start`
   - **Port:** `3000` (hoặc biến `PORT` mặc định của Koyeb)
   - **Health check path:** `/healthz`
3. Thêm các biến môi trường `NODE_ENV=production`, `GEMINI_API_KEY`, `SESSION_SECRET` (và `TELEGRAM_BOT_TOKEN` nếu dùng).

---

## 2 Bước Bắt buộc Sau Khi Có Link Web (`.onrender.com` hoặc `.koyeb.app`)

1. **Cho phép đăng nhập Google Sheets trên domain mới:**
   - Mở **Firebase Console** (https://console.firebase.google.com) → chọn project `gen-lang-client-0261827499`
   - Vào **Authentication** → **Settings** → **Authorized domains** → **Add domain**
   - Dán domain mới của bạn vào (ví dụ: `cap-manager-xxxx.onrender.com` hoặc `xxxx.koyeb.app`) → **Add**.
   - *(Nếu thiếu bước này, bấm đăng nhập Google để đọc Google Sheets sẽ báo lỗi `auth/unauthorized-domain`.)*

2. **Giữ Bot Telegram nhắc lịch đúng giờ `11:00` và `23:30` khi dùng gói Free:**
   - Trên gói Free, Render tự ngủ nếu **15 phút không có ai mở web**.
   - Bạn có thể tạo lịch miễn phí tại https://cron-job.org gọi vào link:
     `https://<domain-cua-ban>/api/telegram/cron` (mỗi 10–15 phút hoặc lúc `11:00` & `23:30` giờ VN, kèm header `x-cron-secret: <CRON_SECRET>` nếu bạn có cài `CRON_SECRET`).
