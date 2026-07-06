(function () {
'use strict';

// ---- tunables ----------------------------------------------------------
var RAW_CHUNK_BYTES = 9000;           // ~12000 base64 chars/chunk, well under data-channel limits
var MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file — demo cap, no framework-level chunking helper exists
var HISTORY_LIMIT = 200;              // per peer
var MAX_KNOWN_PEERS = 30;             // evict the least-recently-seen non-live peer beyond this
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
function isPreviewable(mime) {
    return !!mime && (mime.indexOf('image/') === 0 || mime.indexOf('video/') === 0 || mime.indexOf('audio/') === 0 || mime === 'application/pdf');
}

// ---- state ---------------------------------------------------------------
// One thread per peer we've ever exchanged a hello with (id -> thread).
// Transport is strictly 1:1 (Arcade.peer has exactly one live connection),
// so only the thread matching `livePeerId` can ever be "live"; every other
// known thread is a read-only archive until that peer reconnects.
var peers = new Map();
var myId = null;
var livePeerId = null;   // id of the peer we're currently connected + handshaken with
var viewPeerId = null;   // id of the peer thread currently shown in the UI
var chatReady = false;
var helloTimers = [];
var myName = 'Player';
var currentStatus = null;

// ---- DOM refs -------------------------------------------------------------
var el = {
    connDot: document.getElementById('connDot'),
    connLabel: document.getElementById('connLabel'),
    banner: document.getElementById('banner'),
    peerTabs: document.getElementById('peerTabs'),
    peersEmptyHint: document.getElementById('peersEmptyHint'),
    subTabs: document.getElementById('subTabs'),
    tabBtnChat: document.getElementById('tabBtnChat'),
    tabBtnFiles: document.getElementById('tabBtnFiles'),
    panels: document.getElementById('panels'),
    panelChat: document.getElementById('panel-chat'),
    panelFiles: document.getElementById('panel-files'),
    messages: document.getElementById('messages'),
    jumpLatest: document.getElementById('jumpLatest'),
    peerArchivedHint: document.getElementById('peerArchivedHint'),
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
    lightboxContent: document.getElementById('lightboxContent'),
    lightboxClose: document.getElementById('lightboxClose')
};

// ---- peer bookkeeping ------------------------------------------------
function revokePeerBlobUrls(peer) {
    peer.blobUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    peer.blobUrls.clear();
}

function evictStalePeers() {
    if (peers.size <= MAX_KNOWN_PEERS) return;
    var candidates = Array.from(peers.values())
        .filter(function (p) { return p.id !== livePeerId; })
        .sort(function (a, b) { return a.lastSeen - b.lastSeen; });
    while (peers.size > MAX_KNOWN_PEERS && candidates.length) {
        var drop = candidates.shift();
        revokePeerBlobUrls(drop);
        peers.delete(drop.id);
    }
    if (viewPeerId && !peers.has(viewPeerId)) viewPeerId = livePeerId || orderedPeerIds()[0] || null;
}

function ensurePeer(id, name) {
    var p = peers.get(id);
    if (!p) {
        p = { id: id, name: name || 'Peer', lastSeen: Date.now(), history: [], blobUrls: new Map(), pendingReceives: new Map(), unread: 0 };
        peers.set(id, p);
        evictStalePeers();
    } else {
        if (name) p.name = name;
        p.lastSeen = Date.now();
    }
    return p;
}

function orderedPeerIds() {
    return Array.from(peers.values())
        .sort(function (a, b) { return b.lastSeen - a.lastSeen; })
        .map(function (p) { return p.id; });
}

function activePeer() { return viewPeerId ? peers.get(viewPeerId) : null; }

// ---- persistence ----------------------------------------------------------
function slimHistory(history) {
    return history.map(function (m) {
        var out = { id: m.id, dir: m.dir, kind: m.kind, ts: m.ts };
        if (m.kind === 'text') out.text = m.text;
        if (m.kind === 'file') {
            out.file = { id: m.file.id, name: m.file.name, mime: m.file.mime, size: m.file.size, state: m.file.state };
        }
        if (m.dir === 'sys') out.text = m.text;
        return out;
    });
}
function persist() {
    var out = {};
    peers.forEach(function (p, id) {
        out[id] = { id: p.id, name: p.name, lastSeen: p.lastSeen, history: slimHistory(p.history) };
    });
    Arcade.state.set('peers', out);
}
function loadPeers() {
    var saved = Arcade.state.get('peers');
    var map = new Map();
    if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach(function (id) {
            var raw = saved[id] || {};
            var hist = Array.isArray(raw.history) ? raw.history : [];
            hist.forEach(function (m) { if (m.kind === 'file') m.file.available = false; }); // blobs don't survive reload
            map.set(id, { id: id, name: raw.name || 'Peer', lastSeen: raw.lastSeen || 0, history: hist, blobUrls: new Map(), pendingReceives: new Map(), unread: 0 });
        });
    }
    return map;
}
function ensureMyId() {
    var saved = Arcade.state.get('myId');
    if (typeof saved === 'string' && saved) return saved;
    var id = uid();
    Arcade.state.set('myId', id);
    return id;
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

function fileBubbleInner(peer, entry) {
    var f = entry.file;
    var url = peer.blobUrls.get(f.id);
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

function rowHtml(peer, entry) {
    if (entry.dir === 'sys') {
        return '<div class="msg-row sys" data-id="' + entry.id + '"><div class="bubble">' + escapeHtml(entry.text) + '</div></div>';
    }
    var bubbleInner = entry.kind === 'file' ? fileBubbleInner(peer, entry) : escapeHtml(entry.text);
    var meta = formatTime(entry.ts) + (entry.failed ? ' · not delivered' : '');
    return '<div class="msg-row ' + entry.dir + '" data-id="' + entry.id + '">' +
        '<div class="bubble">' + bubbleInner + '<span class="msg-meta">' + meta + '</span></div>' +
        '</div>';
}

function appendRow(peer, entry) {
    var wasNearBottom = isNearBottom();
    el.messages.insertAdjacentHTML('beforeend', rowHtml(peer, entry));
    if (entry.dir === 'out' || wasNearBottom) scrollToBottom();
    else el.jumpLatest.hidden = false;
}

function renderMessagesFor(peer) {
    el.messages.innerHTML = peer ? peer.history.map(function (e) { return rowHtml(peer, e); }).join('') : '';
    scrollToBottom();
}

function updateFileRowInMessages(peer, fileId) {
    var card = el.messages.querySelector('.file-card[data-file-id="' + fileId + '"]');
    if (!card) return;
    var entry = peer.history.find(function (m) { return m.kind === 'file' && m.file.id === fileId; });
    if (!entry) return;
    card.outerHTML = fileBubbleInner(peer, entry);
}

function renderFilesPanelFor(peer) {
    var files = peer ? peer.history.filter(function (m) { return m.kind === 'file'; }) : [];
    el.filesBadge.hidden = files.length === 0;
    el.filesBadge.textContent = files.length;
    el.filesCount.textContent = files.length + (files.length === 1 ? ' file' : ' files');
    el.filesList.innerHTML = !peer ? '' : files.slice().reverse().map(function (m) {
        var f = m.file;
        var url = peer.blobUrls.get(f.id);
        var dirTag = m.dir === 'out' ? 'Sent' : 'Received';
        var sub = formatBytes(f.size) + ' · ' + formatTime(m.ts);
        if (f.state === 'sending' || f.state === 'receiving') sub += ' · ' + (f.progress || 0) + '%';
        else if (f.available === false) sub += ' · unavailable after reload';
        else if (f.state === 'failed') sub += ' · failed';
        var actions = '';
        if (url) actions += '<a href="' + url + '" download="' + escapeHtml(f.name) + '" title="Download">⬇️</a>';
        actions += '<button class="remove" data-remove="' + f.id + '" title="Remove">🗑️</button>';
        var previewable = url && isPreviewable(f.mime);
        return '<div class="file-row' + (previewable ? ' previewable' : '') + '"' +
            (previewable ? ' data-file-id="' + f.id + '" data-mime="' + escapeHtml(f.mime) + '" data-file-name="' + escapeHtml(f.name) + '" title="Click to preview"' : '') + '>' +
            '<span class="file-icon">' + fileIconFor(f.mime) + '</span>' +
            '<div class="file-info"><div class="file-name"><span class="dir-tag">' + dirTag + '</span>' + escapeHtml(f.name) + '</div>' +
            '<div class="file-sub">' + sub + '</div></div>' +
            '<div class="row-actions">' + actions + '</div>' +
            '</div>';
    }).join('');
}

function renderPeerTabs() {
    var ids = orderedPeerIds();
    el.peerTabs.hidden = ids.length === 0;
    el.peersEmptyHint.hidden = ids.length !== 0;
    el.subTabs.hidden = ids.length === 0;
    el.panels.hidden = ids.length === 0;
    el.peerTabs.innerHTML = ids.map(function (id) {
        var p = peers.get(id);
        var isLive = id === livePeerId && chatReady;
        var isActive = id === viewPeerId;
        var cls = 'peer-tab' + (isActive ? ' active' : '') + (isLive ? ' live' : '');
        var unread = p.unread > 0 ? '<span class="peer-unread">' + p.unread + '</span>' : '';
        return '<button type="button" class="' + cls + '" data-peer-id="' + id + '" role="tab" aria-selected="' + isActive + '" title="' + escapeHtml(p.name) + (isLive ? ' — connected' : '') + '">' +
            '<span class="peer-dot"></span>' + escapeHtml(p.name) + unread + '</button>';
    }).join('');
}

function setComposerEnabled(on, placeholder) {
    el.textInput.disabled = !on;
    el.sendBtn.disabled = !on;
    el.attachBtn.disabled = !on;
    el.textInput.placeholder = placeholder || (on ? 'Type a message…' : 'Pair with a peer to start chatting…');
}

function updateComposerForView() {
    var peer = activePeer();
    if (!peer) {
        setComposerEnabled(false);
        el.peerArchivedHint.hidden = true;
        return;
    }
    var live = peer.id === livePeerId && chatReady;
    if (live) {
        setComposerEnabled(true);
        el.peerArchivedHint.hidden = true;
    } else {
        setComposerEnabled(false, 'Reconnect with ' + peer.name + ' to send messages…');
        el.peerArchivedHint.hidden = false;
        el.peerArchivedHint.textContent = 'Viewing history with ' + peer.name + ' — open the arcade\'s Multiplayer menu to reconnect and send new messages.';
    }
}

function renderAllForView() {
    var peer = activePeer();
    renderMessagesFor(peer);
    renderFilesPanelFor(peer);
    renderPeerTabs();
    updateComposerForView();
}

// ---- history mutation ---------------------------------------------------
function pushEntry(peer, entry) {
    peer.history.push(entry);
    var trimmed = false;
    while (peer.history.length > HISTORY_LIMIT) {
        var dropped = peer.history.shift();
        trimmed = true;
        if (dropped.kind === 'file') {
            var u = peer.blobUrls.get(dropped.file.id);
            if (u) { URL.revokeObjectURL(u); peer.blobUrls.delete(dropped.file.id); }
        }
    }
    persist();
    return trimmed;
}
// Adds an entry and keeps the DOM in sync when the peer's thread is the one
// on screen; otherwise just tallies an unread badge on its tab.
function commitEntryFor(peer, entry) {
    var trimmed = pushEntry(peer, entry);
    if (viewPeerId !== peer.id) {
        if (entry.dir !== 'out') peer.unread++;
        renderPeerTabs();
        return;
    }
    if (trimmed) renderAllForView();
    else { appendRow(peer, entry); renderFilesPanelFor(peer); renderPeerTabs(); }
}
function pushSystemFor(peer, text) {
    commitEntryFor(peer, { id: uid(), dir: 'sys', kind: 'text', text: text, ts: Date.now() });
}

// ---- connection status ---------------------------------------------------
function clearHelloTimers() { helloTimers.forEach(clearTimeout); helloTimers = []; }

function updateConnUI(status) {
    el.connDot.className = 'dot ' + status;
    if (status === 'unavailable') {
        el.connLabel.textContent = 'Standalone';
        el.banner.hidden = false;
        el.banner.textContent = 'Running standalone — open this game from the arcade and pair via the Multiplayer menu to chat with someone.';
    } else if (status === 'idle') {
        el.connLabel.textContent = 'Not paired';
        el.banner.hidden = false;
        el.banner.textContent = 'Not paired yet — open the Multiplayer menu in the arcade and connect with a peer.';
    } else if (status === 'connecting') {
        el.connLabel.textContent = 'Connecting…';
        el.banner.hidden = false;
        el.banner.textContent = 'Connecting to your peer…';
    } else if (status === 'interrupted') {
        el.connLabel.textContent = 'Reconnecting…';
        el.banner.hidden = false;
        el.banner.textContent = 'Connection interrupted — reconnecting… You can keep typing; messages are delivered when the link recovers.';
    } else if (status === 'connected') {
        var live = (livePeerId && chatReady) ? peers.get(livePeerId) : null;
        el.connLabel.textContent = live ? ('Chatting with ' + live.name) : 'Connected';
        el.banner.hidden = true;
    }
    updateComposerForView();
}

function sayHello() {
    Arcade.peer.send({ t: 'hello', from: myName, id: myId });
}

function onStatusChange(status) {
    var prev = currentStatus;
    var wasLive = prev === 'connected' || prev === 'interrupted';
    currentStatus = status;

    if (status === 'interrupted') {
        // The transport is repairing the SAME session (v1.7): keep the live
        // thread and any in-flight transfers — sends queue and replay on
        // recovery — and just tell the user what's happening.
        if (prev === 'connected' && chatReady && livePeerId) {
            var iPeer = peers.get(livePeerId);
            if (iPeer) pushSystemFor(iPeer, 'Connection interrupted — reconnecting…');
        }
    } else if (status !== 'connected') {
        if (wasLive) {
            clearHelloTimers();
            if (chatReady && livePeerId) {
                var peer = peers.get(livePeerId);
                if (peer) {
                    pushSystemFor(peer, peer.name + ' disconnected');
                    peer.pendingReceives.clear();
                    peer.history.forEach(function (m) {
                        if (m.kind === 'file' && (m.file.state === 'sending' || m.file.state === 'receiving')) {
                            m.file.state = 'failed';
                        }
                    });
                    persist();
                    if (viewPeerId === peer.id) renderAllForView();
                }
            }
            chatReady = false;
            livePeerId = null;
            renderPeerTabs();
        }
    } else if (prev === 'interrupted' && chatReady && livePeerId) {
        // Same session resumed — queued messages are replaying; no re-hello.
        var rPeer = peers.get(livePeerId);
        if (rPeer) pushSystemFor(rPeer, 'Reconnected');
    } else if (prev !== 'connected') {
        chatReady = false;
        livePeerId = null;
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
        case 'hello': {
            // Fall back to a name-derived id for a peer still running an
            // older build that doesn't send one, rather than dropping them.
            var incomingId = payload.id || ('anon-' + (payload.from || 'peer'));
            var peer = ensurePeer(incomingId, payload.from || 'Peer');
            if (!chatReady) {
                chatReady = true;
                livePeerId = incomingId;
                clearHelloTimers();
                viewPeerId = incomingId;
                peer.unread = 0;
                pushSystemFor(peer, 'Connected — chatting with ' + peer.name);
                // Our own initial hello may have been dropped if the peer's
                // game hadn't attached its message listener yet (a real
                // launcher-relay race, not just a retry-timing gap). Echo
                // once so a peer stuck waiting hears from us right away;
                // the !chatReady guard means this fires at most once per
                // connection and can't turn into a reply ping-pong.
                sayHello();
            }
            persist();
            renderAllForView();
            updateConnUI('connected');
            break;
        }

        case 'msg': {
            if (!livePeerId) break;
            var msgPeer = peers.get(livePeerId);
            if (!msgPeer) break;
            commitEntryFor(msgPeer, { id: payload.id || uid(), dir: 'in', kind: 'text', text: String(payload.text || ''), ts: payload.ts || Date.now() });
            break;
        }

        case 'file-meta': {
            if (!livePeerId) break;
            var metaPeer = peers.get(livePeerId);
            if (!metaPeer) break;
            metaPeer.pendingReceives.set(payload.id, {
                name: payload.name, mime: payload.mime, size: payload.size,
                total: payload.chunks, chunks: new Array(payload.chunks), got: 0
            });
            commitEntryFor(metaPeer, {
                id: uid(), dir: 'in', kind: 'file', ts: payload.ts || Date.now(),
                file: { id: payload.id, name: payload.name, mime: payload.mime, size: payload.size, state: 'receiving', progress: 0 }
            });
            break;
        }

        case 'file-chunk': {
            if (!livePeerId) break;
            var chunkPeer = peers.get(livePeerId);
            if (!chunkPeer) break;
            var pending = chunkPeer.pendingReceives.get(payload.id);
            if (!pending) break;
            pending.chunks[payload.seq] = payload.data;
            pending.got++;
            var progress = Math.round((pending.got / pending.total) * 100);
            var entry = chunkPeer.history.find(function (m) { return m.kind === 'file' && m.file.id === payload.id; });
            if (entry) {
                entry.file.progress = progress;
                if (viewPeerId === chunkPeer.id) { updateFileRowInMessages(chunkPeer, payload.id); renderFilesPanelFor(chunkPeer); }
            }
            break;
        }

        case 'file-done': {
            if (!livePeerId) break;
            var donePeer = peers.get(livePeerId);
            if (!donePeer) break;
            var p = donePeer.pendingReceives.get(payload.id);
            donePeer.pendingReceives.delete(payload.id);
            var e = donePeer.history.find(function (m) { return m.kind === 'file' && m.file.id === payload.id; });
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
                donePeer.blobUrls.set(payload.id, url);
                e.file.state = 'done';
                e.file.progress = 100;
                e.file.available = true;
            }
            persist();
            if (viewPeerId === donePeer.id) { updateFileRowInMessages(donePeer, payload.id); renderFilesPanelFor(donePeer); }
            break;
        }
    }
}

// ---- sending --------------------------------------------------------------
function sendText(text) {
    var peer = activePeer();
    if (!peer || peer.id !== livePeerId || !chatReady) return;
    var entry = { id: uid(), dir: 'out', kind: 'text', text: text, ts: Date.now() };
    var ok = Arcade.peer.send({ t: 'msg', id: entry.id, from: myName, ts: entry.ts, text: text });
    if (!ok) entry.failed = true;
    commitEntryFor(peer, entry);
}

function sendFile(file) {
    var peer = activePeer();
    if (!peer || peer.id !== livePeerId || !chatReady) return Promise.resolve();
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
    peer.blobUrls.set(id, URL.createObjectURL(file));
    commitEntryFor(peer, entry);

    function fail() {
        entry.file.state = 'failed';
        persist();
        if (viewPeerId === peer.id) { updateFileRowInMessages(peer, id); renderFilesPanelFor(peer); }
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
                persist();
                if (viewPeerId === peer.id) { updateFileRowInMessages(peer, id); renderFilesPanelFor(peer); }
                return;
            }
            var start = seq * RAW_CHUNK_BYTES;
            var slice = bytes.subarray(start, Math.min(start + RAW_CHUNK_BYTES, bytes.length));
            var okChunk = Arcade.peer.send({ t: 'file-chunk', id: id, seq: seq, data: bytesToBase64(slice) });
            if (!okChunk) { fail(); return; }
            entry.file.progress = Math.round(((seq + 1) / total) * 100);
            if (viewPeerId === peer.id) { updateFileRowInMessages(peer, id); renderFilesPanelFor(peer); }
            return sleep(CHUNK_PACE_MS).then(function () { return sendChunk(seq + 1); });
        }
        return sendChunk(0);
    });
}

// ---- clear actions ----------------------------------------------------
function clearChat() {
    var peer = activePeer();
    if (!peer) return;
    revokePeerBlobUrls(peer);
    peer.pendingReceives.clear();
    peer.history = [];
    peer.unread = 0;
    persist();
    renderAllForView();
}
function clearFiles() {
    var peer = activePeer();
    if (!peer) return;
    peer.history.filter(function (m) { return m.kind === 'file'; }).forEach(function (m) {
        var u = peer.blobUrls.get(m.file.id);
        if (u) { URL.revokeObjectURL(u); peer.blobUrls.delete(m.file.id); }
    });
    peer.history = peer.history.filter(function (m) { return m.kind !== 'file'; });
    persist();
    renderAllForView();
}

// ---- lightbox --------------------------------------------------------
// Plays/displays media inline instead of only offering a download link —
// covers every type the Files panel can preview (isPreviewable above).
function openMedia(mime, url, name) {
    var html;
    if (mime && mime.indexOf('image/') === 0) {
        html = '<img alt="' + escapeHtml(name) + '" src="' + url + '">';
    } else if (mime && mime.indexOf('video/') === 0) {
        html = '<video src="' + url + '" controls autoplay playsinline></video>';
    } else if (mime && mime.indexOf('audio/') === 0) {
        html = '<audio src="' + url + '" controls autoplay></audio>';
    } else if (mime === 'application/pdf') {
        html = '<iframe class="lightbox-pdf" src="' + url + '" title="' + escapeHtml(name) + '"></iframe>';
    } else {
        return false;
    }
    el.lightboxContent.innerHTML = html;
    el.lightbox.hidden = false;
    return true;
}
function closeLightbox() {
    el.lightbox.hidden = true;
    el.lightboxContent.innerHTML = ''; // drop the element so video/audio playback stops
}

// ---- tab switching ------------------------------------------------------
function switchPeerTab(id) {
    if (!peers.has(id) || viewPeerId === id) return;
    viewPeerId = id;
    peers.get(id).unread = 0;
    renderAllForView();
}
function switchSubTab(tab) {
    var chat = tab === 'chat';
    el.tabBtnChat.classList.toggle('active', chat);
    el.tabBtnFiles.classList.toggle('active', !chat);
    el.tabBtnChat.setAttribute('aria-selected', String(chat));
    el.tabBtnFiles.setAttribute('aria-selected', String(!chat));
    el.panelChat.classList.toggle('hidden', !chat);
    el.panelFiles.classList.toggle('hidden', chat);
}

// ---- wiring ------------------------------------------------------------
function wireUI() {
    el.peerTabs.addEventListener('click', function (e) {
        var btn = e.target.closest('.peer-tab');
        if (btn) switchPeerTab(btn.getAttribute('data-peer-id'));
    });

    el.tabBtnChat.addEventListener('click', function () { switchSubTab('chat'); });
    el.tabBtnFiles.addEventListener('click', function () { switchSubTab('files'); });

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
    armToConfirm(el.clearChatBtn, function () { var p = activePeer(); return !!p && p.history.length > 0; }, clearChat);
    armToConfirm(el.clearFilesBtn, function () { var p = activePeer(); return !!p && p.history.some(function (m) { return m.kind === 'file'; }); }, clearFiles);

    el.messages.addEventListener('click', function (e) {
        var thumb = e.target.closest('.file-thumb');
        if (thumb) openMedia('image/*', thumb.src, thumb.alt);
    });
    el.filesList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-remove]');
        if (btn) {
            var peer = activePeer();
            if (!peer) return;
            var fid = btn.getAttribute('data-remove');
            var u = peer.blobUrls.get(fid);
            if (u) { URL.revokeObjectURL(u); peer.blobUrls.delete(fid); }
            peer.history = peer.history.filter(function (m) { return !(m.kind === 'file' && m.file.id === fid); });
            persist();
            renderAllForView();
            return;
        }
        if (e.target.closest('a[download]')) return; // let the download proceed as-is
        var row = e.target.closest('.file-row.previewable');
        if (!row) return;
        var rowPeer = activePeer();
        if (!rowPeer) return;
        var url = rowPeer.blobUrls.get(row.getAttribute('data-file-id'));
        if (url) openMedia(row.getAttribute('data-mime'), url, row.getAttribute('data-file-name') || '');
    });
    el.lightboxClose.addEventListener('click', closeLightbox);
    el.lightbox.addEventListener('click', function (e) { if (e.target === el.lightbox) closeLightbox(); });
}

function init() {
    myName = (Arcade.player && Arcade.player.name && Arcade.player.name()) || 'Player';
    myId = ensureMyId();
    peers = loadPeers();
    viewPeerId = orderedPeerIds()[0] || null;
    wireUI();
    renderAllForView();

    // A game mounted mid-session can already be 'connected' — route the
    // initial read through the same transition handler as live updates
    // rather than duplicating the "entered connected" logic here.
    onStatusChange(Arcade.peer.status());

    Arcade.peer.onStatus(onStatusChange);
    Arcade.peer.onMessage(onPeerMessage);

    if (Arcade.onStateReplaced) {
        Arcade.onStateReplaced(function () {
            // Keep the actively-connected peer's live in-memory thread (its
            // blobUrls/pendingReceives) rather than replacing it with a
            // reloaded husk that has neither — an import is about history,
            // not about severing whatever is mid-flight right now.
            var wasLive = (livePeerId && chatReady) ? peers.get(livePeerId) : null;
            peers = loadPeers();
            if (wasLive) peers.set(wasLive.id, wasLive);
            viewPeerId = (livePeerId && peers.has(livePeerId)) ? livePeerId : (orderedPeerIds()[0] || null);
            renderAllForView();
        });
    }
    if (Arcade.onSuspend) Arcade.onSuspend(persist);
}

Arcade.ready.then(init);

})();
