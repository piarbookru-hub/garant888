'use strict';

if (typeof CMS_CONFIG === 'undefined') {
    document.body.innerHTML = '<p style="padding:40px;color:#ff4444;">Не найден config.js (CMS_CONFIG). Проверьте, что файл лежит рядом с этой страницей.</p>';
    throw new Error('CMS_CONFIG is not defined');
}

const LINK_COLORS = { inherit: null, brown: '#8B4513', lightbrown: '#CD853F' };
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

const PREVIEW_SANDBOX = 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
const VIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';

const FILES_FOLDER = 'files';
const FILES_BASE = 'prices';
const MAX_FILES = 3;
const MAX_FILE_SIZE = 1024 * 1024;
const BLOCKED_EXTS = ['exe', 'bat', 'cmd', 'sh', 'com', 'scr', 'msi', 'vbs', 'ps1', 'jar'];
const SLOT_RE = /^prices(\d*)(\.[^/]*)?$/i;

// НОВОЕ: настройки автосжатия фото
const IMG_MAX_WIDTH = 1600;
const IMG_QUALITY = 0.85;

const $ = id => document.getElementById(id);

const mkStore = st => ({
    get: k => { try { return st.getItem(k); } catch { return null; } },
    set: (k, v) => { try { st.setItem(k, v); } catch {} },
    del: k => { try { st.removeItem(k); } catch {} }
});
let ls, ss;
try { ls = mkStore(localStorage); } catch { ls = { get: () => null, set() {}, del() {} }; }
try { ss = mkStore(sessionStorage); } catch { ss = { get: () => null, set() {}, del() {} }; }

ls.del('gh_token');
let token = ss.get('gh_token');
let pending = {};
let editKind = null, editKey = null, editImagePath = null, pendingImg = null, statusTimer = null, lastFocus = null;
let editOrigText = null, editOrigImg = null;
let currentFile = ls.get('cms_currentFile') || 'index.html';
let viewModeUrl = null;
let siteBaseUrl = '';
let siteBasePath = '/';
let repoDeployId = null;
let deployPollGen = 0;
let panelFileData = null, panelFileNew = null, panelFileOld = null;
let sessionFileNames = [];

// НОВОЕ: состояние preview режима
let previewWidth = 100;
// НОВОЕ: текущий подсвеченный элемент в iframe (для выделения)
let highlightedElKey = null;

// ===== Текущий репозиторий =====
let currentOwner = ls.get('cms_currentOwner') || CMS_CONFIG.owner;
let currentRepo = ls.get('cms_currentRepo') || CMS_CONFIG.repo;
let currentBranch = CMS_CONFIG.branch;
let API = `https://api.github.com/repos/${currentOwner}/${currentRepo}`;

let reposCache = null;
let reposCacheTime = 0;
const REPOS_CACHE_TTL = 15 * 60 * 1000;

function updateAPI() { API = `https://api.github.com/repos/${currentOwner}/${currentRepo}`; }

function saveCurrentRepoState() {
    ls.set('cms_currentOwner', currentOwner);
    ls.set('cms_currentRepo', currentRepo);
    ls.set('cms_currentFile', currentFile);
}

function updateRepoHeader() { $('repoNameHeader').textContent = `· ${currentOwner}/${currentRepo}`; }

$('projectNameHeader').textContent = CMS_CONFIG.projectName || 'Редактор';
updateRepoHeader();

function saveCurrentFile() { ls.set('cms_currentFile', currentFile); }

function setSiteBase(url) {
    try {
        const u = new URL(url);
        const path = u.pathname.replace(/\/*$/, '/');
        siteBaseUrl = u.origin + path;
        siteBasePath = path;
    } catch {}
}

try {
    const loc = window.location;
    const pathParts = loc.pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart.endsWith('.html')) pathParts.pop();
        const secondLast = pathParts[pathParts.length - 1];
        if (secondLast === 'admin' || secondLast === 'panel') pathParts.pop();
    }
    setSiteBase(loc.origin + '/' + (pathParts.length ? pathParts.join('/') + '/' : ''));
} catch {
    setSiteBase(window.location.origin + '/');
}
const HOME_BASE_URL = siteBaseUrl;

function isHomeRepo() {
    return currentOwner.toLowerCase() === String(CMS_CONFIG.owner).toLowerCase() &&
           currentRepo.toLowerCase() === String(CMS_CONFIG.repo).toLowerCase();
}

async function resolveRepoContext() {
    if (isHomeRepo()) {
        currentBranch = CMS_CONFIG.branch;
        setSiteBase(HOME_BASE_URL);
        return;
    }
    try {
        const r = await (await gh(API)).json();
        currentBranch = r.default_branch || CMS_CONFIG.branch;
    } catch { currentBranch = CMS_CONFIG.branch; }
    let url = null;
    try {
        const p = await (await gh(`${API}/pages`)).json();
        if (p && p.html_url) url = p.html_url;
    } catch {}
    if (!url) {
        url = currentRepo.toLowerCase() === (currentOwner + '.github.io').toLowerCase()
            ? `https://${currentOwner}.github.io/`
            : `https://${currentOwner}.github.io/${currentRepo}/`;
    }
    setSiteBase(url);
}

function siteBasePathNoSlash() { return siteBasePath.replace(/\/+$/, ''); }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

function pageUrl(file = currentFile) { return new URL(encPath(file), siteBaseUrl); }

function safeAbs(href) {
    try {
        const u = new URL(href, pageUrl());
        return ['http:', 'https:', 'tel:', 'mailto:'].includes(u.protocol) ? u.href : null;
    } catch { return null; }
}
function openSafe(href) { const u = safeAbs(href); if (u) window.open(u, '_blank', 'noopener'); }
function validLinkUrl(u) {
    if (!u) return true;
    if (u.startsWith('#')) return true;
    return !!safeAbs(u);
}

function isAdminSelf(file) {
    try { return new URL(encPath(file), siteBaseUrl).pathname === window.location.pathname && new URL(siteBaseUrl).origin === window.location.origin; }
    catch { return false; }
}

function resolveRepoPath(src) {
    try {
        const dirUrl = new URL(encPath(currentFile), 'https://repo.local/');
        const u = new URL(src, dirUrl);
        let p = decodeURIComponent(u.pathname);
        if (src.startsWith('/') && siteBasePath !== '/' && p.startsWith(siteBasePath)) p = p.slice(siteBasePath.length);
        p = p.replace(/^\/+/, '');
        return p || null;
    } catch { return null; }
}

// ===== Адресная строка =====
function updatePageIndicator() {
    const input = $('addressInput');
    const bar = $('addressBar');
    const prefix = $('addressPrefix');
    const icon = $('addressIcon');
    if (!input) return;
    if (viewModeUrl) {
        input.value = viewModeUrl;
        prefix.textContent = '';
        prefix.style.display = 'none';
        bar.classList.add('viewmode');
        icon.className = 'fas fa-eye address-icon';
        bar.title = 'Режим просмотра (без редактирования). Нажмите «Домой» для возврата.';
    } else {
        input.value = currentFile;
        prefix.textContent = currentOwner + '/' + currentRepo + '/';
        prefix.style.display = '';
        bar.classList.remove('viewmode');
        icon.className = 'fas fa-file address-icon';
        bar.title = 'Текущая страница (сохраняется при F5)';
    }
}

function normRepoFile(f) {
    f = String(f || '').split(/[?#]/)[0].replace(/^\/+/, '');
    try { f = decodeURIComponent(f); } catch {}
    if (!f) return 'index.html';
    if (f.endsWith('/')) return f + 'index.html';
    if (!/\.[a-z0-9]+$/i.test(f.split('/').pop())) return f + '.html';
    return f;
}

function parseAddressInput(raw) {
    let v = String(raw || '').trim();
    if (!v) return { kind: 'internal', href: 'index.html' };
    if (/^(javascript:|data:|vbscript:|file:|tel:|mailto:)/i.test(v)) return { kind: 'invalid' };
    if (/^(www\.)?github\.com\//i.test(v)) v = 'https://' + v;

    const ghMatch = v.match(/^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/(?:blob|tree)\/[^/]+\/(.+))?\/?$/i);
    if (ghMatch) {
        return { kind: 'switch-repo', owner: ghMatch[1], repo: ghMatch[2], file: normRepoFile(ghMatch[3]) };
    }

    const orMatch = v.match(/^@?([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\/(.+))?$/);
    if (orMatch && !/^https?:/i.test(v)) {
        const full = (orMatch[1] + '/' + orMatch[2]).toLowerCase();
        const known = (reposCache || []).find(r => r.full_name.toLowerCase() === full);
        if (known) return { kind: 'switch-repo', owner: known.owner, repo: known.name, file: normRepoFile(orMatch[3]) };
    }

    if (/^(https?:)?\/\//i.test(v)) {
        if (isInternalPage(v)) return { kind: 'internal', href: v };
        const abs = safeAbs(v.startsWith('//') ? 'https:' + v : v);
        return abs && /^https?:/i.test(abs) ? { kind: 'external', url: abs } : { kind: 'invalid' };
    }

    const first = v.split('/')[0];
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(first) && /\.[a-z]{2,}$/i.test(first) &&
        !/\.(html?|php|css|js|png|jpe?g|webp|gif|svg|pdf)$/i.test(first)) {
        const abs = safeAbs('https://' + v);
        if (abs) return isInternalPage(abs) ? { kind: 'internal', href: abs } : { kind: 'external', url: abs };
    }

    v = v.split(/[?#]/)[0].replace(/^\/+/, '');
    const base = siteBasePathNoSlash().replace(/^\/+/, '');
    if (base && (v === base || v.startsWith(base + '/'))) v = v.slice(base.length).replace(/^\/+/, '');
    if (!v) return { kind: 'internal', href: 'index.html' };
    if (v.endsWith('/')) v += 'index.html';
    else if (!/\.[a-z0-9]+$/i.test(v.split('/').pop())) v += '.html';
    if (!/\.html?$/i.test(v)) return { kind: 'invalid' };
    return { kind: 'internal', href: '/' + v };
}

async function goToAddress() {
    const input = $('addressInput');
    if (!reposCache && /^@?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\/|$)/.test(input.value.trim()) && !/^https?:/i.test(input.value.trim())) {
        showStatus('Проверяю адрес...', 'info');
        await fetchUserRepos();
    }
    const parsed = parseAddressInput(input.value);
    if (parsed.kind === 'invalid') {
        showStatus('Введите about.html, owner/repo или github.com/owner/repo', 'error');
        updatePageIndicator();
        return;
    }
    input.blur();
    if (parsed.kind === 'internal') { navigateTo(parsed.href); return; }
    if (parsed.kind === 'switch-repo') { await switchRepo(parsed.owner, parsed.repo, parsed.file); return; }
    if (Object.keys(pending).length && !confirm('Есть несохранённые правки. При переходе они будут потеряны. Продолжить?')) {
        updatePageIndicator();
        return;
    }
    pending = {}; markUnsaved();
    openExternalInIframe(parsed.url);
}

// ===== Список репозиториев =====
async function fetchUserRepos(force = false) {
    if (!force && reposCache && (Date.now() - reposCacheTime < REPOS_CACHE_TTL)) return reposCache;
    try {
        const repos = [];
        for (let page = 1; page <= 10; page++) {
            const r = await (await gh(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`)).json();
            if (!Array.isArray(r) || r.length === 0) break;
            repos.push(...r);
            if (r.length < 100) break;
        }
        const filtered = repos
            .filter(r => r.permissions && r.permissions.push && !r.archived)
            .map(r => ({
                owner: r.owner.login, name: r.name, full_name: r.full_name,
                private: r.private, updated: r.updated_at, branch: r.default_branch || 'main', description: r.description || ''
            }))
            .sort((a, b) => new Date(b.updated) - new Date(a.updated));
        reposCache = filtered;
        reposCacheTime = Date.now();
        return filtered;
    } catch (e) {
        console.error('fetchUserRepos error:', e);
        return [];
    }
}

async function checkRepoReadiness(owner, repo, branch) {
    try {
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/index.html?ref=${encodeURIComponent(branch)}`;
        const res = await fetch(url, {
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.raw+json' }
        });
        if (res.status === 404) return 'empty';
        if (!res.ok) return 'error';
        const content = await res.text();
        return content.includes('data-edit="') ? 'ready' : 'needs-prepare';
    } catch { return 'error'; }
}

const readinessQueue = [];
let readinessActive = 0;
function queueReadiness(job) { readinessQueue.push(job); pumpReadiness(); }
function pumpReadiness() {
    while (readinessActive < 4 && readinessQueue.length) {
        const j = readinessQueue.shift();
        readinessActive++;
        checkRepoReadiness(j.owner, j.repo, j.branch).then(j.cb).catch(() => j.cb('error')).finally(() => { readinessActive--; pumpReadiness(); });
    }
}

async function fillReposDropdown() {
    const dropdown = $('reposDropdown');
    if (!dropdown) return;
    readinessQueue.length = 0;
    dropdown.innerHTML = '<div class="repos-dropdown-header"><i class="fas fa-spinner fa-spin"></i> Загрузка списка репозиториев...</div>';
    dropdown.classList.add('show');

    const repos = await fetchUserRepos();
    if (!dropdown.classList.contains('show')) return;
    if (!repos.length) {
        dropdown.innerHTML = '<div class="repos-dropdown-header">Не найдено репозиториев с правом записи. Проверьте токен.</div>';
        return;
    }

    dropdown.innerHTML = `<div class="repos-dropdown-header">Репозиториев с правом записи: ${repos.length}. Клик — открыть для редактирования.</div>`;

    repos.forEach((r, idx) => {
        const isActive = r.owner === currentOwner && r.name === currentRepo;
        const item = document.createElement('div');
        item.className = 'repos-dropdown-item' + (isActive ? ' active' : '');

        const left = document.createElement('div');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'repo-name';
        nameDiv.textContent = (r.private ? '🔒 ' : '🌐 ') + r.owner + '/' + r.name;
        const metaDiv = document.createElement('div');
        metaDiv.className = 'repo-meta';
        metaDiv.textContent = r.description ? r.description.slice(0, 60) : '—';
        left.appendChild(nameDiv);
        left.appendChild(metaDiv);

        const status = document.createElement('span');
        status.className = 'repo-meta';
        status.textContent = idx < 40 ? '...' : '';

        item.appendChild(left);
        item.appendChild(status);
        dropdown.appendChild(item);

        if (idx < 40) {
            const isHome = r.owner.toLowerCase() === String(CMS_CONFIG.owner).toLowerCase() && r.name.toLowerCase() === String(CMS_CONFIG.repo).toLowerCase();
            queueReadiness({
                owner: r.owner, repo: r.name, branch: isHome ? CMS_CONFIG.branch : r.branch,
                cb: st => {
                    if (st === 'ready') { status.className = 'repo-ready'; status.textContent = '✓ готов'; }
                    else if (st === 'needs-prepare') { status.className = 'repo-notready'; status.textContent = '⚠ подготовить'; }
                    else if (st === 'empty') { status.className = 'repo-notready'; status.textContent = '— нет index.html'; }
                    else { status.textContent = '?'; }
                }
            });
        }

        item.addEventListener('click', async () => {
            dropdown.classList.remove('show');
            await switchRepo(r.owner, r.name, 'index.html');
        });
    });
}

async function switchRepo(owner, repo, file = 'index.html') {
    if (owner.toLowerCase() === currentOwner.toLowerCase() && repo.toLowerCase() === currentRepo.toLowerCase() && file === currentFile && !viewModeUrl) {
        showStatus('Этот репозиторий уже открыт', 'info');
        return;
    }
    if (Object.keys(pending).length > 0) {
        if (!confirm('Есть несохранённые правки. При смене репозитория они будут потеряны. Продолжить?')) { updatePageIndicator(); return; }
        pending = {};
        markUnsaved();
    }

    currentOwner = owner;
    currentRepo = repo;
    currentFile = file;
    viewModeUrl = null;
    updateAPI();
    saveCurrentRepoState();
    updateRepoHeader();
    showStatus(`Переключаюсь на ${owner}/${repo}...`, 'info');

    $('setupScreen').classList.remove('active');
    $('iframeWrapper').style.display = 'none';
    $('hintBanner').style.display = 'none';
    $('errorDetails').innerHTML = '';
    $('progressLog').style.display = 'none';
    setDeployBadge('idle', '');

    await enterApp();
}

async function loadPagesList() {
    const dl = $('pagesList');
    if (!dl) return;
    dl.innerHTML = '';
    try {
        const r = await (await gh(`${API}/git/trees/${encodeURIComponent(currentBranch)}?recursive=1`)).json();
        const files = (r.tree || [])
            .filter(x => x.type === 'blob' && /\.html?$/i.test(x.path) && !isAdminSelf(x.path))
            .map(x => x.path)
            .sort();
        dl.innerHTML = files.map(p => `<option value="${esc(p)}"></option>`).join('');
    } catch {}
}

function newDeployId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function readDeployId(html) {
    const m = html.match(/<meta\s+name=["']cms-deploy-id["']\s+content=["']([^"']+)["']/i);
    return m ? m[1] : null;
}

function stampDeployId(html, id) {
    const tag = `<meta name="cms-deploy-id" content="${id}">`;
    if (/<meta\s+name=["']cms-deploy-id["']/i.test(html)) {
        return html.replace(/<meta\s+name=["']cms-deploy-id["'][^>]*>/i, tag);
    }
    if (/<meta\s+charset[^>]*>/i.test(html)) return html.replace(/<meta\s+charset[^>]*>/i, m => m + '\n' + tag);
    return html.replace(/<head(\s[^>]*)?>/i, m => m + '\n' + tag);
}

function setDeployBadge(state, html) {
    const b = $('deployBadge');
    if (!b) return;
    if (state === 'idle') { b.className = 'deploy-badge'; b.style.display = 'none'; b.innerHTML = ''; return; }
    b.className = 'deploy-badge ' + state;
    b.style.display = 'inline-flex';
    b.innerHTML = html;
}

async function fetchLiveDeployId() {
    const u = pageUrl();
    u.searchParams.set('cb', Date.now());
    const res = await fetch(u.href, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return readDeployId(await res.text());
}

async function verifyDeploy(expectedId, singleCheck) {
    const gen = ++deployPollGen;
    if (!expectedId) { setDeployBadge('unknown', '<i class="fas fa-info-circle"></i> Нет метки'); return; }
    try {
        const live = await fetchLiveDeployId();
        if (gen !== deployPollGen) return;
        if (live === expectedId) { setDeployBadge('live', '<i class="fas fa-check-circle"></i> Сайт обновлён'); return; }
        setDeployBadge('pending', '<i class="fas fa-spinner fa-spin"></i> Деплой...');
        if (singleCheck) return;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 4000));
            if (gen !== deployPollGen) return;
            const live2 = await fetchLiveDeployId();
            if (gen !== deployPollGen) return;
            if (live2 === expectedId) {
                setDeployBadge('live', '<i class="fas fa-check-circle"></i> Сайт обновлён');
                showStatus('✓ GitHub Pages задеплоил изменения — сайт обновлён!', 'success');
                return;
            }
        }
        setDeployBadge('pending', '<i class="fas fa-clock"></i> Долгий деплой');
    } catch (e) {
        if (gen !== deployPollGen) return;
        setDeployBadge('unknown', '<i class="fas fa-question-circle"></i> Не проверить');
    }
}

const b64d = b => {
    try { return new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0))); }
    catch (e) { return atob(b); }
};
const b64e = s => {
    const bytes = new TextEncoder().encode(s);
    let result = '';
    for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(result);
};
const keepWs = (old, nv) => old.match(/^\s*/)[0] + nv.trim() + old.match(/\s*$/)[0];

function showStatus(msg, type = 'success') {
    const bar = $('statusBar');
    clearTimeout(statusTimer);
    bar.textContent = msg;
    bar.className = 'status-bar show ' + type;
    statusTimer = setTimeout(() => bar.classList.remove('show'), 4500);
}

// ===== НОВОЕ: Счётчик правок + сохранение черновика =====
function markUnsaved() {
    const count = Object.keys(pending).length;
    const badge = $('unsavedBadge');
    const countEl = $('pendingCount');
    badge.classList.toggle('show', count > 0);
    if (count > 0) {
        const word = count === 1 ? 'ая правка' : (count < 5 ? 'ых правки' : 'ых правок');
        badge.innerHTML = `<i class="fas fa-circle" style="font-size: 8px;"></i> ${count} несохранённ${count === 1 ? 'ая' : 'ых'}`;
    }
    if (countEl) countEl.textContent = count;
    savePendingDraft();
}

// ===== НОВОЕ: Автоповтор при 409 =====
async function ghWithRetry(url, opts = {}, retries = 1) {
    try {
        return await gh(url, opts);
    } catch (e) {
        if (e.status === 409 && retries > 0 && opts.body) {
            // Перечитать sha и повторить
            try {
                const bodyObj = JSON.parse(opts.body);
                if (bodyObj.sha) {
                    // Попытка определить путь из URL
                    const pathMatch = url.match(/\/contents\/(.+?)(?:\?|$)/);
                    if (pathMatch) {
                        const path = decodeURIComponent(pathMatch[1]);
                        const newSha = await getSha(path);
                        if (newSha) {
                            bodyObj.sha = newSha;
                            opts = { ...opts, body: JSON.stringify(bodyObj) };
                            showStatus('Конфликт версий — повторяю...', 'info');
                            return await ghWithRetry(url, opts, retries - 1);
                        }
                    }
                }
            } catch {}
        }
        throw e;
    }
}

async function gh(url, opts = {}) {
    const res = await fetch(url, {
        ...opts, cache: 'no-store',
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', ...(opts.headers || {}) }
    });
    if (!res.ok) {
        const raw = await res.text();
        let msg = raw;
        try { msg = (JSON.parse(raw)).message || raw; } catch {}
        const err = new Error(`HTTP ${res.status}: ${msg}`);
        err.status = res.status; err.body = msg;
        throw err;
    }
    return res;
}

async function getFile(path) {
    const url = `${API}/contents/${encPath(path)}?ref=${encodeURIComponent(currentBranch)}`;
    const d = await (await gh(url)).json();
    let text;
    if (d.encoding === 'base64' && d.content) text = b64d(d.content);
    else text = await (await gh(url, { headers: { 'Accept': 'application/vnd.github.raw+json' } })).text();
    return { text, sha: d.sha };
}

async function getSha(path) {
    try { return (await (await gh(`${API}/contents/${encPath(path)}?ref=${encodeURIComponent(currentBranch)}`)).json()).sha; }
    catch (e) { if (e.status === 404) return null; throw e; }
}

async function putFile(path, b64, sha, message) {
    const body = { message: message || `Обновление ${path}`, content: b64, branch: currentBranch };
    if (sha) body.sha = sha;
    return (await ghWithRetry(`${API}/contents/${encPath(path)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })).json();
}

async function delFile(path) {
    const sha = await getSha(path);
    if (!sha) return;
    await ghWithRetry(`${API}/contents/${encPath(path)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Удаление ${path}`, sha, branch: currentBranch })
    });
}

async function listSlotFiles() {
    try {
        const d = await (await gh(`${API}/contents/${encPath(FILES_FOLDER)}?ref=${encodeURIComponent(currentBranch)}`)).json();
        if (!Array.isArray(d)) return [];
        return d.filter(x => x.type === 'file' && SLOT_RE.test(x.name)).map(x => x.name);
    } catch (e) { return []; }
}

async function listAllFiles() {
    try {
        const d = await (await gh(`${API}/contents/${encPath(FILES_FOLDER)}?ref=${encodeURIComponent(currentBranch)}`)).json();
        if (!Array.isArray(d)) return [];
        return d.filter(x => x.type === 'file').map(x => ({ name: x.name, size: x.size, path: x.path, download: x.download_url }));
    } catch (e) { return []; }
}

function slotNumber(name) {
    const m = name.match(SLOT_RE);
    if (!m) return -1;
    return m[1] === '' ? 0 : parseInt(m[1], 10);
}

function nextSlotNumber(names) {
    let max = -1;
    names.forEach(n => { const v = slotNumber(n); if (v > max) max = v; });
    return max + 1 < 0 ? 0 : max + 1;
}

function buildSlotName(n, fileName) {
    const m = fileName.match(/\.([^.]+)$/);
    const ext = m ? m[1].toLowerCase() : '';
    return FILES_BASE + (n === 0 ? '' : String(n)) + (ext ? '.' + ext : '');
}

function interpretError(status, body = '') {
    const b = String(body);
    if (status === 401) return { title: 'Токен недействителен или истёк', fix: 'Создайте новый токен и войдите заново.' };
    if (status === 403 || status === 429) {
        if (/rate limit/i.test(b)) return { title: 'Превышен лимит запросов GitHub API', fix: 'Подождите минуту и повторите.' };
        if (/scope|permission|not accessible/i.test(b)) return { title: 'У токена нет нужных прав', fix: 'Создайте НОВЫЙ токен с правами Contents: Read and write на этот репозиторий.' };
        return { title: 'Доступ запрещён', fix: 'Проверьте, что токен выдан на этот репозиторий и имеет право записи.' };
    }
    if (status === 404) return { title: 'Репозиторий или файл не найден', fix: `Проверьте имя файла и ветку "${currentBranch}".` };
    if (status === 409) return { title: 'Конфликт версий (файл был изменён)', fix: 'Кто-то изменил файл в репозитории. Нажмите "Обновить" и примените правки заново.' };
    if (status === 422) return { title: 'Ошибка валидации', fix: 'Файл уже существует или данные некорректны. Попробуйте "Переподготовить".' };
    return { title: 'Ошибка запроса', fix: 'Проверьте интернет-соединение и повторите. Если не помогает — создайте новый токен.' };
}

function showErrorDetails(title, status, body, fix) {
    $('errorDetails').innerHTML = `<div class="error-details">
        <div class="err-title"><i class="fas fa-exclamation-triangle" style="color: #ff4444;"></i> ${esc(title)}</div>
        <div class="err-status">Код: ${esc(status)}</div>
        <div style="color: #888; font-size: 12px; margin-bottom: 8px;">${esc(body)}</div>
        <div class="err-fix"><i class="fas fa-check-circle"></i> ${esc(fix)}</div>
    </div>`;
}

async function checkToken() {
    const box = $('tokenInfo');
    box.textContent = 'Проверка токена...';
    $('errorDetails').innerHTML = '';
    try {
        const user = await (await gh('https://api.github.com/user')).json();
        const repo = await (await gh(API)).json();
        let hasIndex = true;
        try { await gh(`${API}/contents/index.html?ref=${encodeURIComponent(currentBranch)}`); } catch { hasIndex = false; }
        const canPush = repo.permissions ? !!repo.permissions.push : null;
        box.innerHTML = `
            <div class="token-info"><span class="label"><i class="fas fa-check-circle" style="color: #00cc66;"></i> Пользователь:</span> ${esc(user.login)}</div>
            <div class="token-info" style="margin-top: 8px;"><span class="label"><i class="fas fa-check-circle" style="color: #00cc66;"></i> Репозиторий:</span> ${esc(repo.full_name)} (${repo.private ? 'приватный' : 'публичный'})</div>
            <div class="token-info" style="margin-top: 8px;"><span class="label"><i class="fas fa-${canPush === false ? 'times-circle' : 'check-circle'}" style="color: ${canPush === false ? '#ff4444' : '#00cc66'};"></i> Запись в репозиторий:</span> ${canPush === null ? 'нет данных' : canPush ? 'есть' : 'НЕТ — сохранение не удастся'}</div>
            <div class="token-info" style="margin-top: 8px;"><span class="label"><i class="fas fa-${hasIndex ? 'check-circle' : 'exclamation-circle'}" style="color: ${hasIndex ? '#00cc66' : '#ff9900'};"></i> index.html в ветке ${esc(currentBranch)}:</span> ${hasIndex ? 'найден' : 'НЕ НАЙДЕН'}</div>
        `;
        if (canPush === false) showErrorDetails('Нет прав записи', 'WARNING', '', 'Выдайте токену право Contents: Read and write на этот репозиторий.');
        else if (!hasIndex) showErrorDetails('Файл index.html не найден', '404', `Ветка "${currentBranch}" или файл не существует`, 'Создайте index.html в корне репозитория или проверьте ветку в config.js.');
        const ok = hasIndex && canPush !== false;
        showStatus(ok ? 'Токен валиден' : 'Есть проблемы — см. подробности', ok ? 'success' : 'error');
        return ok;
    } catch (e) {
        const i = interpretError(e.status, e.body);
        box.innerHTML = `<div class="token-info"><span class="label"><i class="fas fa-times-circle" style="color: #ff4444;"></i> Ошибка:</span> ${esc(e.message)}</div>`;
        showErrorDetails(i.title, e.status || 'сеть', e.body || e.message, i.fix);
        showStatus('✗ ' + i.title, 'error');
        return false;
    }
}

async function login() {
    const t = $('tokenInput').value.trim();
    if (!t) return;
    const btn = $('loginBtn');
    btn.disabled = true; btn.textContent = 'Проверка...';
    token = t;
    try {
        await gh('https://api.github.com/user');
        ss.set('gh_token', t);
        enterApp();
    } catch (e) {
        token = null;
        const i = interpretError(e.status, e.body);
        $('loginError').innerHTML = `<strong>${esc(i.title)}</strong><br><small>${esc(i.fix)}</small>`;
        $('loginError').classList.add('show');
        btn.disabled = false; btn.textContent = 'Войти';
    }
}

$('loginBtn').addEventListener('click', login);
$('tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

async function enterApp() {
    $('loginScreen').style.display = 'none';
    $('editorApp').classList.add('active');
    updateRepoHeader();
    updatePageIndicator();
    await resolveRepoContext();
    updatePageIndicator();
    loadPagesList();
    // НОВОЕ: восстановить черновик правок
    loadPendingDraft();
    try {
        let f;
        try { f = await getFile(currentFile); }
        catch (e) {
            if (e.status === 404 && currentFile !== 'index.html') {
                showStatus(`⚠ Файл "${currentFile}" не найден — переключаемся на index.html`, 'info');
                currentFile = 'index.html'; saveCurrentRepoState(); updatePageIndicator();
                f = await getFile(currentFile);
            } else throw e;
        }
        if (isAdminSelf(currentFile)) {
            showSetup();
            showErrorDetails('Админка лежит в корне сайта', 'CONFIG', 'Текущий файл совпадает с файлом самой админ-панели.', 'Переместите этот файл в папку admin/ (admin/index.html), а сайт оставьте в корневом index.html. Иначе редактор будет править сам себя.');
            return;
        }
        if (f.text.includes('data-edit="')) {
            repoDeployId = readDeployId(f.text);
            showEditor();
        } else { showSetup(); await checkToken(); }
    } catch (e) {
        showSetup();
        if (e.status === 404) showErrorDetails('Файл не найден', 404, `В репозитории ${currentOwner}/${currentRepo} ветка ${currentBranch}`, 'Проверьте имя файла и ветку.');
        else if (e.status === 401 || e.status === 403) await checkToken();
        else { const i = interpretError(e.status, e.body); showErrorDetails(i.title, e.status || 'unknown', e.body || e.message, i.fix); }
    }
}

function logout() {
    if (Object.keys(pending).length && !confirm('Есть несохранённые изменения. Выйти?')) return;
    ss.del('gh_token');
    ls.del('cms_currentFile');
    ls.del('cms_currentOwner');
    ls.del('cms_currentRepo');
    clearPendingDraft();
    location.reload();
}

function showSetup() {
    $('setupScreen').classList.add('active');
    $('iframeWrapper').style.display = 'none';
    if (ls.get('cms_hintHidden') !== '1') $('hintBanner').style.display = 'block';
    $('prepareBtn').disabled = false;
    $('prepareBtn').innerHTML = '<i class="fas fa-download"></i> Подготовить страницу';
    $('setupTitle').textContent = `Подготовка: ${currentOwner}/${currentRepo}/${currentFile}`;
}

function showEditor() {
    $('setupScreen').classList.remove('active');
    $('iframeWrapper').style.display = 'flex';
    if (ls.get('cms_hintHidden') !== '1') $('hintBanner').style.display = 'block';
    loadSite();
}

function buildPreviewHtml(text) {
    const d = new DOMParser().parseFromString(text, 'text/html');
    d.querySelectorAll('meta[http-equiv="refresh" i]').forEach(n => n.remove());
    d.querySelectorAll('base').forEach(b => b.remove());
    const base = d.createElement('base');
    base.setAttribute('href', pageUrl().href);
    d.head.insertBefore(base, d.head.firstChild);
    return '<!DOCTYPE html>\n' + d.documentElement.outerHTML;
}

async function loadSite(skipVerify = false) {
    viewModeUrl = null;
    updatePageIndicator();
    const ifr = $('siteIframe');
    const loader = $('iframeLoader');
    const status = $('loaderStatus');
    loader.classList.remove('hidden');
    ifr.setAttribute('sandbox', PREVIEW_SANDBOX);
    status.textContent = 'Загрузка ' + currentFile + ' из ' + currentOwner + '/' + currentRepo + '...';
    try {
        const f = await getFile(currentFile);
        status.textContent = 'Подготовка превью...';
        repoDeployId = readDeployId(f.text);
        const html = buildPreviewHtml(f.text);
        ifr.onload = () => {
            hookIframe();
            loader.classList.add('hidden');
            if (!skipVerify) verifyDeploy(repoDeployId, true);
        };
        ifr.srcdoc = html;
    } catch (e) {
        status.textContent = 'Ошибка: ' + e.message;
        setTimeout(() => {
            ifr.removeAttribute('srcdoc');
            ifr.onload = () => { hookIframe(); loader.classList.add('hidden'); };
            ifr.src = pageUrl().href + '?t=' + Date.now();
        }, 1000);
    }
}

function reloadPreview() {
    if (Object.keys(pending).length) {
        if (!confirm('Несохранённые правки в превью пропадут. Обновить?')) return;
        pending = {}; markUnsaved();
    }
    loadSite();
    showStatus('Обновляем превью...', 'info');
}

function isInternalPage(href) {
    if (href === undefined || href === null) return false;
    if (href.trim().startsWith('#')) return false;
    if (href === '' || href === '/' || href === './') return true;
    const clean = href.split(/[?#]/)[0];
    if (/^(tel:|mailto:|javascript:|data:)/i.test(clean)) return false;
    if (!/^(https?:|\/\/)/i.test(clean)) {
        if (clean === '' || clean === '.') return true;
        if (clean.endsWith('/')) return true;
        if (clean.startsWith('/') && clean.replace(/\/+$/, '') === siteBasePathNoSlash()) return true;
        return /\.html?$/i.test(clean);
    }
    try {
        const url = new URL(clean.startsWith('//') ? 'https:' + clean : clean);
        const base = new URL(siteBaseUrl);
        if (url.hostname !== base.hostname) return false;
        const normalizedUrlPath = url.pathname.replace(/\/+$/, '');
        const normalizedBasePath = base.pathname.replace(/\/+$/, '');
        if (normalizedUrlPath === normalizedBasePath) return true;
        if (normalizedBasePath && !url.pathname.startsWith(normalizedBasePath + '/')) return false;
        return /\.html?$/i.test(url.pathname);
    } catch { return false; }
}

function normalizePagePath(href) {
    if (href === '' || href === '/' || href === './') return 'index.html';
    let p = href.split(/[?#]/)[0];
    if (/^(https?:|\/\/)/i.test(p)) {
        try {
            const u = new URL(p.startsWith('//') ? 'https:' + p : p);
            const basePathNoSlash = siteBasePathNoSlash();
            const up = u.pathname.replace(/\/+$/, '');
            if (up === basePathNoSlash) return 'index.html';
            p = u.pathname;
        } catch {}
        try { p = decodeURIComponent(p); } catch {}
        if (siteBasePath !== '/' && p.startsWith(siteBasePath)) p = p.slice(siteBasePath.length);
        p = p.replace(/^\/+/, '');
    } else {
        try { p = decodeURIComponent(p); } catch {}
        if (p.startsWith('/')) {
            const basePathNoSlash = siteBasePathNoSlash();
            const pp = p.replace(/\/+$/, '');
            if (pp === basePathNoSlash) return 'index.html';
            if (siteBasePath !== '/' && p.startsWith(siteBasePath)) p = p.slice(siteBasePath.length);
            p = p.replace(/^\/+/, '');
        } else {
            if (p === '' || p === '.') return 'index.html';
            if (p.endsWith('/')) {
                const resolved = resolveRepoPath(p + 'index.html');
                return resolved || 'index.html';
            }
            const r = resolveRepoPath(p);
            p = r || '';
        }
    }
    p = p.replace(/^(\.\/)+/, '');
    if (!p || p === '.') return 'index.html';
    if (p.split('/').some(s => s === '..')) return '';
    return p;
}

async function prepareCurrentFile(logContainer = null) {
    const btn = $('prepareBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Подготовка...'; }
    const fileBeingPrepared = currentFile;
    const li = (msg, type = '') => {
        if (logContainer) {
            const div = document.createElement('div');
            div.className = 'log-item ' + type;
            div.textContent = (type === 'done' ? '✓ ' : type === 'error' ? '✗ ' : '> ') + msg;
            logContainer.appendChild(div);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    };
    try {
        if (isAdminSelf(fileBeingPrepared)) {
            li('Операция отменена: это файл самой админ-панели', 'error');
            showStatus('Админку нельзя редактировать через саму себя. Переместите её в папку admin/.', 'error');
            return false;
        }
        li('Загрузка ' + fileBeingPrepared + ' из ' + currentOwner + '/' + currentRepo + '...', 'working');
        const f = await getFile(fileBeingPrepared);
        if (!f.text.trim()) throw new Error(fileBeingPrepared + ' пуст или не прочитан');
        li(`${fileBeingPrepared} загружен (${(f.text.length / 1024).toFixed(1)} КБ)`, 'done');
        if (f.text.includes('data-edit="') || f.text.includes('data-img=')) {
            li('Обнаружены старые метки — очищаем...', 'working');
            const cleaned = cleanHtmlMarks(f.text);
            f.text = cleaned.html;
            li(`Удалено: ${cleaned.removedEdit} text-меток и ${cleaned.removedImg} img-меток`, 'done');
        }
        li('Анализ контента и расстановка меток...', 'working');
        const r = processHtml(f.text);
        li(`Найдено ${r.textCount} текстов и ${r.imgCount} картинок`, 'done');
        li('Сохранение подготовленного ' + fileBeingPrepared + '...', 'working');
        const deployId = newDeployId();
        const stamped = stampDeployId(r.html, deployId);
        await putFile(fileBeingPrepared, b64e(stamped), f.sha, `Подготовка ${fileBeingPrepared} к редактированию`);
        repoDeployId = deployId;
        li(fileBeingPrepared + ' обновлён в ' + currentOwner + '/' + currentRepo, 'done');
        li('Подготовка завершена!', 'done');
        return true;
    } catch (e) {
        li('Ошибка: ' + e.message, 'error');
        const i = interpretError(e.status, e.body);
        showErrorDetails(i.title, e.status || 'ошибка', e.body || e.message, i.fix);
        showStatus(`✗ ${i.title}`, 'error');
        return false;
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Подготовить страницу'; }
    }
}

async function prepareSite() {
    const log = $('progressLog');
    log.style.display = 'block'; log.innerHTML = '';
    $('errorDetails').innerHTML = '';
    const ok = await prepareCurrentFile(log);
    if (ok) setTimeout(() => { showStatus('Страница подготовлена! Открываем редактор...'); setTimeout(showEditor, 500); }, 300);
}

function restoreAfterFailedNav(prevFile, prevView) {
    currentFile = prevFile;
    viewModeUrl = prevView;
    saveCurrentFile();
    updatePageIndicator();
    $('setupScreen').classList.remove('active');
    if (prevView) {
        $('iframeWrapper').style.display = 'flex';
        if (ls.get('cms_hintHidden') !== '1') $('hintBanner').style.display = 'block';
    } else {
        showEditor();
    }
}

async function navigateTo(href) {
    const cleanPath = normalizePagePath(href);
    if (!cleanPath) { showStatus('Не удалось определить страницу по ссылке: ' + href, 'error'); updatePageIndicator(); return; }
    if (isAdminSelf(cleanPath)) {
        showStatus('⚠ Это файл самой админ-панели — редактировать его нельзя.', 'error');
        updatePageIndicator();
        return;
    }
    if (cleanPath === currentFile && !viewModeUrl) { reloadPreview(); return; }
    if (Object.keys(pending).length) {
        if (!confirm('Есть несохранённые правки. При переходе они будут потеряны. Продолжить?')) { updatePageIndicator(); return; }
        pending = {}; markUnsaved();
    }
    const prevFile = currentFile;
    const prevView = viewModeUrl;
    currentFile = cleanPath;
    saveCurrentFile();
    viewModeUrl = null;
    updatePageIndicator();
    showStatus('Открываю ' + cleanPath + '...', 'info');
    try {
        const f = await getFile(currentFile);
        if (f.text.includes('data-edit="')) {
            repoDeployId = readDeployId(f.text);
            showEditor();
            showStatus('✓ ' + cleanPath + ' открыта для редактирования', 'success');
        } else {
            showSetup();
            $('errorDetails').innerHTML = '';
            const log = $('progressLog');
            log.style.display = 'block'; log.innerHTML = '';
            showStatus('Страница не подготовлена — подготавливаю ' + cleanPath + '...', 'info');
            const ok = await prepareCurrentFile(log);
            if (ok) {
                showEditor();
                showStatus('✓ Страница ' + cleanPath + ' готова к редактированию!', 'success');
            } else {
                restoreAfterFailedNav(prevFile, prevView);
            }
        }
    } catch (e) {
        const i = interpretError(e.status, e.body);
        showStatus('✗ Не удалось открыть ' + cleanPath + ': ' + (e.status === 404 ? 'страница не найдена в репозитории' : i.title), 'error');
        restoreAfterFailedNav(prevFile, prevView);
    }
}

function openExternalInIframe(url) {
    viewModeUrl = url;
    updatePageIndicator();
    $('setupScreen').classList.remove('active');
    $('iframeWrapper').style.display = 'flex';
    if (ls.get('cms_hintHidden') !== '1') $('hintBanner').style.display = 'block';
    const ifr = $('siteIframe');
    $('iframeLoader').classList.remove('hidden');
    $('loaderStatus').textContent = 'Открываю ссылку в режиме просмотра...';
    ifr.setAttribute('sandbox', VIEW_SANDBOX);
    ifr.removeAttribute('srcdoc');
    ifr.onload = () => { $('iframeLoader').classList.add('hidden'); };
    ifr.src = url;
    showStatus('Режим просмотра: редактирование недоступно. Нажмите «Домой» для возврата.', 'info');
}

function goHome() {
    if (currentFile === 'index.html' && !viewModeUrl) { reloadPreview(); return; }
    navigateTo('index.html');
}

function openLiveSite() { window.open(viewModeUrl ? viewModeUrl : pageUrl().href, '_blank', 'noopener'); }

// ===== НОВОЕ: Подсветка выбранного элемента в iframe =====
function highlightElementInIframe(key) {
    clearHighlightInIframe();
    highlightedElKey = key;
    let d;
    try { d = $('siteIframe').contentDocument; } catch { return; }
    if (!d) return;
    const el = d.querySelector(`[data-edit="${CSS.escape(key)}"], [data-img-id="${CSS.escape(key)}"]`);
    if (!el) return;
    el.setAttribute('data-cms-active', '1');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearHighlightInIframe() {
    highlightedElKey = null;
    let d;
    try { d = $('siteIframe').contentDocument; } catch { return; }
    if (!d) return;
    d.querySelectorAll('[data-cms-active]').forEach(el => el.removeAttribute('data-cms-active'));
}

function hookIframe() {
    let d;
    try { d = $('siteIframe').contentDocument; } catch { d = null; }
    if (!d || !d.head) {
        showStatus('Нет доступа к превью (sandbox)', 'error');
        return;
    }
    // НОВОЕ: добавлен data-cms-active стиль
    const st = d.createElement('style');
    st.textContent = `
        [data-edit]:hover, [data-img]:hover { outline: 2px dashed #F40009; outline-offset: 2px; cursor: pointer; }
        [data-cms-active="1"] { outline: 3px solid #F40009 !important; outline-offset: 3px; background: rgba(244, 0, 9, 0.08) !important; }
    `;
    d.head.appendChild(st);

    function hideLoadedPlaceholders() {
        d.querySelectorAll('.placeholder-label').forEach(ph => {
            const holder = ph.parentElement;
            if (!holder) return;
            const img = holder.querySelector('img');
            if (!img) return;
            const hide = () => { if (img.complete && img.naturalWidth > 0) ph.style.display = 'none'; };
            if (img.complete) hide();
            img.addEventListener('load', hide);
            img.addEventListener('error', () => { if (ph.style.display !== 'none') ph.style.display = ''; });
        });
    }
    hideLoadedPlaceholders();

    const handleModifierOpen = ev => {
        const linkEl = ev.target.closest && ev.target.closest('a[href]');
        if (!linkEl) return false;
        ev.preventDefault(); ev.stopPropagation();
        openSafe((linkEl.getAttribute('href') || '').trim());
        return true;
    };

    d.addEventListener('auxclick', ev => { if (ev.button === 1) handleModifierOpen(ev); }, true);
    d.addEventListener('submit', ev => { ev.preventDefault(); }, true);

    d.addEventListener('click', ev => {
        if (ev.altKey) {
            const linkEl = ev.target.closest && ev.target.closest('a[href]');
            if (linkEl) {
                ev.preventDefault();
                ev.stopPropagation();
                const href = (linkEl.getAttribute('href') || '').trim();
                if (href === '') return;
                if (/^(tel:|mailto:)/i.test(href)) { openSafe(href); return; }
                if (/^javascript:/i.test(href)) return;
                if (href.startsWith('#')) {
                    const id = href.slice(1);
                    const target = id ? (d.getElementById(id) || d.querySelector(`[name="${CSS.escape(id)}"]`)) : null;
                    if (target) target.scrollIntoView({ behavior: 'smooth' });
                    return;
                }
                if (isInternalPage(href)) { navigateTo(href); return; }
                const abs = safeAbs(href);
                if (abs && /^https?:/i.test(abs)) openExternalInIframe(abs);
                return;
            }
            ev.preventDefault();
            return;
        }
        if (ev.ctrlKey || ev.metaKey) {
            if (handleModifierOpen(ev)) return;
        }
        const textEl = ev.target.closest && ev.target.closest('[data-edit]');
        if (textEl) { ev.preventDefault(); ev.stopPropagation(); openText(textEl.getAttribute('data-edit'), textEl.textContent); return; }
        const imgEl = ev.target.closest && ev.target.closest('[data-img]');
        if (imgEl) {
            ev.preventDefault(); ev.stopPropagation();
            const path = imgEl.getAttribute('data-img');
            const imgId = imgEl.getAttribute('data-img-id') || '';
            const actualImg = imgEl.tagName === 'IMG' ? imgEl : imgEl.querySelector('img');
            openImage(path, actualImg ? (actualImg.currentSrc || actualImg.src) : '', imgId);
            return;
        }
        const linkEl = ev.target.closest && ev.target.closest('a[href]');
        if (linkEl) ev.preventDefault();
    }, true);
    d.addEventListener('keydown', ev => { if (ev.key === 'Escape') closePanel(); });
}

// ===== Горячие клавиши: Esc, Ctrl+L, Ctrl+S, Ctrl+Enter =====
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('editPanel').classList.contains('active')) closePanel();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && $('editorApp').classList.contains('active')) {
        e.preventDefault();
        const inp = $('addressInput');
        inp.focus(); inp.select();
    }
    // НОВОЕ: Ctrl+S — сохранить
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if ($('editorApp').classList.contains('active')) saveAll();
    }
    // НОВОЕ: Ctrl+Enter — применить в панели редактирования
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && $('editPanel').classList.contains('active')) {
        e.preventDefault();
        applyEdit();
    }
});

function syncHref(el, newValue) {
    const link = el.closest('a[href]');
    if (!link || link.hasAttribute('data-cms-link')) return;
    const href = link.getAttribute('href') || '';
    const v = newValue.trim();
    if (/^tel:/i.test(href)) {
        const clean = v.replace(/[^\d+]/g, '');
        if (clean.length >= 7) link.setAttribute('href', 'tel:' + clean);
        return;
    }
    if (/^mailto:/i.test(href)) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) link.setAttribute('href', 'mailto:' + v);
        return;
    }
    let host = '';
    try { host = new URL(href, 'https://x.invalid').hostname.replace(/^www\./, '').toLowerCase(); } catch { return; }
    if (host === 't.me' || host === 'telegram.me') {
        const u = v.replace(/^@/, '').replace(/^https?:\/\/(t\.me|telegram\.me)\//, '');
        if (/^[a-zA-Z0-9_]{3,}$/.test(u)) link.setAttribute('href', 'https://t.me/' + u);
    } else if (host === 'wa.me') {
        const clean = v.replace(/[^\d]/g, '');
        if (clean.length >= 7) link.setAttribute('href', 'https://wa.me/' + clean);
    } else if (host === 'vk.com') {
        const u = v.replace(/^@/, '').replace(/^https?:\/\/(www\.)?vk\.com\//, '');
        if (/^[a-zA-Z0-9_.]+$/.test(u)) link.setAttribute('href', 'https://vk.com/' + u);
    } else if (host === 'instagram.com') {
        const u = v.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '');
        if (/^[a-zA-Z0-9_.]+$/.test(u)) link.setAttribute('href', 'https://instagram.com/' + u);
    }
}

function findImgTargets(doc, key, path) {
    if (!doc) return [];
    if (key && /^img_\d+$/.test(key)) {
        const el = doc.querySelector(`[data-img-id="${CSS.escape(key)}"]`);
        return el ? [el] : [];
    }
    const lookupPath = path || key;
    if (!lookupPath) return [];
    return Array.from(doc.querySelectorAll(`[data-img="${CSS.escape(lookupPath)}"]`));
}

function readTextLink(key) {
    const dflt = { url: '', linkColor: 'inherit', linkTarget: '_blank', fileName: '' };
    let d = null;
    try { d = $('siteIframe').contentDocument; } catch {}
    if (!d) return dflt;
    const el = d.querySelector(`[data-edit="${CSS.escape(key)}"]`);
    if (!el) return dflt;
    const link = el.closest('a[data-cms-link]');
    if (!link) return dflt;
    const storedColor = link.getAttribute('data-link-color') || 'inherit';
    const target = link.getAttribute('target') || '_blank';
    return {
        url: link.getAttribute('href') || '',
        linkColor: LINK_COLORS[storedColor] !== undefined ? storedColor : 'inherit',
        linkTarget: target === '_self' ? '_self' : '_blank',
        fileName: link.getAttribute('data-cms-file') || ''
    };
}

function readImageLink(key, path) {
    let d = null;
    try { d = $('siteIframe').contentDocument; } catch {}
    if (!d) return { url: '', linkTarget: '_blank', alt: '' };
    const targets = findImgTargets(d, key, path);
    if (!targets.length) return { url: '', linkTarget: '_blank', alt: '' };
    const target = targets[0];
    let linkEl = target.tagName === 'A' ? target : (target.closest ? target.closest('a') : null);
    if (!linkEl && target.querySelector) {
        const inner = target.querySelector('img');
        linkEl = inner ? inner.closest('a') : null;
    }
    // НОВОЕ: читаем alt
    let alt = '';
    const imgEl = target.tagName === 'IMG' ? target : (target.querySelector ? target.querySelector('img') : null);
    if (imgEl) alt = imgEl.getAttribute('alt') || '';

    if (!linkEl) return { url: '', linkTarget: '_blank', alt };
    const href = linkEl.getAttribute('href') || '';
    const targetAttr = linkEl.getAttribute('target') || '_blank';
    if (linkEl.hasAttribute('data-cms-link') || (!/^(tel:|mailto:|#)/i.test(href))) {
        return { url: href, linkTarget: targetAttr === '_self' ? '_self' : '_blank', alt };
    }
    return { url: '', linkTarget: '_blank', alt };
}

function applyLinkToText(doc, el, url, keepColor, linkColor, linkTarget, fileName) {
    if (!el) return;
    let link = el.closest ? el.closest('a') : null;
    if (url && url.trim()) {
        url = url.trim();
        if (!link) {
            link = doc.createElement('a');
            el.parentNode.insertBefore(link, el);
            link.appendChild(el);
        }
        link.setAttribute('data-cms-link', '1');
        link.setAttribute('href', url);
        link.setAttribute('target', linkTarget === '_self' ? '_self' : '_blank');
        if (linkTarget === '_blank') link.setAttribute('rel', 'noopener');
        else link.removeAttribute('rel');
        if (fileName !== undefined) {
            if (fileName) link.setAttribute('data-cms-file', fileName);
            else link.removeAttribute('data-cms-file');
        }
        const colorKey = linkColor && LINK_COLORS[linkColor] !== undefined ? linkColor : 'inherit';
        link.setAttribute('data-link-color', colorKey);
        if (colorKey === 'inherit' || keepColor) {
            link.style.color = 'inherit';
            link.style.textDecoration = 'none';
            if (keepColor) link.setAttribute('data-keep-color', '1');
            else link.removeAttribute('data-keep-color');
        } else {
            link.removeAttribute('data-keep-color');
            link.style.color = LINK_COLORS[colorKey];
            link.style.textDecoration = 'underline';
        }
    } else if (link && link.hasAttribute('data-cms-link')) {
        link.parentNode.insertBefore(el, link);
        if (link.textContent.trim() === '' && !link.querySelector('img, [data-edit], [data-img]')) {
            link.parentNode.removeChild(link);
        } else {
            ['data-cms-link', 'data-keep-color', 'data-link-color', 'data-cms-file', 'href', 'target', 'rel'].forEach(a => link.removeAttribute(a));
            link.style.color = '';
            link.style.textDecoration = '';
        }
    }
}

function applyLinkToImage(doc, target, url, linkTarget = '_blank') {
    if (!target) return;
    const isA = target.tagName === 'A';
    const findInner = () => {
        if (!target.querySelector) return null;
        const img = target.querySelector('img');
        const a = img ? img.closest('a') : null;
        return a && target.contains(a) ? a : null;
    };
    if (!url || !url.trim()) {
        const link = isA ? target : ((target.closest && target.closest('a')) || findInner());
        if (!link) return;
        if (link === target) {
            ['href', 'target', 'rel', 'data-cms-link'].forEach(a => link.removeAttribute(a));
            return;
        }
        while (link.firstChild) link.parentNode.insertBefore(link.firstChild, link);
        link.parentNode.removeChild(link);
        return;
    }
    url = url.trim();
    let link = isA ? target : ((target.closest && target.closest('a')) || findInner());
    if (!link) {
        const hasInnerA = target.querySelector && target.querySelector('a');
        const wrapNode = hasInnerA ? (target.querySelector('img') || target) : target;
        link = doc.createElement('a');
        wrapNode.parentNode.insertBefore(link, wrapNode);
        link.appendChild(wrapNode);
    }
    link.setAttribute('data-cms-link', '1');
    link.setAttribute('href', url);
    link.setAttribute('target', linkTarget === '_self' ? '_self' : '_blank');
    if (linkTarget === '_blank') link.setAttribute('rel', 'noopener');
    else link.removeAttribute('rel');
}

function cleanHtmlMarks(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const beforeEdit = doc.querySelectorAll('[data-edit]').length;
    const beforeImg = doc.querySelectorAll('[data-img]').length;
    doc.querySelectorAll('[data-edit]').forEach(el => {
        const parent = el.parentNode;
        if (!parent) return;
        const pure = el.tagName === 'SPAN' && el.attributes.length === 1;
        if (pure) {
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
        } else el.removeAttribute('data-edit');
    });
    doc.querySelectorAll('[data-img], [data-img-id]').forEach(el => {
        el.removeAttribute('data-img');
        el.removeAttribute('data-img-id');
    });
    doc.body.normalize();
    return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, removedEdit: beforeEdit, removedImg: beforeImg };
}

function processHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let textCounter = 0;
    const SKIP_TAGS = new Set(['script', 'style', 'title', 'meta', 'noscript', 'input', 'textarea', 'select', 'option', 'head', 'link', 'template']);
    const extra = (CMS_CONFIG.extraEditableSelectors || []).concat('[data-editable]').join(', ');
    const forced = new Set();
    try { doc.querySelectorAll(extra).forEach(el => forced.add(el)); } catch {}

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.namespaceURI !== XHTML_NS) return NodeFilter.FILTER_REJECT;
            if (parent.closest('svg, math, script, style, textarea, select, noscript, template')) return NodeFilter.FILTER_REJECT;
            if (!forced.has(parent) && SKIP_TAGS.has(parent.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
            if (parent.hasAttribute('data-edit')) return NodeFilter.FILTER_REJECT;
            const text = node.textContent;
            if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
            return /[\p{L}\p{N}]/u.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
    });
    const nodesToProcess = [];
    let node;
    while (node = walker.nextNode()) nodesToProcess.push(node);
    let textCount = 0;
    nodesToProcess.forEach(textNode => {
        const span = doc.createElement('span');
        span.setAttribute('data-edit', `auto_${++textCounter}`);
        span.textContent = textNode.textContent;
        textNode.parentElement.replaceChild(span, textNode);
        textCount++;
    });
    doc.querySelectorAll('[data-editable]').forEach(el => el.removeAttribute('data-editable'));

    const CORE_IMAGE_WRAPPERS = [
        '.img-wrapper', '.gallery-item', '.team-photo',
        '.about-img-wrapper', '.hero-img-wrapper', '.product-image',
        '.portfolio-card', '.space-card', '.portfolio-item'
    ];
    const wrapperSelector = [...CORE_IMAGE_WRAPPERS, ...(CMS_CONFIG.imageWrappers || [])].join(', ');
    let imgCount = 0, imgIdCounter = 0;
    doc.querySelectorAll('img').forEach(img => {
        if (img.hasAttribute('data-img')) return;
        const src = img.getAttribute('src');
        if (!src || /^(data:|blob:|https?:|\/\/)/i.test(src)) return;
        const path = resolveRepoPath(src);
        if (!path) return;
        let wrapper = null;
        try { wrapper = img.closest(wrapperSelector); } catch {}
        if (wrapper && wrapper.hasAttribute('data-img')) return;
        const imgId = 'img_' + (++imgIdCounter);
        const holder = wrapper || img;
        holder.setAttribute('data-img', path);
        holder.setAttribute('data-img-id', imgId);
        imgCount++;
    });
    return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, textCount, imgCount };
}

async function cleanMarks() {
    if (Object.keys(pending).length > 0) {
        if (!confirm('У вас есть несохранённые правки. Они будут потеряны при очистке. Продолжить?')) return;
        pending = {}; markUnsaved();
    }
    if (!confirm('Удалить ВСЕ метки редактирования (data-edit, data-img, data-img-id) из ' + currentFile + '?\n\nПравки текстов и ручные ссылки СОХРАНЯЮТСЯ.\nПосле очистки нужно снова нажать «Подготовить страницу».\n\nПродолжить?')) return;
    const btn = $('cleanBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Очищаю...';
    try {
        showStatus('Загружаю ' + currentFile + '...', 'info');
        const f = await getFile(currentFile);
        if (!f.text.includes('data-edit="') && !f.text.includes('data-img=')) {
            showStatus('Меток в файле нет — очищать нечего', 'info');
            return;
        }
        showStatus('Удаляю метки...', 'info');
        const result = cleanHtmlMarks(f.text);
        const deployId = newDeployId();
        const stamped = stampDeployId(result.html, deployId);
        showStatus('Сохраняю очищенный файл...', 'info');
        await putFile(currentFile, b64e(stamped), f.sha, `Очистка меток редактирования в ${currentFile}`);
        repoDeployId = deployId;
        showStatus(`✓ Очищено: ${result.removedEdit} text-меток и ${result.removedImg} img-меток.`, 'success');
        setTimeout(() => { showSetup(); $('setupTitle').textContent = 'Страница очищена — готова к подготовке'; }, 1500);
    } catch (e) {
        const i = interpretError(e.status, e.body);
        showStatus(`✗ Ошибка: ${i.title}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-broom"></i> Очистить метки';
    }
}

async function hidePlaceholders() {
    if (Object.keys(pending).length > 0) {
        if (!confirm('У вас есть несохранённые правки. Они будут потеряны. Продолжить?')) return;
        pending = {}; markUnsaved();
    }
    if (!confirm('Удалить ВСЕ заглушки (placeholder-label) из ' + currentFile + '?\n\nЗаглушки исчезнут физически. Чтобы вернуть — нажмите «Поставить заглушки».\n\nПродолжить?')) return;
    const btn = $('hidePlaceholdersBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Скрываю...';
    try {
        showStatus('Загружаю ' + currentFile + '...', 'info');
        const f = await getFile(currentFile);
        const doc = new DOMParser().parseFromString(f.text, 'text/html');
        const placeholders = doc.querySelectorAll('.placeholder-label');
        if (placeholders.length === 0) {
            showStatus('Заглушек в файле нет — скрывать нечего', 'info');
            return;
        }
        placeholders.forEach(ph => ph.parentNode.removeChild(ph));
        doc.body.normalize();
        const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
        const deployId = newDeployId();
        const stamped = stampDeployId(newHtml, deployId);
        showStatus(`Сохраняю (удалено ${placeholders.length} заглушек)...`, 'info');
        await putFile(currentFile, b64e(stamped), f.sha, `Скрытие заглушек в ${currentFile}`);
        repoDeployId = deployId;
        showStatus(`✓ Удалено ${placeholders.length} заглушек из ${currentFile}`, 'success');
        setDeployBadge('pending', '<i class="fas fa-spinner fa-spin"></i> Деплой...');
        setTimeout(() => { loadSite(true); verifyDeploy(repoDeployId, false); }, 500);
    } catch (e) {
        const i = interpretError(e.status, e.body);
        showStatus(`✗ Ошибка: ${i.title}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-eye-slash"></i> Скрыть заглушки';
    }
}

async function showPlaceholders() {
    if (Object.keys(pending).length > 0) {
        if (!confirm('У вас есть несохранённые правки. Они будут потеряны. Продолжить?')) return;
        pending = {}; markUnsaved();
    }
    if (!confirm('Добавить стандартные заглушки ко всем картинкам (data-img) в ' + currentFile + '?\n\nВНИМАНИЕ: если вы ранее редактировали текст заглушек — он будет заменён на стандартный.\n\nПродолжить?')) return;
    const btn = $('showPlaceholdersBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Создаю...';
    try {
        showStatus('Загружаю ' + currentFile + '...', 'info');
        const f = await getFile(currentFile);
        const doc = new DOMParser().parseFromString(f.text, 'text/html');
        const imgHolders = doc.querySelectorAll('[data-img]');
        let added = 0;
        let phCounter = 0;

        doc.querySelectorAll('[data-edit^="ph_img_"], [data-edit^="ph_txt_"]').forEach(el => {
            const m = el.getAttribute('data-edit').match(/^ph_(?:img|txt)_(\d+)$/);
            if (m) phCounter = Math.max(phCounter, parseInt(m[1], 10));
        });

        imgHolders.forEach(holder => {
            if (holder.querySelector('.placeholder-label')) return;
            const imgPath = holder.getAttribute('data-img') || '';
            const fileName = imgPath.split('/').pop() || 'image.jpg';
            const ph = doc.createElement('div');
            ph.className = 'placeholder-label';
            const strong = doc.createElement('strong');
            const spanImg = doc.createElement('span');
            spanImg.setAttribute('data-edit', `ph_img_${++phCounter}`);
            spanImg.textContent = fileName;
            strong.appendChild(spanImg);
            const spanTxt = doc.createElement('span');
            const innerSpan = doc.createElement('span');
            innerSpan.setAttribute('data-edit', `ph_txt_${++phCounter}`);
            innerSpan.textContent = 'Скриншот сайта';
            spanTxt.appendChild(innerSpan);
            ph.appendChild(strong);
            ph.appendChild(spanTxt);
            const img = holder.querySelector('img');
            if (img && img.nextSibling) holder.insertBefore(ph, img.nextSibling);
            else holder.appendChild(ph);
            added++;
        });

        if (added === 0) {
            showStatus('Все заглушки уже на месте — создавать нечего', 'info');
            return;
        }

        doc.body.normalize();
        const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
        const deployId = newDeployId();
        const stamped = stampDeployId(newHtml, deployId);
        showStatus(`Сохраняю (добавлено ${added} заглушек)...`, 'info');
        await putFile(currentFile, b64e(stamped), f.sha, `Добавление заглушек в ${currentFile}`);
        repoDeployId = deployId;
        showStatus(`✓ Добавлено ${added} заглушек в ${currentFile}`, 'success');
        setDeployBadge('pending', '<i class="fas fa-spinner fa-spin"></i> Деплой...');
        setTimeout(() => { loadSite(true); verifyDeploy(repoDeployId, false); }, 500);
    } catch (e) {
        const i = interpretError(e.status, e.body);
        showStatus(`✗ Ошибка: ${i.title}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-eye"></i> Поставить заглушки';
    }
}

function openPanel(title, key) {
    lastFocus = document.activeElement;
    $('editTitle').textContent = title;
    $('editKey').textContent = key;
    $('editPanel').classList.add('active');
    // НОВОЕ: подсветка выбранного элемента + автоскролл
    highlightElementInIframe(key);
}

// ===== НОВОЕ: Автосжатие фото через canvas =====
function compressImage(file, maxWidth = IMG_MAX_WIDTH, quality = IMG_QUALITY) {
    return new Promise((resolve, reject) => {
        // SVG и GIF не сжимаем (они могут быть анимированными или векторными)
        if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
            const r = new FileReader();
            r.onload = ev => resolve(ev.target.result);
            r.onerror = reject;
            r.readAsDataURL(file);
            return;
        }
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width <= maxWidth) {
                    // Размер в норме — просто отдаём как есть (без перекодирования)
                    resolve(ev.target.result);
                    return;
                }
                height = Math.round(height * maxWidth / width);
                width = maxWidth;
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, width, height);
                const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                const dataUrl = canvas.toDataURL(mime, quality);
                const origKB = Math.round(file.size / 1024);
                const newKB = Math.round((dataUrl.length * 3 / 4) / 1024);
                showStatus(`📦 Сжато: ${origKB} КБ → ${newKB} КБ (${width}×${height})`, 'info');
                resolve(dataUrl);
            };
            img.onerror = reject;
            img.src = ev.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function openText(key, value) {
    editKind = 'text'; editKey = key;
    panelFileData = null; panelFileNew = null; panelFileOld = null;
    openPanel('Редактирование текста', key);
    const linkData = readTextLink(key);
    editOrigText = linkData;
    $('editPanelContent').innerHTML = `
        <textarea id="editTextArea" aria-label="Текст"></textarea>
        <div class="link-section">
            <label class="field-label" for="editLink"><i class="fas fa-link" style="color:#F40009;"></i> Ссылка при клике на текст (необязательно)</label>
            <input type="url" id="editLink" placeholder="https://..." autocomplete="off">
            <div class="link-hint">Оставьте поле пустым, чтобы убрать ссылку с текста.</div>
        </div>
        <div class="link-section">
            <span class="field-label"><i class="fas fa-paperclip" style="color:#c9a961;"></i> Файл для скачивания (прайс, документ)</span>
            <div class="file-slot-box ok" id="fileSlotInfo">Проверяю папку ${FILES_FOLDER}/…</div>
            <label class="file-upload" id="docUploadLabel">
                <i class="fas fa-file-upload"></i>
                <div class="upload-text"><strong>Прикрепить файл</strong><br><small>Любой формат, до 1 МБ. Файл уйдёт в папку ${FILES_FOLDER}/</small></div>
                <input type="file" id="docFileInput">
            </label>
            <div id="filePreview" style="margin-top:8px;"></div>
        </div>
        <div class="link-option">
            <span class="field-label"><i class="fas fa-palette" style="color:#CD853F;"></i> Цвет ссылки</span>
            <div class="option-group">
                <label class="radio-label"><input type="radio" name="linkColor" value="inherit"><span class="color-preview inherit">Текущий</span></label>
                <label class="radio-label"><input type="radio" name="linkColor" value="brown"><span class="color-preview brown">Коричневый</span></label>
                <label class="radio-label"><input type="radio" name="linkColor" value="lightbrown"><span class="color-preview lightbrown">Светло-коричневый</span></label>
            </div>
        </div>
        <div class="link-option">
            <span class="field-label"><i class="fas fa-external-link-alt" style="color:#c9a961;"></i> Открывать ссылку</span>
            <div class="option-group">
                <label class="radio-label"><input type="radio" name="linkTarget" value="_blank"><span class="target-label">В новой вкладке</span></label>
                <label class="radio-label"><input type="radio" name="linkTarget" value="_self"><span class="target-label">В том же окне</span></label>
            </div>
        </div>
    `;
    const ta = $('editTextArea');
    ta.value = pending['t:' + key] ? pending['t:' + key].value : value.trim();
    $('editLink').value = linkData.url;
    const colorRadio = document.querySelector(`input[name="linkColor"][value="${linkData.linkColor}"]`) || document.querySelector('input[name="linkColor"][value="inherit"]');
    if (colorRadio) colorRadio.checked = true;
    const targetRadio = document.querySelector(`input[name="linkTarget"][value="${linkData.linkTarget}"]`) || document.querySelector('input[name="linkTarget"][value="_blank"]');
    if (targetRadio) targetRadio.checked = true;
    setTimeout(() => ta.focus(), 100);

    const slotNames = await listSlotFiles();
    const info = $('fileSlotInfo');
    const input = $('docFileInput');
    const label = $('docUploadLabel');
    if (!info || !input) return;
    const allNames = slotNames.concat(sessionFileNames);
    if (linkData.fileName) {
        panelFileOld = linkData.fileName;
        info.className = 'file-slot-box cur';
        info.innerHTML = `<i class="fas fa-file"></i> Текущий файл: <strong>${FILES_FOLDER}/${esc(linkData.fileName)}</strong><br>Загрузите новый — он получит следующий номер, а старый файл удалится.`;
    } else if (slotNames.length >= MAX_FILES) {
        info.className = 'file-slot-box full';
        info.innerHTML = `<i class="fas fa-exclamation-triangle"></i> В папке ${FILES_FOLDER}/ уже ${MAX_FILES} файла: ${slotNames.map(n => esc(n)).join(', ')}.<br>Чтобы прикрепить файл сюда — удалите ссылку с одного из текстов (освободите слот).`;
        label.classList.add('disabled');
        input.disabled = true;
    } else {
        const n = nextSlotNumber(allNames);
        info.className = 'file-slot-box ok';
        info.innerHTML = `<i class="fas fa-info-circle"></i> Файл запишется как <strong>${FILES_FOLDER}/${esc(FILES_BASE + (n === 0 ? '' : n))}.&lt;расширение вашего файла&gt;</strong><br>Занято ${slotNames.length} из ${MAX_FILES} слотов.`;
    }

    // НОВОЕ: drag&drop для файла
    setupDropZone(label, async file => {
        await handleDocFile(file, linkData);
    });

    input.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        await handleDocFile(file, linkData);
    });
}

async function handleDocFile(file, linkData) {
    if (file.size > MAX_FILE_SIZE) {
        return showStatus('Файл слишком большой (максимум 1 МБ)', 'error');
    }
    const m = file.name.match(/\.([^.]+)$/);
    const ext = m ? m[1].toLowerCase() : '';
    if (ext && BLOCKED_EXTS.includes(ext)) {
        return showStatus('Формат .' + ext + ' запрещён (исполняемые файлы)', 'error');
    }
    const slotNames = await listSlotFiles();
    const names = slotNames.concat(sessionFileNames);
    const newName = buildSlotName(nextSlotNumber(names), file.name);
    const rd = new FileReader();
    rd.onload = ev => {
        panelFileData = ev.target.result;
        panelFileNew = newName;
        panelFileOld = linkData.fileName || null;
        sessionFileNames.push(newName);
        $('editLink').value = FILES_FOLDER + '/' + newName;
        $('filePreview').innerHTML = `<div style="color: #00cc66; font-size: 13px;"><i class="fas fa-check-circle"></i> Файл: <strong>${esc(file.name)}</strong> (${(file.size / 1024).toFixed(0)} КБ) → будет записан как <strong>${FILES_FOLDER}/${esc(newName)}</strong>${panelFileOld ? ', старый ' + esc(panelFileOld) + ' удалится' : ''}</div>`;
    };
    rd.readAsDataURL(file);
}

function openImage(path, src, imgId) {
    editKind = 'image';
    editKey = imgId || path;
    editImagePath = path;
    pendingImg = null;
    openPanel('Замена изображения', path);
    const imgLinkData = readImageLink(editKey, path);
    editOrigImg = imgLinkData;

    const currentExt = (path.split('.').pop() || '').toLowerCase();
    const extDisplay = currentExt ? `<code style="background:#2a2a2a;padding:2px 6px;border-radius:3px;font-size:11px;">.${esc(currentExt)}</code>` : '';

    // НОВОЕ: поле alt
    $('editPanelContent').innerHTML = `
        <div style="margin-bottom: 16px;">
            <div style="color: #888; font-size: 13px; margin-bottom: 8px;">Текущее фото ${extDisplay}:</div>
            <img id="curImg" alt="" style="max-width: 100%; max-height: 180px; border-radius: 8px;">
        </div>
        <label class="file-upload" id="imageDropZone">
            <i class="fas fa-cloud-upload-alt"></i>
            <div class="upload-text"><strong>Выберите или перетащите изображение</strong><br><small>JPG, PNG, WebP, GIF, SVG. Большие фото (>1600px) сожмутся автоматически. Максимум 2 МБ после сжатия.</small></div>
            <input type="file" id="imageFileInput" accept="image/*">
        </label>
        <div id="imagePreview" style="margin-top: 12px;"></div>
        <div class="link-section">
            <label class="field-label" for="imgAlt"><i class="fas fa-font" style="color:#c9a961;"></i> Alt-текст (SEO и доступность)</label>
            <input type="text" id="imgAlt" placeholder="Описание фото..." autocomplete="off">
            <div class="link-hint">Краткое описание для поисковиков и незрячих пользователей.</div>
        </div>
        <div class="link-section">
            <label class="field-label" for="imgLink"><i class="fas fa-link" style="color:#F40009;"></i> Ссылка при клике на фото (необязательно)</label>
            <input type="url" id="imgLink" placeholder="https://..." autocomplete="off">
            <div class="link-hint">Куда переходить при клике по картинке. Оставьте пустым, чтобы убрать ссылку.</div>
        </div>
        <div class="link-option">
            <span class="field-label"><i class="fas fa-external-link-alt" style="color:#c9a961;"></i> Открывать ссылку</span>
            <div class="option-group">
                <label class="radio-label"><input type="radio" name="imgLinkTarget" value="_blank"><span class="target-label">В новой вкладке</span></label>
                <label class="radio-label"><input type="radio" name="imgLinkTarget" value="_self"><span class="target-label">В том же окне</span></label>
            </div>
        </div>
    `;
    if (src) $('curImg').src = src;
    $('imgLink').value = imgLinkData.url;
    $('imgAlt').value = imgLinkData.alt || '';
    const r = document.querySelector(`input[name="imgLinkTarget"][value="${imgLinkData.linkTarget}"]`) || document.querySelector('input[name="imgLinkTarget"][value="_blank"]');
    if (r) r.checked = true;

    // НОВОЕ: drag&drop
    const dropZone = $('imageDropZone');
    const fileInput = $('imageFileInput');
    setupDropZone(dropZone, async file => {
        await handleImageFile(file);
    });

    // НОВОЕ: Ctrl+V
    document.addEventListener('paste', handlePasteImage);

    fileInput.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        await handleImageFile(file);
    });
}

async function handleImageFile(file) {
    const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/bmp', 'image/x-icon'];
    if (!IMAGE_TYPES.includes(file.type) && !file.type.startsWith('image/')) {
        return showStatus('Файл должен быть изображением', 'error');
    }
    const fileExt = (file.name.split('.').pop() || '').toLowerCase();
    const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'ico'];
    if (!ALLOWED_EXTS.includes(fileExt)) {
        return showStatus('Неподдерживаемое расширение: .' + fileExt, 'error');
    }
    try {
        // НОВОЕ: автосжатие
        let compressed = await compressImage(file);
        // Проверка размера после сжатия
        const sizeBytes = Math.round(compressed.length * 3 / 4);
        if (sizeBytes > 2 * 1024 * 1024) {
            return showStatus('Даже после сжатия файл больше 2 МБ', 'error');
        }
        pendingImg = compressed;
        const origKB = Math.round(file.size / 1024);
        const newKB = Math.round(sizeBytes / 1024);
        $('imagePreview').innerHTML = `<div style="color: #00cc66; font-size: 13px;"><i class="fas fa-check-circle"></i> Файл: <strong>${esc(file.name)}</strong> (${origKB} КБ → ${newKB} КБ) — готов к загрузке</div>`;
    } catch (e) {
        showStatus('Ошибка обработки файла: ' + e.message, 'error');
    }
}

function handlePasteImage(e) {
    if (!$('editPanel').classList.contains('active') || editKind !== 'image') return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
            e.preventDefault();
            const file = items[i].getAsFile();
            if (file) handleImageFile(file);
            return;
        }
    }
}

// ===== НОВОЕ: Настройка зоны drag&drop =====
function setupDropZone(zone, onFile) {
    if (!zone) return;
    ['dragenter', 'dragover'].forEach(ev => {
        zone.addEventListener(ev, e => {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.add('dragover');
        });
    });
    ['dragleave', 'drop'].forEach(ev => {
        zone.addEventListener(ev, e => {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.remove('dragover');
        });
    });
    zone.addEventListener('drop', e => {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) onFile(file);
    });
}

function applyEdit() {
    let d = null;
    try { d = $('siteIframe').contentDocument; } catch {}

    if (editKind === 'text') {
        const v = $('editTextArea').value;
        let linkUrl = $('editLink').value.trim();
        if (!validLinkUrl(linkUrl)) return showStatus('Недопустимая ссылка (разрешены http, https, tel, mailto, #)', 'error');
        let fileNew = panelFileNew, fileOld = panelFileOld, fileData = panelFileData;
        if (!linkUrl) { fileNew = null; fileData = null; }
        const deleteOld = (!linkUrl && editOrigText && editOrigText.fileName && !fileData) ? editOrigText.fileName : null;
        const colorEl = document.querySelector('input[name="linkColor"]:checked');
        const targetEl = document.querySelector('input[name="linkTarget"]:checked');
        const linkColor = colorEl ? colorEl.value : 'inherit';
        const linkTarget = targetEl ? targetEl.value : '_blank';
        const keepColor = linkColor === 'inherit';
        const o = editOrigText || { url: '', linkColor: 'inherit', linkTarget: '_blank', fileName: '' };
        const prev = pending['t:' + editKey];
        const changed = linkUrl !== o.url || (!!linkUrl && (linkColor !== o.linkColor || linkTarget !== o.linkTarget));
        const linkChanged = changed || !!fileData || !!deleteOld || !!(prev && prev.linkChanged);
        pending['t:' + editKey] = {
            type: 'text', value: v, link: linkUrl, keepColor, linkColor, linkTarget, linkChanged,
            fileNew: fileNew || (prev && prev.fileNew) || null,
            fileOld: fileOld || (prev && prev.fileOld) || null,
            fileData: fileData || (prev && prev.fileData) || null,
            deleteOld: deleteOld || (prev && prev.deleteOld) || null
        };
        if (d) {
            const el = d.querySelector(`[data-edit="${CSS.escape(editKey)}"]`);
            if (el) {
                el.textContent = keepWs(el.textContent, v);
                if (linkChanged) applyLinkToText(d, el, linkUrl, keepColor, linkColor, linkTarget, fileData ? fileNew : undefined);
                if (!linkUrl) syncHref(el, v);
            }
        }
        showStatus((fileData ? 'Файл и ссылка применены.' : linkUrl ? 'Изменения и ссылка применены.' : 'Изменения применены.') + ' Сохраните в GitHub (Ctrl+S).');
    } else if (editKind === 'image') {
        const imgLinkUrl = $('imgLink').value.trim();
        if (!validLinkUrl(imgLinkUrl)) return showStatus('Недопустимая ссылка', 'error');
        const imgTargetEl = document.querySelector('input[name="imgLinkTarget"]:checked');
        const imgLinkTarget = imgTargetEl ? imgTargetEl.value : '_blank';
        // НОВОЕ: alt
        const imgAlt = $('imgAlt').value.trim();
        const o = editOrigImg || { url: '', linkTarget: '_blank', alt: '' };
        const prev = pending['i:' + editKey];
        const changed = imgLinkUrl !== o.url || (!!imgLinkUrl && imgLinkTarget !== o.linkTarget) || imgAlt !== (o.alt || '');
        const linkChanged = changed || !!(prev && prev.linkChanged);
        const data = pendingImg || (prev && prev.data) || null;
        if (!data && !linkChanged) return showStatus('Выберите файл или измените ссылку/alt', 'error');
        const path = editImagePath || editKey;
        pending['i:' + editKey] = { type: 'image', data, path, key: editKey, link: imgLinkUrl, linkTarget: imgLinkTarget, linkChanged, alt: imgAlt };
        if (d) {
            findImgTargets(d, editKey, path).forEach(target => {
                if (pendingImg) {
                    const img = target.tagName === 'IMG' ? target : target.querySelector('img');
                    if (img) {
                        img.removeAttribute('srcset');
                        const pic = img.closest('picture');
                        if (pic) pic.querySelectorAll('source').forEach(s => s.removeAttribute('srcset'));
                        img.src = pendingImg;
                    }
                }
                // НОВОЕ: применяем alt
                if (imgAlt !== undefined) {
                    const img = target.tagName === 'IMG' ? target : target.querySelector('img');
                    if (img) img.setAttribute('alt', imgAlt);
                }
                if (linkChanged) applyLinkToImage(d, target, imgLinkUrl, imgLinkTarget);
            });
        }
        if (pendingImg && changed && imgLinkUrl) showStatus('Фото и ссылка применены.');
        else if (changed && imgLinkUrl) showStatus('Ссылка на фото применена.');
        else if (pendingImg) showStatus('Фото изменено.');
        else showStatus('Изменения фото применены.');
    }
    markUnsaved();
    closePanel();
}

function closePanel() {
    $('editPanel').classList.remove('active');
    editKind = editKey = editImagePath = pendingImg = editOrigText = editOrigImg = null;
    panelFileData = panelFileNew = panelFileOld = null;
    // НОВОЕ: убираем paste listener и подсветку
    document.removeEventListener('paste', handlePasteImage);
    clearHighlightInIframe();
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch {} }
    lastFocus = null;
}

async function saveAll() {
    const keys = Object.keys(pending);
    if (!keys.length) return showStatus('Нет изменений для сохранения', 'info');
    const btn = $('saveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохранение...';
    const done = [], failed = [];
    try {
        const texts = keys.filter(k => pending[k].type === 'text');
        const images = keys.filter(k => pending[k].type === 'image');
        const imagesWithData = images.filter(k => pending[k].data);
        const imagesWithLinks = images.filter(k => pending[k].linkChanged);

        const fileUploads = texts.filter(k => pending[k].fileNew && pending[k].fileData);
        for (const k of fileUploads) {
            const p = pending[k];
            try {
                const fp = FILES_FOLDER + '/' + p.fileNew;
                await putFile(fp, p.fileData.split(',')[1], await getSha(fp), `Загрузка файла ${p.fileNew}`);
            } catch (e) { failed.push(k); }
        }

        const htmlTexts = texts.filter(k => !failed.includes(k));
        if (htmlTexts.length || imagesWithLinks.length) {
            const f = await getFile(currentFile);
            const doc = new DOMParser().parseFromString(f.text, 'text/html');

            for (const k of htmlTexts) {
                const p = pending[k];
                const el = doc.querySelector(`[data-edit="${CSS.escape(k.slice(2))}"]`);
                if (!el) { failed.push(k); continue; }
                el.textContent = keepWs(el.textContent, p.value);
                if (p.linkChanged) applyLinkToText(doc, el, p.link || '', p.keepColor || false, p.linkColor || 'inherit', p.linkTarget || '_blank', p.fileNew || undefined);
                if (!p.link) syncHref(el, p.value);
                done.push(k);
            }

            for (const k of imagesWithLinks) {
                const { path, link, key, linkTarget, alt } = pending[k];
                const targets = findImgTargets(doc, key || k.slice(2), path);
                if (targets.length) {
                    targets.forEach(t => {
                        applyLinkToImage(doc, t, link, linkTarget || '_blank');
                        // НОВОЕ: сохраняем alt
                        if (alt !== undefined) {
                            const img = t.tagName === 'IMG' ? t : t.querySelector('img');
                            if (img) img.setAttribute('alt', alt);
                        }
                    });
                } else failed.push(k);
            }

            const deployId = newDeployId();
            const stamped = stampDeployId('<!DOCTYPE html>\n' + doc.documentElement.outerHTML, deployId);
            await putFile(currentFile, b64e(stamped), f.sha, `Редактирование текстов и ссылок в ${currentFile}`);
            repoDeployId = deployId;
        }

        for (const k of texts) {
            if (failed.includes(k)) continue;
            const p = pending[k];
            if (p.fileOld && (p.fileNew || p.deleteOld)) {
                try { await delFile(FILES_FOLDER + '/' + p.fileOld); } catch {}
            } else if (p.deleteOld && !p.fileNew) {
                try { await delFile(FILES_FOLDER + '/' + p.deleteOld); } catch {}
            }
        }

        for (const k of imagesWithData) {
            const { path, data } = pending[k];
            // НОВОЕ: сохраняем alt для картинок с данными
            const altValue = pending[k].alt;
            try {
                await putFile(path, data.split(',')[1], await getSha(path), `Обновление изображения ${path}`);
                if (altValue !== undefined) {
                    // Перечитать HTML и обновить alt
                    try {
                        const f = await getFile(currentFile);
                        const doc = new DOMParser().parseFromString(f.text, 'text/html');
                        const targets = findImgTargets(doc, pending[k].key || k.slice(2), path);
                        targets.forEach(t => {
                            const img = t.tagName === 'IMG' ? t : t.querySelector('img');
                            if (img) img.setAttribute('alt', altValue);
                        });
                        const deployId = newDeployId();
                        const stamped = stampDeployId('<!DOCTYPE html>\n' + doc.documentElement.outerHTML, deployId);
                        await putFile(currentFile, b64e(stamped), f.sha, `Обновление alt для ${path}`);
                        repoDeployId = deployId;
                    } catch {}
                }
                if (!done.includes(k)) done.push(k);
            } catch (e) { if (!failed.includes(k)) failed.push(k); }
        }

        imagesWithLinks.forEach(k => { if (!done.includes(k) && !failed.includes(k)) done.push(k); });
        fileUploads.forEach(k => { if (!done.includes(k) && !failed.includes(k)) done.push(k); });

        done.filter(k => !failed.includes(k)).forEach(k => delete pending[k]);
        sessionFileNames = [];
        markUnsaved();
        if (failed.length) showStatus(`Сохранено: ${done.length}. Не сохранено: ${failed.length}.`, 'error');
        else {
            showStatus(`Сохранено в ${currentOwner}/${currentRepo}! Ждём деплой GitHub Pages...`, 'success');
            setDeployBadge('pending', '<i class="fas fa-spinner fa-spin"></i> Деплой...');
            setTimeout(() => { loadSite(true); verifyDeploy(repoDeployId, false); }, 500);
        }
    } catch (e) {
        const i = interpretError(e.status, e.body);
        showStatus(`✗ ${i.title}. ${i.fix}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Сохранить в GitHub';
    }
}

async function resetSite() {
    if (Object.keys(pending).length && !confirm('Есть несохранённые правки, они будут потеряны. Продолжить?')) return;
    if (!confirm('Переподготовить страницу ' + currentFile + '? Метки будут обновлены.')) return;
    pending = {}; markUnsaved();
    showSetup();
    $('setupTitle').textContent = 'Переподготовка ' + currentFile;
    $('progressLog').style.display = 'none';
    $('errorDetails').innerHTML = '';
}

// ===== НОВОЕ: Черновик правок в localStorage =====
function draftKey() { return `cms_draft_${currentOwner}_${currentRepo}_${currentFile}`; }
function savePendingDraft() {
    try {
        const keys = Object.keys(pending);
        if (keys.length === 0) { ls.del(draftKey()); return; }
        // Сохраняем только текстовые поля (без бинарных данных — они слишком большие)
        const toSave = {};
        keys.forEach(k => {
            const p = pending[k];
            const copy = { ...p };
            if (copy.data) copy._hadData = true; // флаг, но сами данные не сохраняем
            if (copy.fileData) copy._hadFileData = true;
            delete copy.data;
            delete copy.fileData;
            toSave[k] = copy;
        });
        ls.set(draftKey(), JSON.stringify(toSave));
    } catch {}
}
function loadPendingDraft() {
    try {
        const raw = ls.get(draftKey());
        if (!raw) return;
        const loaded = JSON.parse(raw);
        let count = 0;
        Object.keys(loaded).forEach(k => {
            pending[k] = loaded[k];
            // Помечаем что данные нужно ввести заново
            if (loaded[k]._hadData || loaded[k]._hadFileData) {
                pending[k]._needsReupload = true;
            }
            count++;
        });
        if (count > 0) {
            markUnsaved();
            showStatus(`Восстановлено ${count} несохранённых правок из черновика. Изображения нужно загрузить заново.`, 'info');
        }
    } catch {}
}
function clearPendingDraft() { ls.del(draftKey()); }

// ===== НОВОЕ: Preview режимы =====
document.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.preview-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        previewWidth = parseInt(btn.dataset.width);
        applyPreviewMode();
    });
});
function applyPreviewMode() {
    const wrapper = $('iframeWrapper');
    wrapper.classList.remove('mobile-375', 'tablet-768');
    if (previewWidth === 375) wrapper.classList.add('mobile-375');
    else if (previewWidth === 768) wrapper.classList.add('tablet-768');
}

// ===== НОВОЕ: Сворачивание подсказки =====
if (ls.get('cms_hintHidden') === '1') {
    $('hintBanner').style.display = 'none';
}
$('hintCloseBtn').addEventListener('click', () => {
    $('hintBanner').style.display = 'none';
    ls.set('cms_hintHidden', '1');
});

// ===== НОВОЕ: Модальные окна (универсальные) =====
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
});
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.classList.remove('show');
    });
});

// ===== НОВОЕ: Поиск по текстам =====
$('searchBtn').addEventListener('click', () => {
    openModal('searchModal');
    setTimeout(() => $('searchInput').focus(), 100);
    runSearch('');
});
$('searchInput').addEventListener('input', e => runSearch(e.target.value));

function runSearch(query) {
    const results = $('searchResults');
    const meta = $('searchMeta');
    results.innerHTML = '';
    let d;
    try { d = $('siteIframe').contentDocument; } catch { d = null; }
    if (!d) { meta.textContent = 'Превью не загружено'; return; }
    const all = d.querySelectorAll('[data-edit]');
    const q = query.trim().toLowerCase();
    const matches = [];
    all.forEach(el => {
        const text = el.textContent.trim();
        if (!text) return;
        if (!q || text.toLowerCase().includes(q)) {
            matches.push({ key: el.getAttribute('data-edit'), text });
        }
    });
    meta.textContent = `Найдено: ${matches.length} из ${all.length}`;
    if (matches.length === 0) {
        results.innerHTML = '<p class="empty" style="color:#666;text-align:center;padding:20px;">Ничего не найдено</p>';
        return;
    }
    matches.slice(0, 100).forEach(m => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        let displayText = esc(m.text);
        if (q) {
            const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            displayText = displayText.replace(re, '<mark>$1</mark>');
        }
        item.innerHTML = `<span class="sr-key">${esc(m.key)}</span><span>${displayText}</span>`;
        item.addEventListener('click', () => {
            closeModal('searchModal');
            highlightElementInIframe(m.key);
            openText(m.key, m.text);
        });
        results.appendChild(item);
    });
}

// ===== НОВОЕ: История версий =====
$('historyBtn').addEventListener('click', async () => {
    openModal('historyModal');
    $('historyFileName').textContent = currentFile;
    $('historyList').innerHTML = '<p style="color:#888;padding:20px;text-align:center;"><i class="fas fa-spinner fa-spin"></i> Загрузка...</p>';
    try {
        const r = await (await gh(`${API}/commits?path=${encPath(currentFile)}&per_page=30`)).json();
        const list = $('historyList');
        list.innerHTML = '';
        if (!Array.isArray(r) || r.length === 0) {
            list.innerHTML = '<p class="empty" style="color:#666;text-align:center;padding:20px;">История пуста</p>';
            return;
        }
        r.forEach(commit => {
            const item = document.createElement('div');
            item.className = 'history-item';
            const date = new Date(commit.commit.committer.date).toLocaleString('ru-RU');
            item.innerHTML = `
                <div class="history-info">
                    <div class="history-sha">${esc(commit.sha.slice(0, 8))}</div>
                    <div class="history-msg">${esc(commit.commit.message)}</div>
                    <div class="history-date">${esc(date)} · ${esc(commit.commit.author.name)}</div>
                </div>
                <button class="history-restore" data-sha="${esc(commit.sha)}" title="Вернуться к этой версии"><i class="fas fa-undo"></i> Откатить</button>
            `;
            item.querySelector('.history-restore').addEventListener('click', () => restoreFromCommit(commit.sha));
            list.appendChild(item);
        });
    } catch (e) {
        $('historyList').innerHTML = `<p class="empty" style="color:#ff4444;padding:20px;text-align:center;">Ошибка: ${esc(e.message)}</p>`;
    }
});

async function restoreFromCommit(sha) {
    if (!confirm(`Откатить ${currentFile} к версии ${sha.slice(0, 8)}?\nТекущие несохранённые правки будут потеряны.`)) return;
    if (Object.keys(pending).length) { pending = {}; markUnsaved(); }
    closeModal('historyModal');
    showStatus('Загружаю старую версию...', 'info');
    try {
        const r = await (await gh(`${API}/contents/${encPath(currentFile)}?ref=${sha}`)).json();
        const oldContent = b64d(r.content);
        const current = await getFile(currentFile);
        const deployId = newDeployId();
        const stamped = stampDeployId(oldContent, deployId);
        await putFile(currentFile, b64e(stamped), current.sha, `Откат к коммиту ${sha.slice(0, 8)}`);
        repoDeployId = deployId;
        showStatus(`✓ Откат выполнен к ${sha.slice(0, 8)}`, 'success');
        setDeployBadge('pending', '<i class="fas fa-spinner fa-spin"></i> Деплой...');
        setTimeout(() => { loadSite(true); verifyDeploy(repoDeployId, false); }, 500);
    } catch (e) {
        const i = interpretError(e.status, e.body);
        showStatus(`✗ Ошибка отката: ${i.title}`, 'error');
    }
}

// ===== НОВОЕ: Список правок =====
$('pendingBtn').addEventListener('click', () => {
    openModal('pendingModal');
    renderPendingList();
});

function renderPendingList() {
    const list = $('pendingList');
    const keys = Object.keys(pending);
    if (keys.length === 0) {
        list.innerHTML = '<p class="empty">Нет несохранённых правок</p>';
        return;
    }
    list.innerHTML = '';
    keys.forEach(k => {
        const p = pending[k];
        const item = document.createElement('div');
        item.className = 'pending-item';
        const typeLabel = p.type === 'text' ? 'Текст' : 'Фото';
        let desc = '';
        if (p.type === 'text') {
            desc = (p.value || '').slice(0, 80) + ((p.value || '').length > 80 ? '…' : '');
        } else {
            desc = p.path || p.key || k;
        }
        const warnIcon = p._needsReupload ? '<i class="fas fa-exclamation-triangle" style="color:#ff9900;margin-left:6px;" title="Фото нужно загрузить заново"></i>' : '';
        item.innerHTML = `
            <div>
                <span class="pi-type ${p.type}">${typeLabel}</span>
                <span class="pi-desc" title="${esc(desc)}">${esc(desc)}${warnIcon}</span>
            </div>
            <button class="pi-remove" title="Отменить эту правку" data-key="${esc(k)}"><i class="fas fa-times"></i></button>
        `;
        item.querySelector('.pi-remove').addEventListener('click', () => {
            delete pending[k];
            markUnsaved();
            renderPendingList();
            showStatus('Правка отменена', 'info');
        });
        list.appendChild(item);
    });
}

$('discardAllBtn').addEventListener('click', () => {
    if (!Object.keys(pending).length) return;
    if (!confirm('Отменить ВСЕ несохранённые правки?')) return;
    pending = {};
    markUnsaved();
    renderPendingList();
    closeModal('pendingModal');
    showStatus('Все правки отменены', 'info');
    loadSite();
});
$('saveFromListBtn').addEventListener('click', () => {
    closeModal('pendingModal');
    saveAll();
});

// ===== НОВОЕ: Панель файлов =====
$('filesBtn').addEventListener('click', async () => {
    openModal('filesModal');
    $('filesList').innerHTML = '<p style="color:#888;padding:20px;text-align:center;"><i class="fas fa-spinner fa-spin"></i> Загрузка...</p>';
    const files = await listAllFiles();
    const list = $('filesList');
    list.innerHTML = '';
    $('filesCount').textContent = `(${files.length}/${MAX_FILES} слотов)`;
    if (files.length === 0) {
        list.innerHTML = '<p class="empty">Папка files/ пуста</p>';
        return;
    }
    files.forEach(f => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const sizeKB = (f.size / 1024).toFixed(1);
        const downloadUrl = `${siteBaseUrl}${FILES_FOLDER}/${encodeURIComponent(f.name)}`;
        item.innerHTML = `
            <div class="fi-info">
                <div class="fi-name">${esc(f.name)}</div>
                <div class="fi-size">${sizeKB} КБ</div>
            </div>
            <div class="fi-actions">
                <a class="fi-btn" href="${esc(downloadUrl)}" target="_blank" download title="Скачать"><i class="fas fa-download"></i></a>
                <button class="fi-btn danger" data-name="${esc(f.name)}" title="Удалить"><i class="fas fa-trash"></i></button>
            </div>
        `;
        item.querySelector('.danger').addEventListener('click', async () => {
            if (!confirm(`Удалить файл ${f.name} из папки ${FILES_FOLDER}/?\n\nВнимание: ссылки на этот файл на сайте перестанут работать.`)) return;
            try {
                await delFile(FILES_FOLDER + '/' + f.name);
                showStatus(`✓ Файл ${f.name} удалён`, 'success');
                item.remove();
                const count = $('filesCount');
                const newCount = parseInt((count.textContent.match(/\d+/) || [0])[0]) - 1;
                count.textContent = `(${newCount}/${MAX_FILES} слотов)`;
            } catch (e) {
                const i = interpretError(e.status, e.body);
                showStatus(`✗ ${i.title}`, 'error');
            }
        });
        list.appendChild(item);
    });
});

// ===== НОВОЕ: Меню "Инструменты" =====
$('toolsBtn').addEventListener('click', e => {
    e.stopPropagation();
    $('toolsDropdown').classList.toggle('show');
});
document.addEventListener('click', e => {
    const wrap = document.querySelector('.tools-wrap');
    if (wrap && !wrap.contains(e.target)) $('toolsDropdown').classList.remove('show');
    const reposWrap = document.querySelector('.repos-wrap');
    const reposDropdown = $('reposDropdown');
    if (reposDropdown && reposDropdown.classList.contains('show') && reposWrap && !reposWrap.contains(e.target)) {
        reposDropdown.classList.remove('show');
    }
});

// ===== Остальные обработчики =====
$('checkBtn').addEventListener('click', checkToken);
$('checkBtn2').addEventListener('click', checkToken);
$('reloadBtn').addEventListener('click', reloadPreview);
$('cleanBtn').addEventListener('click', () => { $('toolsDropdown').classList.remove('show'); cleanMarks(); });
$('hidePlaceholdersBtn').addEventListener('click', () => { $('toolsDropdown').classList.remove('show'); hidePlaceholders(); });
$('showPlaceholdersBtn').addEventListener('click', () => { $('toolsDropdown').classList.remove('show'); showPlaceholders(); });
$('resetBtn').addEventListener('click', () => { $('toolsDropdown').classList.remove('show'); resetSite(); });
$('saveBtn').addEventListener('click', saveAll);
$('logoutBtn').addEventListener('click', logout);
$('prepareBtn').addEventListener('click', prepareSite);
$('applyBtn').addEventListener('click', applyEdit);
$('cancelBtn').addEventListener('click', closePanel);
$('closePanelBtn').addEventListener('click', closePanel);
$('homeBtn').addEventListener('click', goHome);
$('openSiteBtn').addEventListener('click', openLiveSite);
$('deployBadge').addEventListener('click', () => verifyDeploy(repoDeployId, true));

$('reposBtn').addEventListener('click', e => {
    e.stopPropagation();
    const dropdown = $('reposDropdown');
    if (dropdown.classList.contains('show')) dropdown.classList.remove('show');
    else fillReposDropdown();
});

$('addressBar').addEventListener('submit', e => { e.preventDefault(); goToAddress(); });
$('addressInput').addEventListener('focus', e => e.target.select());
$('addressInput').addEventListener('keydown', e => {
    if (e.key === 'Escape') { updatePageIndicator(); e.target.blur(); }
});

window.addEventListener('beforeunload', e => { if (Object.keys(pending).length) { e.preventDefault(); e.returnValue = ''; } });

if (token) enterApp();