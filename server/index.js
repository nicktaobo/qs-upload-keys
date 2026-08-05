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
const sanitizeUser = (user) => ({
  id: user.id,
  username: user.username,
  role: user.role === "ADMIN" ? "admin" : "supplier",
  channelTemplate: user.role === "SUPPLIER" && user.channel_type_id && user.channel_group && user.channel_name_prefix ? {
    typeId: Number(user.channel_type_id),
    group: user.channel_group,
    prefix: user.channel_name_prefix
  } : null
});
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
  async createChannels(platformKey, body) { return this.request(`/api/platforms/${encodeURIComponent(platformKey)}/channels/batch`, { method: "POST", body }); }
  async getJobLogs(jobId) { return this.request(`/api/jobs/${encodeURIComponent(jobId)}/logs?p=1&page_size=100`); }
  async getChannels(platformKey, params = {}) { const query = new URLSearchParams(params); return this.request(`/api/platforms/${encodeURIComponent(platformKey)}/channels?${query}`); }
}
const upstream = () => new UpstreamClient();

const uniqueStrings = (values) => [...new Set((Array.isArray(values) ? values : []).map((item) => typeof item === "string" ? item : item?.name ?? item?.model ?? item?.id).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
const publicUpstreamError = (value) => {
  const message = String(value || "").replace(/https?:\/\/\S+/gi, "[已隐藏地址]").replace(/[\r\n]+/g, " ").trim();
  return message && message.length <= 240 ? message : "上游渠道创建失败";
};
const jobItems = (result) => Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
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

async function getUpstreamSubmissionContext(client, typeId) {
  const [platforms, profiles] = await Promise.all([client.getPlatforms(), client.getProfiles()]);
  const platformList = Array.isArray(platforms) ? platforms : [];
  const platform = platformList.find((item) => String(item.platform_key) === client.platformKey) || platformList.find((item) => item.enabled !== false) || platformList[0];
  const profileList = Array.isArray(profiles) ? profiles : [];
  const profile = profileList.find((item) => String(item.type) === String(platform?.profile_type));
  const channelType = profile?.channel_types?.find((item) => Number(item.id) === Number(typeId));
  if (!platform?.platform_key || !channelType) throw new Error("上游渠道类型不可用");
  return { platformKey: String(platform.platform_key), officialBaseUrl: String(channelType.official_base_url || "") };
}

async function waitForUpstreamChannel(client, platformKey, jobId) {
  const deadline = Date.now() + Number(env("UPSTREAM_JOB_TIMEOUT_MS") || 60000);
  let channelId = "";
  while (Date.now() < deadline) {
    const logs = jobItems(await client.getJobLogs(jobId));
    const failed = logs.find((item) => item.level === "error");
    if (failed) throw new Error(publicUpstreamError(failed.message));
    for (const item of logs) {
      const match = String(item.message || "").match(/渠道ID=(\d+)/);
      if (match) channelId = match[1];
    }
    if (channelId) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!channelId) throw new Error("上游渠道创建超时");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await client.getChannels(platformKey, { p: "1", page_size: "10", q: channelId });
    const channel = jobItems(result).find((item) => String(item.channel_id) === channelId);
    if (channel) return channel;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("上游渠道创建成功，但台账尚未就绪");
}

async function submitApiKeyUpstream(client, context, submission, record) {
  const setting = JSON.stringify({ force_format: false, thinking_to_content: false, pass_through_body_enabled: false, system_prompt: "", system_prompt_override: false, proxy: "" });
  const settings = JSON.stringify({ allow_service_tier: false, disable_store: false, allow_safety_identifier: false, allow_include_obfuscation: false });
  const channelFields = {
    type: submission.typeId,
    base_url: context.officialBaseUrl,
    models: submission.models.join(","),
    group: submission.group,
    auto_ban: submission.autoDisable ? 1 : 0,
    priority: 0,
    weight: 0,
    status: 1,
    setting,
    settings
  };
  if (Object.keys(submission.modelMapping).length) channelFields.model_mapping = JSON.stringify(submission.modelMapping);
  const created = await client.createChannels(context.platformKey, { type: submission.typeId, channel_fields: channelFields, keys: [record.value], batch: false, name: submission.name, discount: submission.discount });
  const jobId = String(created?.job_id || "");
  if (!jobId) throw new Error("上游未返回任务 ID");
  await database.query("update api_keys set upstream_job_id=$1 where id=$2", [jobId, record.id]);
  const channel = await waitForUpstreamChannel(client, context.platformKey, jobId);
  await database.query("update api_keys set upstream_channel_id=$1,upstream_channel_key=$2,upstream_channel_name=$3,upstream_error=null,status='SYNCED',last_synced_at=now() where id=$4", [String(channel.channel_id), String(channel.channel_key || ""), String(channel.name || submission.name), record.id]);
  return { keyId: record.id, channelId: String(channel.channel_id) };
}

function resolveChannelTemplate(metadata, body) {
  const typeId = Number(body.channelTypeId);
  const group = String(body.channelGroup || "").trim();
  const prefix = String(body.channelNamePrefix || "").trim();
  const channelType = metadata?.channelTypes.find((item) => item.id === typeId);
  if (!channelType || !metadata.groups.includes(group) || !prefix || prefix.length > 80) return null;
  return { typeId, group, prefix, channelType };
}

async function getPlatformMetrics(queryable = database) {
  const result = await queryable.query("select rpm,tpm,sampled_at from platform_metrics where id=true");
  const metric = result.rows[0] || { rpm: 0, tpm: 0, sampled_at: null };
  return { rpm: Number(metric.rpm), tpm: Number(metric.tpm), sampledAt: metric.sampled_at, source: "shared_upstream_cache" };
}

async function refreshUpstreamMetrics() {
  const lockClient = await database.connect();
  let locked = false;
  try {
    const lockResult = await lockClient.query("select pg_try_advisory_lock($1) as locked", [731942051]);
    locked = Boolean(lockResult.rows[0]?.locked);
    if (!locked) return { ...await getPlatformMetrics(lockClient), throttled: true, retryAfterMs: 1000 };
    const cached = await getPlatformMetrics(lockClient);
    const ageMs = cached.sampledAt ? Date.now() - new Date(cached.sampledAt).getTime() : Infinity;
    if (ageMs < 1000) return { ...cached, throttled: true, retryAfterMs: Math.max(1, 1000 - ageMs) };
    const client = await upstream().login();
    const platforms = await client.getPlatforms();
    const platformList = Array.isArray(platforms) ? platforms : [];
    const platform = platformList.find((item) => String(item.platform_key) === client.platformKey) || platformList.find((item) => item.enabled !== false) || platformList[0];
    if (!platform?.platform_key) throw new Error("上游平台配置不可用");
    const metrics = await client.getRpmTpm(platform.platform_key);
    const rpm = Number(metrics?.rpm);
    const tpm = Number(metrics?.tpm);
    if (!Number.isFinite(rpm) || rpm < 0 || !Number.isFinite(tpm) || tpm < 0) throw new Error("上游吞吐数据不可用");
    const result = await lockClient.query("update platform_metrics set rpm=$1,tpm=$2,sampled_at=now() where id=true returning rpm,tpm,sampled_at", [Math.round(rpm), Math.round(tpm)]);
    return { rpm: Number(result.rows[0].rpm), tpm: Number(result.rows[0].tpm), sampledAt: result.rows[0].sampled_at, source: "upstream", throttled: false, retryAfterMs: 0 };
  } finally {
    if (locked) await lockClient.query("select pg_advisory_unlock($1)", [731942051]).catch(() => {});
    lockClient.release();
  }
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
    if (route === "/api/admin/users" && method === "GET") { const user = await requireUser(request, response, true); if (!user) return; const result = await database.query("select u.id,u.username,u.role,u.channel_type_id,u.channel_group,u.channel_name_prefix,u.is_active,u.created_at,count(k.id)::int as keys from app_users u left join api_keys k on k.owner_id=u.id group by u.id order by u.created_at asc"); return json(response, 200, { items: result.rows.map((item) => ({ ...item, role: item.role === "ADMIN" ? "管理员" : "供应商", status: item.is_active ? "正常" : "已停用", channelTemplate: item.role === "SUPPLIER" && item.channel_type_id && item.channel_group && item.channel_name_prefix ? { typeId: Number(item.channel_type_id), group: item.channel_group, prefix: item.channel_name_prefix } : null })) }); }
    if (route === "/api/admin/users" && method === "POST") { const user = await requireUser(request, response, true); if (!user) return; const body = await parseBody(request); const username = String(body.username || "").trim(); if (!username || String(body.password || "").length < 8) return json(response, 400, { message: "用户名不能为空，密码至少需要 8 位" }); const role = body.role === "管理员" ? "ADMIN" : "SUPPLIER"; const metadata = role === "SUPPLIER" ? await getCachedMetadata() : null; const template = role === "SUPPLIER" ? resolveChannelTemplate(metadata, body) : null; if (role === "SUPPLIER" && !template) return json(response, 400, { message: "请选择有效的渠道类型和分组，并填写不超过 80 个字符的渠道名前缀" }); const result = await database.query("insert into app_users (username,password_hash,role,channel_type_id,channel_group,channel_name_prefix) values ($1,$2,$3,$4,$5,$6) returning *", [username, hashPassword(String(body.password)), role, template?.typeId || null, template?.group || null, template?.prefix || null]).catch((error) => error.code === "23505" ? null : Promise.reject(error)); if (!result) return json(response, 409, { message: "用户名已存在" }); return json(response, 201, { user: sanitizeUser(result.rows[0]) }); }
    if (route.startsWith("/api/admin/users/") && route.endsWith("/template") && method === "POST") { const user = await requireUser(request, response, true); if (!user) return; const id = route.split("/")[4]; const body = await parseBody(request); const metadata = await getCachedMetadata(); const template = resolveChannelTemplate(metadata, body); if (!template) return json(response, 400, { message: "请选择有效的渠道类型和分组，并填写不超过 80 个字符的渠道名前缀" }); const result = await database.query("update app_users set channel_type_id=$1,channel_group=$2,channel_name_prefix=$3 where id=$4 and role='SUPPLIER' returning *", [template.typeId, template.group, template.prefix, id]); if (!result.rowCount) return json(response, 404, { message: "供应商用户不存在" }); return json(response, 200, { user: sanitizeUser(result.rows[0]) }); }
    if (route.startsWith("/api/admin/users/") && route.endsWith("/status") && method === "POST") { const user = await requireUser(request, response, true); if (!user) return; const id = route.split("/")[4]; const body = await parseBody(request); const result = await database.query("update app_users set is_active=$1 where id=$2 and id<>$3", [Boolean(body.isActive), id, user.id]); if (!result.rowCount) return json(response, 400, { message: "不能停用当前管理员账号" }); return json(response, 200, { ok: true }); }
    if (route === "/api/channels" && method === "GET") { const user = await requireUser(request, response); if (!user) return; const result = await database.query("select c.*, count(k.id)::int as key_count, coalesce(sum(k.usage_usd),0)::float as usage_usd, array_remove(array_agg(distinct k.status),null) as key_statuses from channel_configs c left join api_keys k on k.channel_config_id=c.id where c.owner_id=$1 group by c.id order by c.created_at desc", [user.id]); return json(response, 200, { items: result.rows.map((item) => ({ id: item.id, name: item.name, provider: item.provider, models: item.models, group: item.group_name, discount: String(item.discount), state: item.key_statuses?.includes("UPSTREAM_ERROR") ? "同步异常" : item.key_statuses?.every((status) => status === "SYNCED") ? "已同步" : item.key_statuses?.includes("PENDING") ? "同步中" : "模拟记录", keyCount: item.key_count, usageUsd: item.usage_usd, createdAt: item.created_at })) }); }
    if (route === "/api/keys" && method === "GET") { const user = await requireUser(request, response); if (!user) return; const result = await database.query("select k.id,k.key_name,k.status,k.usage_usd,k.rpm,k.tpm,c.name as channel_name,c.models,c.group_name from api_keys k join channel_configs c on c.id=k.channel_config_id where k.owner_id=$1 order by k.created_at desc", [user.id]); return json(response, 200, { items: result.rows.map((item) => ({ id: item.id, name: item.key_name, channel: item.channel_name, model: item.models?.[0] || "未指定", group: item.group_name, usageUsd: Number(item.usage_usd), rpm: item.rpm, tpm: item.tpm, status: item.status })) }); }
    if (route === "/api/metrics" && method === "GET") { const user = await requireUser(request, response); if (!user) return; return json(response, 200, await getPlatformMetrics()); }
    if (route === "/api/metrics/refresh" && method === "POST") { const user = await requireUser(request, response); if (!user) return; return json(response, 200, await refreshUpstreamMetrics()); }
    if (route === "/api/channels" && method === "POST") {
      const user = await requireUser(request, response); if (!user) return;
      const body = await parseBody(request);
      const metadata = await getCachedMetadata();
      const isSupplier = user.role === "SUPPLIER";
      if (isSupplier && (!user.channel_type_id || !user.channel_group || !user.channel_name_prefix)) return json(response, 409, { message: "管理员尚未给当前账号分配渠道模板" });
      const typeId = isSupplier ? Number(body.typeId || user.channel_type_id) : Number(body.typeId);
      const channelType = metadata?.channelTypes.find((item) => item.id === typeId);
      const group = isSupplier ? String(body.group || user.channel_group) : String(body.group || "default");
      const allowedModels = metadata?.typeModels[String(typeId)]?.length ? metadata.typeModels[String(typeId)] : metadata?.enabledModels || [];
      const models = isSupplier ? allowedModels : uniqueStrings(body.models);
      const suffix = String(body.suffix || "").trim();
      const name = isSupplier ? `${String(user.channel_name_prefix).trim()}${suffix}` : String(body.name || "").trim();
      const keys = (Array.isArray(body.keys) ? body.keys : []).map((item) => String(item).trim()).filter(Boolean);
      const discount = isSupplier ? 1 : Number(body.discount ?? 1);
      const modelMapping = isSupplier ? {} : body.modelMapping || {};
      const autoDisable = isSupplier ? true : body.autoDisable !== false;
      const invalidSupplierName = isSupplier && (!suffix || suffix.length > 80 || name.length > 160);
      if (!metadata || invalidSupplierName || !name || name.length > 160 || !channelType || !models.length || models.some((model) => !allowedModels.includes(model)) || !keys.length || !metadata.groups.includes(group) || !Number.isFinite(discount) || discount <= 0 || discount > 1) return json(response, 400, { message: isSupplier ? "请填写不超过 80 个字符的渠道后缀和至少一枚 Key" : "渠道信息不完整或已过期，请刷新配置后重试" });
      const dbClient = await database.connect();
      let config;
      const records = [];
      try {
        await dbClient.query("begin");
        config = await dbClient.query("insert into channel_configs (owner_id,name,provider,type_id,models,model_mapping,group_name,discount,auto_disable) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *", [user.id, name, channelType.name, typeId, JSON.stringify(models), JSON.stringify(modelMapping), group, discount, autoDisable]);
        for (const [index, value] of keys.entries()) {
          const keyName = `${name}-key-${String(index + 1).padStart(2, "0")}`;
          const encrypted = encryptSecret(value);
          const inserted = await dbClient.query("insert into api_keys (owner_id,channel_config_id,key_name,encrypted_key,key_iv,key_auth_tag,status) values ($1,$2,$3,$4,$5,$6,$7) returning id", [user.id, config.rows[0].id, keyName, encrypted.encrypted, encrypted.iv, encrypted.authTag, upstreamWritesEnabled ? "PENDING" : "SIMULATED"]);
          records.push({ id: inserted.rows[0].id, value });
        }
        await dbClient.query("commit");
      } catch (error) {
        await dbClient.query("rollback");
        if (error.code === "23505") return json(response, 409, { message: "渠道名称已存在，请更换后缀" });
        throw error;
      } finally { dbClient.release(); }
      if (!upstreamWritesEnabled) return json(response, 201, { id: config.rows[0].id, name, upstreamSubmitted: false, mode: "simulation", successfulCount: 0, failedCount: 0 });
      const submission = { name, typeId, models, modelMapping, group, discount, autoDisable };
      let upstreamClient;
      let context;
      try {
        upstreamClient = await upstream().login();
        context = await getUpstreamSubmissionContext(upstreamClient, typeId);
      } catch (error) {
        const message = publicUpstreamError(error instanceof Error ? error.message : "");
        await database.query("update api_keys set status='UPSTREAM_ERROR',upstream_error=$1,last_synced_at=now() where channel_config_id=$2 and status='PENDING'", [message, config.rows[0].id]);
        return json(response, 201, { id: config.rows[0].id, name, upstreamSubmitted: false, mode: "upstream", successfulCount: 0, failedCount: records.length });
      }
      let successfulCount = 0;
      let failedCount = 0;
      for (const record of records) {
        try {
          await submitApiKeyUpstream(upstreamClient, context, submission, record);
          successfulCount += 1;
        } catch (error) {
          failedCount += 1;
          const message = publicUpstreamError(error instanceof Error ? error.message : "");
          await database.query("update api_keys set status='UPSTREAM_ERROR',upstream_error=$1,last_synced_at=now() where id=$2", [message, record.id]);
          console.error(`upstream channel submission failed: ${message}`);
        }
      }
      return json(response, 201, { id: config.rows[0].id, name, upstreamSubmitted: successfulCount > 0, mode: "upstream", successfulCount, failedCount });
    }
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
