(function () {
'use strict';

// ---- tunables ----------------------------------------------------------
var RAW_CHUNK_BYTES = 9000;           // ~12000 base64 chars/chunk, well under data-channel limits
var MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file — demo cap, no framework-level chunking helper exists
var HISTORY_LIMIT = 200;
var CHUNK_PACE_MS = 0;                // yield to the event loop between chunks

// ---- tiny utils ---------------------------------------------------------
function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function formatTime(ts) {
    var d = new Date(ts);
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
}
function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}
function base64ToBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
function fileIconFor(mime) {
    if (mime && mime.indexOf('image/') === 0) return '🖼️';
    if (mime && mime.indexOf('video/') === 0) return '🎞️';
    if (mime && mime.indexOf('audio/') === 0) return '🎵';
    if (mime === 'application/pdf') return '📄';
    return '📎';
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---- state ---------------------------------------------------------------
var history = [];                 // persisted (sans blob urls)
var blobUrls = new Map();         // fileId -> object URL (session-only)
var pendingReceives = new Map();  // fileId -> { name, mime, size, total, chunks: [], got: 0 }
var chatReady = false;
var peerName = null;
var helloTimers = [];
var myName = 'Player';

// ---- DOM refs -------------------------------------------------------------
var el = {
    connDot: document.getElementById('connDot'),
    connLabel: document.getElementById('connLabel'),
    banner: document.getElementById('banner'),
    tabBtnChat: document.getElementById('tabBtnChat'),
    tabBtnFiles: document.getElementById('tabBtnFiles'),
    panelChat: document.getElementById('panel-chat'),
    panelFiles: document.getElementById('panel-files'),
    messages: document.getElementById('messages'),
    jumpLatest: document.getElementById('jumpLatest'),
    composer: document.getElementById('composer'),
    attachBtn: document.getElementById('attachBtn'),
    fileInput: document.getElementById('fileInput'),
    textInput: document.getElementById('textInput'),
    sendBtn: document.getElementById('sendBtn'),
    clearChatBtn: document.getElementById('clearChatBtn'),
    filesBadge: document.getElementById('filesBadge'),
    filesList: document.getElementById('filesList'),
    filesCount: document.getElementById('filesCount'),
    clearFilesBtn: document.getElementById('clearFilesBtn'),
    lightbox: document.getElementById('lightbox'),
    lightboxImg: document.getElementById('lightboxImg'),
    lightboxClose: document.getElementById('lightboxClose')
};

// ---- persistence ----------------------------------------------------------
function persist() {
    var slim = history.map(function (m) {
        var out = { id: m.id, dir: m.dir, kind: m.kind, ts: m.ts };
        if (m.kind === 'text') out.text = m.text;
        if (m.kind === 'file') {
            out.file = { id: m.file.id, name: m.file.name, mime: m.file.mime, size: m.file.size, state: m.file.state };
        }
        if (m.dir === 'sys') out.text = m.text;
        return out;
    });
    Arcade.state.set('history', slim);
}
function loadHistory() {
    var saved = Arcade.state.get('history');
    if (!Array.isArray(saved)) return [];
    return saved.map(function (m) {
        if (m.kind === 'file') m.file.available = false; // blobs don't survive reload
        return m;
    });
}

// ---- rendering --------------------------------------------------------
function isNearBottom() {
    var m = el.messages;
    return (m.scrollHeight - m.scrollTop - m.clientHeight) < 80;
}
function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
    el.jumpLatest.hidden = true;
}

function fileBubbleInner(entry) {
    var f = entry.file;
    var url = blobUrls.get(f.id);
    var isImage = f.mime && f.mime.indexOf('image/') === 0;
    var html = '<div class="file-card" data-file-id="' + f.id + '">';
    if (isImage && url) {
        html += '<img class="file-thumb" src="' + url + '" alt="' + escapeHtml(f.name) + '">';
        if (f.state === 'sending') {
            html += '<div class="file-progress"><div style="width:' + (f.progress || 0) + '%"></div></div>';
        }
    } else {
        html += '<span class="file-icon">' + fileIconFor(f.mime) + '</span>';
        html += '<div class="file-info">';
        html += '<div class="file-name">' + escapeHtml(f.name) + '</div>';
        html += '<div class="file-sub">' + formatBytes(f.size) + '</div>';
        if (f.state === 'sending' || f.state === 'receiving') {
            html += '<div class="file-progress"><div style="width:' + (f.progress || 0) + '%"></div></div>';
        } else if (url) {
            html += '<a class="file-dl" href="' + url + '" download="' + escapeHtml(f.name) + '">Download</a>';
        } else if (f.available === false) {
            html += '<span class="file-sub">(unavailable after reload)</span>';
        } else if (f.state === 'failed') {
            html += '<span class="file-sub">Transfer failed</span>';
        }
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function rowHtml(entry) {
    if (entry.dir === 'sys') {
        return '<div class="msg-row sys" data-id="' + entry.id + '"><div class="bubble">' + escapeHtml(entry.text) + '</div></div>';
    }
    var bubbleInner = entry.kind === 'file' ? fileBubbleInner(entry) : escapeHtml(entry.text);
    var meta = formatTime(entry.ts) + (entry.failed ? ' · not delivered' : '');
    return '<div class="msg-row ' + entry.dir + '" data-id="' + entry.id + '">' +
        '<div class="bubble">' + bubbleInner + '<span class="msg-meta">' + meta + '</span></div>' +
        '</div>';
}

function appendRow(entry) {
    var wasNearBottom = isNearBottom();
    el.messages.insertAdjacentHTML('beforeend', rowHtml(entry));
    if (entry.dir === 'out' || wasNearBottom) scrollToBottom();
    else el.jumpLatest.hidden = false;
}

function renderAllMessages() {
    el.messages.innerHTML = history.map(rowHtml).join('');
    scrollToBottom();
}

function updateFileRowInMessages(fileId) {
    var card = el.messages.querySelector('.file-card[data-file-id="' + fileId + '"]');
    if (!card) return;
    var entry = history.find(function (m) { return m.kind === 'file' && m.file.id === fileId; });
    if (!entry) return;
    card.outerHTML = fileBubbleInner(entry);
}

function renderFilesPanel() {
    var files = history.filter(function (m) { return m.kind === 'file'; });
    el.filesBadge.hidden = files.length === 0;
    el.filesBadge.textContent = files.length;
    el.filesCount.textContent = files.length + (files.length === 1 ? ' file' : ' files');
    el.filesList.innerHTML = files.slice().reverse().map(function (m) {
        var f = m.file;
        var url = blobUrls.get(f.id);
        var dirTag = m.dir === 'out' ? 'Sent' : 'Received';
        var sub = formatBytes(f.size) + ' · ' + formatTime(m.ts);
        if (f.state === 'sending' || f.state === 'receiving') sub += ' · ' + (f.progress || 0) + '%';
        else if (f.available === false) sub += ' · unavailable after reload';
        else if (f.state === 'failed') sub += ' · failed';
        var actions = '';
        if (url) actions += '<a href="' + url + '" download="' + escapeHtml(f.name) + '" title="Download">⬇️</a>';
        actions += '<button class="remove" data-remove="' + f.id + '" title="Remove">🗑️</button>';
        return '<div class="file-row">' +
            '<span class="file-icon">' + fileIconFor(f.mime) + '</span>' +
            '<div class="file-info"><div class="file-name"><span class="dir-tag">' + dirTag + '</span>' + escapeHtml(f.name) + '</div>' +
            '<div class="file-sub">' + sub + '</div></div>' +
            '<div class="row-actions">' + actions + '</div>' +
            '</div>';
    }).join('');
}

function renderAll() { renderAllMessages(); renderFilesPanel(); }

// ---- history mutation ---------------------------------------------------
function pushEntry(entry) {
    history.push(entry);
    var trimmed = false;
    while (history.length > HISTORY_LIMIT) {
        var dropped = history.shift();
        trimmed = true;
        if (dropped.kind === 'file') {
            var u = blobUrls.get(dropped.file.id);
            if (u) { URL.revokeObjectURL(u); blobUrls.delete(dropped.file.id); }
        }
    }
    persist();
    return trimmed;
}
// Adds an entry and keeps the DOM in sync — a full re-render when the
// history cap trimmed older rows out from under an incremental append.
function commitEntry(entry) {
    var trimmed = pushEntry(entry);
    if (trimmed) renderAll();
    else { appendRow(entry); renderFilesPanel(); }
}
function pushSystem(text) {
    commitEntry({ id: uid(), dir: 'sys', kind: 'text', text: text, ts: Date.now() });
}

// ---- connection status ---------------------------------------------------
function clearHelloTimers() { helloTimers.forEach(clearTimeout); helloTimers = []; }

function setComposerEnabled(on) {
    el.textInput.disabled = !on;
    el.sendBtn.disabled = !on;
    el.attachBtn.disabled = !on;
    el.textInput.placeholder = on ? 'Type a message…' : 'Pair with a peer to start chatting…';
}

function updateConnUI(status) {
    el.connDot.className = 'dot ' + status;
    if (status === 'unavailable') {
        el.connLabel.textContent = 'Standalone';
        el.banner.hidden = false;
        el.banner.textContent = 'Running standalone — open this game from the arcade and pair via the Multiplayer menu to chat with someone.';
        setComposerEnabled(false);
    } else if (status === 'idle') {
        el.connLabel.textContent = 'Not paired';
        el.banner.hidden = false;
        el.banner.textContent = 'Not paired yet — open the Multiplayer menu in the arcade and connect with a peer.';
        setComposerEnabled(false);
    } else if (status === 'connecting') {
        el.connLabel.textContent = 'Connecting…';
        el.banner.hidden = false;
        el.banner.textContent = 'Connecting to your peer…';
        setComposerEnabled(false);
    } else if (status === 'connected') {
        el.connLabel.textContent = chatReady ? ('Chatting with ' + peerName) : 'Connected';
        el.banner.hidden = true;
        setComposerEnabled(true);
    }
}

function sayHello() {
    Arcade.peer.send({ t: 'hello', from: myName });
}

var currentStatus = null;

function onStatusChange(status) {
    var wasConnected = currentStatus === 'connected';
    currentStatus = status;

    if (status !== 'connected') {
        if (wasConnected) {
            clearHelloTimers();
            if (chatReady) pushSystem(peerName ? (peerName + ' disconnected') : 'Peer disconnected');
            chatReady = false;
            peerName = null;
            // any in-flight transfers can no longer complete
            pendingReceives.clear();
            history.forEach(function (m) {
                if (m.kind === 'file' && (m.file.state === 'sending' || m.file.state === 'receiving')) {
                    m.file.state = 'failed';
                }
            });
            renderAll();
        }
    } else if (!wasConnected) {
        chatReady = false;
        peerName = null;
        sayHello();
        helloTimers.push(setTimeout(function () { if (!chatReady) sayHello(); }, 1500));
        helloTimers.push(setTimeout(function () { if (!chatReady) sayHello(); }, 4000));
    }
    updateConnUI(status);
}

// ---- incoming messages ---------------------------------------------------
function onPeerMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
    switch (payload.t) {
        case 'hello':
            peerName = payload.from || 'Peer';
            if (!chatReady) {
                chatReady = true;
                clearHelloTimers();
                pushSystem('Connected — chatting with ' + peerName);
                // Our own initial hello may have been dropped if the peer's
                // game hadn't attached its message listener yet (a real
                // launcher-relay race, not just a retry-timing gap). Echo
                // once so a peer stuck waiting hears from us right away;
                // the !chatReady guard means this fires at most once per
                // connection and can't turn into a reply ping-pong.
                sayHello();
            }
            updateConnUI('connected');
            break;

        case 'msg':
            commitEntry({ id: payload.id || uid(), dir: 'in', kind: 'text', text: String(payload.text || ''), ts: payload.ts || Date.now() });
            break;

        case 'file-meta':
            pendingReceives.set(payload.id, {
                name: payload.name, mime: payload.mime, size: payload.size,
                total: payload.chunks, chunks: new Array(payload.chunks), got: 0
            });
            commitEntry({
                id: uid(), dir: 'in', kind: 'file', ts: payload.ts || Date.now(),
                file: { id: payload.id, name: payload.name, mime: payload.mime, size: payload.size, state: 'receiving', progress: 0 }
            });
            break;

        case 'file-chunk': {
            var pending = pendingReceives.get(payload.id);
            if (!pending) break;
            pending.chunks[payload.seq] = payload.data;
            pending.got++;
            var progress = Math.round((pending.got / pending.total) * 100);
            var entry = history.find(function (m) { return m.kind === 'file' && m.file.id === payload.id; });
            if (entry) { entry.file.progress = progress; updateFileRowInMessages(payload.id); renderFilesPanel(); }
            break;
        }

        case 'file-done': {
            var p = pendingReceives.get(payload.id);
            pendingReceives.delete(payload.id);
            var e = history.find(function (m) { return m.kind === 'file' && m.file.id === payload.id; });
            if (!p || !e) break;
            if (p.got !== p.total || p.chunks.indexOf(undefined) !== -1) {
                e.file.state = 'failed';
                Arcade.ui.toast('File transfer from peer incomplete: ' + e.file.name, { kind: 'error' });
            } else {
                var totalLen = 0, byteParts = p.chunks.map(function (c) { var b = base64ToBytes(c); totalLen += b.length; return b; });
                var combined = new Uint8Array(totalLen);
                var offset = 0;
                byteParts.forEach(function (b) { combined.set(b, offset); offset += b.length; });
                var blob = new Blob([combined], { type: p.mime || 'application/octet-stream' });
                var url = URL.createObjectURL(blob);
                blobUrls.set(payload.id, url);
                e.file.state = 'done';
                e.file.progress = 100;
                e.file.available = true;
            }
            persist();
            updateFileRowInMessages(payload.id);
            renderFilesPanel();
            break;
        }
    }
}

// ---- sending --------------------------------------------------------------
function sendText(text) {
    var entry = { id: uid(), dir: 'out', kind: 'text', text: text, ts: Date.now() };
    var ok = Arcade.peer.send({ t: 'msg', id: entry.id, from: myName, ts: entry.ts, text: text });
    if (!ok) entry.failed = true;
    commitEntry(entry);
}

function sendFile(file) {
    if (file.size === 0) { Arcade.ui.toast("Can't send an empty file", { kind: 'error' }); return Promise.resolve(); }
    if (file.size > MAX_FILE_BYTES) {
        Arcade.ui.toast('File too large (' + formatBytes(file.size) + ') — demo limit is ' + formatBytes(MAX_FILE_BYTES), { kind: 'error' });
        return Promise.resolve();
    }
    var id = uid();
    var ts = Date.now();
    var mime = file.type || 'application/octet-stream';
    var total = Math.max(1, Math.ceil(file.size / RAW_CHUNK_BYTES));

    var entry = { id: uid(), dir: 'out', kind: 'file', ts: ts, file: { id: id, name: file.name, mime: mime, size: file.size, state: 'sending', progress: 0 } };
    blobUrls.set(id, URL.createObjectURL(file));
    commitEntry(entry);

    function fail() {
        entry.file.state = 'failed';
        persist(); updateFileRowInMessages(id); renderFilesPanel();
        Arcade.ui.toast('Could not send ' + file.name + ' — connection lost', { kind: 'error' });
    }

    return file.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        var ok = Arcade.peer.send({ t: 'file-meta', id: id, from: myName, ts: ts, name: file.name, mime: mime, size: file.size, chunks: total });
        if (!ok) { fail(); return; }

        function sendChunk(seq) {
            if (seq >= total) {
                Arcade.peer.send({ t: 'file-done', id: id });
                entry.file.state = 'done';
                entry.file.progress = 100;
                persist(); updateFileRowInMessages(id); renderFilesPanel();
                return;
            }
            var start = seq * RAW_CHUNK_BYTES;
            var slice = bytes.subarray(start, Math.min(start + RAW_CHUNK_BYTES, bytes.length));
            var okChunk = Arcade.peer.send({ t: 'file-chunk', id: id, seq: seq, data: bytesToBase64(slice) });
            if (!okChunk) { fail(); return; }
            entry.file.progress = Math.round(((seq + 1) / total) * 100);
            updateFileRowInMessages(id); renderFilesPanel();
            return sleep(CHUNK_PACE_MS).then(function () { return sendChunk(seq + 1); });
        }
        return sendChunk(0);
    });
}

// ---- clear actions ----------------------------------------------------
function revokeAllBlobUrls() { blobUrls.forEach(function (u) { URL.revokeObjectURL(u); }); blobUrls.clear(); }

function clearChat() {
    revokeAllBlobUrls();
    pendingReceives.clear();
    history = [];
    persist();
    renderAll();
}
function clearFiles() {
    history.filter(function (m) { return m.kind === 'file'; }).forEach(function (m) {
        var u = blobUrls.get(m.file.id);
        if (u) { URL.revokeObjectURL(u); blobUrls.delete(m.file.id); }
    });
    history = history.filter(function (m) { return m.kind !== 'file'; });
    persist();
    renderAll();
}

// ---- lightbox --------------------------------------------------------
function openLightbox(src) {
    el.lightboxImg.src = src;
    el.lightbox.hidden = false;
}
function closeLightbox() { el.lightbox.hidden = true; el.lightboxImg.src = ''; }

// ---- wiring ------------------------------------------------------------
function wireUI() {
    el.tabBtnChat.addEventListener('click', function () { switchTab('chat'); });
    el.tabBtnFiles.addEventListener('click', function () { switchTab('files'); });

    function switchTab(tab) {
        var chat = tab === 'chat';
        el.tabBtnChat.classList.toggle('active', chat);
        el.tabBtnFiles.classList.toggle('active', !chat);
        el.tabBtnChat.setAttribute('aria-selected', String(chat));
        el.tabBtnFiles.setAttribute('aria-selected', String(!chat));
        el.panelChat.classList.toggle('hidden', !chat);
        el.panelFiles.classList.toggle('hidden', chat);
    }

    // Plain click/keydown, not a <form submit> — sandboxed iframes without
    // `allow-forms` silently block form submission (a native default action,
    // not something preventDefault() can head off from the submit handler).
    function trySend() {
        var text = el.textInput.value.trim();
        if (!text) return;
        sendText(text);
        el.textInput.value = '';
    }
    el.sendBtn.addEventListener('click', trySend);
    el.textInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); trySend(); }
    });

    el.attachBtn.addEventListener('click', function () { el.fileInput.click(); });
    el.fileInput.addEventListener('change', function () {
        var files = Array.prototype.slice.call(el.fileInput.files || []);
        el.fileInput.value = '';
        files.reduce(function (chain, f) { return chain.then(function () { return sendFile(f); }); }, Promise.resolve());
    });

    el.jumpLatest.addEventListener('click', scrollToBottom);
    el.messages.addEventListener('scroll', function () { if (isNearBottom()) el.jumpLatest.hidden = true; });

    // Sandboxed iframes without `allow-modals` silently no-op window.confirm(),
    // so destructive actions use a same-page "click again to confirm" arm
    // instead of a native dialog.
    function armToConfirm(btn, hasSomethingToClear, action) {
        var original = btn.textContent, timer = null, armed = false;
        function disarm() { armed = false; clearTimeout(timer); btn.textContent = original; btn.classList.remove('confirm-armed'); }
        btn.addEventListener('click', function () {
            if (!hasSomethingToClear()) return;
            if (!armed) {
                armed = true;
                btn.textContent = 'Click again to confirm';
                btn.classList.add('confirm-armed');
                timer = setTimeout(disarm, 4000);
            } else {
                disarm();
                action();
            }
        });
    }
    armToConfirm(el.clearChatBtn, function () { return history.length > 0; }, clearChat);
    armToConfirm(el.clearFilesBtn, function () { return history.some(function (m) { return m.kind === 'file'; }); }, clearFiles);

    el.messages.addEventListener('click', function (e) {
        var thumb = e.target.closest('.file-thumb');
        if (thumb) openLightbox(thumb.src);
    });
    el.filesList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-remove]');
        if (!btn) return;
        var fid = btn.getAttribute('data-remove');
        var u = blobUrls.get(fid);
        if (u) { URL.revokeObjectURL(u); blobUrls.delete(fid); }
        history = history.filter(function (m) { return !(m.kind === 'file' && m.file.id === fid); });
        persist();
        renderAll();
    });
    el.lightboxClose.addEventListener('click', closeLightbox);
    el.lightbox.addEventListener('click', function (e) { if (e.target === el.lightbox) closeLightbox(); });
}

function init() {
    myName = (Arcade.player && Arcade.player.name && Arcade.player.name()) || 'Player';
    history = loadHistory();
    wireUI();
    renderAll();

    // A game mounted mid-session can already be 'connected' — route the
    // initial read through the same transition handler as live updates
    // rather than duplicating the "entered connected" logic here.
    onStatusChange(Arcade.peer.status());

    Arcade.peer.onStatus(onStatusChange);
    Arcade.peer.onMessage(onPeerMessage);

    if (Arcade.onStateReplaced) {
        Arcade.onStateReplaced(function () { history = loadHistory(); renderAll(); });
    }
    if (Arcade.onSuspend) Arcade.onSuspend(persist);
}

Arcade.ready.then(init);

})();
