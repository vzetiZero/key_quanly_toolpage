# KeyDesk · Quản lý License

Website quản trị license độc lập với News247US Studio. Người dùng Studio chỉ nhập key tại ứng dụng `localhost:4300`; trang này là nơi admin cấp hạn dùng, số máy, thu hồi key và giải phóng thiết bị. Website dùng Cloudflare Workers Static Assets + D1 để chạy giao diện và API cùng origin.

## Tính năng

- Dashboard thống kê key hoạt động, key hết hạn gần, thiết bị và lịch sử.
- Tạo key tự sinh hoặc nhập riêng; chỉnh sửa tên/gói/hạn/số thiết bị, thu hồi, mở lại, xóa.
- Xem và gỡ thiết bị đang chiếm chỗ license.
- Kích hoạt theo fingerprint máy; Worker kiểm tra hạn và trạng thái online.
- Key lưu bằng HMAC-SHA256 với pepper bí mật; mật khẩu admin dùng PBKDF2; session HttpOnly/SameSite; giới hạn thử đăng nhập.
- `viet` là master key vĩnh viễn, tối đa một máy chủ. Worker từ chối kích hoạt key này nếu chưa khớp fingerprint máy chủ đã đặt trong secret `MASTER_DEVICE_FINGERPRINT`.
- Tài khoản khởi tạo `admin` được tạo từ secret riêng `BOOTSTRAP_ADMIN_PASSWORD`; lần đăng nhập đầu buộc đổi mật khẩu sang tối thiểu 12 ký tự.

## Chạy local

1. Cài Node.js 20+ và Wrangler: `npm install`.
2. Tạo `.dev.vars` từ `.dev.vars.example`, đặt `LICENSE_PEPPER`, `SESSION_SECRET`, `MASTER_DEVICE_FINGERPRINT` và `BOOTSTRAP_ADMIN_PASSWORD` bằng các giá trị riêng. Mật khẩu bootstrap phải được lưu kín và đổi ngay lần đăng nhập đầu.
3. Tạo database: `npx wrangler d1 create key-quanly-toolpage`; cập nhật `database_id` trong `wrangler.jsonc`.
4. Áp dụng schema: `npx wrangler d1 migrations apply DB --local`.
5. Chạy: `npm run dev`.

Mã máy chủ hiện tại có thể lấy trong dự án Studio bằng `node -e "console.log(require('./lib/license').machine().fingerprint)"`. Không đưa fingerprint, pepper, session secret hay token Cloudflare vào Git.

## Deploy public lên Cloudflare

1. Tạo D1 database và điền `database_id` trong `wrangler.jsonc`.
2. Tạo Wrangler secrets `LICENSE_PEPPER`, `SESSION_SECRET`, `MASTER_DEVICE_FINGERPRINT` và `BOOTSTRAP_ADMIN_PASSWORD` (đặt giá trị bootstrap bạn muốn dùng cho tài khoản `admin`).
3. Trong GitHub repo, đặt Actions secrets `CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID`.
4. Chạy `npx wrangler d1 migrations apply DB --remote` rồi `npx wrangler deploy`, hoặc push thư mục này lên nhánh `main` sau khi đã cấu hình database và secrets để GitHub Actions triển khai.
5. Đăng nhập website bằng tài khoản `admin` và mật khẩu bootstrap đã lưu trong secret, rồi đổi password ngay. URL Worker sẽ có dạng `https://key-quanly-toolpage.<subdomain>.workers.dev`.
6. Trên các bản cài Studio, đặt `LICENSE_API_URL` thành URL Worker. Không đặt Cloudflare admin token trong app người dùng.

Cloudflare deploy chưa được chạy trong repo này vì chưa có Cloudflare account/API token. GitHub Actions chỉ triển khai sau khi các secrets và D1 ID được cấu hình.
