import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ProxyAgent, fetch as upstreamFetch } from "undici";

const root = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(root, "..", "dist");
const env = (name) => { const value = process.env[name] || ""; const quote = value[0]; return value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value; };
const port = Number(env("PORT") || 3000);
const database = new Pool({ connectionString: env("DATABASE_URL"), ssl: env("DATABASE_SSL") === "true" ? { rejectUnauthorized: false } : false });
const encryptionKey = Buffer.from(env("ENCRYPTION_KEY_BASE64"), "base64");
if (encryptionKey.length !== 32) throw new Error("ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
if (!env("SESSION_SECRET")) throw new Error("SESSION_SECRET is required");

const json = (response, status, body, headers = {}) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); response.end(JSON.stringify(body)); };
const parseBody = async (request) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); if (!chunks.length) return {}; return JSON.parse(Buffer.concat(chunks).toString("utf8")); };
const sessionCookie = (id, maxAge) => `qushu_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const getCookie = (request, name) => (request.headers.cookie || "").split(";").map((part) => part.trim().split("=")).find(([key]) => key === name)?.[1];
const hashPassword = (password, salt = crypto.randomBytes(16)) => { const hash = crypto.scryptSync(password, salt, 64); return `${salt.toString("base64")}:${hash.toString("base64")}`; };
const verifyPassword = (password, stored) => { const [saltText, hashText] = String(stored).split(":"); if (!saltText || !hashText) return false; const actual = crypto.scryptSync(password, Buffer.from(saltText, "base64"), 64); return crypto.timingSafeEqual(actual, Buffer.from(hashText, "base64")); };
const encryptSecret = (value) => { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") }; };
const decryptSecret = (record) => { const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(record.key_iv, "base64")); decipher.setAuthTag(Buffer.from(record.key_auth_tag, "base64")); return Buffer.concat([decipher.update(Buffer.from(record.encrypted_key, "base64")), decipher.final()]).toString("utf8"); };
const sanitizeUser = (user) => ({ id: user.id, username: user.username, role: user.role === "ADMIN" ? "admin" : "supplier" });
const upstreamWritesEnabled = env("UPSTREAM_WRITE_ENABLED") === "true";
const upstreamDispatcher = env("UPSTREAM_PROXY_URL") ? new ProxyAgent(env("UPSTREAM_PROXY_URL")) : undefined;

async function currentUser(request) { const sessionId = getCookie(request, "qushu_session"); if (!sessionId) return null; const result = await database.query("select u.* from sessions s join app_users u on u.id=s.user_id where s.id=$1 and s.expires_at > now() and u.is_active=true", [decodeURIComponent(sessionId)]); return result.rows[0] || null; }
async function requireUser(request, response, admin = false) { const user = await currentUser(request); if (!user) { json(response, 401, { message: "请先登录" }); return null; } if (admin && user.role !== "ADMIN") { json(response, 403, { message: "需要管理员权限" }); return null; } return user; }
async function ensureSchema() { await database.query(await fs.readFile(path.join(root, "schema.sql"), "utf8")); if (env("ADMIN_USERNAME") && env("ADMIN_PASSWORD")) { const hash = hashPassword(env("ADMIN_PASSWORD")); await database.query("insert into app_users (username,password_hash,role) values ($1,$2,'ADMIN') on conflict (username) do update set password_hash=excluded.password_hash,role='ADMIN',is_active=true", [env("ADMIN_USERNAME"), hash]); } }

class UpstreamClient {
  constructor() { this.baseUrl = new URL(env("UPSTREAM_BASE_URL")); this.timeout = Number(env("UPSTREAM_TIMEOUT_MS") || 10000); this.cookie = ""; this.userId = ""; this.platformKey = ""; }
  async request(relativePath, options = {}) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeout); const headers = { accept: "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.userId ? { "New-Api-User": this.userId } : {}), ...(options.body ? { "content-type": "application/json" } : {}) }; try { const response = await upstreamFetch(new URL(relativePath, this.baseUrl), { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined, signal: controller.signal, dispatcher: upstreamDispatcher }); const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean); if (setCookies.length) this.cookie = setCookies.map((item) => item.split(";")[0]).join("; "); const payload = await response.json().catch(() => ({})); if (!response.ok || payload.success === false) throw new Error("上游请求失败"); return payload.data ?? payload; } catch (error) { if (error.name === "AbortError") throw new Error("上游请求超时"); throw error instanceof Error && error.message === "上游请求失败" ? error : new Error("上游服务暂时不可用"); } finally { clearTimeout(timer); } }
  async login() { const result = await this.request("/api/login", { method: "POST", body: { username: env("UPSTREAM_USERNAME"), password: env("UPSTREAM_PASSWORD") } }); this.userId = String(result.user_id ?? ""); this.platformKey = String(result.platform_key ?? ""); return this; }
  async getPlatforms() { return this.request("/api/platforms"); }
  async getProfiles() { return this.request("/api/platform-profiles"); }
  async getGroups(platformKey) { return this.request(`/api/platforms/${encodeURIComponent(platformKey)}/groups`); }
  async getModels(platformKey) { return this.request(`/api/platforms/${encodeURIComponent(platformKey)}/models`); }
  async getRpmTpm(platformKey) { return this.request(`/api/platforms/${encodeURIComponent(platformKey)}/rpm-tpm`); }
}
const upstream = () => new UpstreamClient();

const uniqueStrings = (values) => [...new Set((Array.isArray(values) ? values : []).map((item) => typeof item === "string" ? item : item?.name ?? item?.model ?? item?.id).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
const sanitizeMetadata = (row) => ({
  channelTypes: Array.isArray(row.channel_types) ? row.channel_types : [],
  groups: Array.isArray(row.groups) ? row.groups : [],
  typeModels: row.type_models && typeof row.type_models === "object" ? row.type_models : {},
  enabledModels: Array.isArray(row.enabled_models) ? row.enabled_models : [],
  allModels: Array.isArray(row.all_models) ? row.all_models : [],
  syncedAt: row.synced_at,
  submissionMode: upstreamWritesEnabled ? "upstream" : "simulation"
});

async function syncUpstreamMetadata() {
  if (!env("UPSTREAM_BASE_URL") || !env("UPSTREAM_USERNAME") || !env("UPSTREAM_PASSWORD")) throw new Error("上游同步配置不完整");
  const client = await upstream().login();
  const [platforms, profiles] = await Promise.all([client.getPlatforms(), client.getProfiles()]);
  const platformList = Array.isArray(platforms) ? platforms : [];
  const platform = platformList.find((item) => String(item.platform_key) === client.platformKey) || platformList.find((item) => item.enabled !== false) || platformList[0];
  if (!platform?.platform_key || !platform?.profile_type) throw new Error("上游平台配置不可用");
  const profileList = Array.isArray(profiles) ? profiles : [];
  const profile = profileList.find((item) => String(item.type) === String(platform.profile_type));
  if (!profile || !Array.isArray(profile.channel_types)) throw new Error("上游渠道类型不可用");
  const [groupsResult, modelsResult] = await Promise.all([client.getGroups(platform.platform_key), client.getModels(platform.platform_key)]);
  const channelTypes = profile.channel_types.map((item) => ({ id: Number(item.id), name: String(item.name || "").trim(), authMethods: uniqueStrings(item.auth_methods) })).filter((item) => Number.isInteger(item.id) && item.name);
  const typeModels = Object.fromEntries(Object.entries(modelsResult?.type_models || {}).map(([typeId, models]) => [String(typeId), uniqueStrings(models)]).filter(([, models]) => models.length));
  const groups = uniqueStrings(groupsResult);
  const enabledModels = uniqueStrings(modelsResult?.enabled);
  const allModels = uniqueStrings(modelsResult?.all);
  if (!channelTypes.length || !groups.length || !allModels.length) throw new Error("上游元数据为空");
  const result = await database.query(`insert into upstream_metadata (id,profile_type,channel_types,groups,type_models,enabled_models,all_models,synced_at)
    values (true,$1,$2,$3,$4,$5,$6,now())
    on conflict (id) do update set profile_type=excluded.profile_type,channel_types=excluded.channel_types,groups=excluded.groups,type_models=excluded.type_models,enabled_models=excluded.enabled_models,all_models=excluded.all_models,synced_at=now()
    returning channel_types,groups,type_models,enabled_models,all_models,synced_at`, [String(platform.profile_type), JSON.stringify(channelTypes), JSON.stringify(groups), JSON.stringify(typeModels), JSON.stringify(enabledModels), JSON.stringify(allModels)]);
  return sanitizeMetadata(result.rows[0]);
}

async function getCachedMetadata() {
  const result = await database.query("select channel_types,groups,type_models,enabled_models,all_models,synced_at from upstream_metadata where id=true");
  return result.rows[0] ? sanitizeMetadata(result.rows[0]) : null;
}

async function refreshUpstreamMetrics() {
  const client = await upstream().login();
  const platforms = await client.getPlatforms();
  const platformList = Array.isArray(platforms) ? platforms : [];
  const platform = platformList.find((item) => String(item.platform_key) === client.platformKey) || platformList.find((item) => item.enabled !== false) || platformList[0];
  if (!platform?.platform_key) throw new Error("上游平台配置不可用");
  const metrics = await client.getRpmTpm(platform.platform_key);
  const rpm = Number(metrics?.rpm);
  const tpm = Number(metrics?.tpm);
  if (!Number.isFinite(rpm) || rpm < 0 || !Number.isFinite(tpm) || tpm < 0) throw new Error("上游吞吐数据不可用");
  const result = await database.query("update platform_metrics set rpm=$1,tpm=$2,sampled_at=now() where id=true returning rpm,tpm,sampled_at", [Math.round(rpm), Math.round(tpm)]);
  return { rpm: Number(result.rows[0].rpm), tpm: Number(result.rows[0].tpm), sampledAt: result.rows[0].sampled_at };
}

async function api(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`); const method = request.method; const route = url.pathname;
  try {
    if (route === "/api/health" && method === "GET") return json(response, 200, { ok: true });
    if (route === "/api/auth/login" && method === "POST") { const body = await parseBody(request); const result = await database.query("select * from app_users where username=$1 and is_active=true", [String(body.username || "")]); const user = result.rows[0]; if (!user || !verifyPassword(String(body.password || ""), user.password_hash)) return json(response, 401, { message: "用户名或密码错误" }); const id = crypto.randomBytes(32).toString("hex"); await database.query("insert into sessions (id,user_id,expires_at) values ($1,$2,now()+interval '7 days')", [id, user.id]); return json(response, 200, { user: sanitizeUser(user) }, { "set-cookie": sessionCookie(id, 604800) }); }
    if (route === "/api/auth/logout" && method === "POST") { const id = getCookie(request, "qushu_session"); if (id) await database.query("delete from sessions where id=$1", [decodeURIComponent(id)]); return json(response, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) }); }
    if (route === "/api/auth/me" && method === "GET") { const user = await requireUser(request, response); if (!user) return; return json(response, 200, { user: sanitizeUser(user) }); }
    if (route === "/api/metadata" && method === "GET") { const user = await requireUser(request, response); if (!user) return; const metadata = await getCachedMetadata() || await syncUpstreamMetadata(); return json(response, 200, metadata); }
    if (route === "/api/admin/metadata/refresh" && method === "POST") { const user = await requireUser(request, response, true); if (!user) return; const metadata = await syncUpstreamMetadata(); return json(response, 200, metadata); }
    if (route === "/api/admin/users" && method === "GET") { const user = await requireUser(request, response, true); if (!user) return; const result = await database.query("select u.id,u.username,u.role,u.is_active,u.created_at,count(k.id)::int as keys from app_users u left join api_keys k on k.owner_id=u.id group by u.id order by u.created_at asc"); return json(response, 200, { items: result.rows.map((item) => ({ ...item, role: item.role === "ADMIN" ? "管理员" : "供应商", status: item.is_active ? "正常" : "已停用" })) }); }
    if (route === "/api/admin/users" && method === "POST") { const user = await requireUser(request, response, true); if (!user) return; const body = await parseBody(request); if (!body.username || String(body.password || "").length < 8) return json(response, 400, { message: "用户名不能为空，密码至少需要 8 位" }); const role = body.role === "管理员" ? "ADMIN" : "SUPPLIER"; const result = await database.query("insert into app_users (username,password_hash,role) values ($1,$2,$3) returning id,username,role,created_at", [String(body.username).trim(), hashPassword(String(body.password)), role]).catch((error) => error.code === "23505" ? null : Promise.reject(error)); if (!result) return json(response, 409, { message: "用户名已存在" }); return json(response, 201, { user: sanitizeUser(result.rows[0]) }); }
    if (route.startsWith("/api/admin/users/") && route.endsWith("/status") && method === "POST") { const user = await requireUser(request, response, true); if (!user) return; const id = route.split("/")[4]; const body = await parseBody(request); const result = await database.query("update app_users set is_active=$1 where id=$2 and id<>$3", [Boolean(body.isActive), id, user.id]); if (!result.rowCount) return json(response, 400, { message: "不能停用当前管理员账号" }); return json(response, 200, { ok: true }); }
    if (route === "/api/channels" && method === "GET") { const user = await requireUser(request, response); if (!user) return; const result = await database.query("select c.*, count(k.id)::int as key_count, coalesce(sum(k.usage_usd),0)::float as usage_usd, array_remove(array_agg(distinct k.status),null) as key_statuses from channel_configs c left join api_keys k on k.channel_config_id=c.id where c.owner_id=$1 group by c.id order by c.created_at desc", [user.id]); return json(response, 200, { items: result.rows.map((item) => ({ id: item.id, name: item.name, provider: item.provider, models: item.models, group: item.group_name, discount: String(item.discount), state: item.key_statuses?.includes("UPSTREAM_ERROR") ? "同步异常" : item.key_statuses?.every((status) => status === "SYNCED") ? "已同步" : "模拟记录", keyCount: item.key_count, usageUsd: item.usage_usd, createdAt: item.created_at })) }); }
    if (route === "/api/keys" && method === "GET") { const user = await requireUser(request, response); if (!user) return; const result = await database.query("select k.id,k.key_name,k.status,k.usage_usd,k.rpm,k.tpm,c.name as channel_name,c.models,c.group_name from api_keys k join channel_configs c on c.id=k.channel_config_id where k.owner_id=$1 order by k.created_at desc", [user.id]); return json(response, 200, { items: result.rows.map((item) => ({ id: item.id, name: item.key_name, channel: item.channel_name, model: item.models?.[0] || "未指定", group: item.group_name, usageUsd: Number(item.usage_usd), rpm: item.rpm, tpm: item.tpm, status: item.status })) }); }
    if (route === "/api/metrics" && method === "GET") { const user = await requireUser(request, response); if (!user) return; const result = await database.query("select rpm,tpm,sampled_at from platform_metrics where id=true"); const metric = result.rows[0] || { rpm: 0, tpm: 0 }; return json(response, 200, { rpm: Number(metric.rpm), tpm: Number(metric.tpm), sampledAt: metric.sampled_at, source: "admin_upstream_cache" }); }
    if (route === "/api/metrics/refresh" && method === "POST") { const user = await requireUser(request, response, true); if (!user) return; return json(response, 200, await refreshUpstreamMetrics()); }
    if (route === "/api/channels" && method === "POST") { const user = await requireUser(request, response); if (!user) return; const body = await parseBody(request); const models = uniqueStrings(body.models); const typeId = Number(body.typeId); const metadata = await getCachedMetadata(); const channelType = metadata?.channelTypes.find((item) => item.id === typeId); const group = String(body.group || "default"); const allowedModels = metadata?.typeModels[String(typeId)]?.length ? metadata.typeModels[String(typeId)] : metadata?.enabledModels || []; const discount = Number(body.discount ?? 1); if (!body.name || !channelType || !models.length || models.some((model) => !allowedModels.includes(model)) || !Array.isArray(body.keys) || !body.keys.length || !metadata.groups.includes(group) || !Number.isFinite(discount) || discount < 0 || discount > 10) return json(response, 400, { message: "渠道信息不完整或已过期，请刷新配置后重试" }); if (upstreamWritesEnabled) return json(response, 503, { message: "当前版本尚未开放上游写入" }); const client = await database.connect(); try { await client.query("begin"); const config = await client.query("insert into channel_configs (owner_id,name,provider,type_id,models,model_mapping,group_name,discount,auto_disable) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *", [user.id, String(body.name).trim(), channelType.name, typeId, JSON.stringify(models), JSON.stringify(body.modelMapping || {}), group, discount, body.autoDisable !== false]); for (const [index, apiKey] of body.keys.entries()) { const value = String(apiKey).trim(); if (!value) continue; const keyName = `${String(body.name).trim()}-key-${String(index + 1).padStart(2, "0")}`; const encrypted = encryptSecret(value); await client.query("insert into api_keys (owner_id,channel_config_id,key_name,encrypted_key,key_iv,key_auth_tag,status) values ($1,$2,$3,$4,$5,$6,'SIMULATED')", [user.id, config.rows[0].id, keyName, encrypted.encrypted, encrypted.iv, encrypted.authTag]); } await client.query("commit"); return json(response, 201, { id: config.rows[0].id, upstreamSubmitted: false, mode: "simulation" }); } catch (error) { await client.query("rollback"); if (error.code === "23505") return json(response, 409, { message: "渠道名称已存在" }); throw error; } finally { client.release(); } }
    return json(response, 404, { message: "接口不存在" });
  } catch (error) { console.error(error instanceof Error ? error.message : "request failed"); return json(response, 500, { message: "服务暂时不可用" }); }
}

await ensureSchema();
http.createServer((request, response) => {
  if (request.url?.startsWith("/api/")) return void api(request, response);
  if (request.method !== "GET") { response.writeHead(404); response.end(); return; }
  const pathname = new URL(request.url || "/", `http://${request.headers.host}`).pathname;
  const file = path.resolve(distRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${distRoot}${path.sep}`)) { response.writeHead(400); response.end(); return; }
  const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  fs.readFile(file).then((data) => { response.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream" }); response.end(data); }).catch(() => json(response, 404, { message: "Not found" }));
}).listen(port, () => console.log(`QuShu server listening on ${port}`));
