const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const SESSION_FILE = path.join(DATA_DIR, "sessions.json");
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE = Math.floor(SESSION_MAX_AGE_MS / 1000);
const REMOTE_RETRY_COUNT = 3;
const FULL_PAGE_DELAY_MS = 1000;
const SEARCH_JOB_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();
const searchJobs = new Map();

const PLATFORMS = {
  ldxp: {
    id: "ldxp",
    name: "链动小店",
    baseUrl: process.env.LDXP_BASE_URL || process.env.SOURCE_BASE_URL || "https://wzyp.cn"
  },
  catfk: {
    id: "catfk",
    name: "云猫寄售",
    baseUrl: process.env.CATFK_BASE_URL || "https://catfk.com"
  }
};

function getPlatform(platformId) {
  return PLATFORMS[platformId] || PLATFORMS.ldxp;
}

function normalizePlatformId(value) {
  const id = String(value || "ldxp").trim();
  return PLATFORMS[id] ? id : "ldxp";
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function normalizeSession(session) {
  if (!session || !session.token || !session.username) return null;

  const createdAt = Number(session.createdAt || Date.now());
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > SESSION_MAX_AGE_MS) {
    return null;
  }

  return {
    platformId: normalizePlatformId(session.platformId),
    token: String(session.token),
    remoteCookies: session.remoteCookies && typeof session.remoteCookies === "object"
      ? session.remoteCookies
      : {},
    username: String(session.username),
    displayName: session.displayName ? String(session.displayName) : String(session.username),
    createdAt
  };
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    const saved = JSON.parse(raw);
    for (const [sid, session] of Object.entries(saved.sessions || {})) {
      const normalized = normalizeSession(session);
      if (normalized) sessions.set(sid, normalized);
    }
  } catch (error) {
    console.warn(`读取本地会话失败：${error.message}`);
  }
}

function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      sessions: Object.fromEntries(sessions)
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn(`保存本地会话失败：${error.message}`);
  }
}

function pruneSessions() {
  let changed = false;
  for (const [sid, session] of sessions) {
    if (!normalizeSession(session)) {
      sessions.delete(sid);
      changed = true;
    }
  }
  if (changed) saveSessions();
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, part) => {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) return cookies;
    cookies[name] = decodeURIComponent(valueParts.join("="));
    return cookies;
  }, {});
}

function getSession(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const session = normalizeSession(sessions.get(sid));
  if (!session) {
    sessions.delete(sid);
    saveSessions();
    return null;
  }
  sessions.set(sid, session);
  return session;
}

function splitSetCookieHeader(headerValue) {
  if (!headerValue) return [];
  return headerValue.split(/,(?=\s*[^;,=\s]+=[^;,]+)/).map(value => value.trim()).filter(Boolean);
}

function collectSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  return splitSetCookieHeader(headers.get("set-cookie"));
}

function storeRemoteCookies(session, responseHeaders) {
  const setCookies = collectSetCookies(responseHeaders);
  for (const setCookie of setCookies) {
    const [pair, ...attributes] = setCookie.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const shouldDelete = attributes.some(attr => {
      const normalized = attr.trim().toLowerCase();
      return normalized === "max-age=0" || normalized.startsWith("expires=thu, 01 jan 1970");
    });

    if (shouldDelete) {
      delete session.remoteCookies[name];
    } else {
      session.remoteCookies[name] = value;
    }
  }
}

function buildRemoteCookieHeader(session) {
  if (!session) return "";

  const cookies = { ...(session.remoteCookies || {}) };
  if (session.token) cookies["merchant-token"] = session.token;

  return Object.entries(cookies)
    .filter(([name, value]) => name && value !== undefined && value !== null && value !== "")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RemoteHttpError extends Error {
  constructor(message, status, data, retryable = false) {
    super(message);
    this.name = "RemoteHttpError";
    this.status = status;
    this.data = data;
    this.retryable = retryable;
  }
}

class SearchCancelledError extends Error {
  constructor() {
    super("查询已取消，结果未更新");
    this.name = "SearchCancelledError";
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("请求 JSON 格式不正确"));
      }
    });
    req.on("error", reject);
  });
}

async function postRemote(endpoint, payload, session, refererPath, options = {}) {
  const platform = getPlatform(session && session.platformId);
  const retries = Number(options.retries ?? REMOTE_RETRY_COUNT);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Origin": platform.baseUrl,
        "Referer": `${platform.baseUrl}${refererPath || "/merchant/login"}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      };

      if (session && session.token) {
        headers["Merchant-Token"] = session.token;
        headers.Authorization = `Bearer ${session.token}`;
      }

      const cookieHeader = buildRemoteCookieHeader(session);
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      const response = await fetch(`${platform.baseUrl}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload || {})
      });

      if (session) {
        storeRemoteCookies(session, response.headers);
      }

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const contentType = response.headers.get("content-type") || "";
        const isHtml = contentType.includes("text/html") || /^\s*<(?:!doctype\s+html|html)/i.test(text);
        const message = isHtml
          ? `远端返回网页防护或登录页面，HTTP ${response.status}`
          : `远端返回非 JSON 内容，HTTP ${response.status}`;
        throw new RemoteHttpError(message, response.status, { contentType }, isHtml);
      }

      if (!response.ok) {
        throw new RemoteHttpError(data.msg || `远端 HTTP ${response.status}`, response.status, data);
      }

      return data;
    } catch (error) {
      lastError = error;
      const status = Number(error.status || 0);
      const retryable = error.retryable || status >= 500 || status === 0;
      if (!retryable || attempt >= retries) break;
      const delayMs = error.retryable
        ? 3000 * (2 ** attempt)
        : 400 * (attempt + 1);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function handleLogin(req, res) {
  const { username, password, platform: requestedPlatform } = await readRequestBody(req);
  if (!username || !password) {
    return sendJson(res, 400, { ok: false, message: "请输入用户名和密码" });
  }

  const platformId = normalizePlatformId(requestedPlatform);
  const platform = getPlatform(platformId);
  const payload = { username, password };
  const remoteSession = {
    platformId,
    token: "",
    remoteCookies: {},
    username,
    displayName: username,
    createdAt: Date.now()
  };

  await postRemote("/merchantApi/system/config", {}, remoteSession, "/merchant/");

  const safe = await postRemote("/merchantApi/user/checkSafeMode", payload, remoteSession, "/merchant/login");
  if (safe.code !== 1) {
    return sendJson(res, 401, { ok: false, message: `安全模式检查失败：${safe.msg || "未知错误"}` });
  }

  const safeMode = safe.data && Number(safe.data.safe_mode);
  if (safeMode) {
    return sendJson(res, 409, { ok: false, message: "该账号需要安全验证，当前版本暂未实现验证码流程" });
  }

  const login = await postRemote("/merchantApi/user/login", payload, remoteSession, "/merchant/login");
  if (login.code !== 1 || !login.data || !login.data.merchant_token) {
    return sendJson(res, 401, { ok: false, message: `登录失败：${login.msg || "未知错误"}` });
  }

  remoteSession.token = login.data.merchant_token;
  remoteSession.remoteCookies["merchant-token"] = remoteSession.token;

  let displayName = username;
  try {
    const userinfo = await postRemote("/merchantApi/user/userinfo", {}, remoteSession, "/merchant/login");
    if (userinfo.code === 1 && userinfo.data) {
      displayName = userinfo.data.nickname || userinfo.data.username || username;
      remoteSession.username = userinfo.data.username || username;
      remoteSession.displayName = displayName;
    }
  } catch {
    // userinfo is useful for display, but the merchant_token is the actual API credential.
  }

  const sid = crypto.randomUUID();
  sessions.set(sid, remoteSession);
  saveSessions();

  sendJson(res, 200, {
    ok: true,
    username: remoteSession.username,
    displayName,
    platform: platform.id,
    platformName: platform.name
  }, {
    "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}`
  });
}

async function handleMe(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { ok: false });
  const platform = getPlatform(session.platformId);
  sendJson(res, 200, {
    ok: true,
    username: session.username,
    displayName: session.displayName || session.username,
    platform: platform.id,
    platformName: platform.name
  });
}

async function handleLogout(req, res) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) {
    sessions.delete(sid);
    saveSessions();
  }
  sendJson(res, 200, { ok: true }, {
    "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  });
}

function normalizeSearchBody(body) {
  const current = Math.max(1, Number(body.current || 1));
  const requestedPages = String(body.pages || 1);
  const fetchAllPages = requestedPages === "all";
  const requestedPageSize = Math.min(100, Math.max(1, Number(body.pageSize || 20)));
  const pageSize = fetchAllPages ? 100 : requestedPageSize;
  let pages = fetchAllPages ? 1 : Math.max(1, Number(requestedPages || 1));
  const keywords = String(body.keywords || "").trim();
  const goodsType = String(body.goods_type || "card").trim() || "card";

  return { current, pageSize, requestedPages, fetchAllPages, pages, keywords, goodsType };
}

function normalizeGoodsItem(item, platform) {
  const goodsKey = item.goods_key || item.key || "";
  return {
    ...item,
    goods_key: goodsKey || item.goods_key,
    platform_id: platform.id,
    platform_name: platform.name,
    platform_base_url: platform.baseUrl,
    link: item.link || (goodsKey ? `${platform.baseUrl}/item/${encodeURIComponent(goodsKey)}` : "")
  };
}

async function fetchSearchResults(session, params, job = null) {
  let { current, pageSize, fetchAllPages, pages, keywords, goodsType } = params;
  const platform = getPlatform(session.platformId);
  let total = 0;
  const list = [];

  for (let pageOffset = 0; pageOffset < pages; pageOffset += 1) {
    if (job && job.cancelled) throw new SearchCancelledError();

    const page = fetchAllPages ? pageOffset + 1 : current + pageOffset;
    let data;
    try {
      data = await postRemote(
        "/merchantApi/MyParent/searchGoodsList",
        {
          current: page,
          pageSize,
          name: "",
          goods_type: goodsType,
          keywords
        },
        session,
        "/merchant/my_parent/source_square"
      );
    } catch (error) {
      const message = error && error.message ? error.message : "未知错误";
      throw new Error(`远端第 ${page} 页请求失败：${message}`);
    }

    if (job && job.cancelled) throw new SearchCancelledError();

    if (data.code !== 1) {
      throw new Error(`远端第 ${page} 页返回失败：${data.msg || "货源查询失败"}`);
    }

    if (pageOffset === 0) {
      total = Number(data.data && data.data.total) || 0;
      if (fetchAllPages) {
        pages = Math.max(1, Math.ceil(total / pageSize));
      }
      if (job) {
        job.total = total;
        job.totalPages = pages;
      }
    }

    const pageList = Array.isArray(data.data && data.data.list)
      ? data.data.list.map(item => normalizeGoodsItem(item, platform))
      : [];
    list.push(...pageList);
    if (job) {
      job.loaded = list.length;
      job.currentPage = page;
      job.loadedPages = pageOffset + 1;
      job.updatedAt = Date.now();
    }

    if (!pageList.length || list.length >= total) break;
    if (fetchAllPages && pageOffset + 1 < pages) {
      await sleep(FULL_PAGE_DELAY_MS);
    }
  }

  saveSessions();
  return {
    ok: true,
    total,
    loaded: list.length,
    loadedPages: pages,
    list
  };
}

async function handleSearch(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { ok: false, message: "请先登录" });

  const body = await readRequestBody(req);
  const params = normalizeSearchBody(body);
  const result = await fetchSearchResults(session, params);
  sendJson(res, 200, result);
}

function pruneSearchJobs() {
  const now = Date.now();
  for (const [id, job] of searchJobs) {
    const finished = ["done", "failed", "cancelled"].includes(job.status);
    if (finished && now - job.updatedAt > SEARCH_JOB_TTL_MS) {
      searchJobs.delete(id);
    }
  }
}

async function handleSearchStart(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { ok: false, message: "请先登录" });

  pruneSearchJobs();
  const body = await readRequestBody(req);
  const params = normalizeSearchBody(body);
  const id = crypto.randomUUID();
  const now = Date.now();
  const job = {
    id,
    status: "running",
    cancelled: false,
    startedAt: now,
    updatedAt: now,
    currentPage: 0,
    loadedPages: 0,
    totalPages: params.fetchAllPages ? 0 : params.pages,
    loaded: 0,
    total: 0,
    result: null,
    error: ""
  };

  searchJobs.set(id, job);
  fetchSearchResults(session, params, job)
    .then(result => {
      if (job.cancelled) {
        job.status = "cancelled";
        job.error = "查询已取消，结果未更新";
      } else {
        job.status = "done";
        job.result = result;
        job.loaded = result.loaded;
        job.total = result.total;
      }
      job.updatedAt = Date.now();
    })
    .catch(error => {
      job.status = error instanceof SearchCancelledError ? "cancelled" : "failed";
      job.error = error.message || "查询失败";
      job.updatedAt = Date.now();
    });

  sendJson(res, 200, { ok: true, jobId: id });
}

async function handleSearchStatus(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { ok: false, message: "请先登录" });

  const url = new URL(req.url, "http://localhost");
  const id = url.searchParams.get("id");
  const job = id ? searchJobs.get(id) : null;
  if (!job) return sendJson(res, 404, { ok: false, message: "查询任务不存在或已过期" });

  sendJson(res, 200, {
    ok: true,
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    currentPage: job.currentPage,
    loadedPages: job.loadedPages,
    totalPages: job.totalPages,
    loaded: job.loaded,
    total: job.total,
    error: job.error,
    result: job.status === "done" ? job.result : null
  });
}

async function handleSearchCancel(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { ok: false, message: "请先登录" });

  const body = await readRequestBody(req);
  const job = body.jobId ? searchJobs.get(body.jobId) : null;
  if (!job) return sendJson(res, 404, { ok: false, message: "查询任务不存在或已过期" });

  job.cancelled = true;
  job.updatedAt = Date.now();
  sendJson(res, 200, { ok: true });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/login") return await handleLogin(req, res);
    if (req.method === "POST" && req.url === "/api/logout") return await handleLogout(req, res);
    if (req.method === "GET" && req.url === "/api/me") return await handleMe(req, res);
    if (req.method === "POST" && req.url === "/api/search/start") return await handleSearchStart(req, res);
    if (req.method === "GET" && req.url.startsWith("/api/search/status")) return await handleSearchStatus(req, res);
    if (req.method === "POST" && req.url === "/api/search/cancel") return await handleSearchCancel(req, res);
    if (req.method === "POST" && req.url === "/api/search") return await handleSearch(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { ok: false, message: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error.message || "服务器错误" });
  }
});

loadSessions();
pruneSessions();

server.listen(PORT, () => {
  console.log(`货源查询页面已启动：http://localhost:${PORT}`);
  console.log("已加载平台：");
  for (const platform of Object.values(PLATFORMS)) {
    console.log(`- ${platform.name}：${platform.baseUrl}`);
  }
});
