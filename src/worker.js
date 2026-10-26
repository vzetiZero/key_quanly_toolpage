const encoder = new TextEncoder();
const now = () => new Date().toISOString();
let masterSeeded = false;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const error = (message, status = 400) => json({ message }, status);
const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
const fromHex = (value) => new Uint8Array(String(value).match(/.{2}/g).map((part) => parseInt(part, 16)));
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const decode64 = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
const dateExpiry = (value) => !value ? null : (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : new Date(value).toISOString());

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function keyHash(code, env) {
  if (!env.LICENSE_PEPPER) throw new Error('License service chưa cấu hình pepper.');
  return hex(await hmac(String(code || '').trim().toLowerCase(), env.LICENSE_PEPPER));
}
async function passwordHash(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromHex(salt), iterations: 310000, hash: 'SHA-256' }, material, 256));
}
async function ensureMaster(env) {
  if (masterSeeded) return;
  const digest = await keyHash('viet', env);
  const exists = await env.DB.prepare('SELECT id FROM licenses WHERE code_hash=?').bind(digest).first();
  if (!exists) {
    const at = now();
    await env.DB.prepare("INSERT OR IGNORE INTO licenses (id,code_hash,key_hint,name,plan,status,expires_at,max_devices,notes,created_at,updated_at) VALUES (?,?,?,?,?,'active',NULL,1,?,?,?)")
      .bind(crypto.randomUUID(), digest, 'viet', 'Master license', 'permanent', 'Key master vĩnh viễn', at, at).run();
  }
  masterSeeded = true;
}
async function ensureAdmin(env) {
  const exists = await env.DB.prepare('SELECT username FROM admins LIMIT 1').first();
  if (exists) return;
  if (!env.BOOTSTRAP_ADMIN_PASSWORD) throw new Error('Thiếu secret BOOTSTRAP_ADMIN_PASSWORD để khởi tạo tài khoản quản trị.');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const password = await passwordHash(env.BOOTSTRAP_ADMIN_PASSWORD, salt);
  const at = now();
  await env.DB.prepare('INSERT OR IGNORE INTO admins (username,password_hash,salt,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind('admin', password, salt, 1, at, at).run();
}
function cookie(request, name) {
  const entry = (request.headers.get('Cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
async function signSession(username, env) {
  const payload = b64url(encoder.encode(JSON.stringify({ sub: username, exp: Date.now() + 8 * 60 * 60 * 1000 })));
  const signature = b64url(await hmac(payload, env.SESSION_SECRET));
  return `${payload}.${signature}`;
}
async function session(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = cookie(request, 'key_admin');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = b64url(await hmac(payload, env.SESSION_SECRET));
  if (signature !== expected) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(decode64(payload)));
    if (data.exp < Date.now()) return null;
    return data.sub;
  } catch { return null; }
}
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || new URL(origin).origin === new URL(request.url).origin;
}
async function event(env, type, licenseId = null, detail = '') {
  await env.DB.prepare('INSERT INTO license_events (id,license_id,type,detail,at) VALUES (?,?,?,?,?)')
    .bind(crypto.randomUUID(), licenseId, type, String(detail).slice(0, 200), now()).run();
}
async function publicLicense(env, row) {
  const devices = await env.DB.prepare('SELECT fingerprint,code,name,platform,activated_at,last_seen_at FROM license_devices WHERE license_id=? ORDER BY activated_at DESC').bind(row.id).all();
  return { id: row.id, key: row.key_hint === 'viet' ? 'viet' : `••••${row.key_hint}`, name: row.name, plan: row.plan, status: row.status, expiresAt: row.expires_at, maxDevices: row.max_devices, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at, devices: devices.results.map((item) => ({ fingerprint: item.fingerprint, code: item.code, name: item.name, platform: item.platform, activatedAt: item.activated_at, lastSeenAt: item.last_seen_at })) };
}
async function adminRequired(request, env) {
  const username = await session(request, env);
  if (!username) return { response: error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 401) };
  const admin = await env.DB.prepare('SELECT must_change_password FROM admins WHERE username=?').bind(username).first();
  if (!admin) return { response: error('Tài khoản không còn tồn tại.', 401) };
  return { username, mustChange: Boolean(admin.must_change_password) };
}
async function login(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const lock = await env.DB.prepare('SELECT attempts,blocked_until FROM login_limits WHERE ip=?').bind(ip).first();
  if (lock?.blocked_until > Date.now()) return error('Đăng nhập tạm khóa. Vui lòng thử lại sau 15 phút.', 429);
  const body = await request.json();
  const admin = await env.DB.prepare('SELECT username,password_hash,salt,must_change_password FROM admins WHERE username=?').bind(String(body.username || '').trim()).first();
  const actual = admin ? await passwordHash(String(body.password || ''), admin.salt) : '';
  if (!admin || actual !== admin.password_hash) {
    const attempts = (lock?.attempts || 0) + 1;
    await env.DB.prepare('INSERT INTO login_limits (ip,attempts,blocked_until) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET attempts=excluded.attempts,blocked_until=excluded.blocked_until')
      .bind(ip, attempts >= 5 ? 0 : attempts, attempts >= 5 ? Date.now() + 15 * 60 * 1000 : 0).run();
    return error('Tên đăng nhập hoặc mật khẩu chưa đúng.', 401);
  }
  await env.DB.prepare('DELETE FROM login_limits WHERE ip=?').bind(ip).run();
  const token = await signSession(admin.username, env);
  return json({ ok: true, username: admin.username, mustChangePassword: Boolean(admin.must_change_password) }, 200, { 'Set-Cookie': `key_admin=${encodeURIComponent(token)}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  await ensureMaster(env);
  if (path.startsWith('/api/')) await ensureAdmin(env);

  if (path === '/api/health' && method === 'GET') return json({ ok: true });
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': 'key_admin=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  if (path.startsWith('/api/') && !sameOrigin(request)) return error('Origin không hợp lệ.', 403);
  if (path === '/api/auth/me' && method === 'GET') {
    const auth = await adminRequired(request, env);
    if (auth.response) return auth.response;
    return json({ username: auth.username, mustChangePassword: auth.mustChange });
  }
  if (path === '/api/auth/password' && method === 'PUT') {
    const auth = await adminRequired(request, env);
    if (auth.response) return auth.response;
    const body = await request.json();
    if (String(body.password || '').length < 12) return error('Mật khẩu mới cần ít nhất 12 ký tự.');
    const current = await env.DB.prepare('SELECT password_hash,salt FROM admins WHERE username=?').bind(auth.username).first();
    if (!current || await passwordHash(String(body.current || ''), current.salt) !== current.password_hash) return error('Mật khẩu hiện tại chưa đúng.', 401);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const digest = await passwordHash(String(body.password), salt);
    await env.DB.prepare('UPDATE admins SET password_hash=?,salt=?,must_change_password=0,updated_at=? WHERE username=?').bind(digest, salt, now(), auth.username).run();
    return json({ ok: true });
  }

  if (path === '/v1/activate' && method === 'POST') {
    const body = await request.json(); const device = body.device || {};
    if (!/^[A-F0-9]{64}$/i.test(String(device.fingerprint || ''))) return error('Mã máy không hợp lệ.');
    const row = await env.DB.prepare('SELECT * FROM licenses WHERE code_hash=?').bind(await keyHash(body.code, env)).first();
    if (!row || row.status !== 'active') return error('License không hợp lệ hoặc đã bị thu hồi.', 400);
    if (row.expires_at && row.expires_at < now()) return error('License đã hết hạn.', 400);
    if (row.key_hint === 'viet' && (!env.MASTER_DEVICE_FINGERPRINT || String(device.fingerprint).toUpperCase() !== env.MASTER_DEVICE_FINGERPRINT.toUpperCase())) return error('Key master chỉ dùng trên thiết bị chủ đã đăng ký.', 403);
    const bound = await env.DB.prepare('SELECT fingerprint FROM license_devices WHERE license_id=? AND fingerprint=?').bind(row.id, device.fingerprint).first();
    const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM license_devices WHERE license_id=?').bind(row.id).first();
    if (!bound && count.total >= row.max_devices) return error('License đã dùng hết số thiết bị được cấp.', 409);
    if (!bound) await env.DB.prepare('INSERT INTO license_devices (fingerprint,license_id,code,name,platform,activated_at,last_seen_at) VALUES (?,?,?,?,?,?,?)').bind(device.fingerprint,row.id,device.code||'',device.name||'Thiết bị',device.platform||'',now(),now()).run();
    else await env.DB.prepare('UPDATE license_devices SET last_seen_at=? WHERE fingerprint=?').bind(now(),device.fingerprint).run();
    await event(env, bound ? 'device.checked' : 'device.activated', row.id, device.code || '');
    return json({ ok: true, license: { name: row.name, plan: row.plan, expiresAt: row.expires_at } });
  }
  if (path === '/v1/check' && method === 'POST') {
    const body = await request.json();
    if (!/^[A-F0-9]{64}$/i.test(String(body.fingerprint || ''))) return json({ active: false });
    const row = await env.DB.prepare("SELECT l.* FROM licenses l JOIN license_devices d ON d.license_id=l.id WHERE d.fingerprint=? AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>=?)").bind(body.fingerprint, now()).first();
    if (!row) return json({ active: false });
    await env.DB.prepare('UPDATE license_devices SET last_seen_at=? WHERE fingerprint=?').bind(now(), body.fingerprint).run();
    return json({ active: true, license: { name: row.name, plan: row.plan, expiresAt: row.expires_at } });
  }

  if (!path.startsWith('/api/admin/')) return error('Không tìm thấy API.', 404);
  const auth = await adminRequired(request, env);
  if (auth.response) return auth.response;
  if (auth.mustChange && path !== '/api/admin/overview') return error('Hãy đổi mật khẩu mặc định trước khi tiếp tục.', 403);
  if (path === '/api/admin/overview' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
    const licenses = await Promise.all(rows.results.map((row) => publicLicense(env, row)));
    const events = await env.DB.prepare('SELECT id,type,detail,at FROM license_events ORDER BY at DESC LIMIT 100').all();
    const totals = await env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='active' AND (expires_at IS NULL OR expires_at>=?) THEN 1 ELSE 0 END) active FROM licenses").bind(now()).first();
    const devices = await env.DB.prepare('SELECT COUNT(*) total FROM license_devices').first();
    return json({ licenses, events: events.results, stats: { total: totals.total || 0, active: totals.active || 0, devices: devices.total || 0 } });
  }
  if (path === '/api/admin/licenses' && method === 'POST') {
    const body = await request.json(); const key = String(body.key || '').trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(key)) return error('Key cần từ 4–64 ký tự gồm chữ, số, - hoặc _.');
    const plan = ['standard','pro','permanent'].includes(body.plan) ? body.plan : 'standard';
    const id = crypto.randomUUID(); const at = now();
    try {
      await env.DB.prepare('INSERT INTO licenses (id,code_hash,key_hint,name,plan,status,expires_at,max_devices,notes,created_at,updated_at) VALUES (?,?,?,?,?,\'active\',?,?,?,?,?)')
        .bind(id, await keyHash(key, env), key.slice(-4), String(body.name || 'License mới').slice(0,100), plan, plan === 'permanent' ? null : dateExpiry(body.expiresAt), Math.min(1000,Math.max(1,Number(body.maxDevices)||1)), String(body.notes||'').slice(0,500), at, at).run();
    } catch (e) { return error('Key đã tồn tại hoặc dữ liệu không hợp lệ.', 409); }
    await event(env,'license.created',id,String(body.name||''));
    return json({ ok:true, key, id },201);
  }
  const match = path.match(/^\/api\/admin\/licenses\/([^/]+)$/);
  if (match && method === 'PATCH') {
    const id=match[1];const body=await request.json();const row=await env.DB.prepare('SELECT * FROM licenses WHERE id=?').bind(id).first();if(!row)return error('Không tìm thấy license.',404);
    if(body.releaseFingerprint) await env.DB.prepare('DELETE FROM license_devices WHERE license_id=? AND fingerprint=?').bind(id,body.releaseFingerprint).run();
    const status=['active','revoked'].includes(body.status)?body.status:row.status;
    const plan=['standard','pro','permanent'].includes(body.plan)?body.plan:row.plan;
    const expiry=plan==='permanent'?null:(body.expiresAt===undefined?row.expires_at:dateExpiry(body.expiresAt));
    const max=Math.min(1000,Math.max(1,Number(body.maxDevices??row.max_devices)||1));
    const name=String(body.name??row.name).slice(0,100);const notes=String(body.notes??row.notes).slice(0,500);
    await env.DB.prepare('UPDATE licenses SET name=?,plan=?,status=?,expires_at=?,max_devices=?,notes=?,updated_at=? WHERE id=?').bind(name,plan,status,expiry,max,notes,now(),id).run();
    await event(env,body.releaseFingerprint?'device.released':'license.updated',id,body.releaseFingerprint||status);
    return json({ok:true});
  }
  if(match&&method==='DELETE'){
    await env.DB.prepare('DELETE FROM license_devices WHERE license_id=?').bind(match[1]).run();
    await env.DB.prepare('DELETE FROM licenses WHERE id=?').bind(match[1]).run();
    await event(env,'license.deleted',match[1]);return json({ok:true});
  }
  return error('Không tìm thấy API.',404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
        const response = await route(request, env);
        return response;
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return error(e.message || 'License service error.', 500);
    }
  }
};
