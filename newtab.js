const $ = (selector) => document.querySelector(selector);
const searchInput = $('#searchInput');
const results = $('#results');
const categoryNav = $('#categoryNav');
let allBookmarks = [];
let folders = [];
let usageCounts = {};
let pinnedUrls = new Set();
let activeFolder = '__all__';
let query = '';
let sortMode = 'usage';
let hasRendered = false;
const PIN_GLYPH = '\u21e7';
const FAVICON_TTL = 7 * 24 * 60 * 60 * 1000;
const FAVICON_RETRY = 10 * 60 * 1000;
const FAVICON_MAX = 400;
// storage.local 配额是 10MB：按字节再设一道硬上限，避免写满后静默失败、每次开新标签页都重下。
const FAVICON_BYTES_MAX = 4 * 1024 * 1024;
const FAVICON_CONCURRENCY = 6;
const FAVICON_VERSION = 3;
const FAVICON_MIN = 64;
const BRAND_COLORS = ['#0f766e', '#0e7490', '#4338ca', '#7e22ce', '#b45309', '#be123c', '#15803d', '#475569'];
const PIN_HOVER_DELAY = 600;
const RENDER_DELAY = 140;
let favicons = {};
const faviconJobs = new Map();
let faviconSaveTimer = 0;
let renderTimer = 0;
let pendingUse = Object.create(null);
let usageFlushTimer = 0;
let faviconActive = 0;
const faviconQueue = [];

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}
function domainOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return raw || ''; }
}
// 只保留协议 + 主机：图标请求绝不能带上书签的路径和查询参数（可能含 token）。
function originOf(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? `${url.protocol}//${url.host}` : null;
  } catch { return null; }
}
function flatten(nodes, path = []) {
  const out = [];
  for (const node of nodes || []) {
    if (node.url) {
      const url = safeUrl(node.url);
      if (url) {
        const leaf = path.length ? path[path.length - 1] : null;
        out.push({
          id: node.id,
          title: node.title || domainOf(node.url),
          url: url.href,
          path,
          folderId: leaf ? leaf.id : '__other__',
          folderName: leaf ? leaf.title : '其他书签',
          // 完整层级路径，让搜索能命中父级文件夹名（例如「工作」下的「前端」）。
          folderPath: path.map(p => p.title).join(' ')
        });
      }
    } else if (node.children) {
      const nextPath = node.id === '0' ? path : [...path, { id: node.id, title: node.title || '未命名文件夹' }];
      out.push(...flatten(node.children, nextPath));
    }
  }
  return out;
}
function countFor(bookmark) { return Number(usageCounts[bookmark.url] || 0); }
function isPinned(bookmark) { return pinnedUrls.has(bookmark.url); }
function savePins() {
  if (!globalThis.chrome?.storage) return;
  chrome.storage.local.set({ pinnedUrls: [...pinnedUrls] });
}
function togglePin(bookmark) {
  if (pinnedUrls.has(bookmark.url)) pinnedUrls.delete(bookmark.url); else pinnedUrls.add(bookmark.url);
  savePins();
  render();
}
function usageSort(a, b) { return countFor(b) - countFor(a) || a.title.localeCompare(b.title, 'zh-CN'); }
function buildData(tree) {
  allBookmarks = flatten(tree);
  const map = new Map();
  for (const b of allBookmarks) {
    if (b.folderId !== '__other__') map.set(b.folderId, b.folderName);
  }
  folders = [...map.entries()].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  // 当前选中的分类可能已被删除，回退到「全部书签」而不是留下一个空列表。
  if (activeFolder !== '__all__' && !folders.some(f => f.id === activeFolder)) activeFolder = '__all__';
  $('#bookmarkCount').textContent = `${allBookmarks.length} 个书签`;
  $('#folderCount').textContent = `${folders.length} 个分类`;
  $('#subtitle').textContent = `已同步 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  renderNav();
  render();
}
function init() {
  if (!globalThis.chrome?.bookmarks) {
    results.innerHTML = '<div class="empty"><strong>无法读取 Chrome 书签</strong>请确认已通过 Chrome 扩展程序页面加载本扩展，然后重新打开新标签页。</div>';
    $('#subtitle').textContent = '未检测到扩展环境';
    return;
  }
  // 先用书签数据渲染，再看本地存储 —— 存储失败不应该让页面卡在加载态。
  const boot = (data) => {
    if (data) {
      usageCounts = data.usageCounts || {};
      pinnedUrls = new Set(Array.isArray(data.pinnedUrls) ? data.pinnedUrls : []);
      favicons = data.favicons && typeof data.favicons === 'object' ? data.favicons : {};
      sortMode = data.sortMode === 'name' ? 'name' : 'usage';
      $('#sortSelect').value = sortMode;
    }
    // getTree 只接受一个回调参数，错误由 chrome.runtime.lastError 提供。
    try {
      chrome.bookmarks.getTree(tree => {
        if (chrome.runtime.lastError) reportError(chrome.runtime.lastError);
        else buildData(tree);
      });
    } catch (error) {
      reportError(error);
    }
  };
  try {
    chrome.storage.local.get({ usageCounts: {}, pinnedUrls: [], favicons: {}, sortMode: 'usage' }, boot);
  } catch (error) {
    reportError(error);
    boot();
  }
}
function reportError(error) {
  const message = error && error.message ? error.message : String(error || '未知错误');
  $('#subtitle').textContent = '读取失败';
  const box = document.createElement('div');
  box.className = 'empty';
  const strong = document.createElement('strong');
  strong.textContent = '读取 Chrome 书签失败';
  const detail = document.createElement('span');
  detail.textContent = message;
  const hint = document.createElement('small');
  hint.textContent = '可在新标签页按 F12 打开控制台查看完整错误。';
  box.append(strong, detail, hint);
  results.replaceChildren(box);
}
function renderNav() {
  const items = [{ id: '__all__', title: '全部书签' }, ...folders];
  categoryNav.innerHTML = '';
  for (const folder of items) {
    const button = document.createElement('button');
    button.className = `category${activeFolder === folder.id ? ' active' : ''}`;
    button.textContent = folder.title;
    button.type = 'button';
    button.addEventListener('click', () => { activeFolder = folder.id; renderNav(); render(); });
    categoryNav.append(button);
  }
}
function recordUse(bookmark) {
  usageCounts[bookmark.url] = countFor(bookmark) + 1;
  pendingUse[bookmark.url] = (pendingUse[bookmark.url] || 0) + 1;
  scheduleUsageFlush();
  // 名称排序下点击不改变顺序，没必要重建列表。
  if (sortMode !== 'usage') return;
  // 频率排序下顺序会变，重建但保持滚动位置，避免视口跳走。
  const scrollY = window.scrollY;
  render();
  window.scrollTo(0, scrollY);
}
// 计数落盘：先读最新值再叠加本次增量。直接回写内存快照会让同时开着的多个
// 新标签页互相覆盖，把对方的点击吃掉。
function scheduleUsageFlush() {
  clearTimeout(usageFlushTimer);
  usageFlushTimer = setTimeout(() => {
    const batch = pendingUse;
    pendingUse = Object.create(null);
    chrome.storage.local.get({ usageCounts: {} }, data => {
      const latest = { ...(data.usageCounts || {}) };
      for (const [url, delta] of Object.entries(batch)) latest[url] = Number(latest[url] || 0) + delta;
      usageCounts = latest;
      chrome.storage.local.set({ usageCounts: latest }, () => { void chrome.runtime.lastError; });
    });
  }, 400);
}
function sameCounts(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Number(a[key] || 0) === Number(b[key] || 0));
}
// 图标按域名缓存为 dataURL：只下载一次，之后每次渲染和离线打开都走本地。
function isFaviconFresh(entry) {
  if (entry.v !== FAVICON_VERSION) return false;
  // 取到了图（哪怕偏小）缓存 7 天；完全失败只压 10 分钟，避免离线时一周不重试。
  const ok = entry.data || entry.w > 0;
  return Date.now() - (entry.ts || 0) < (ok ? FAVICON_TTL : FAVICON_RETRY);
}
function saveFavicons() {
  clearTimeout(faviconSaveTimer);
  faviconSaveTimer = setTimeout(() => {
    // 多个新标签页会各自持有内存副本，写回前先合并，避免互相覆盖。
    chrome.storage.local.get({ favicons: {} }, data => {
      const merged = { ...data.favicons };
      for (const [domain, entry] of Object.entries(favicons)) {
        if (!merged[domain] || (entry.ts || 0) >= (merged[domain].ts || 0)) merged[domain] = entry;
      }
      favicons = merged;
      pruneFavicons();
      chrome.storage.local.set({ favicons });
    });
  }, 800);
}
function pruneFavicons() {
  const entries = Object.entries(favicons);
  let bytes = 0;
  for (const [, entry] of entries) bytes += entry.data ? entry.data.length : 0;
  if (entries.length <= FAVICON_MAX && bytes <= FAVICON_BYTES_MAX) return;
  // 按时间从旧到新淘汰，直到条数和字节数都回到预算内。
  entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  let count = entries.length;
  for (const [domain, entry] of entries) {
    if (count <= FAVICON_MAX && bytes <= FAVICON_BYTES_MAX) break;
    delete favicons[domain];
    count -= 1;
    bytes -= entry.data ? entry.data.length : 0;
  }
}
function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
// 读取源图真实宽度：小于阈值说明放大会糊，直接不用它。
function imageWidth(data) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth || 0);
    img.onerror = () => resolve(0);
    img.src = data;
  });
}
// 同时最多 6 个图标请求：首次安装或缓存过期时可能上百个域名一起排队，
// 不限并发会把网络和首屏渲染都拖住。
function pumpFaviconQueue() {
  while (faviconActive < FAVICON_CONCURRENCY && faviconQueue.length) {
    const task = faviconQueue.shift();
    faviconActive += 1;
    Promise.resolve().then(task).catch(() => {}).finally(() => {
      faviconActive -= 1;
      pumpFaviconQueue();
    });
  }
}
function downloadFavicon(origin) {
  return new Promise(resolve => {
    faviconQueue.push(async () => {
      let data = null;
      let width = 0;
      try {
        const res = await fetch(`https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(origin)}&sz=128`);
        const blob = res.ok ? await res.blob() : null;
        if (blob && blob.type.startsWith('image/') && blob.size <= 96 * 1024) {
          data = await blobToDataUrl(blob);
          width = data ? await imageWidth(data) : 0;
        }
      } catch { /* 网络失败按失败记录，10 分钟后再试 */ }
      resolve({ data, width });
    });
    pumpFaviconQueue();
  });
}
async function fetchFavicon(domain, url) {
  if (faviconJobs.has(domain)) return faviconJobs.get(domain);
  const job = (async () => {
    const origin = originOf(url);
    let result = { data: null, width: 0 };
    // 离线时直接记失败，别把每次开新标签页都变成一轮必然超时的请求。
    if (origin && navigator.onLine !== false) result = await downloadFavicon(origin);
    // 小图不存 dataURL，省空间；渲染时改用「品牌色 + 首字母」。
    favicons[domain] = { data: result.width >= FAVICON_MIN ? result.data : null, w: result.width, ts: Date.now(), v: FAVICON_VERSION };
    faviconJobs.delete(domain);
    pruneFavicons();
    saveFavicons();
    return favicons[domain];
  })();
  faviconJobs.set(domain, job);
  return job;
}
function brandColor(domain) {
  // FNV-1a：同一域名永远同色，且相邻域名不容易撞色。
  let hash = 2166136261;
  for (let i = 0; i < domain.length; i++) {
    hash ^= domain.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return BRAND_COLORS[(hash >>> 0) % BRAND_COLORS.length];
}
function paintFavicon(icon, data) {
  const img = document.createElement('img');
  img.alt = ''; img.decoding = 'async'; img.src = data;
  icon.style.background = '';
  icon.style.color = '';
  icon.replaceChildren(img);
}
function paintInitial(icon, bookmark, domain) {
  icon.textContent = (bookmark.title.trim()[0] || '•').toUpperCase();
  icon.style.background = brandColor(domain);
  icon.style.color = '#fff';
}
function makeFavicon(bookmark) {
  const domain = domainOf(bookmark.url);
  const icon = document.createElement('span'); icon.className = 'favicon';
  const entry = favicons[domain];
  if (entry && entry.data) paintFavicon(icon, entry.data);
  else paintInitial(icon, bookmark, domain);
  if (!entry || !isFaviconFresh(entry)) {
    fetchFavicon(domain, bookmark.url).then(result => {
      // 渲染可能已经重建了卡片，旧节点直接丢弃。
      if (!icon.isConnected) return;
      if (result.data) paintFavicon(icon, result.data);
      // 取到了但太小：换成品牌色首字母；w 为 0 表示取图失败，保留现状。
      else if (result.w > 0) paintInitial(icon, bookmark, domain);
    });
  }
  return icon;
}
function makeCard(bookmark, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tile';
  wrapper.style.setProperty('--i', index % 24);
  const a = document.createElement('a');
  a.className = 'tile-link'; a.href = bookmark.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.title = `${bookmark.title}\n${bookmark.url}`;
  a.addEventListener('click', () => recordUse(bookmark));
  const icon = makeFavicon(bookmark);
  const copy = document.createElement('span'); copy.className = 'tile-copy';
  const title = document.createElement('span'); title.className = 'tile-name'; title.textContent = bookmark.title;
  const url = document.createElement('span'); url.className = 'tile-host'; url.textContent = domainOf(bookmark.url);
  copy.append(title, url);
  a.append(icon, copy);
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.textContent = PIN_GLYPH;
  pin.className = `tile-pin${isPinned(bookmark) ? ' is-pinned' : ''}`;
  const pinnedNow = isPinned(bookmark);
  pin.title = pinnedNow ? '取消置顶' : '置顶到顶部';
  pin.setAttribute('aria-label', `${pin.title}：${bookmark.title}`);
  pin.setAttribute('aria-pressed', String(pinnedNow));
  pin.addEventListener('click', () => togglePin(bookmark));
  // 置顶按钮默认隐藏，悬停满 2 秒才出现，避免误触。
  let hoverTimer = 0;
  wrapper.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => wrapper.classList.add('pin-ready'), PIN_HOVER_DELAY);
  });
  wrapper.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    wrapper.classList.remove('pin-ready');
  });
  wrapper.append(a, pin);
  return wrapper;
}
function makeSection(titleText, bookmarks, iconText = '▦', extraClass = '') {
  if (!bookmarks.length) return null;
  const section = document.createElement('section'); section.className = `section ${extraClass}`.trim();
  const head = document.createElement('div'); head.className = 'section-head';
  const ico = document.createElement('span'); ico.className = 'section-icon'; ico.textContent = iconText;
  const title = document.createElement('h3'); title.textContent = titleText;
  const count = document.createElement('span'); count.className = 'section-count'; count.textContent = bookmarks.length;
  head.append(ico, title, count);
  const grid = document.createElement('div'); grid.className = 'bookmark-grid';
  bookmarks.forEach((b, index) => grid.append(makeCard(b, index)));
  section.append(head, grid);
  return section;
}
function filteredBookmarks() {
  const normalized = query.trim().toLocaleLowerCase();
  const list = allBookmarks.filter(b => {
    const folderMatch = activeFolder === '__all__' || b.folderId === activeFolder;
    const searchMatch = !normalized || `${b.title} ${b.url} ${b.folderPath}`.toLocaleLowerCase().includes(normalized);
    return folderMatch && searchMatch;
  });
  list.sort(sortMode === 'name' ? (a, b) => a.title.localeCompare(b.title, 'zh-CN') : usageSort);
  return list;
}
function openInNewTab(url) {
  if (globalThis.chrome?.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}
function searchOnGoogle(value) {
  const term = (value || '').trim();
  if (!term) return;
  openInNewTab(`https://www.google.com/search?q=${encodeURIComponent(term)}`);
}
function makeSearchAction(term) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'search-action';
  const label = document.createElement('span');
  label.append('在 Google 中搜索 “');
  const keyword = document.createElement('strong'); keyword.textContent = term;
  label.append(keyword, '”');
  const hint = document.createElement('span'); hint.className = 'search-action-hint'; hint.textContent = '回车';
  const icon = document.createElement('span'); icon.className = 'search-action-icon'; icon.textContent = 'G';
  button.append(icon, label, hint);
  button.addEventListener('click', () => searchOnGoogle(term));
  return button;
}
function render() {
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = filteredBookmarks();
  results.innerHTML = '';
  results.classList.toggle('animate', !hasRendered);
  hasRendered = true;
  $('#clearBtn').hidden = !query;
  if (normalized) results.append(makeSearchAction(query.trim()));
  if (!filtered.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const strong = document.createElement('strong'); strong.textContent = normalized ? '没有找到匹配的书签' : '这个分类暂时没有书签';
    const desc = document.createElement('span'); desc.textContent = normalized ? '试试更短的关键词，或搜索域名。' : '你在 Chrome 中添加的书签会自动出现在这里。';
    empty.append(strong, desc); results.append(empty); return;
  }
  // 手动置顶的书签始终排在最前，不受搜索/排序影响。
  const pinned = filtered.filter(isPinned);
  if (pinned.length) {
    const section = makeSection('置顶书签', pinned, '★', 'pinned-section');
    if (section) results.append(section);
  }
  // Surface the most-used links at the top when showing all bookmarks without a search query.
  if (activeFolder === '__all__' && !normalized && sortMode === 'usage') {
    const frequent = filtered.filter(b => !isPinned(b) && countFor(b) > 0).sort(usageSort).slice(0, 8);
    const section = makeSection('常用书签', frequent, '↗', 'frequent-section');
    if (section) results.append(section);
  }
  const groups = new Map();
  for (const b of filtered) {
    const key = activeFolder === '__all__' && !normalized ? b.folderId : '__filtered__';
    if (!groups.has(key)) groups.set(key, { title: key === '__filtered__' ? (normalized ? '搜索结果' : b.folderName) : b.folderName, bookmarks: [] });
    groups.get(key).bookmarks.push(b);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => {
    if (sortMode === 'name') return a.title.localeCompare(b.title, 'zh-CN');
    return Math.max(...b.bookmarks.map(countFor)) - Math.max(...a.bookmarks.map(countFor)) || a.title.localeCompare(b.title, 'zh-CN');
  });
  for (const group of orderedGroups) {
    const section = makeSection(group.title, group.bookmarks, '▦');
    if (section) results.append(section);
  }
}
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, RENDER_DELAY);
}
searchInput.addEventListener('input', () => {
  query = searchInput.value;
  // 清除按钮要立刻响应，列表重建可以等一拍。
  $('#clearBtn').hidden = !query;
  scheduleRender();
});
searchInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  searchOnGoogle(query);
});
$('#clearBtn').addEventListener('click', () => { clearTimeout(renderTimer); searchInput.value = ''; query = ''; render(); searchInput.focus(); });
$('#refreshBtn').addEventListener('click', init);
$('#sortSelect').addEventListener('change', event => {
  sortMode = event.target.value;
  chrome.storage.local.set({ sortMode });
  render();
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); searchInput.focus(); }
  if (event.key === 'Escape') { clearTimeout(renderTimer); searchInput.value = ''; query = ''; render(); searchInput.blur(); }
});
if (globalThis.chrome?.bookmarks) {
  chrome.bookmarks.onCreated.addListener(init);
  chrome.bookmarks.onRemoved.addListener(init);
  chrome.bookmarks.onChanged.addListener(init);
  chrome.bookmarks.onMoved.addListener(init);
  chrome.bookmarks.onChildrenReordered.addListener(init);
  chrome.bookmarks.onImportEnded.addListener(init);
}
// 其它标签页写入计数后同步过来；本页还有待落盘增量时不覆盖，避免显示回退。
if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.usageCounts) return;
    const next = changes.usageCounts.newValue || {};
    if (Object.keys(pendingUse).length || sameCounts(next, usageCounts)) return;
    usageCounts = next;
    render();
  });
}
init();
