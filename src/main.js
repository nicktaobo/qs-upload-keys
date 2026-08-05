import "./style.css";

const defaultChannels = [
  { id: "47228", name: "production-openai", provider: "OpenAI", models: ["gpt-5.5", "gpt-5.6-sol"], group: "openai", discount: "0.72", state: "已同步", keyCount: 2, updatedAt: "刚刚", amount: 1531.65, latency: 188, createdAt: "2026/08/04 03:28" },
  { id: "47227", name: "claude-mainline", provider: "Anthropic Claude", models: ["claude-opus-4-8", "claude-sonnet-4-6"], group: "anthropic", discount: "0.85", state: "已同步", keyCount: 1, updatedAt: "今天 09:42", amount: 826.42, latency: 241, createdAt: "2026/08/03 21:16" }
];
const defaultUsers = [
  { username: "admin", role: "管理员", status: "正常", createdAt: "2026/08/01 10:24", keys: 0 },
  { username: "supplier-demo", role: "供应商", status: "正常", createdAt: "2026/08/03 16:08", keys: 3 }
];
const state = {
  channels: JSON.parse(localStorage.getItem("qushu-channels") || "null") || defaultChannels,
  users: JSON.parse(localStorage.getItem("qushu-users") || "null") || defaultUsers,
  page: "overview", modal: false, userModal: false, editingUserId: null, batch: false, mappings: [], usageUpdated: "09:09:40",
  traffic: { rpm: 3056, tpm: 45550206 },
  metadata: { channelTypes: [], groups: [], typeModels: {}, enabledModels: [], allModels: [], syncedAt: null, submissionMode: "simulation" },
  channelDraft: { typeId: "", name: "", suffix: "", discount: "1.000", keys: "", group: "default", models: null, autoDisable: true }
};
state.apiMode = import.meta.env.VITE_API_MODE === "true";
state.user = null;
state.keys = [];
state.loginError = "";
state.booting = state.apiMode;
state.channels = state.channels.map((channel, index) => ({
  id: channel.id || `local-${String(47228 - index)}`,
  amount: Number.isFinite(Number(channel.amount)) ? Number(channel.amount) : 0,
  latency: Number.isFinite(Number(channel.latency)) ? Number(channel.latency) : 0,
  createdAt: channel.createdAt || "待同步",
  ...channel,
}));
const app = document.querySelector("#app");
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
const icon = (name) => ({ grid: "▦", plug: "⌁", chart: "◒", users: "♙", settings: "◌", plus: "+", refresh: "↻", close: "×", arrow: "→", check: "✓", key: "⌘", lock: "◇", logout: "↪" }[name] || "·");
const totalKeys = () => state.channels.reduce((sum, channel) => sum + channel.keyCount, 0);
const formatTime = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
const modelsForType = (typeId) => state.metadata.typeModels[String(typeId)]?.length ? state.metadata.typeModels[String(typeId)] : state.metadata.enabledModels;
const channelTypeName = (typeId) => state.metadata.channelTypes.find((item) => item.id === Number(typeId))?.name || "未分配";
const newChannelDraft = () => {
  const template = state.user?.role === "supplier" ? state.user.channelTemplate : null;
  return { typeId: String(template?.typeId || state.metadata.channelTypes[0]?.id || ""), name: "", suffix: "", discount: "1.000", keys: "", group: template?.group || (state.metadata.groups.includes("default") ? "default" : (state.metadata.groups[0] || "")), models: null, autoDisable: true };
};

function render() {
  if (state.apiMode && state.booting) { app.innerHTML = `<div class="boot-state">正在连接服务端…</div>`; return; }
  if (state.apiMode && !state.user) { app.innerHTML = loginPage(); bindEvents(); return; }
  app.innerHTML = `<div class="shell">
    <aside class="sidebar"><div class="brand"><span class="brand-mark">${icon("key")}</span><span>渠道中转台</span><small>MODEL BOXS</small></div>
      <nav><div class="nav-label">我的工作台</div>${navItem("mykeys", "key", "我的 Key")}${navItem("usage", "chart", "我的用量")}${state.user?.role === "admin" || !state.apiMode ? `<div class="nav-label">平台管理</div>${navItem("overview", "grid", "平台概览")}${navItem("channels", "plug", "渠道管理")}${navItem("users", "users", "用户管理")}${navItem("settings", "settings", "安全设置")}` : ""}</nav>
      <div class="sidebar-foot"><span class="status-dot"></span><div><strong>中转服务在线</strong><small>敏感信息由服务端托管</small></div></div></aside>
    <main class="main"><header class="topbar"><div class="crumb">${pageTitle()} <span>/</span> 管理控制台</div><div class="top-actions"><span class="target-pill"><span class="status-dot"></span>${state.user?.role === "admin" ? "管理员模式" : "用户模式"}</span><span class="avatar">${esc((state.user?.username || "U").slice(0, 2).toUpperCase())}</span><span class="user-name">${esc(state.user?.username || "本地演示")}</span><button class="icon-button" title="刷新数据" id="refresh">${icon("refresh")}</button><button class="logout-button" title="退出登录" id="logout">${icon("logout")}<span>退出</span></button></div></header>
      ${renderPage()}</main></div>${state.modal ? channelModal() : ""}${state.userModal ? userModal() : ""}`;
  bindEvents();
}

function loginPage() { return `<div class="login-page"><form class="login-panel" id="login-form"><div class="brand"><span class="brand-mark">${icon("key")}</span><span>渠道中转台</span></div><p class="eyebrow">MODELBOXS</p><h1>登录平台</h1><p class="subline">账号由管理员创建，暂不开放公开注册。</p>${state.loginError ? `<div class="login-error">${esc(state.loginError)}</div>` : ""}<label class="field"><span>用户名</span><input id="login-username" autocomplete="username" required></label><label class="field"><span>密码</span><input id="login-password" type="password" autocomplete="current-password" required></label><button class="primary-button login-submit" type="submit">登录 ${icon("arrow")}</button></form></div>`; }

function navItem(page, iconName, label) { return `<button class="nav-item ${state.page === page ? "active" : ""}" data-page="${page}">${icon(iconName)}<span>${label}</span></button>`; }
function pageTitle() { return ({ mykeys: "我的 Key", overview: "平台概览", channels: "渠道管理", usage: "我的用量", users: "用户管理", settings: "安全设置" }[state.page] || "平台概览"); }
function stat(label, value, detail, className = "") { return `<div class="stat ${className}"><span>${label}</span><strong>${value}</strong><em>${detail}</em></div>`; }

function renderPage() {
  if (state.page === "mykeys") return myKeysPage();
  if (state.page === "usage") return usagePage();
  if (state.page === "users") return usersPage();
  if (state.page === "settings") return settingsPage();
  const isOverview = state.page === "overview";
  const isSupplierChannel = !isOverview && state.user?.role === "supplier";
  const template = state.user?.channelTemplate;
  const metadataStatus = isSupplierChannel ? `<span>账号默认值 · 类型 ${esc(channelTypeName(template?.typeId))} · 分组 ${esc(template?.group || "未分配")} · 固定前缀 ${esc(template?.prefix || "未分配")}</span><time>${template ? "类型与分组可调整" : "等待管理员配置"}</time>` : `<span>渠道类型 ${state.metadata.channelTypes.length} 种 · 分组 ${state.metadata.groups.length} 个 · 模型 ${state.metadata.allModels.length} 个</span><time>上次同步：${esc(formatTime(state.metadata.syncedAt))}</time>`;
  return `<section class="content"><div class="intro"><div><p class="eyebrow">SUPPLIER CONSOLE / ${isOverview ? "01" : "02"}</p><h1>${isOverview ? "平台概览" : "渠道管理"}</h1><p class="subline">${isOverview ? "查看平台运行状态、吞吐能力和渠道健康度。" : isSupplierChannel ? "填写渠道后缀和 Key，需要时可调整默认类型与分组。" : "使用上游实时配置创建本地模拟渠道。"}</p></div><div class="intro-actions">${state.user?.role === "admin" ? `<button class="secondary-button" id="refresh-metadata">${icon("refresh")} 同步配置数据</button>` : ""}<button class="primary-button" id="open-modal">${icon("plus")} ${isSupplierChannel ? "上传 Key" : "添加渠道"}</button></div></div><div class="metadata-strip"><span class="status-dot"></span>${metadataStatus}</div>
    ${isOverview ? overviewMetrics() : channelTable()}
  </section>`;
}

function overviewMetrics() {
  return `<div class="stats">${stat("已配置渠道", state.channels.length, "个渠道")}${stat("已接入 Key", totalKeys(), "枚凭据")}${stat("当前 RPM", state.traffic.rpm.toLocaleString(), `请求 / 分钟 · ${state.usageUpdated}`, "metric-live")}${stat("当前 TPM", state.traffic.tpm.toLocaleString(), `Token / 分钟 · ${state.usageUpdated}`, "metric-live")}</div>
    <section class="traffic-panel"><div><p class="eyebrow">LIVE THROUGHPUT</p><h2>平台实时吞吐</h2><p>数据由服务端聚合后返回，前端不接触上游请求明细。</p></div><button class="outline-button" id="refresh-traffic">${icon("refresh")} 刷新 RPM / TPM</button><div class="traffic-bars"><div><span>RPM</span><strong>${state.traffic.rpm.toLocaleString()}</strong><i><b style="width:${Math.min(100, state.traffic.rpm / 40)}%"></b></i></div><div><span>TPM</span><strong>${state.traffic.tpm.toLocaleString()}</strong><i><b style="width:${Math.min(100, state.traffic.tpm / 700000)}%"></b></i></div></div></section>
    <div class="section-head"><div><h2>渠道健康度</h2><p>只显示本平台需要的运行指标。</p></div><button class="text-button" data-page="usage">查看使用统计 ${icon("arrow")}</button></div>${channelTable(true)}`;
}

function channelTable(compact = false) {
  return `<div class="table-wrap"><table><thead><tr><th>渠道名称</th><th>类型</th><th>模型</th><th>分组</th><th>折扣</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.channels.map((channel) => `<tr><td><div class="channel-name"><span class="provider-icon">${channel.provider.slice(0, 1)}</span><div><strong>${esc(channel.name)}</strong><small>内部编号 ${esc(channel.id || "待分配")} · ${esc(channel.updatedAt)}</small></div></div></td><td>${esc(channel.provider)}</td><td><span class="model-count">${channel.models.length} 个模型</span><div class="model-preview">${channel.models.slice(0, 2).map(esc).join(" · ")}</div></td><td><span class="group-tag">${esc(channel.group || "default")}</span></td><td><strong class="discount">${esc(channel.discount)}</strong></td><td><span class="sync-state"><i></i>${esc(channel.state)}</span></td><td><button class="row-action" data-page="usage" title="查看使用统计">${icon("arrow")}</button></td></tr>`).join("")}</tbody></table>${state.channels.length === 0 ? `<div class="empty">还没有渠道，点击右上角添加第一条配置。</div>` : ""}</div>${compact ? "" : `<div class="notice"><span class="notice-icon">${icon("lock")}</span><div><strong>敏感数据隔离</strong><p>上游地址、请求参数、鉴权信息和原始响应只在服务端处理，用户界面不会展示。</p></div></div>`}`;
}

function usagePage() {
  const totalAmount = state.channels.reduce((sum, channel) => sum + channel.amount, 0);
  return `<section class="content"><div class="page-band"><div><p class="eyebrow">CHANNEL ANALYTICS / 03</p><h1>渠道使用统计</h1><p class="subline">按渠道查看消费、响应和分组数据。</p></div><button class="primary-button" id="refresh-usage">${icon("refresh")} 刷新数据</button></div><div class="usage-summary"><div><span>今日消费总计</span><strong>$${totalAmount.toFixed(3)}</strong></div><div><span>平均响应</span><strong>${Math.round(state.channels.reduce((sum, item) => sum + item.latency, 0) / state.channels.length || 0)} <small>ms</small></strong></div><div><span>数据更新时间</span><strong>${state.usageUpdated}</strong></div></div><div class="table-wrap usage-table"><table><thead><tr><th>渠道 ID</th><th>渠道名称</th><th>类型</th><th>状态</th><th>消费金额</th><th>响应 (MS)</th><th>分组</th><th>创建时间</th></tr></thead><tbody>${state.channels.map((channel) => `<tr><td class="mono">${esc(channel.id || "待分配")}</td><td><strong>${esc(channel.name)}</strong></td><td>${esc(channel.provider)}</td><td><span class="status-badge ${channel.state === "已禁用" ? "danger" : "success"}">${esc(channel.state === "已同步" ? "已启用" : channel.state)}</span></td><td class="money">$${channel.amount.toFixed(3)}</td><td>${channel.latency}<small> ms</small></td><td>${esc(channel.group || "default")}</td><td class="mono">${esc(channel.createdAt || "刚刚")}</td></tr>`).join("")}</tbody></table></div><div class="notice"><span class="notice-icon">${icon("lock")}</span><div><strong>统计数据已脱敏</strong><p>本页不展示上游地址、请求路径、请求头、Key、Cookie 或原始响应，只保留平台内部可运营指标。</p></div></div></section>`;
}

function myKeysPage() {
  const demoRecords = state.channels.flatMap((channel) => Array.from({ length: channel.keyCount }, (_, index) => ({
    name: `${channel.name}-key-${String(index + 1).padStart(2, "0")}`,
    channel: channel.name,
    model: channel.models[index % channel.models.length] || "未指定",
    group: channel.group || "default",
    amount: Number((channel.amount / Math.max(1, channel.keyCount)).toFixed(3)),
    rpm: Math.max(0, Math.round(state.traffic.rpm / Math.max(1, totalKeys()))),
    tpm: Math.max(0, Math.round(state.traffic.tpm / Math.max(1, totalKeys()))),
    state: channel.state === "已禁用" ? "已禁用" : "正常"
  })));
  const records = state.apiMode ? state.keys.map((item) => ({ name: item.name, channel: item.channel, model: item.model, group: item.group, amount: Number(item.usageUsd || 0), rpm: Number(item.rpm || 0), tpm: Number(item.tpm || 0), state: item.status === "UPSTREAM_ERROR" ? "异常" : item.status === "SIMULATED" ? "模拟记录" : "正常" })) : demoRecords;
  const myAmount = records.reduce((sum, item) => sum + item.amount, 0);
  return `<section class="content"><div class="page-band"><div><p class="eyebrow">PERSONAL KEYS / 01</p><h1>我的 Key</h1><p class="subline">只展示当前用户自己提交的 Key 名称与用量，不显示完整密钥。</p></div><button class="primary-button" data-page="channels">${icon("plus")} 提交新 Key</button></div><div class="user-context"><span class="avatar small-avatar">${esc((state.user?.username || "U").slice(0, 2).toUpperCase())}</span><div><strong>${esc(state.user?.username || "本地演示")}</strong><small>${state.user?.role === "admin" ? "管理员" : "供应商用户"} · Key 数据仅本人可见，平台吞吐由管理员共享</small></div><span class="context-lock">${icon("lock")} 数据已隔离</span></div><div class="stats user-stats">${stat("我的 Key", records.length, "枚凭据")}${stat("今日用量", `$${myAmount.toFixed(3)}`, "累计消费")}${stat("平台 RPM", state.traffic.rpm.toLocaleString(), `请求 / 分钟 · ${state.usageUpdated}`, "metric-live")}${stat("平台 TPM", state.traffic.tpm.toLocaleString(), `Token / 分钟 · ${state.usageUpdated}`, "metric-live")}</div><div class="section-head"><div><h2>Key 使用明细</h2><p>Key 名称由平台生成，完整密钥仅在服务端加密保存。</p></div><button class="text-button" id="refresh-my-usage">${icon("refresh")} 刷新显示</button></div><div class="table-wrap key-usage-table"><table><thead><tr><th>Key 名称</th><th>所属渠道</th><th>模型</th><th>分组</th><th>使用量</th><th>RPM</th><th>TPM</th><th>状态</th></tr></thead><tbody>${records.map((item) => `<tr><td><div class="key-label"><span>${icon("key")}</span><strong>${esc(item.name)}</strong></div></td><td>${esc(item.channel)}</td><td class="mono">${esc(item.model)}</td><td><span class="group-tag">${esc(item.group)}</span></td><td class="money">$${item.amount.toFixed(3)}</td><td class="mono">${item.rpm.toLocaleString()}</td><td class="mono">${item.tpm.toLocaleString()}</td><td><span class="sync-state"><i></i>${esc(item.state)}</span></td></tr>`).join("")}</tbody></table>${records.length === 0 ? `<div class="empty">你还没有提交 Key。</div>` : ""}</div></section>`;
}

function usersPage() {
  return `<section class="content"><div class="page-band"><div><p class="eyebrow">ACCESS CONTROL / 04</p><h1>用户管理</h1><p class="subline">创建供应商账号时，同时分配默认渠道类型、默认分组和名称前缀。</p></div><button class="primary-button" id="open-user-modal">${icon("plus")} 创建用户</button></div><div class="permission-strip"><span class="permission-icon">${icon("lock")}</span><div><strong>账号级渠道默认值</strong><p>供应商上传时默认选中管理员配置的类型和分组，也可以按本次渠道调整；名称前缀保持固定。</p></div></div><div class="table-wrap user-table"><table><thead><tr><th>用户名</th><th>角色</th><th>渠道默认值</th><th>状态</th><th>已接入 Key</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${state.users.map((user) => `<tr><td><div class="user-cell"><span class="avatar small-avatar">${esc(user.username.slice(0, 2).toUpperCase())}</span><strong>${esc(user.username)}</strong></div></td><td><span class="role-tag">${esc(user.role)}</span></td><td>${user.role === "供应商" ? user.channelTemplate ? `<div class="template-cell"><strong>${esc(channelTypeName(user.channelTemplate.typeId))} · ${esc(user.channelTemplate.group)}</strong><small>${esc(user.channelTemplate.prefix)} + 后缀</small></div>` : `<span class="status-badge danger">待配置</span>` : `<span class="muted-cell">不适用</span>`}</td><td><span class="status-badge ${user.status === "正常" ? "success" : "danger"}">${esc(user.status)}</span></td><td>${user.keys}</td><td class="mono">${esc(user.createdAt)}</td><td><div class="user-actions">${user.role === "供应商" ? `<button class="row-action" data-configure-user="${esc(user.id)}">配置</button>` : ""}<button class="row-action" data-toggle-user="${esc(user.id)}" data-user-active="${user.status === "正常"}" ${user.username === state.user?.username ? "disabled" : ""}>${user.status === "正常" ? "停用" : "启用"}</button></div></td></tr>`).join("")}</tbody></table></div></section>`;
}

function settingsPage() {
  return `<section class="content"><div class="page-band"><div><p class="eyebrow">SECURITY / 05</p><h1>安全设置</h1><p class="subline">查看服务端托管策略，敏感配置不在浏览器中展示。</p></div></div><div class="security-grid"><div class="security-card"><span class="security-icon">${icon("lock")}</span><h2>密钥隔离</h2><p>Key 只在服务端短暂解密并转发，前端不保存明文。</p><span class="security-state">已启用</span></div><div class="security-card"><span class="security-icon">${icon("users")}</span><h2>管理员创建用户</h2><p>关闭公开注册，账号由管理员统一创建、停用和重置。</p><span class="security-state">已启用</span></div><div class="security-card"><span class="security-icon">${icon("chart")}</span><h2>统计代理</h2><p>RPM、TPM、用量和延迟由服务端聚合后展示。</p><span class="security-state">已启用</span></div></div></section>`;
}

function channelModal() {
  const types = state.metadata.channelTypes;
  const isSupplier = state.user?.role === "supplier";
  const template = state.user?.channelTemplate;
  const typeId = String(state.channelDraft.typeId || (isSupplier ? template?.typeId : types[0]?.id) || "");
  const currentType = types.find((item) => String(item.id) === typeId);
  const models = modelsForType(typeId);
  const selectedModels = state.channelDraft.models === null ? models : state.channelDraft.models;
  const keyCount = state.channelDraft.keys.split(/\n+/).map((item) => item.trim()).filter(Boolean).length;
  const templateReady = Boolean(template && currentType && state.metadata.groups.includes(state.channelDraft.group) && models.length);
  const keyField = `<label class="field full"><span>Key <b>*</b><small class="field-help">每行一个，开启批量添加后可一次提交多枚</small></span><textarea id="keys" rows="${state.batch ? 4 : 2}" placeholder="请输入渠道对应的鉴权密钥">${esc(state.channelDraft.keys)}</textarea><label class="toggle-line"><input id="batch" type="checkbox" ${state.batch ? "checked" : ""}><span>批量添加</span><small id="key-counter">${state.batch ? `${keyCount} 枚待提交` : "单枚 Key"}</small></label></label>`;
  const supplierForm = templateReady ? `<div class="template-summary"><div><span>固定名称前缀</span><strong>${esc(template.prefix)}</strong></div><div><span>当前自动模型</span><strong>${models.length} 个</strong></div><div><span>默认配置</span><strong>${esc(channelTypeName(template.typeId))} · ${esc(template.group)}</strong></div></div><div class="form-grid supplier-key-form"><label class="field"><span>渠道类型 <b>*</b><small class="field-help">默认已选中，可调整</small></span><select id="provider">${types.map((item) => `<option value="${item.id}" ${String(item.id) === typeId ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label><label class="field"><span>分组 <b>*</b><small class="field-help">默认已选中，可调整</small></span><select id="group">${state.metadata.groups.map((group) => `<option value="${esc(group)}" ${group === state.channelDraft.group ? "selected" : ""}>${esc(group)}</option>`).join("")}</select></label><label class="field full"><span>渠道后缀 <b>*</b><small class="field-help">最终名称由固定前缀与后缀直接拼接</small></span><div class="prefix-input"><span>${esc(template.prefix)}</span><input id="channel-suffix" value="${esc(state.channelDraft.suffix)}" maxlength="80" placeholder="例如：openai-01"></div><small class="channel-name-preview">最终渠道名：<b id="channel-name-preview">${esc(`${template.prefix}${state.channelDraft.suffix}`)}</b></small></label>${keyField}</div>` : `<div class="empty modal-empty">当前账号还没有可用的渠道默认值，请联系管理员分配类型、分组和渠道名前缀。</div>`;
  const adminForm = types.length ? `<div class="form-grid"><label class="field full"><span>类型 <b>*</b><small class="field-help">${esc(currentType?.authMethods?.join(" / ") || "上游同步")}</small></span><select id="provider">${types.map((item) => `<option value="${item.id}" ${String(item.id) === typeId ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label><label class="field"><span>折扣 <b>*</b></span><div class="number-input"><button type="button" data-step="-0.01">−</button><input id="discount" type="number" step="0.001" min="0" max="10" value="${esc(state.channelDraft.discount)}"><button type="button" data-step="0.01">+</button></div></label><label class="field"><span>渠道名称 <b>*</b></span><input id="channel-name" value="${esc(state.channelDraft.name)}" placeholder="例如：production-openai"></label>${keyField}<label class="field"><span>分组 <b>*</b></span><select id="group">${state.metadata.groups.map((group) => `<option value="${esc(group)}" ${group === state.channelDraft.group ? "selected" : ""}>${esc(group)}</option>`).join("")}</select></label><label class="field"><span>当前可选模型</span><div class="field-readout">${models.length} 个</div></label><label class="field full"><span>模型 <b>*</b><small class="field-help">按当前渠道类型自动筛选</small></span><div class="chips model-picker" id="model-chips">${models.map((model) => `<button type="button" class="chip ${selectedModels.includes(model) ? "selected" : ""}" data-model="${esc(model)}">${esc(model)} <span>×</span></button>`).join("") || `<span class="empty-inline">该类型没有可用模型，请先同步配置数据</span>`}</div><button type="button" class="outline-button" id="fill-models">${icon("check")} 全选当前模型</button></label><div class="field full"><span>高级设置</span><div class="advanced"><label class="toggle-line"><input id="auto-disable" type="checkbox" ${state.channelDraft.autoDisable ? "checked" : ""}><span>自动禁用</span><small>后续真实同步时，测试失败自动停用</small></label><div id="mapping-list">${state.mappings.map((item, index) => mappingRow(index, item)).join("")}</div><button type="button" class="text-button" id="add-mapping">${icon("plus")} 添加模型重定向</button></div></div></div>` : `<div class="empty modal-empty">还没有可用配置，请由管理员先同步配置数据。</div>`;
  const canSubmit = isSupplier ? templateReady : types.length > 0;
  return `<div class="modal-backdrop" id="modal-backdrop"><section class="modal ${isSupplier ? "supplier-modal" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div><p class="eyebrow">${isSupplier ? "UPLOAD KEY / ACCOUNT DEFAULTS" : "NEW CHANNEL / SIMULATION"}</p><h2 id="modal-title">${isSupplier ? "上传 Key" : "添加渠道"}</h2></div><button class="close-button" id="close-modal" title="关闭">${icon("close")}</button></div><div class="modal-scroll"><div class="callout simulation-callout"><span>${icon("lock")}</span><div><strong>${isSupplier ? "已载入账号默认配置" : "当前为模拟提交"}</strong><small>${isSupplier ? "类型和分组可以调整；渠道名前缀固定，模型按所选类型自动配置" : "类型、模型和分组来自上游实时配置；本次只保存到本平台，不会写入上游"}</small></div><time>${esc(formatTime(state.metadata.syncedAt))}</time></div>${isSupplier ? supplierForm : adminForm}</div><div class="modal-foot"><span><i class="secure-dot"></i> Key 不在前端留存</span><div><button class="secondary-button" id="cancel-modal">取消</button><button class="primary-button" id="submit-channel" ${canSubmit ? "" : "disabled"}>${icon("arrow")} 模拟提交</button></div></div></section></div>`;
}

function userModal() {
  const editingUser = state.users.find((item) => item.id === state.editingUserId);
  const template = editingUser?.channelTemplate;
  const typeId = String(template?.typeId || state.metadata.channelTypes[0]?.id || "");
  const group = template?.group || (state.metadata.groups.includes("default") ? "default" : state.metadata.groups[0] || "");
  const templateFields = `<div class="field full template-section" id="supplier-template-fields"><span>供应商渠道默认值</span><div class="template-form-grid"><label class="field"><span>默认渠道类型 <b>*</b></span><select id="new-channel-type">${state.metadata.channelTypes.map((item) => `<option value="${item.id}" ${String(item.id) === typeId ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label><label class="field"><span>默认分组 <b>*</b></span><select id="new-channel-group">${state.metadata.groups.map((item) => `<option value="${esc(item)}" ${item === group ? "selected" : ""}>${esc(item)}</option>`).join("")}</select></label><label class="field full"><span>固定渠道名前缀 <b>*</b><small class="field-help">建议包含分隔符，例如 supplier-001-</small></span><input id="new-channel-prefix" maxlength="80" value="${esc(template?.prefix || "")}" placeholder="例如：supplier-001-"></label></div></div>`;
  const identityFields = editingUser ? `<div class="field full"><span>供应商账号</span><div class="field-readout">${esc(editingUser.username)}</div></div>` : `<label class="field full"><span>用户名 <b>*</b></span><input id="new-username" placeholder="例如：supplier-001"></label><label class="field full"><span>初始密码 <b>*</b></span><input id="new-password" type="password" placeholder="至少 8 位"></label><label class="field full"><span>角色</span><select id="new-role"><option>供应商</option><option>管理员</option></select></label>`;
  return `<div class="modal-backdrop" id="user-modal-backdrop"><section class="modal account-modal" role="dialog" aria-modal="true"><div class="modal-head"><div><p class="eyebrow">ADMIN ONLY / ${editingUser ? "DEFAULTS" : "ACCOUNT"}</p><h2>${editingUser ? "配置渠道默认值" : "创建平台用户"}</h2></div><button class="close-button" id="close-user-modal" title="关闭">${icon("close")}</button></div><div class="modal-scroll"><div class="callout"><span>${icon("users")}</span><div><strong>${editingUser ? "调整账号默认配置" : "创建账号并分配渠道默认值"}</strong><small>供应商进入上传面板时自动选中，类型和分组仍可调整</small></div></div><div class="form-grid">${identityFields}${templateFields}</div></div><div class="modal-foot"><span><i class="secure-dot"></i> 默认配置由服务端保存</span><div><button class="secondary-button" id="cancel-user-modal">取消</button><button class="primary-button" id="submit-user" ${state.metadata.channelTypes.length && state.metadata.groups.length ? "" : "disabled"}>${icon("check")} ${editingUser ? "保存默认值" : "创建用户"}</button></div></div></section></div>`;
}
function mappingRow(index, mapping = {}) { return `<div class="mapping-row"><input value="${esc(mapping.from || "")}" placeholder="源模型" data-map-from="${index}"><span>→</span><input value="${esc(mapping.to || "")}" placeholder="目标模型" data-map-to="${index}"><button type="button" class="remove-map" data-remove-map="${index}" title="删除映射">${icon("close")}</button></div>`; }

function syncChannelDraft() {
  if (state.user?.role === "supplier") {
    state.channelDraft = { ...state.channelDraft, suffix: document.querySelector("#channel-suffix")?.value || "", keys: document.querySelector("#keys")?.value || "", group: document.querySelector("#group")?.value || state.channelDraft.group };
    return;
  }
  const provider = document.querySelector("#provider");
  if (!provider) return;
  state.channelDraft = {
    typeId: provider.value,
    name: document.querySelector("#channel-name")?.value || "",
    discount: document.querySelector("#discount")?.value || "1.000",
    keys: document.querySelector("#keys")?.value || "",
    group: document.querySelector("#group")?.value || "default",
    models: [...document.querySelectorAll(".chip.selected")].map((chip) => chip.dataset.model),
    autoDisable: document.querySelector("#auto-disable")?.checked !== false
  };
  state.mappings = state.mappings.map((_, index) => ({ from: document.querySelector(`[data-map-from="${index}"]`)?.value || "", to: document.querySelector(`[data-map-to="${index}"]`)?.value || "" }));
}

function bindEvents() {
  document.querySelector("#login-form")?.addEventListener("submit", login);
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => { state.page = button.dataset.page; state.modal = false; state.userModal = false; render(); }));
  document.querySelector("#open-modal")?.addEventListener("click", () => { state.channelDraft = newChannelDraft(); state.batch = false; state.mappings = []; state.modal = true; render(); });
  document.querySelector("#close-modal")?.addEventListener("click", closeModal); document.querySelector("#cancel-modal")?.addEventListener("click", closeModal);
  document.querySelector("#modal-backdrop")?.addEventListener("click", (event) => { if (event.target.id === "modal-backdrop") closeModal(); });
  document.querySelector("#provider")?.addEventListener("change", (event) => { syncChannelDraft(); state.channelDraft.typeId = event.target.value; state.channelDraft.models = null; render(); });
  document.querySelector("#batch")?.addEventListener("change", (event) => { syncChannelDraft(); state.batch = event.target.checked; render(); });
  document.querySelector("#keys")?.addEventListener("input", (event) => { const count = event.target.value.split(/\n+/).map((x) => x.trim()).filter(Boolean).length; document.querySelector("#key-counter").textContent = state.batch ? `${count} 枚待提交` : "单枚 Key"; });
  document.querySelectorAll("[data-step]").forEach((button) => button.addEventListener("click", () => { const input = document.querySelector("#discount"); input.value = Math.max(0, Number(input.value) + Number(button.dataset.step)).toFixed(3); }));
  document.querySelector("#fill-models")?.addEventListener("click", () => document.querySelectorAll(".chip").forEach((chip) => chip.classList.add("selected")));
  document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => chip.classList.toggle("selected")));
  document.querySelector("#add-mapping")?.addEventListener("click", () => { syncChannelDraft(); state.mappings.push({}); render(); });
  document.querySelectorAll("[data-remove-map]").forEach((button) => button.addEventListener("click", () => { syncChannelDraft(); state.mappings.splice(Number(button.dataset.removeMap), 1); render(); }));
  document.querySelector("#submit-channel")?.addEventListener("click", submitChannel);
  document.querySelector("#refresh-traffic")?.addEventListener("click", refreshTraffic);
  document.querySelector("#refresh-usage")?.addEventListener("click", refreshUsage);
  document.querySelector("#refresh-my-usage")?.addEventListener("click", refreshTraffic);
  document.querySelector("#refresh")?.addEventListener("click", () => { document.querySelector("#refresh").classList.add("spin"); refreshTraffic(); setTimeout(() => document.querySelector("#refresh")?.classList.remove("spin"), 600); });
  document.querySelector("#logout")?.addEventListener("click", logout);
  document.querySelector("#refresh-metadata")?.addEventListener("click", refreshMetadata);
  document.querySelector("#channel-suffix")?.addEventListener("input", (event) => { state.channelDraft.suffix = event.target.value; const preview = document.querySelector("#channel-name-preview"); if (preview) preview.textContent = `${state.user?.channelTemplate?.prefix || ""}${event.target.value.trim()}`; });
  document.querySelector("#open-user-modal")?.addEventListener("click", () => { state.editingUserId = null; state.userModal = true; render(); });
  document.querySelector("#close-user-modal")?.addEventListener("click", closeUserModal); document.querySelector("#cancel-user-modal")?.addEventListener("click", closeUserModal);
  document.querySelector("#new-role")?.addEventListener("change", (event) => { const fields = document.querySelector("#supplier-template-fields"); if (!fields) return; fields.hidden = event.target.value !== "供应商"; fields.querySelectorAll("input,select").forEach((input) => { input.disabled = fields.hidden; }); const submit = document.querySelector("#submit-user"); if (submit) submit.disabled = !fields.hidden && (!state.metadata.channelTypes.length || !state.metadata.groups.length); });
  document.querySelector("#submit-user")?.addEventListener("click", submitUser);
  document.querySelectorAll("[data-configure-user]").forEach((button) => button.addEventListener("click", () => { state.editingUserId = button.dataset.configureUser; state.userModal = true; render(); }));
  document.querySelectorAll("[data-toggle-user]").forEach((button) => button.addEventListener("click", () => toggleUser(button.dataset.toggleUser, button.dataset.userActive === "true")));
}

async function apiRequest(path, options = {}) { const response = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.message || "请求失败"); return payload; }
async function login(event) { event.preventDefault(); state.loginError = ""; try { const payload = await apiRequest("/api/auth/login", { method: "POST", body: JSON.stringify({ username: document.querySelector("#login-username").value, password: document.querySelector("#login-password").value }) }); state.user = payload.user; if (state.user.role === "supplier") state.page = "mykeys"; await loadRemoteData(); render(); } catch (error) { state.loginError = error instanceof Error ? error.message : "登录失败"; render(); } }
async function logout() { try { await apiRequest("/api/auth/logout", { method: "POST", body: "{}" }); } finally { state.user = null; state.channels = []; state.keys = []; state.page = "overview"; state.modal = false; state.userModal = false; render(); } }
async function loadRemoteData() { const [channels, keys, metrics, metadata] = await Promise.all([apiRequest("/api/channels"), apiRequest("/api/keys"), apiRequest("/api/metrics"), apiRequest("/api/metadata")]); state.channels = channels.items.map((item) => ({ ...item, id: item.id, amount: Number(item.usageUsd || 0), latency: 0, createdAt: formatTime(item.createdAt), updatedAt: "刚刚", models: item.models || [], keyCount: Number(item.keyCount || 0) })); state.keys = keys.items; state.traffic = { rpm: Number(metrics.rpm || 0), tpm: Number(metrics.tpm || 0) }; state.usageUpdated = metrics.sampledAt ? new Date(metrics.sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) : state.usageUpdated; state.metadata = metadata; if (state.user?.role === "admin") { const users = await apiRequest("/api/admin/users"); state.users = users.items.map((item) => ({ ...item, keys: Number(item.keys || 0), createdAt: formatTime(item.created_at || item.createdAt) })); } }
async function refreshMetadata() { try { const button = document.querySelector("#refresh-metadata"); button?.classList.add("syncing"); state.metadata = await apiRequest("/api/admin/metadata/refresh", { method: "POST", body: "{}" }); state.channelDraft = newChannelDraft(); render(); toast(`配置同步完成：${state.metadata.channelTypes.length} 种类型，${state.metadata.groups.length} 个分组`); } catch (error) { toast(error instanceof Error ? error.message : "配置同步失败"); } }
async function refreshTraffic() { if (state.apiMode) { try { const metrics = await apiRequest("/api/metrics/refresh", { method: "POST", body: "{}" }); state.traffic = { rpm: Number(metrics.rpm || 0), tpm: Number(metrics.tpm || 0) }; state.usageUpdated = metrics.sampledAt ? new Date(metrics.sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) : state.usageUpdated; render(); toast(metrics.throttled ? "刷新过于频繁，已显示最新平台数据" : "平台 RPM / TPM 已刷新"); } catch (error) { toast(error instanceof Error ? error.message : "刷新失败"); } return; } state.traffic.rpm = Math.round(state.traffic.rpm * (0.96 + Math.random() * 0.08)); state.traffic.tpm = Math.round(state.traffic.tpm * (0.96 + Math.random() * 0.08)); state.usageUpdated = new Date().toLocaleTimeString("zh-CN", { hour12: false }); render(); toast("RPM / TPM 已刷新"); }
async function refreshUsage() { if (state.apiMode) { try { await loadRemoteData(); render(); toast("使用统计已刷新"); } catch (error) { toast(error instanceof Error ? error.message : "刷新失败"); } return; } state.usageUpdated = new Date().toLocaleTimeString("zh-CN", { hour12: false }); state.channels.forEach((item) => { item.amount = Number((item.amount * (0.99 + Math.random() * 0.02)).toFixed(3)); item.latency = Math.max(80, item.latency + Math.round(Math.random() * 20 - 10)); }); render(); toast("使用统计已刷新"); }
function closeModal() { state.modal = false; state.mappings = []; state.channelDraft = newChannelDraft(); render(); }
function closeUserModal() { state.userModal = false; state.editingUserId = null; render(); }
function toast(message) { const item = document.createElement("div"); item.className = "toast"; item.textContent = message; document.body.append(item); setTimeout(() => item.remove(), 2400); }
async function submitChannel() {
  const keys = document.querySelector("#keys")?.value.split(/\n+/).map((item) => item.trim()).filter(Boolean) || [];
  if (state.user?.role === "supplier") {
    const suffix = document.querySelector("#channel-suffix")?.value.trim() || "";
    if (!state.user.channelTemplate) { toast("管理员尚未给当前账号分配渠道模板"); return; }
    if (!suffix || !keys.length) { toast("请填写渠道后缀和至少一枚 Key"); return; }
    try {
      const result = await apiRequest("/api/channels", { method: "POST", body: JSON.stringify({ suffix, keys, typeId: Number(document.querySelector("#provider").value), group: document.querySelector("#group").value }) });
      await loadRemoteData();
      closeModal();
      toast(`模拟提交成功：${result.name}`);
    } catch (error) { toast(error instanceof Error ? error.message : "模拟提交失败"); }
    return;
  }
  const name = document.querySelector("#channel-name").value.trim();
  const models = [...document.querySelectorAll(".chip.selected")].map((chip) => chip.dataset.model);
  if (!name || !keys.length || !models.length) { toast("请填写渠道名称、Key，并至少选择一个模型"); return; }
  const typeId = Number(document.querySelector("#provider").value);
  const channelType = state.metadata.channelTypes.find((item) => item.id === typeId);
  const modelMapping = Object.fromEntries(state.mappings.map((_, index) => [document.querySelector(`[data-map-from="${index}"]`)?.value.trim(), document.querySelector(`[data-map-to="${index}"]`)?.value.trim()]).filter(([from, to]) => from && to));
  if (state.apiMode) {
    try {
      const result = await apiRequest("/api/channels", { method: "POST", body: JSON.stringify({ name, typeId, models, keys, group: document.querySelector("#group").value, discount: Number(document.querySelector("#discount").value), autoDisable: document.querySelector("#auto-disable").checked, modelMapping }) });
      await loadRemoteData(); closeModal(); toast(result.upstreamSubmitted ? "渠道已同步" : "模拟提交成功，未写入上游");
    } catch (error) { toast(error instanceof Error ? error.message : "模拟提交失败"); }
    return;
  }
  const channel = { id: `local-${Date.now().toString().slice(-5)}`, name, provider: channelType?.name || "未知类型", models, group: document.querySelector("#group").value || "default", discount: Number(document.querySelector("#discount").value).toFixed(3).replace(/0+$/, "").replace(/\.$/, ""), state: "模拟记录", keyCount: keys.length, updatedAt: "刚刚", amount: 0, latency: 0, createdAt: new Date().toLocaleString("zh-CN", { hour12: false }) };
  state.channels.unshift(channel); localStorage.setItem("qushu-channels", JSON.stringify(state.channels)); closeModal(); render(); toast("模拟提交成功，未写入上游");
}
async function submitUser() {
  const channelTypeId = Number(document.querySelector("#new-channel-type")?.value);
  const channelGroup = document.querySelector("#new-channel-group")?.value || "";
  const channelNamePrefix = document.querySelector("#new-channel-prefix")?.value.trim() || "";
  if (state.editingUserId) {
    if (!channelTypeId || !channelGroup || !channelNamePrefix) { toast("请选择类型和分组，并填写渠道名前缀"); return; }
    try {
      await apiRequest(`/api/admin/users/${encodeURIComponent(state.editingUserId)}/template`, { method: "POST", body: JSON.stringify({ channelTypeId, channelGroup, channelNamePrefix }) });
      await loadRemoteData(); closeUserModal(); toast("渠道模板已更新");
    } catch (error) { toast(error instanceof Error ? error.message : "保存失败"); }
    return;
  }
  const username = document.querySelector("#new-username").value.trim();
  const password = document.querySelector("#new-password").value;
  const role = document.querySelector("#new-role").value;
  if (!username || password.length < 8) { toast("用户名不能为空，密码至少需要 8 位"); return; }
  if (role === "供应商" && (!channelTypeId || !channelGroup || !channelNamePrefix)) { toast("请为供应商选择类型、分组并填写渠道名前缀"); return; }
  if (state.apiMode) {
    try {
      await apiRequest("/api/admin/users", { method: "POST", body: JSON.stringify({ username, password, role, channelTypeId, channelGroup, channelNamePrefix }) });
      await loadRemoteData(); closeUserModal(); toast("用户创建成功");
    } catch (error) { toast(error instanceof Error ? error.message : "创建失败"); }
    return;
  }
  if (state.users.some((user) => user.username === username)) { toast("用户名已存在"); return; }
  state.users.push({ username, role, channelTemplate: role === "供应商" ? { typeId: channelTypeId, group: channelGroup, prefix: channelNamePrefix } : null, status: "正常", createdAt: new Date().toLocaleString("zh-CN", { hour12: false }), keys: 0 });
  localStorage.setItem("qushu-users", JSON.stringify(state.users)); closeUserModal(); toast("用户创建成功");
}
async function toggleUser(id, isActive) { if (state.apiMode) { try { await apiRequest(`/api/admin/users/${encodeURIComponent(id)}/status`, { method: "POST", body: JSON.stringify({ isActive: !isActive }) }); await loadRemoteData(); render(); toast(`用户已${isActive ? "停用" : "启用"}`); } catch (error) { toast(error instanceof Error ? error.message : "操作失败"); } return; } const user = state.users.find((item) => item.id === id); if (user) { user.status = isActive ? "已停用" : "正常"; localStorage.setItem("qushu-users", JSON.stringify(state.users)); render(); } }

render();
if (state.apiMode) bootstrap();

async function bootstrap() { try { state.user = (await apiRequest("/api/auth/me")).user; if (state.user.role === "supplier" && state.page === "overview") state.page = "mykeys"; await loadRemoteData(); } catch { state.user = null; } finally { state.booting = false; render(); } }
