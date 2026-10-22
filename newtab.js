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

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}
function domainOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return raw || ''; }
}
function flatten(nodes, path = []) {
  const out = [];
  for (const node of nodes || []) {
    if (node.url) {
      const url = safeUrl(node.url);
      if (url) out.push({ id: node.id, title: node.title || domainOf(node.url), url: url.href, path, folderId: path.length ? path[path.length - 1].id : '__other__', folderName: path.length ? path[path.length - 1].title : '其他书签' });
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
  $('#bookmarkCount').textContent = `${allBookmarks.length} 个书签`;
  $('#folderCount').textContent = `${folders.length} 个分类`;
  $('#subtitle').textContent = `已同步 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  renderNav();
  render();
  document.documentElement.dataset.bookmarkCount = allBookmarks.length;
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
    chrome.storage.local.get({ usageCounts: {}, pinnedUrls: [] }, boot);
  } catch (error) {
    reportError(error);
    boot();
  }
}
function reportError(error) {
  const message = error && error.message ? error.message : String(error || '未知错误');
  $('#subtitle').textContent = '读取失败';
  results.innerHTML = `<div class="empty"><strong>读取 Chrome 书签失败</strong>${message}<small>可在新标签页按 F12 打开控制台查看完整错误。</small></div>`;
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
  chrome.storage.local.set({ usageCounts }, () => {
    // Keep the page responsive; update visible ranking after the click is recorded.
    render();
  });
}
function makeCard(bookmark, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'card';
  wrapper.style.setProperty('--i', index % 24);
  const a = document.createElement('a');
  a.className = 'bookmark-card'; a.href = bookmark.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.title = `${bookmark.title}\n${bookmark.url}`;
  a.addEventListener('click', () => recordUse(bookmark));
  const icon = document.createElement('span'); icon.className = 'favicon';
  const img = document.createElement('img');
  img.alt = ''; img.loading = 'lazy';
  img.src = `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(bookmark.url)}&sz=64`;
  img.onerror = () => { img.remove(); icon.textContent = (bookmark.title.trim()[0] || '•').toUpperCase(); };
  icon.append(img);
  const copy = document.createElement('span'); copy.className = 'card-copy';
  const titleRow = document.createElement('span'); titleRow.className = 'card-title-row';
  const title = document.createElement('span'); title.className = 'card-title'; title.textContent = bookmark.title;
  const url = document.createElement('span'); url.className = 'card-url'; url.textContent = domainOf(bookmark.url);
  titleRow.append(title);
  const count = countFor(bookmark);
  if (count > 0) {
    const badge = document.createElement('span'); badge.className = 'usage-badge'; badge.textContent = `${count} 次`;
    badge.title = '通过此导航页打开的次数'; titleRow.append(badge);
  }
  copy.append(titleRow, url); a.append(icon, copy);
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.textContent = PIN_GLYPH;
  pin.className = `pin-btn${isPinned(bookmark) ? ' is-pinned' : ''}`;
  const pinnedNow = isPinned(bookmark);
  pin.title = pinnedNow ? '取消置顶' : '置顶到顶部';
  pin.setAttribute('aria-label', `${pin.title}：${bookmark.title}`);
  pin.setAttribute('aria-pressed', String(pinnedNow));
  pin.addEventListener('click', () => togglePin(bookmark));
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
function render() {
  const normalized = query.trim().toLocaleLowerCase();
  let filtered = allBookmarks.filter(b => {
    const folderMatch = activeFolder === '__all__' || b.folderId === activeFolder;
    const searchMatch = !normalized || `${b.title} ${b.url} ${b.folderName}`.toLocaleLowerCase().includes(normalized);
    return folderMatch && searchMatch;
  });
  filtered.sort(sortMode === 'name' ? (a, b) => a.title.localeCompare(b.title, 'zh-CN') : usageSort);
  results.innerHTML = '';
  results.classList.toggle('animate', !hasRendered);
  hasRendered = true;
  $('#clearBtn').hidden = !query;
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
searchInput.addEventListener('input', () => { query = searchInput.value; render(); });
$('#clearBtn').addEventListener('click', () => { searchInput.value = ''; query = ''; render(); searchInput.focus(); });
$('#refreshBtn').addEventListener('click', init);
$('#sortSelect').addEventListener('change', event => { sortMode = event.target.value; render(); });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); searchInput.focus(); }
  if (event.key === 'Escape') { searchInput.value = ''; query = ''; render(); searchInput.blur(); }
});
if (globalThis.chrome?.bookmarks) {
  chrome.bookmarks.onCreated.addListener(init);
  chrome.bookmarks.onRemoved.addListener(init);
  chrome.bookmarks.onChanged.addListener(init);
  chrome.bookmarks.onMoved.addListener(init);
  chrome.bookmarks.onChildrenReordered.addListener(init);
  chrome.bookmarks.onImportEnded.addListener(init);
}
init();
