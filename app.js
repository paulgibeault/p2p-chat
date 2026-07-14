(function () {
'use strict';

// ---- tunables ----------------------------------------------------------
var RAW_CHUNK_BYTES = 9000;           // ~12000 base64 chars/chunk, well under data-channel limits
var MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file — demo cap, no framework-level chunking helper exists
var HISTORY_LIMIT = 200;              // per thread
var MAX_KNOWN_PEERS = 30;             // evict the least-recently-seen non-live peer beyond this
var CHUNK_PACE_MS = 0;                // yield to the event loop between chunks
var MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / RAW_CHUNK_BYTES); // bound a peer-declared file-meta chunk count

// ---- tiny utils ---------------------------------------------------------
function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
// The SDK ships the canonical escaper — one implementation to audit,
// shared with every other arcade app (see GAME_INTEGRATION §7b).
var escapeHtml = Arcade.html.escape;
// Peer-supplied ids (message/file/group ids) end up in HTML attributes,
// querySelector() selectors and Map keys, so they're constrained at the
// door rather than escaped per use. Device identities do NOT need this —
// fromDeviceId below comes from the launcher's identity handshake, not
// from message content, so it can't be spoofed by a hostile payload.
function sanitizeId(id) {
    return typeof id === 'string' ? id.replace(/[^\w-]/g, '_').slice(0, 128) : '';
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
// One thread per peer we've ever exchanged identities with (deviceId ->
// thread), plus one thread per group chat we're a member of (groupId ->
// thread). Any number of peer threads can be simultaneously live — the
// launcher's transport is a star topology (a host + any number of
// joiners), not strictly 1:1 (v2.0).
var peers = new Map();
var groups = new Map();
var roster = [];          // last Arcade.peer.peers() snapshot: [{deviceId,name,status,direct}]
var knownLiveIds = new Set(); // deviceIds we've already greeted this "arrival" (dedupes onReady)
var viewKey = null;       // 'p:<deviceId>' or 'g:<groupId>' — thread currently shown
var currentStatus = null; // overall Arcade.peer.status() — session-wide transport health
var pausedSends = [];     // resolvers for sendChunk() calls parked while status === 'interrupted'
var renaming = false;     // guards against double-committing the inline rename input

// ---- DOM refs -------------------------------------------------------------
var el = {
    connDot: document.getElementById('connDot'),
    connLabel: document.getElementById('connLabel'),
    banner: document.getElementById('banner'),
    peerTabs: document.getElementById('peerTabs'),
    newGroupBtn: document.getElementById('newGroupBtn'),
    peersEmptyHint: document.getElementById('peersEmptyHint'),
    threadHeader: document.getElementById('threadHeader'),
    threadName: document.getElementById('threadName'),
    renameBtn: document.getElementById('renameBtn'),
    membersBtn: document.getElementById('membersBtn'),
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
    lightboxClose: document.getElementById('lightboxClose'),
    groupModal: document.getElementById('groupModal'),
    groupModalTitle: document.getElementById('groupModalTitle'),
    groupNameRow: document.getElementById('groupNameRow'),
    groupNameInput: document.getElementById('groupNameInput'),
    groupMemberList: document.getElementById('groupMemberList'),
    groupModalSave: document.getElementById('groupModalSave'),
    groupModalCancel: document.getElementById('groupModalCancel'),
    membersModal: document.getElementById('membersModal'),
    membersModalList: document.getElementById('membersModalList'),
    membersModalLeave: document.getElementById('membersModalLeave'),
    membersModalClose: document.getElementById('membersModalClose')
};

// ---- identity --------------------------------------------------------
// Recomputed live rather than cached: null until the very first pairing
// completes, and callers need the up-to-date value at that boundary.
function myDeviceId() {
    var self = Arcade.peer.self();
    return self ? self.deviceId : null;
}

function isLive(deviceId) {
    for (var i = 0; i < roster.length; i++) {
        if (roster[i].deviceId === deviceId) return roster[i].status === 'connected' || roster[i].status === 'interrupted';
    }
    // Arcade.peer.peers() is direct-links-only (a joiner's roster holds just
    // the host — other joiners are reachable only via the host bridge and
    // are, per the framework's own docs, "a game-level concern"). Such a
    // peer still fires onReady and can still be sent to with {to}, so treat
    // "we've heard ready from them and our own session is still up" as the
    // best-effort liveness proxy the framework leaves us to build — there's
    // no departure signal for an indirect peer short of the whole session
    // ending for us.
    return knownLiveIds.has(deviceId) && (currentStatus === 'connected' || currentStatus === 'interrupted');
}

// ---- thread bookkeeping ------------------------------------------------
function revokeBlobUrls(thread) {
    thread.blobUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    thread.blobUrls.clear();
}

function evictStalePeers() {
    if (peers.size <= MAX_KNOWN_PEERS) return;
    var candidates = Array.from(peers.values())
        .filter(function (p) { return !isLive(p.id); })
        .sort(function (a, b) { return a.lastSeen - b.lastSeen; });
    while (peers.size > MAX_KNOWN_PEERS && candidates.length) {
        var drop = candidates.shift();
        revokeBlobUrls(drop);
        peers.delete(drop.id);
        if (viewKey === peerKey(drop.id)) viewKey = null;
    }
    if (!viewKey) viewKey = orderedThreads()[0] ? orderedThreads()[0].key : null;
}

function ensurePeer(id, name) {
    var p = peers.get(id);
    if (!p) {
        p = { id: id, name: name || 'Peer', renamed: false, lastSeen: Date.now(), history: [], blobUrls: new Map(), pendingReceives: new Map(), unread: 0 };
        peers.set(id, p);
        evictStalePeers();
    } else {
        if (name && !p.renamed) p.name = name;
        p.lastSeen = Date.now();
    }
    return p;
}

function ensureGroup(id, name, creatorId, members, rev) {
    var g = groups.get(id);
    if (!g) {
        g = { id: id, name: name || 'Group chat', renamed: false, creatorId: creatorId, members: members, rev: rev, history: [], blobUrls: new Map(), pendingReceives: new Map(), unread: 0, left: false, lastActivity: Date.now() };
        groups.set(id, g);
    }
    return g;
}

function peerKey(id) { return 'p:' + id; }
function groupKey(id) { return 'g:' + id; }

function orderedThreads() {
    var out = [];
    peers.forEach(function (p) { out.push({ key: peerKey(p.id), kind: 'peer', id: p.id, obj: p, activity: p.lastSeen }); });
    groups.forEach(function (g) { out.push({ key: groupKey(g.id), kind: 'group', id: g.id, obj: g, activity: g.lastActivity }); });
    out.sort(function (a, b) { return b.activity - a.activity; });
    return out;
}

function currentThread() {
    if (!viewKey) return null;
    var kind = viewKey.charAt(0) === 'p' ? 'peer' : 'group';
    var obj = kind === 'peer' ? peers.get(viewKey.slice(2)) : groups.get(viewKey.slice(2));
    return obj ? { key: viewKey, kind: kind, obj: obj } : null;
}

function switchView(key) {
    if (viewKey === key) return;
    viewKey = key;
    var t = currentThread();
    if (t) t.obj.unread = 0;
    renderAllForView();
}

// Every group member the current device can currently reach directly.
function liveGroupMembers(g) {
    var me = myDeviceId();
    return g.members.filter(function (m) { return m.deviceId !== me && isLive(m.deviceId); });
}
function groupHasAnyLiveMember(g) { return liveGroupMembers(g).length > 0; }

// Re-push the current membership to a member who just (re)connected — the
// only way an offline-at-invite-time member ever learns about a group, and
// how membership edits reach someone who was offline when they happened.
function resyncGroupsFor(deviceId) {
    var me = myDeviceId();
    groups.forEach(function (g) {
        if (g.left || g.creatorId !== me) return;
        if (!g.members.some(function (m) { return m.deviceId === deviceId; })) return;
        Arcade.peer.send({ t: 'group-sync', groupId: g.id, name: g.name, members: g.members, rev: g.rev }, { to: deviceId });
    });
}

// ---- persistence ----------------------------------------------------------
function slimHistory(history) {
    return history.map(function (m) {
        var out = { id: m.id, dir: m.dir, kind: m.kind, ts: m.ts };
        if (m.kind === 'text') out.text = m.text;
        if (m.kind === 'file') {
            out.file = { id: m.file.id, name: m.file.name, mime: m.file.mime, size: m.file.size, state: m.file.state };
        }
        if (m.fromName) out.fromName = m.fromName;
        if (m.dir === 'sys') out.text = m.text;
        return out;
    });
}
function persist() {
    var outPeers = {};
    peers.forEach(function (p, id) {
        outPeers[id] = { id: p.id, name: p.name, renamed: p.renamed, lastSeen: p.lastSeen, history: slimHistory(p.history) };
    });
    Arcade.state.set('peers', outPeers);
    var outGroups = {};
    groups.forEach(function (g, id) {
        outGroups[id] = { id: g.id, name: g.name, renamed: g.renamed, creatorId: g.creatorId, members: g.members, rev: g.rev, left: g.left, lastActivity: g.lastActivity, history: slimHistory(g.history) };
    });
    Arcade.state.set('groups', outGroups);
}
function loadPeers() {
    var saved = Arcade.state.get('peers');
    var map = new Map();
    if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach(function (id) {
            var raw = saved[id] || {};
            var hist = Array.isArray(raw.history) ? raw.history : [];
            hist.forEach(function (m) { if (m.kind === 'file') m.file.available = false; }); // blobs don't survive reload
            map.set(id, { id: id, name: raw.name || 'Peer', renamed: !!raw.renamed, lastSeen: raw.lastSeen || 0, history: hist, blobUrls: new Map(), pendingReceives: new Map(), unread: 0 });
        });
    }
    return map;
}
function loadGroups() {
    var saved = Arcade.state.get('groups');
    var map = new Map();
    if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach(function (id) {
            var raw = saved[id] || {};
            var hist = Array.isArray(raw.history) ? raw.history : [];
            hist.forEach(function (m) { if (m.kind === 'file') m.file.available = false; });
            var members = Array.isArray(raw.members) ? raw.members : [];
            map.set(id, {
                id: id, name: raw.name || 'Group chat', renamed: !!raw.renamed,
                creatorId: raw.creatorId || '', members: members, rev: raw.rev || 1,
                left: !!raw.left, lastActivity: raw.lastActivity || 0, history: hist,
                blobUrls: new Map(), pendingReceives: new Map(), unread: 0
            });
        });
    }
    return map;
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

function fileBubbleInner(thread, entry) {
    var f = entry.file;
    var url = thread.blobUrls.get(f.id);
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

function rowHtml(thread, entry) {
    if (entry.dir === 'sys') {
        return '<div class="msg-row sys" data-id="' + entry.id + '"><div class="bubble">' + escapeHtml(entry.text) + '</div></div>';
    }
    var bubbleInner = entry.kind === 'file' ? fileBubbleInner(thread, entry) : escapeHtml(entry.text);
    var meta = formatTime(entry.ts) + (entry.failed ? ' · not delivered' : '');
    var sender = (entry.dir === 'in' && entry.fromName) ? '<span class="msg-sender">' + escapeHtml(entry.fromName) + '</span>' : '';
    return '<div class="msg-row ' + entry.dir + '" data-id="' + entry.id + '">' +
        '<div class="bubble">' + sender + bubbleInner + '<span class="msg-meta">' + meta + '</span></div>' +
        '</div>';
}

function appendRow(thread, entry) {
    var wasNearBottom = isNearBottom();
    el.messages.insertAdjacentHTML('beforeend', rowHtml(thread, entry));
    if (entry.dir === 'out' || wasNearBottom) scrollToBottom();
    else el.jumpLatest.hidden = false;
}

function renderMessagesFor(thread) {
    el.messages.innerHTML = thread ? thread.history.map(function (e) { return rowHtml(thread, e); }).join('') : '';
    scrollToBottom();
}

function updateFileRowInMessages(thread, fileId) {
    var card = el.messages.querySelector('.file-card[data-file-id="' + fileId + '"]');
    if (!card) return;
    var entry = thread.history.find(function (m) { return m.kind === 'file' && m.file.id === fileId; });
    if (!entry) return;
    card.outerHTML = fileBubbleInner(thread, entry);
}

function renderFilesPanelFor(thread) {
    var files = thread ? thread.history.filter(function (m) { return m.kind === 'file'; }) : [];
    el.filesBadge.hidden = files.length === 0;
    el.filesBadge.textContent = files.length;
    el.filesCount.textContent = files.length + (files.length === 1 ? ' file' : ' files');
    el.filesList.innerHTML = !thread ? '' : files.slice().reverse().map(function (m) {
        var f = m.file;
        var url = thread.blobUrls.get(f.id);
        var dirTag = m.dir === 'out' ? 'Sent' : (m.fromName ? escapeHtml(m.fromName) : 'Received');
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

function renderTabs() {
    var threads = orderedThreads();
    el.peerTabs.hidden = threads.length === 0;
    el.peersEmptyHint.hidden = threads.length !== 0;
    el.subTabs.hidden = threads.length === 0;
    el.panels.hidden = threads.length === 0;
    el.newGroupBtn.hidden = peers.size === 0;
    el.peerTabs.innerHTML = threads.map(function (t) {
        var isActive = t.key === viewKey;
        var isLiveNow = t.kind === 'peer' ? isLive(t.id) : groupHasAnyLiveMember(t.obj);
        var cls = 'peer-tab' + (isActive ? ' active' : '') + (isLiveNow ? ' live' : '');
        var unread = t.obj.unread > 0 ? '<span class="peer-unread">' + t.obj.unread + '</span>' : '';
        var icon = t.kind === 'group' ? '<span class="tab-icon" aria-hidden="true">👥</span>' : '<span class="peer-dot"></span>';
        return '<button type="button" class="' + cls + '" data-tab-key="' + t.key + '" role="tab" aria-selected="' + isActive + '" title="' + escapeHtml(t.obj.name) + '">' +
            icon + escapeHtml(t.obj.name) + unread + '</button>';
    }).join('');
}

function updateThreadHeader() {
    var t = currentThread();
    if (!t) { el.threadHeader.hidden = true; return; }
    el.threadHeader.hidden = false;
    el.threadName.textContent = t.obj.name;
    el.membersBtn.hidden = t.kind !== 'group';
}

function setComposerEnabled(on, placeholder) {
    el.textInput.disabled = !on;
    el.sendBtn.disabled = !on;
    el.attachBtn.disabled = !on;
    el.textInput.placeholder = placeholder || (on ? 'Type a message…' : 'Pair with a peer to start chatting…');
}

function updateComposerForView() {
    var t = currentThread();
    if (!t) {
        setComposerEnabled(false);
        el.peerArchivedHint.hidden = true;
        return;
    }
    var live = t.kind === 'peer' ? isLive(t.obj.id) : (!t.obj.left && groupHasAnyLiveMember(t.obj));
    if (live) {
        setComposerEnabled(true);
        el.peerArchivedHint.hidden = true;
    } else {
        setComposerEnabled(false, 'Reconnect to send messages…');
        el.peerArchivedHint.hidden = false;
        el.peerArchivedHint.textContent = t.kind === 'group' && t.obj.left
            ? 'You left this group — viewing history only.'
            : 'Viewing history — open the arcade\'s Multiplayer menu to reconnect and send new messages.';
    }
}

function renderAllForView() {
    var t = currentThread();
    renderMessagesFor(t ? t.obj : null);
    renderFilesPanelFor(t ? t.obj : null);
    renderTabs();
    updateThreadHeader();
    updateComposerForView();
}

// ---- history mutation ---------------------------------------------------
function pushEntry(thread, entry) {
    thread.history.push(entry);
    if (thread.lastActivity !== undefined) thread.lastActivity = Date.now();
    var trimmed = false;
    while (thread.history.length > HISTORY_LIMIT) {
        var dropped = thread.history.shift();
        trimmed = true;
        if (dropped.kind === 'file') {
            var u = thread.blobUrls.get(dropped.file.id);
            if (u) { URL.revokeObjectURL(u); thread.blobUrls.delete(dropped.file.id); }
        }
    }
    persist();
    return trimmed;
}
// Adds an entry and keeps the DOM in sync when the thread is the one on
// screen; otherwise just tallies an unread badge on its tab.
function commitEntryFor(thread, entry) {
    var trimmed = pushEntry(thread, entry);
    var key = thread.creatorId !== undefined ? groupKey(thread.id) : peerKey(thread.id);
    if (viewKey !== key) {
        if (entry.dir !== 'out') thread.unread++;
        renderTabs();
        return;
    }
    if (trimmed) renderAllForView();
    else { appendRow(thread, entry); renderFilesPanelFor(thread); renderTabs(); }
}
function pushSystemFor(thread, text) {
    commitEntryFor(thread, { id: uid(), dir: 'sys', kind: 'text', text: text, ts: Date.now() });
}

// ---- connection status ---------------------------------------------------
function resumePausedSends() {
    var waiters = pausedSends;
    pausedSends = [];
    waiters.forEach(function (fn) { fn(); });
}

function updateConnUI(status) {
    currentStatus = status;
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
        var names = roster.filter(function (r) { return r.status === 'connected' || r.status === 'interrupted'; }).map(function (r) { return r.name; });
        if (names.length === 0) el.connLabel.textContent = 'Connected';
        else if (names.length === 1) el.connLabel.textContent = 'Chatting with ' + names[0];
        else el.connLabel.textContent = 'Chatting with ' + names.length + ' peers';
        el.banner.hidden = true;
    }
    updateComposerForView();
}

// ---- roster / presence ---------------------------------------------------
function onPeerReady(info) {
    var id = sanitizeId(info.deviceId);
    if (!id) return;
    var firstEver = peers.size === 0 && groups.size === 0;
    var wasKnownLive = knownLiveIds.has(id);
    var p = ensurePeer(id, info.name);
    if (!wasKnownLive) {
        knownLiveIds.add(id);
        pushSystemFor(p, 'Connected — chatting with ' + p.name);
        if (firstEver || !viewKey) viewKey = peerKey(id);
        resyncGroupsFor(id);
    }
    persist();
    renderAllForView();
}

function onPeersChange(list) {
    var prevIds = {};
    roster.forEach(function (r) { prevIds[r.deviceId] = true; });
    roster = Array.isArray(list) ? list : [];
    var nowIds = {};
    roster.forEach(function (r) { nowIds[r.deviceId] = true; });

    Object.keys(prevIds).forEach(function (id) {
        if (nowIds[id]) return;
        knownLiveIds.delete(id);
        var p = peers.get(id);
        if (!p) return;
        pushSystemFor(p, p.name + ' disconnected');
        p.pendingReceives.clear();
        p.history.forEach(function (m) {
            if (m.kind === 'file' && (m.file.state === 'sending' || m.file.state === 'receiving')) m.file.state = 'failed';
        });
        persist();
        if (viewKey === peerKey(id)) renderAllForView();
    });
    Object.keys(nowIds).forEach(function (id) { if (!prevIds[id]) resyncGroupsFor(id); });

    renderAllForView();
}

// ---- incoming messages ---------------------------------------------------
function nameFor(deviceId) {
    var p = peers.get(deviceId);
    if (p) return p.name;
    return 'Peer';
}

function onPeerMessage(payload, fromDeviceId) {
    if (!payload || typeof payload !== 'object') return;
    var fromId = sanitizeId(fromDeviceId);

    switch (payload.t) {
        case 'group-sync': {
            var gsId = sanitizeId(payload.groupId);
            if (!gsId || !fromId) break;
            var members = Array.isArray(payload.members) ? payload.members
                .filter(function (m) { return m && sanitizeId(m.deviceId); })
                .map(function (m) { return { deviceId: sanitizeId(m.deviceId), name: (typeof m.name === 'string' ? m.name.slice(0, 60) : 'Peer') }; }) : [];
            var rev = typeof payload.rev === 'number' ? payload.rev : 0;
            var existing = groups.get(gsId);
            if (!existing) {
                // First time we've heard of this group: whoever told us
                // about it is trusted as its creator — never trust a
                // self-declared creatorId field in the payload itself.
                var g = ensureGroup(gsId, typeof payload.name === 'string' ? payload.name : 'Group chat', fromId, members, rev);
                g.lastActivity = Date.now();
                persist();
                renderAllForView();
            } else if (fromId === existing.creatorId && rev > existing.rev) {
                // Only the original creator's updates are honored, and only
                // if newer — an impersonator or stale/replayed frame is ignored.
                existing.rev = rev;
                if (!existing.renamed) existing.name = typeof payload.name === 'string' ? payload.name : existing.name;
                var me = myDeviceId();
                var stillMember = members.some(function (m) { return m.deviceId === me; });
                existing.members = members;
                if (!stillMember) existing.left = true;
                persist();
                if (viewKey === groupKey(gsId)) renderAllForView(); else renderTabs();
            }
            break;
        }

        case 'group-leave': {
            var glId = sanitizeId(payload.groupId);
            if (!glId || !fromId) break;
            var lg = groups.get(glId);
            if (!lg) break;
            var idx = lg.members.findIndex(function (m) { return m.deviceId === fromId; });
            if (idx === -1) break;
            var leftName = lg.members[idx].name;
            lg.members = lg.members.slice(0, idx).concat(lg.members.slice(idx + 1));
            pushSystemFor(lg, leftName + ' left the group');
            break;
        }

        case 'msg': {
            if (!fromId) break;
            var groupId = sanitizeId(payload.groupId);
            var text = String(payload.text || '');
            var msgId = sanitizeId(payload.id) || uid();
            var ts = payload.ts || Date.now();
            if (groupId) {
                var mg = groups.get(groupId);
                if (!mg || mg.left) break;
                if (!mg.members.some(function (m) { return m.deviceId === fromId; })) break;
                commitEntryFor(mg, { id: msgId, dir: 'in', kind: 'text', text: text, ts: ts, fromName: nameFor(fromId) });
            } else {
                var mp = ensurePeer(fromId);
                commitEntryFor(mp, { id: msgId, dir: 'in', kind: 'text', text: text, ts: ts });
            }
            break;
        }

        case 'file-meta': {
            if (!fromId) break;
            var fmGroupId = sanitizeId(payload.groupId);
            var fmThread = fmGroupId ? groups.get(fmGroupId) : ensurePeer(fromId);
            if (!fmThread) break;
            if (fmGroupId && (fmThread.left || !fmThread.members.some(function (m) { return m.deviceId === fromId; }))) break;
            var metaId = sanitizeId(payload.id);
            if (!metaId) break;
            var totalChunks = payload.chunks;
            if (typeof totalChunks !== 'number' || !isFinite(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) break;
            fmThread.pendingReceives.set(metaId, {
                name: payload.name, mime: payload.mime, size: payload.size,
                total: totalChunks, chunks: new Array(totalChunks), got: 0, fromId: fromId
            });
            commitEntryFor(fmThread, {
                id: uid(), dir: 'in', kind: 'file', ts: payload.ts || Date.now(), fromName: fmGroupId ? nameFor(fromId) : undefined,
                file: { id: metaId, name: payload.name, mime: payload.mime, size: payload.size, state: 'receiving', progress: 0 }
            });
            break;
        }

        case 'file-chunk': {
            if (!fromId) break;
            var fcGroupId = sanitizeId(payload.groupId);
            var fcThread = fcGroupId ? groups.get(fcGroupId) : peers.get(fromId);
            if (!fcThread) break;
            var chunkId = sanitizeId(payload.id);
            if (!chunkId) break;
            var pending = fcThread.pendingReceives.get(chunkId);
            if (!pending || pending.fromId !== fromId) break;
            var seq = payload.seq;
            if (typeof seq !== 'number' || seq < 0 || seq >= pending.total) break;
            pending.chunks[seq] = payload.data;
            pending.got++;
            var progress = Math.round((pending.got / pending.total) * 100);
            var entry = fcThread.history.find(function (m) { return m.kind === 'file' && m.file.id === chunkId; });
            if (entry) {
                entry.file.progress = progress;
                var fcKey = fcGroupId ? groupKey(fcGroupId) : peerKey(fromId);
                if (viewKey === fcKey) { updateFileRowInMessages(fcThread, chunkId); renderFilesPanelFor(fcThread); }
            }
            break;
        }

        case 'file-done': {
            if (!fromId) break;
            var fdGroupId = sanitizeId(payload.groupId);
            var fdThread = fdGroupId ? groups.get(fdGroupId) : peers.get(fromId);
            if (!fdThread) break;
            var doneId = sanitizeId(payload.id);
            if (!doneId) break;
            var p = fdThread.pendingReceives.get(doneId);
            if (!p || p.fromId !== fromId) break;
            fdThread.pendingReceives.delete(doneId);
            var e = fdThread.history.find(function (m) { return m.kind === 'file' && m.file.id === doneId; });
            if (!e) break;
            if (p.got !== p.total || p.chunks.indexOf(undefined) !== -1) {
                e.file.state = 'failed';
                Arcade.ui.toast('File transfer incomplete: ' + e.file.name, { kind: 'error' });
            } else {
                var totalLen = 0, byteParts = p.chunks.map(function (c) { var b = base64ToBytes(c); totalLen += b.length; return b; });
                var combined = new Uint8Array(totalLen);
                var offset = 0;
                byteParts.forEach(function (b) { combined.set(b, offset); offset += b.length; });
                var blob = new Blob([combined], { type: p.mime || 'application/octet-stream' });
                var url = URL.createObjectURL(blob);
                fdThread.blobUrls.set(doneId, url);
                e.file.state = 'done';
                e.file.progress = 100;
                e.file.available = true;
            }
            persist();
            var fdKey = fdGroupId ? groupKey(fdGroupId) : peerKey(fromId);
            if (viewKey === fdKey) { updateFileRowInMessages(fdThread, doneId); renderFilesPanelFor(fdThread); }
            break;
        }
    }
}

// ---- sending --------------------------------------------------------------
function targetsFor(t) {
    if (t.kind === 'peer') return [t.obj.id];
    var me = myDeviceId();
    return t.obj.members.filter(function (m) { return m.deviceId !== me; }).map(function (m) { return m.deviceId; });
}

function sendText(text) {
    var t = currentThread();
    if (!t) return;
    var targets = targetsFor(t);
    var id = uid(), ts = Date.now();
    var okAny = false;
    targets.forEach(function (deviceId) {
        var payload = { t: 'msg', id: id, ts: ts, text: text };
        if (t.kind === 'group') payload.groupId = t.obj.id;
        if (Arcade.peer.send(payload, { to: deviceId })) okAny = true;
    });
    var entry = { id: id, dir: 'out', kind: 'text', text: text, ts: ts };
    if (!okAny) entry.failed = true;
    commitEntryFor(t.obj, entry);
}

function sendFile(file) {
    var t = currentThread();
    if (!t) return Promise.resolve();
    var targets = targetsFor(t);
    if (targets.length === 0) return Promise.resolve();
    if (file.size === 0) { Arcade.ui.toast("Can't send an empty file", { kind: 'error' }); return Promise.resolve(); }
    if (file.size > MAX_FILE_BYTES) {
        Arcade.ui.toast('File too large (' + formatBytes(file.size) + ') — demo limit is ' + formatBytes(MAX_FILE_BYTES), { kind: 'error' });
        return Promise.resolve();
    }
    var thread = t.obj;
    var groupId = t.kind === 'group' ? thread.id : undefined;
    var id = uid();
    var ts = Date.now();
    var mime = file.type || 'application/octet-stream';
    var total = Math.max(1, Math.ceil(file.size / RAW_CHUNK_BYTES));

    var entry = { id: uid(), dir: 'out', kind: 'file', ts: ts, file: { id: id, name: file.name, mime: mime, size: file.size, state: 'sending', progress: 0 } };
    thread.blobUrls.set(id, URL.createObjectURL(file));
    commitEntryFor(thread, entry);

    function fail() {
        entry.file.state = 'failed';
        persist();
        if (viewKey === t.key) { updateFileRowInMessages(thread, id); renderFilesPanelFor(thread); }
        Arcade.ui.toast('Could not send ' + file.name + ' — connection lost', { kind: 'error' });
    }

    return file.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        var active = targets.filter(function (to) {
            var meta = { t: 'file-meta', id: id, ts: ts, name: file.name, mime: mime, size: file.size, chunks: total };
            if (groupId) meta.groupId = groupId;
            return Arcade.peer.send(meta, { to: to });
        });
        if (active.length === 0) { fail(); return; }

        function sendChunk(seq) {
            if (currentStatus === 'interrupted') {
                // Sends during 'interrupted' still queue for replay (v1.7) rather than
                // failing outright, so racing ahead here would silently blow the
                // transport's replay-queue cap; park until the status settles.
                return new Promise(function (resolve) { pausedSends.push(resolve); }).then(function () { return sendChunk(seq); });
            }
            active = active.filter(function (to) { return isLive(to); });
            if (active.length === 0) { fail(); return; }
            if (seq >= total) {
                active.forEach(function (to) {
                    var doneMsg = { t: 'file-done', id: id };
                    if (groupId) doneMsg.groupId = groupId;
                    Arcade.peer.send(doneMsg, { to: to });
                });
                entry.file.state = 'done';
                entry.file.progress = 100;
                persist();
                if (viewKey === t.key) { updateFileRowInMessages(thread, id); renderFilesPanelFor(thread); }
                return;
            }
            var start = seq * RAW_CHUNK_BYTES;
            var slice = bytes.subarray(start, Math.min(start + RAW_CHUNK_BYTES, bytes.length));
            var data = bytesToBase64(slice);
            active = active.filter(function (to) {
                var chunkMsg = { t: 'file-chunk', id: id, seq: seq, data: data };
                if (groupId) chunkMsg.groupId = groupId;
                return Arcade.peer.send(chunkMsg, { to: to });
            });
            if (active.length === 0) { fail(); return; }
            entry.file.progress = Math.round(((seq + 1) / total) * 100);
            if (viewKey === t.key) { updateFileRowInMessages(thread, id); renderFilesPanelFor(thread); }
            return sleep(CHUNK_PACE_MS).then(function () { return sendChunk(seq + 1); });
        }
        return sendChunk(0);
    });
}

// ---- clear actions ----------------------------------------------------
function clearChat() {
    var t = currentThread();
    if (!t) return;
    revokeBlobUrls(t.obj);
    t.obj.pendingReceives.clear();
    t.obj.history = [];
    t.obj.unread = 0;
    persist();
    renderAllForView();
}
function clearFiles() {
    var t = currentThread();
    if (!t) return;
    t.obj.history.filter(function (m) { return m.kind === 'file'; }).forEach(function (m) {
        var u = t.obj.blobUrls.get(m.file.id);
        if (u) { URL.revokeObjectURL(u); t.obj.blobUrls.delete(m.file.id); }
    });
    t.obj.history = t.obj.history.filter(function (m) { return m.kind !== 'file'; });
    persist();
    renderAllForView();
}

// ---- rename ------------------------------------------------------------
function startRename() {
    var t = currentThread();
    if (!t || renaming) return;
    renaming = true;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'thread-name-input';
    input.maxLength = 60;
    input.value = t.obj.name;
    el.threadName.replaceWith(input);
    input.focus();
    input.select();
    function commit() {
        if (!renaming) return;
        renaming = false;
        var val = input.value.trim();
        if (val) { t.obj.name = val; t.obj.renamed = true; persist(); }
        input.replaceWith(el.threadName);
        renderAllForView();
    }
    function cancel() {
        if (!renaming) return;
        renaming = false;
        input.replaceWith(el.threadName);
        renderAllForView();
    }
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
}

// ---- group create / manage modal ---------------------------------------
var groupModalMode = 'create'; // 'create' | 'manage'

function knownPeerRows(checkedIds) {
    var checked = checkedIds || [];
    return Array.from(peers.values()).sort(function (a, b) { return b.lastSeen - a.lastSeen; }).map(function (p) {
        var isChecked = checked.indexOf(p.id) !== -1;
        var status = isLive(p.id) ? 'online' : 'offline';
        return '<label class="member-row"><input type="checkbox" value="' + p.id + '"' + (isChecked ? ' checked' : '') + '>' +
            '<span class="member-name">' + escapeHtml(p.name) + '</span>' +
            '<span class="member-status ' + status + '">' + status + '</span></label>';
    }).join('');
}

function openCreateGroupModal() {
    groupModalMode = 'create';
    el.groupModalTitle.textContent = 'New group chat';
    el.groupNameRow.hidden = false;
    el.groupNameInput.value = '';
    el.groupMemberList.innerHTML = knownPeerRows([]);
    el.groupModalSave.textContent = 'Create';
    el.groupModal.hidden = false;
    el.groupNameInput.focus();
}

function openManageMembersModal() {
    var t = currentThread();
    if (!t || t.kind !== 'group') return;
    groupModalMode = 'manage';
    el.groupModalTitle.textContent = 'Manage members';
    el.groupNameRow.hidden = true;
    el.groupMemberList.innerHTML = knownPeerRows(t.obj.members.map(function (m) { return m.deviceId; }));
    el.groupModalSave.textContent = 'Save';
    el.groupModal.hidden = false;
}

function closeGroupModal() { el.groupModal.hidden = true; }

function submitGroupModal() {
    var checked = Array.prototype.slice.call(el.groupMemberList.querySelectorAll('input[type=checkbox]:checked')).map(function (cb) { return cb.value; });
    var me = myDeviceId();
    if (!me) { closeGroupModal(); return; }
    var memberObjs = checked.map(function (id) { var p = peers.get(id); return { deviceId: id, name: p ? p.name : 'Peer' }; });
    var mySelf = Arcade.peer.self();
    memberObjs.push({ deviceId: me, name: (mySelf && mySelf.name) || 'Me' });

    if (groupModalMode === 'create') {
        if (checked.length === 0) { closeGroupModal(); return; }
        var name = el.groupNameInput.value.trim() || 'Group chat';
        var id = 'g' + uid();
        var g = ensureGroup(id, name, me, memberObjs, 1);
        g.renamed = true; // the creator's chosen name always wins over any future sync no-op
        persist();
        viewKey = groupKey(id);
        memberObjs.forEach(function (m) {
            if (m.deviceId === me) return;
            Arcade.peer.send({ t: 'group-sync', groupId: id, name: name, members: memberObjs, rev: 1 }, { to: m.deviceId });
        });
        renderAllForView();
    } else {
        var t = currentThread();
        if (!t || t.kind !== 'group') { closeGroupModal(); return; }
        var g2 = t.obj;
        var prevMembers = g2.members;
        g2.rev += 1;
        g2.members = memberObjs;
        persist();
        var union = {};
        prevMembers.concat(memberObjs).forEach(function (m) { if (m.deviceId !== me) union[m.deviceId] = true; });
        Object.keys(union).forEach(function (deviceId) {
            Arcade.peer.send({ t: 'group-sync', groupId: g2.id, name: g2.name, members: memberObjs, rev: g2.rev }, { to: deviceId });
        });
        renderAllForView();
    }
    closeGroupModal();
}

// ---- members panel (view-only + leave) ----------------------------------
function openMembersPanel() {
    var t = currentThread();
    if (!t || t.kind !== 'group') return;
    var me = myDeviceId();
    if (t.obj.creatorId === me) { openManageMembersModal(); return; }
    el.membersModalList.innerHTML = t.obj.members.map(function (m) {
        var status = m.deviceId === me ? 'you' : (isLive(m.deviceId) ? 'online' : 'offline');
        return '<div class="member-row read-only"><span class="member-name">' + escapeHtml(m.name) + '</span>' +
            '<span class="member-status ' + status + '">' + status + '</span></div>';
    }).join('');
    el.membersModalLeave.hidden = t.obj.left;
    el.membersModal.hidden = false;
}
function closeMembersModal() { el.membersModal.hidden = true; }

function leaveGroup() {
    var t = currentThread();
    if (!t || t.kind !== 'group') return;
    var g = t.obj;
    g.left = true;
    persist();
    liveGroupMembers(g).forEach(function (m) {
        Arcade.peer.send({ t: 'group-leave', groupId: g.id }, { to: m.deviceId });
    });
    closeMembersModal();
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
        if (btn) switchView(btn.getAttribute('data-tab-key'));
    });
    el.newGroupBtn.addEventListener('click', openCreateGroupModal);

    el.renameBtn.addEventListener('click', startRename);
    el.membersBtn.addEventListener('click', openMembersPanel);

    el.groupModalSave.addEventListener('click', submitGroupModal);
    el.groupModalCancel.addEventListener('click', closeGroupModal);
    el.groupModal.addEventListener('click', function (e) { if (e.target === el.groupModal) closeGroupModal(); });

    el.membersModalClose.addEventListener('click', closeMembersModal);
    el.membersModal.addEventListener('click', function (e) { if (e.target === el.membersModal) closeMembersModal(); });

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
    armToConfirm(el.clearChatBtn, function () { var t = currentThread(); return !!t && t.obj.history.length > 0; }, clearChat);
    armToConfirm(el.clearFilesBtn, function () { var t = currentThread(); return !!t && t.obj.history.some(function (m) { return m.kind === 'file'; }); }, clearFiles);
    armToConfirm(el.membersModalLeave, function () { return true; }, leaveGroup);

    el.messages.addEventListener('click', function (e) {
        var thumb = e.target.closest('.file-thumb');
        if (thumb) openMedia('image/*', thumb.src, thumb.alt);
    });
    el.filesList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-remove]');
        if (btn) {
            var t = currentThread();
            if (!t) return;
            var fid = btn.getAttribute('data-remove');
            var u = t.obj.blobUrls.get(fid);
            if (u) { URL.revokeObjectURL(u); t.obj.blobUrls.delete(fid); }
            t.obj.history = t.obj.history.filter(function (m) { return !(m.kind === 'file' && m.file.id === fid); });
            persist();
            renderAllForView();
            return;
        }
        if (e.target.closest('a[download]')) return; // let the download proceed as-is
        var row = e.target.closest('.file-row.previewable');
        if (!row) return;
        var t = currentThread();
        if (!t) return;
        var url = t.obj.blobUrls.get(row.getAttribute('data-file-id'));
        if (url) openMedia(row.getAttribute('data-mime'), url, row.getAttribute('data-file-name') || '');
    });
    el.lightboxClose.addEventListener('click', closeLightbox);
    el.lightbox.addEventListener('click', function (e) { if (e.target === el.lightbox) closeLightbox(); });
}

function init() {
    if (Arcade.state && Arcade.state.migrate) Arcade.state.migrate('v1', function () {}); // no legacy keys to move; satisfies the migration sentinel
    peers = loadPeers();
    groups = loadGroups();
    var first = orderedThreads()[0];
    viewKey = first ? first.key : null;
    wireUI();
    renderAllForView();

    roster = Arcade.peer.peers();
    roster.forEach(function (r) { if (r.status === 'connected' || r.status === 'interrupted') knownLiveIds.add(r.deviceId); });

    // A game mounted mid-session can already be 'connected' — route the
    // initial read through the same transition handler as live updates
    // rather than duplicating the "entered connected" logic here.
    updateConnUI(Arcade.peer.status());

    Arcade.peer.onStatus(updateConnUI);
    Arcade.peer.onMessage(onPeerMessage);
    Arcade.peer.onReady(onPeerReady);
    Arcade.peer.onPeersChange(onPeersChange);

    if (Arcade.onStateReplaced) {
        Arcade.onStateReplaced(function () {
            // Keep any actively-live thread's in-memory extras (blobUrls/
            // pendingReceives) rather than replacing it with a reloaded husk
            // that has neither — an import is about history, not about
            // severing whatever is mid-flight right now.
            var liveBefore = [];
            peers.forEach(function (p) { if (isLive(p.id)) liveBefore.push(p); });
            groups.forEach(function (g) { if (groupHasAnyLiveMember(g)) liveBefore.push(g); });
            peers = loadPeers();
            groups = loadGroups();
            liveBefore.forEach(function (t) {
                var map = t.creatorId !== undefined ? groups : peers;
                map.set(t.id, t);
            });
            var stillThere = viewKey && (viewKey.charAt(0) === 'p' ? peers.has(viewKey.slice(2)) : groups.has(viewKey.slice(2)));
            if (!stillThere) { var f = orderedThreads()[0]; viewKey = f ? f.key : null; }
            renderAllForView();
        });
    }
    if (Arcade.onSuspend) Arcade.onSuspend(persist);
}

Arcade.ready.then(init);

})();
