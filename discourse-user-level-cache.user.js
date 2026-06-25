// ==UserScript==
// @name         Discourse Per-Post Trust Level Cache
// @namespace    https://github.com/codex/discourse-level-cache/
// @version      0.6.0
// @description  手动获取单条 Discourse 帖子作者等级，并缓存用户主页、列表页已有用户数据。
// @author       Codex
// @homepageURL  https://github.com/RSJWY/MyTampermonkeyScript
// @supportURL   https://github.com/RSJWY/MyTampermonkeyScript/issues
// @updateURL    https://raw.githubusercontent.com/RSJWY/MyTampermonkeyScript/main/discourse-user-level-cache.user.js
// @downloadURL  https://raw.githubusercontent.com/RSJWY/MyTampermonkeyScript/main/discourse-user-level-cache.user.js
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  const CACHE_KEY = "discourse_user_level_cache_v2";
  const HOSTS_KEY = "discourse_user_level_allowed_hosts_v1";
  const DEFAULT_ALLOWED_HOSTS = ["idcflare.com"];
  const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
  //请求间隔
  const MIN_REQUEST_GAP_MS = 1500;
  const STYLE_ID = "idf-level-style";
  const BADGE_CLASS = "idf-level-badge";
  const FETCH_CLASS = "idf-level-fetch";
  const REFRESH_CLASS = "idf-level-refresh";
  const POST_SELECTOR = "article.topic-post, .topic-post";
  const USER_LINK_SELECTOR = "a[data-user-card], a.trigger-user-card, .names a, .username a";

  const TRUST_LEVEL_LABELS = {
    0: "TL0",
    1: "TL1",
    2: "TL2",
    3: "TL3",
    4: "TL4",
  };

  const currentHost = normalizeHost(location.hostname);
  const allowedHosts = loadAllowedHosts();
  let cache = loadCache();
  let observer = null;
  let rendering = false;
  let lastRequestAt = 0;
  let routeKey = "";
  let lastUserPageCacheSignature = "";
  const inFlightPosts = new Set();

  registerMenuCommands();

  window.DiscourseUserLevelCache = {
    get(username, host) {
      return getCached(username, host);
    },
    getAll(host) {
      pruneCache();
      return getAllCached(host);
    },
    set(username, data, host) {
      setCached(username, data, host);
      saveCache();
      renderAll();
    },
    clear(host) {
      clearCache(host);
      saveCache();
      renderAll();
    },
    getAllowedHosts() {
      return [...allowedHosts];
    },
    refreshPost(postId) {
      return fetchPostLevelById(postId);
    },
    cacheCurrentUserPage() {
      return cacheFromCurrentUserPage();
    },
    cacheCurrentPageUsers() {
      return cacheUsersFromCurrentPage("manual");
    },
  };
  window.IdcflareUserLevelCache = window.DiscourseUserLevelCache;

  if (!isAllowedHost(currentHost, allowedHosts)) {
    return;
  }

  installRouteWatcher();
  handleRouteChange();

  function loadAllowedHosts() {
    try {
      const raw = GM_getValue(HOSTS_KEY, JSON.stringify(DEFAULT_ALLOWED_HOSTS));
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [...DEFAULT_ALLOWED_HOSTS];
      const hosts = parsed.map(normalizeHostPattern).filter(Boolean);
      return hosts.length ? [...new Set(hosts)] : [...DEFAULT_ALLOWED_HOSTS];
    } catch (_) {
      return [...DEFAULT_ALLOWED_HOSTS];
    }
  }

  function saveAllowedHosts(hosts) {
    GM_setValue(HOSTS_KEY, JSON.stringify([...new Set(hosts.map(normalizeHostPattern).filter(Boolean))]));
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== "function") return;

    if (isAllowedHost(currentHost, allowedHosts)) {
      GM_registerMenuCommand("Discourse 等级：停用当前站点", () => {
        const nextHosts = allowedHosts.filter((host) => !hostMatches(currentHost, host));
        saveAllowedHosts(nextHosts);
        window.alert(`已停用：${currentHost}\n刷新页面后生效。`);
      });
    } else {
      GM_registerMenuCommand("Discourse 等级：启用当前站点", () => {
        saveAllowedHosts([...allowedHosts, currentHost]);
        window.alert(`已启用：${currentHost}\n刷新页面后生效。`);
      });
    }

    GM_registerMenuCommand("Discourse 等级：管理站点", () => {
      const input = window.prompt(
        "允许启用的 Discourse 站点域名，支持逗号或换行分隔。\n子域名可写成 *.example.com。",
        allowedHosts.join("\n")
      );
      if (input === null) return;
      const nextHosts = input
        .split(/[,\n]/)
        .map(normalizeHostPattern)
        .filter(Boolean);
      saveAllowedHosts(nextHosts);
      window.alert("已保存。刷新已打开的页面后生效。");
    });
  }

  function normalizeHost(host) {
    return String(host || "").trim().toLowerCase().replace(/:\d+$/, "");
  }

  function normalizeHostPattern(value) {
    let text = String(value || "").trim().toLowerCase();
    if (!text) return "";
    try {
      if (/^https?:\/\//.test(text)) {
        text = new URL(text).hostname;
      }
    } catch (_) {
      return "";
    }
    text = text.replace(/^https?:\/\//, "").split("/")[0].replace(/:\d+$/, "");
    if (text.startsWith("*.")) {
      const base = normalizeHost(text.slice(2));
      return base ? `*.${base}` : "";
    }
    return normalizeHost(text);
  }

  function isAllowedHost(host, hosts) {
    return hosts.some((pattern) => hostMatches(host, pattern));
  }

  function hostMatches(host, pattern) {
    const cleanHost = normalizeHost(host);
    const cleanPattern = normalizeHostPattern(pattern);
    if (!cleanHost || !cleanPattern) return false;
    if (cleanPattern.startsWith("*.")) {
      const base = cleanPattern.slice(2);
      return cleanHost === base || cleanHost.endsWith(`.${base}`);
    }
    return cleanHost === cleanPattern;
  }

  function isTopicPath(pathname) {
    return /^\/t(?:\/|$)/.test(String(pathname || ""));
  }

  function isUserPath(pathname) {
    return /^\/u\/[^/?#]+(?:\/|$)/.test(String(pathname || ""));
  }

  function usernameFromUserPath(pathname) {
    const match = String(pathname || "").match(/^\/u\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function installRouteWatcher() {
    if (installRouteWatcher.installed) return;
    installRouteWatcher.installed = true;

    const notify = () => window.setTimeout(handleRouteChange, 80);
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patchedHistoryMethod() {
        const result = original.apply(this, arguments);
        notify();
        return result;
      };
    }
    window.addEventListener("popstate", notify);
  }

  function handleRouteChange() {
    const nextRouteKey = `${location.pathname}${location.search}`;
    if (routeKey === nextRouteKey) {
      if (isUserPath(location.pathname)) cacheFromCurrentUserPage();
      if (!isTopicPath(location.pathname) && !isUserPath(location.pathname)) {
        cacheUsersFromCurrentPage("route-repeat");
      }
      return;
    }
    routeKey = nextRouteKey;
    lastUserPageCacheSignature = "";

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (isTopicPath(location.pathname)) {
      injectStyle();
      renderAll();
      observeTopicChanges();
      return;
    }

    if (isUserPath(location.pathname)) {
      cacheFromCurrentUserPage();
      observeUserPageChanges();
      return;
    }

    cacheUsersFromCurrentPage("list-page-preloaded");
    observeListPageChanges();
  }

  function observeUserPageChanges() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      window.clearTimeout(observeUserPageChanges.timer);
      observeUserPageChanges.timer = window.setTimeout(cacheFromCurrentUserPage, 350);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function observeListPageChanges() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      window.clearTimeout(observeListPageChanges.timer);
      observeListPageChanges.timer = window.setTimeout(() => cacheUsersFromCurrentPage("list-page-preloaded"), 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function loadCache() {
    const fallback = { users: {}, updatedAt: Date.now() };
    try {
      const raw = GM_getValue(CACHE_KEY, null);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return fallback;
      return {
        users: parsed.users && typeof parsed.users === "object" ? parsed.users : {},
        updatedAt: Number(parsed.updatedAt) || Date.now(),
      };
    } catch (_) {
      return fallback;
    }
  }

  function saveCache() {
    cache.updatedAt = Date.now();
    GM_setValue(CACHE_KEY, JSON.stringify(cache));
  }

  function normalizeUsername(username) {
    return String(username || "").trim().replace(/^@/, "").toLowerCase();
  }

  function cacheKey(username, host) {
    return `${normalizeHost(host || currentHost)}::${normalizeUsername(username)}`;
  }

  function getCached(username, host) {
    pruneCache();
    return cache.users[cacheKey(username, host)] || null;
  }

  function getAllCached(host) {
    const targetHost = normalizeHost(host || currentHost);
    const result = {};
    for (const [key, item] of Object.entries(cache.users)) {
      if (!item || item.host !== targetHost) continue;
      result[item.username || key.split("::").pop()] = item;
    }
    return result;
  }

  function setCached(username, data, host) {
    const targetHost = normalizeHost(host || currentHost);
    const key = normalizeUsername(username);
    if (!key) return;
    const cacheId = cacheKey(key, targetHost);
    const existing = cache.users[cacheId] || {};
    const hasTrustLevel = Number.isFinite(Number(data.trustLevel));
    cache.users[cacheKey(key, targetHost)] = {
      host: targetHost,
      username: data.username || username,
      trustLevel: hasTrustLevel ? Number(data.trustLevel) : existing.trustLevel ?? null,
      title: data.title ?? existing.title ?? "",
      name: data.name ?? existing.name ?? "",
      userId: data.userId ?? existing.userId ?? null,
      avatarTemplate: data.avatarTemplate ?? existing.avatarTemplate ?? "",
      fetchedAt: Date.now(),
      source: data.source || "unknown",
      postId: data.postId ?? existing.postId ?? null,
    };
  }

  function clearCache(host) {
    const targetHost = host ? normalizeHost(host) : "";
    if (!targetHost) {
      cache = { users: {}, updatedAt: Date.now() };
      return;
    }
    for (const [key, item] of Object.entries(cache.users)) {
      if (item && item.host === targetHost) delete cache.users[key];
    }
  }

  function cacheFromCurrentUserPage() {
    if (!isUserPath(location.pathname)) return false;

    const pathUsername = usernameFromUserPath(location.pathname);
    const pathKey = normalizeUsername(pathUsername);
    if (!pathKey) return false;

    const candidates = extractUserCandidatesFromPage();
    const user = candidates.find((candidate) => normalizeUsername(candidate.username) === pathKey);
    if (!user || typeof user.trust_level !== "number") return false;

    const title = user.title || user.user_title || "";
    const name = user.name || "";
    const signature = `${currentHost}::${pathKey}::${user.trust_level}::${title}::${name}`;
    if (signature === lastUserPageCacheSignature) return true;
    lastUserPageCacheSignature = signature;

    setCached(user.username, {
      username: user.username,
      trustLevel: user.trust_level,
      title,
      name,
      source: "user-page-preloaded",
      postId: null,
    });
    saveCache();
    return true;
  }

  function cacheUsersFromCurrentPage(source) {
    const users = extractUserCandidatesFromPage();
    if (!users.length) return 0;

    const signature = users
      .map((user) => [
        normalizeUsername(user.username),
        user.trust_level ?? "",
        user.user_id ?? user.id ?? "",
        user.avatar_template ?? "",
        user.name ?? "",
        user.title ?? user.user_title ?? "",
      ].join(":"))
      .sort()
      .join("|");

    if (cacheUsersFromCurrentPage.lastSignature === signature) return 0;
    cacheUsersFromCurrentPage.lastSignature = signature;

    let count = 0;
    for (const user of users) {
      if (!user || !user.username) continue;
      setCached(user.username, {
        username: user.username,
        trustLevel: typeof user.trust_level === "number" ? user.trust_level : undefined,
        title: user.title || user.user_title || undefined,
        name: user.name || undefined,
        userId: user.user_id ?? user.id ?? undefined,
        avatarTemplate: user.avatar_template || undefined,
        source,
        postId: null,
      });
      count += 1;
    }

    if (count) saveCache();
    return count;
  }

  function extractUserCandidatesFromPage() {
    const candidates = [];
    const seen = new Set();
    const scripts = document.querySelectorAll("script#data-preloaded, script[type='application/json']");

    for (const script of scripts) {
      const text = (script.textContent || "").trim();
      if (!text || text.length > 2_000_000) continue;
      try {
        collectUserCandidates(JSON.parse(text), candidates, seen, 0);
      } catch (_) {
        continue;
      }
    }

    return candidates;
  }

  function collectUserCandidates(value, candidates, seen, depth) {
    if (!value || depth > 7) return;

    if (typeof value === "string") {
      const text = value.trim();
      if ((text.startsWith("{") || text.startsWith("[")) && text.length <= 2_000_000) {
        try {
          collectUserCandidates(JSON.parse(text), candidates, seen, depth + 1);
        } catch (_) {
          return;
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) collectUserCandidates(item, candidates, seen, depth + 1);
      return;
    }

    if (typeof value !== "object") return;

    if (isDiscourseUserCandidate(value)) {
      const key = [
        normalizeUsername(value.username),
        value.trust_level ?? "",
        value.user_id ?? value.id ?? "",
        value.avatar_template ?? "",
      ].join("::");
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(value);
      }
    }

    for (const item of Object.values(value)) {
      collectUserCandidates(item, candidates, seen, depth + 1);
    }
  }

  function isDiscourseUserCandidate(value) {
    if (!value || typeof value !== "object") return false;
    if (typeof value.username !== "string" || !normalizeUsername(value.username)) return false;

    return (
      typeof value.trust_level === "number" ||
      typeof value.avatar_template === "string" ||
      typeof value.name === "string" ||
      typeof value.title === "string" ||
      typeof value.user_title === "string" ||
      Number.isFinite(Number(value.user_id)) ||
      Number.isFinite(Number(value.id))
    );
  }

  function pruneCache() {
    const now = Date.now();
    let changed = false;
    for (const [username, item] of Object.entries(cache.users)) {
      if (!item || !item.fetchedAt || now - item.fetchedAt > CACHE_TTL_MS) {
        delete cache.users[username];
        changed = true;
      }
    }
    if (changed) saveCache();
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function waitForRequestGap() {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_REQUEST_GAP_MS) {
      await sleep(MIN_REQUEST_GAP_MS - elapsed);
    }
    lastRequestAt = Date.now();
  }

  async function fetchPostLevel(postEl, button) {
    const username = extractUsernameFromPost(postEl);
    if (!username) {
      setFetchButtonState(button, "无用户", false);
      return;
    }

    const cached = getCached(username);
    if (cached && cached.trustLevel !== null) {
      renderAll();
      return;
    }

    const postId = extractPostId(postEl);
    if (!postId) {
      setFetchButtonState(button, "无帖子ID", false);
      return;
    }

    return fetchPostLevelById(postId, username, button);
  }

  async function fetchPostLevelById(postId, expectedUsername, button) {
    const id = String(postId || "").trim();
    if (!id || inFlightPosts.has(id)) return;

    inFlightPosts.add(id);
    setFetchButtonState(button, "获取中...", true);

    try {
      await waitForRequestGap();
      const response = await fetch(`/posts/${encodeURIComponent(id)}.json`, {
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const post = await response.json();
      const username = post.username || expectedUsername || "";
      if (!username || typeof post.trust_level !== "number") {
        throw new Error("Missing username or trust_level");
      }

      setCached(username, {
        username,
        trustLevel: post.trust_level,
        title: post.user_title || post.title || "",
        name: post.name || "",
        source: "post-json",
        postId: id,
      });
      saveCache();
      renderAll();
    } catch (error) {
      console.warn("[IDCFlareLevel] Failed to fetch post level:", error);
      setFetchButtonState(button, "失败", false);
      window.setTimeout(() => resetFetchButtonState(button), 2200);
    } finally {
      inFlightPosts.delete(id);
    }
  }

  function extractPostId(postEl) {
    const withPostId = postEl.closest("[data-post-id]") || postEl.querySelector("[data-post-id]");
    if (withPostId && withPostId.getAttribute("data-post-id")) {
      return withPostId.getAttribute("data-post-id");
    }

    const postNumber = postEl.getAttribute("data-post-number");
    if (postNumber) {
      const cooked = postEl.querySelector(".cooked");
      const idFromCooked = cooked && cooked.id && cooked.id.match(/post_(\d+)/);
      if (idFromCooked) return idFromCooked[1];
    }

    const id = postEl.id || "";
    const idMatch = id.match(/post_(\d+)/);
    return idMatch ? idMatch[1] : "";
  }

  function extractUsernameFromPost(postEl) {
    const link = postEl.querySelector(USER_LINK_SELECTOR);
    if (!link) return "";

    const userCard = link.getAttribute("data-user-card");
    if (userCard) return userCard;

    const href = link.getAttribute("href") || "";
    const hrefMatch = href.match(/\/u\/([^/?#]+)/);
    if (hrefMatch) return decodeURIComponent(hrefMatch[1]);

    return link.textContent || "";
  }

  function findControlHost(postEl) {
    return (
      postEl.querySelector(".topic-meta-data .names") ||
      postEl.querySelector(".names") ||
      postEl.querySelector(".topic-avatar") ||
      postEl
    );
  }

  function renderAll() {
    if (rendering) return;
    rendering = true;
    if (observer) observer.disconnect();

    try {
      pruneCache();
      document.querySelectorAll(`.${BADGE_CLASS}, .${FETCH_CLASS}, .${REFRESH_CLASS}`).forEach((node) => node.remove());

      for (const postEl of document.querySelectorAll(POST_SELECTOR)) {
        const username = extractUsernameFromPost(postEl);
        if (!username) continue;

        const host = findControlHost(postEl);
        if (!host) continue;

        const item = getCached(username);
        if (item && item.trustLevel !== null) {
          host.appendChild(createBadge(username, item));
          host.appendChild(createRefreshButton(postEl, username));
        } else {
          host.appendChild(createFetchButton(postEl));
        }
      }
    } finally {
      rendering = false;
      if (observer) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
  }

  function createBadge(username, item) {
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.textContent = TRUST_LEVEL_LABELS[item.trustLevel] || `TL${item.trustLevel}`;
    badge.title = [
      `@${item.username || username}`,
      `trust_level: ${item.trustLevel}`,
      item.title ? `title: ${item.title}` : "",
      item.postId ? `source post: ${item.postId}` : "",
      item.fetchedAt ? `cached: ${new Date(item.fetchedAt).toLocaleString()}` : "",
    ].filter(Boolean).join("\n");
    return badge;
  }

  function createFetchButton(postEl) {
    const button = document.createElement("button");
    button.className = FETCH_CLASS;
    button.type = "button";
    button.textContent = "获取等级";
    button.dataset.defaultText = "获取等级";
    button.title = "只获取这条帖子的作者等级";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      fetchPostLevel(postEl, button);
    });
    return button;
  }

  function createRefreshButton(postEl, username) {
    const button = document.createElement("button");
    button.className = REFRESH_CLASS;
    button.type = "button";
    button.textContent = "刷新";
    button.dataset.defaultText = "刷新";
    button.title = "只从这条帖子刷新该用户等级缓存";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const postId = extractPostId(postEl);
      if (!postId) {
        setFetchButtonState(button, "无帖子ID", false);
        window.setTimeout(() => resetFetchButtonState(button), 2200);
        return;
      }

      fetchPostLevelById(postId, username, button);
    });
    return button;
  }

  function setFetchButtonState(button, text, disabled) {
    if (!button) return;
    button.textContent = text;
    button.disabled = Boolean(disabled);
  }

  function resetFetchButtonState(button) {
    if (!button) return;
    setFetchButtonState(button, button.dataset.defaultText || "获取等级", false);
  }

  function observeTopicChanges() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (rendering) return;
      window.clearTimeout(observeTopicChanges.timer);
      observeTopicChanges.timer = window.setTimeout(renderAll, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${BADGE_CLASS},
      .${FETCH_CLASS},
      .${REFRESH_CLASS} {
        display: inline-flex;
        align-items: center;
        height: 18px;
        margin-left: 6px;
        padding: 0 6px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 650;
        line-height: 18px;
        vertical-align: middle;
        white-space: nowrap;
      }

      .${BADGE_CLASS} {
        background: #edf5fb;
        color: #175489;
        border: 1px solid #c7dce9;
      }

      .${FETCH_CLASS},
      .${REFRESH_CLASS} {
        background: #f7f7f7;
        color: #444;
        border: 1px solid #d5d5d5;
        cursor: pointer;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .${REFRESH_CLASS} {
        padding: 0 5px;
        font-size: 10px;
      }

      .${FETCH_CLASS}:hover,
      .${REFRESH_CLASS}:hover {
        background: #ededed;
        border-color: #bdbdbd;
      }

      .${FETCH_CLASS}:disabled,
      .${REFRESH_CLASS}:disabled {
        cursor: wait;
        opacity: 0.72;
      }
    `;
    document.head.appendChild(style);
  }
})();
