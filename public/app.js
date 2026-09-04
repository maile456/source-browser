const SETTINGS_KEY = "source-browser-settings-v2";

const state = {
  current: 1,
  pageSize: 20,
  pages: 1,
  allPages: false,
  total: 0,
  loadedPages: 0,
  list: [],
  loading: false,
  localPage: 1,
  localPageSize: 50,
  currentJobId: "",
  pollTimer: null,
  queryStartedAt: 0,
  lastSuccessAt: 0,
  lastError: ""
};

const loginPanel = document.querySelector("#loginPanel");
const workbench = document.querySelector("#workbench");
const loginForm = document.querySelector("#loginForm");
const searchForm = document.querySelector("#searchForm");
const resultBody = document.querySelector("#resultBody");
const summaryText = document.querySelector("#summaryText");
const pageText = document.querySelector("#pageText");
const prevPage = document.querySelector("#prevPage");
const nextPage = document.querySelector("#nextPage");
const toast = document.querySelector("#toast");
const accountText = document.querySelector("#accountText");
const logoutButton = document.querySelector("#logoutButton");
const cancelSearch = document.querySelector("#cancelSearch");
const progressPanel = document.querySelector("#progressPanel");
const progressText = document.querySelector("#progressText");
const progressMeta = document.querySelector("#progressMeta");
const progressBar = document.querySelector("#progressBar");
const localPageSize = document.querySelector("#localPageSize");

const settingFields = [
  "loginPlatform",
  "keywords",
  "goodsType",
  "pageSize",
  "pages",
  "sortMode",
  "availabilityFilter",
  "minPrice",
  "maxPrice",
  "blockKeywords",
  "localPageSize"
];

function showToast(message, isError = true) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message || `请求失败：HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `￥${number.toFixed(2)}`;
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function getDetailLink(item) {
  if (item.link) return item.link;
  const key = item.goods_key || item.key;
  const baseUrl = item.platform_base_url || "https://wzyp.cn";
  return key ? `${baseUrl}/item/${encodeURIComponent(key)}` : "";
}

function getShopName(item) {
  return item.user && item.user.nickname ? item.user.nickname : "";
}

function getStock(item) {
  const value = Number(item.stock_count ?? item.stock ?? item.count ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function getPrice(item) {
  const value = Number(item.price ?? item.real_price ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function getPriceBounds() {
  const minValue = document.querySelector("#minPrice").value;
  const maxValue = document.querySelector("#maxPrice").value;
  const min = minValue === "" ? null : Number(minValue);
  const max = maxValue === "" ? null : Number(maxValue);

  return {
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null
  };
}

function getBlockedKeywords() {
  return document.querySelector("#blockKeywords").value
    .split(/[,，\n]/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function isListed(item) {
  return Number(item.status) === 1;
}

function isVerified(item) {
  return item.verify === undefined || Number(item.verify) === 1;
}

function isAvailable(item) {
  return isListed(item) && isVerified(item) && getStock(item) > 0;
}

function getStatusBadge(item) {
  if (!isVerified(item)) return '<span class="badge muted">未审核</span>';
  if (!isListed(item)) return '<span class="badge offline">未上架</span>';
  if (getStock(item) <= 0) return '<span class="badge empty-stock">缺货</span>';
  return '<span class="badge ok">可售</span>';
}

function filterResults(list) {
  const mode = document.querySelector("#availabilityFilter").value;
  const { min, max } = getPriceBounds();
  const blocked = getBlockedKeywords();

  return list.filter(item => {
    const price = getPrice(item);
    const name = String(item.name || "").toLowerCase();

    if (mode === "available" && !isAvailable(item)) return false;
    if (mode === "listed" && !(isListed(item) && isVerified(item))) return false;
    if (min !== null && price < min) return false;
    if (max !== null && price > max) return false;
    if (blocked.some(keyword => name.includes(keyword))) return false;
    return true;
  });
}

function prepareResults(list) {
  const filtered = filterResults(list);
  const mode = document.querySelector("#sortMode").value;
  return [...filtered].sort((a, b) => {
    const stockA = getStock(a);
    const stockB = getStock(b);
    const priceA = getPrice(a);
    const priceB = getPrice(b);

    if (mode.startsWith("stock") && Boolean(stockA) !== Boolean(stockB)) {
      return stockB - stockA;
    }

    if (mode.endsWith("desc")) return priceB - priceA;
    return priceA - priceB;
  });
}

function getVisibleResults() {
  const rows = prepareResults(state.list);
  const totalPages = Math.max(1, Math.ceil(rows.length / state.localPageSize));
  state.localPage = Math.min(Math.max(1, state.localPage), totalPages);
  const start = (state.localPage - 1) * state.localPageSize;
  return {
    allRows: rows,
    rows: rows.slice(start, start + state.localPageSize),
    totalPages
  };
}

function renderTable() {
  const { rows } = getVisibleResults();
  if (!rows.length) {
    resultBody.innerHTML = '<tr><td colspan="6" class="empty">暂无结果</td></tr>';
    updateSummary();
    return;
  }

  resultBody.innerHTML = rows.map(item => {
    const stock = getStock(item);
    const status = getStatusBadge(item);
    const key = item.goods_key || item.key || "-";
    const type = item.goods_type ? `类型：${escapeHtml(item.goods_type)}` : "";
    const detailLink = getDetailLink(item);
    const safeLink = escapeHtml(detailLink);
    const name = escapeHtml(item.name || "未命名货源");
    const keyHtml = detailLink
      ? `<a class="key-link" href="${safeLink}" target="_blank" rel="noopener noreferrer">${escapeHtml(key)}</a>`
      : escapeHtml(key);
    const actionHtml = detailLink
      ? `<a class="detail-link" href="${safeLink}" target="_blank" rel="noopener noreferrer">打开</a>`
      : "-";
    return `
      <tr>
        <td>
          <div class="goods-name">${detailLink
            ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer">${name}</a>`
            : name}</div>
          <div class="goods-meta">${type}${getShopName(item) ? ` · 店铺：${escapeHtml(getShopName(item))}` : ""}</div>
        </td>
        <td>${status}</td>
        <td>${stock}</td>
        <td class="price">${formatPrice(getPrice(item))}</td>
        <td>${keyHtml}</td>
        <td>${actionHtml}</td>
      </tr>
    `;
  }).join("");
  updateSummary();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function updateSummary() {
  const { allRows, totalPages } = getVisibleResults();
  const dataTime = state.lastSuccessAt ? `，数据时间 ${formatTime(state.lastSuccessAt)}` : "";
  const errorText = state.lastError ? `，上次失败：${state.lastError}` : "";

  summaryText.textContent = state.total
    ? `共 ${state.total} 条，已加载 ${state.list.length} 条，当前显示 ${allRows.length} 条${dataTime}${errorText}`
    : state.lastError
    ? `查询失败：${state.lastError}`
    : "未查询到匹配货源";

  pageText.textContent = `第 ${state.localPage} / ${totalPages} 页`;
  prevPage.disabled = state.loading || state.localPage <= 1;
  nextPage.disabled = state.loading || state.localPage >= totalPages;
}

function setLoading(loading) {
  state.loading = loading;
  document.querySelectorAll("button").forEach(button => {
    if (button.id !== "logoutButton" && button.id !== "cancelSearch") button.disabled = loading;
  });
  cancelSearch.classList.toggle("hidden", !loading);
  updateSummary();
}

function showProgress(visible) {
  progressPanel.classList.toggle("hidden", !visible);
}

function updateProgress(job) {
  showProgress(true);
  const totalPages = Number(job.totalPages || 0);
  const loadedPages = Number(job.loadedPages || 0);
  const percent = totalPages ? Math.min(100, Math.round((loadedPages / totalPages) * 100)) : 8;
  const elapsed = Math.max(1, Math.round((Date.now() - state.queryStartedAt) / 1000));
  const eta = totalPages && loadedPages
    ? Math.max(0, Math.round(((totalPages - loadedPages) * elapsed) / loadedPages))
    : null;

  progressBar.style.width = `${percent}%`;
  progressText.textContent = totalPages
    ? `正在拉取第 ${loadedPages} / ${totalPages} 页`
    : "正在获取总页数";
  progressMeta.textContent = `已加载 ${job.loaded || 0} / ${job.total || 0} 条${eta === null ? "" : `，预计 ${eta} 秒`}`;
}

function resetProgress() {
  progressBar.style.width = "0%";
  progressText.textContent = "准备查询";
  progressMeta.textContent = "";
  showProgress(false);
}

function collectSearchPayload(page = 1) {
  const pagesValue = document.querySelector("#pages").value || "1";
  state.allPages = pagesValue === "all";
  state.pages = state.allPages ? 1 : Number(pagesValue);
  state.current = state.allPages ? 1 : page;
  state.pageSize = Number(document.querySelector("#pageSize").value || 20);

  return {
    current: state.current,
    pageSize: state.pageSize,
    pages: state.allPages ? "all" : state.pages,
    keywords: document.querySelector("#keywords").value.trim(),
    goods_type: document.querySelector("#goodsType").value
  };
}

async function pollSearchJob(jobId) {
  const job = await api(`/api/search/status?id=${encodeURIComponent(jobId)}`);
  if (state.currentJobId !== jobId) return;

  updateProgress(job);

  if (job.status === "running") {
    state.pollTimer = window.setTimeout(() => pollSearchJob(jobId).catch(handleSearchError), 600);
    return;
  }

  state.currentJobId = "";
  setLoading(false);
  if (job.status === "done" && job.result) {
    state.total = job.result.total || 0;
    state.loadedPages = job.result.loadedPages || 0;
    state.list = Array.isArray(job.result.list) ? job.result.list : [];
    state.localPage = 1;
    state.lastSuccessAt = Date.now();
    state.lastError = "";
    renderTable();
    progressBar.style.width = "100%";
    progressText.textContent = "查询完成";
    progressMeta.textContent = `已加载 ${state.list.length} 条`;
    window.setTimeout(() => showProgress(false), 900);
    return;
  }

  const message = job.error || "查询失败";
  state.lastError = message;
  showToast(message);
  updateSummary();
  resetProgress();
}

function handleSearchError(error) {
  state.currentJobId = "";
  state.lastError = error.message;
  setLoading(false);
  showToast(error.message);
    if (!state.list.length) {
      resultBody.innerHTML = '<tr><td colspan="6" class="empty">查询失败</td></tr>';
  }
  if (error.status === 401 || /请先登录|登录/.test(error.message)) {
    showLogin();
  } else {
    updateSummary();
  }
  resetProgress();
}

async function search(page = 1) {
  saveSettings();
  state.lastError = "";
  state.queryStartedAt = Date.now();
  window.clearTimeout(state.pollTimer);
  resetProgress();
  setLoading(true);
  showProgress(true);
  progressText.textContent = "正在创建查询任务";
  progressMeta.textContent = "";

  try {
    const started = await api("/api/search/start", {
      method: "POST",
      body: JSON.stringify(collectSearchPayload(page))
    });
    state.currentJobId = started.jobId;
    await pollSearchJob(started.jobId);
  } catch (error) {
    handleSearchError(error);
  }
}

async function cancelCurrentSearch() {
  if (!state.currentJobId) return;
  const jobId = state.currentJobId;
  state.currentJobId = "";
  window.clearTimeout(state.pollTimer);
  try {
    await api("/api/search/cancel", {
      method: "POST",
      body: JSON.stringify({ jobId })
    });
  } catch {
    // The next status poll or timeout will resolve the visible state.
  }
  state.lastError = "查询已取消，结果未更新";
  setLoading(false);
  showToast(state.lastError);
  updateSummary();
  resetProgress();
}

function showWorkbench(data = {}) {
  const platformName = data.platformName || "链动小店";
  accountText.textContent = `已登录 · ${platformName}`;
  const loginPlatform = document.querySelector("#loginPlatform");
  if (loginPlatform && data.platform) {
    loginPlatform.value = data.platform;
    saveSettings();
  }
  loginPanel.classList.add("hidden");
  workbench.classList.remove("hidden");
}

function showLogin() {
  window.clearTimeout(state.pollTimer);
  state.currentJobId = "";
  setLoading(false);
  resetProgress();
  workbench.classList.add("hidden");
  loginPanel.classList.remove("hidden");
  state.total = 0;
  state.list = [];
  state.current = 1;
  state.localPage = 1;
  updateSummary();
}

function saveSettings() {
  const settings = {};
  for (const id of settingFields) {
    const element = document.querySelector(`#${id}`);
    if (element) settings[id] = element.value;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadSettings() {
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    settings = {};
  }

  for (const id of settingFields) {
    const element = document.querySelector(`#${id}`);
    if (element && settings[id] !== undefined) {
      element.value = settings[id];
    }
  }
  state.localPageSize = Number(localPageSize.value || 50);
}

function bindSettingMemory() {
  for (const id of settingFields) {
    const element = document.querySelector(`#${id}`);
    if (!element) continue;
    element.addEventListener("change", saveSettings);
    element.addEventListener("input", saveSettings);
  }
}

function rerenderFromFilters() {
  state.localPage = 1;
  saveSettings();
  renderTable();
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  const username = String(formData.get("username") || "").trim();
  const password = String(formData.get("password") || "");
  const platform = String(formData.get("platform") || "ldxp");

  setLoading(true);
  try {
    const loginData = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password, platform })
    });
    showWorkbench(loginData);
    await search(1);
  } catch (error) {
    showToast(error.message);
  } finally {
    if (!state.currentJobId) setLoading(false);
  }
});

searchForm.addEventListener("submit", event => {
  event.preventDefault();
  search(1);
});

document.querySelector("#sortMode").addEventListener("change", rerenderFromFilters);
document.querySelector("#availabilityFilter").addEventListener("change", rerenderFromFilters);
document.querySelector("#minPrice").addEventListener("input", rerenderFromFilters);
document.querySelector("#maxPrice").addEventListener("input", rerenderFromFilters);
document.querySelector("#blockKeywords").addEventListener("input", rerenderFromFilters);
localPageSize.addEventListener("change", () => {
  state.localPageSize = Number(localPageSize.value || 50);
  state.localPage = 1;
  saveSettings();
  renderTable();
});
prevPage.addEventListener("click", () => {
  state.localPage = Math.max(1, state.localPage - 1);
  renderTable();
});
nextPage.addEventListener("click", () => {
  state.localPage += 1;
  renderTable();
});
cancelSearch.addEventListener("click", cancelCurrentSearch);

logoutButton.addEventListener("click", async () => {
  try {
    if (state.currentJobId) await cancelCurrentSearch();
    await api("/api/logout", { method: "POST", body: "{}" });
  } finally {
    showLogin();
  }
});

loadSettings();
bindSettingMemory();
api("/api/me")
  .then(data => {
    showWorkbench(data);
  })
  .catch(() => showLogin());
