/**
 * kensaku.js
 * 【責務】: NIP-50 キーワード＆期間指定検索ページ（kensaku.html）の制御
 *
 * リレーの使い分け:
 *   - 検索用リレー（NIP-50）: このファイル内の専用 WebSocket。検索 REQ だけを投げる
 *   - 通常リレー（kind:0取得 / kind:6,7送信 / kind:7の自分分取得 / カスタム絵文字）: window.relayManager
 *   検索専用リレーには書き込みも kind:0 取得もしない。
 */
(function () {
    'use strict';

    console.log('🚀 kensaku.js loaded');

    const DEFAULT_SEARCH_RELAY = 'wss://search.nos.today';
    const DEFAULT_NORMAL_RELAY = 'wss://r.kojira.io/';
    const SEARCH_KINDS = [1, 1111];
    const SEARCH_LIMIT = 100;
    const SEARCH_TIMEOUT_MS = 15000;
    const SCROLL_TOP_THRESHOLD = 200;

    const LS_SEARCH_RELAY = 'kensakuSearchRelay';
    const LS_NORMAL_RELAY = 'kensakuNormalRelay';

    const isValidRelayUrl = (url) => /^wss?:\/\/.+/i.test(url || '');
    const normalizeUrl = (url) => (url || '').trim().replace(/\/+$/, '').toLowerCase();
    const pad2 = (n) => String(n).padStart(2, '0');

    /* ---------- DataStore（okkake.js と同じ簡易版） ---------- */
    window.dataStore = {
        events: new Map(),
        profiles: new Map(),
        likedByMeIds: new Set(),
        addEvent(ev) { if (!this.events.has(ev.id)) this.events.set(ev.id, ev); },
        addProfile(pubkey, profile) { this.profiles.set(pubkey, profile); },
        markAsLikedByMe(eventId) { this.likedByMeIds.add(eventId); },
        isLikedByMe(eventId) { return this.likedByMeIds.has(eventId); }
    };

    /* ---------- 共通アクションメニュー ---------- */
    window.kensakuActionMenu = new NostrActionMenu({
        getRelayUrl: () => window.relayManager.url,
        publish: async (event) => window.relayManager.publish(event)
    });

    /* ---------- カスタム絵文字（通常リレー経由） ---------- */
    let cusemoLoadedKey = null;
    function ensureCustomEmojisLoaded() {
        const mgr = window.customEmojiManager;
        const auth = window.nostrAuth;
        if (!mgr || !auth?.pubkey || !auth.canWrite() || !relayManager.isConnected()) return;

        const key = auth.pubkey + '@' + relayManager.url;
        if (cusemoLoadedKey === key) return;
        if (cusemoLoadedKey && !cusemoLoadedKey.startsWith(auth.pubkey + '@')) {
            mgr.emojis.clear();
        }
        cusemoLoadedKey = key;
        mgr.fetchMyEmojis(auth.pubkey);
    }

    /* ---------- ProfileFetcher（通常リレーのみ） ---------- */
    const PROFILE_CHUNK = 100;
    const profileFetcher = {
        queue: new Set(),
        inProgress: new Set(),
        timer: null,
        seq: 0,

        request(pubkey) {
            if (dataStore.profiles.has(pubkey) || this.inProgress.has(pubkey)) return;
            this.queue.add(pubkey);
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.flush(), 300);
        },

        flush() {
            if (this.queue.size === 0 || !relayManager.isConnected()) return;

            const all = Array.from(this.queue);
            this.queue.clear();

            for (let i = 0; i < all.length; i += PROFILE_CHUNK) {
                const pubkeys = all.slice(i, i + PROFILE_CHUNK);
                pubkeys.forEach(pk => this.inProgress.add(pk));
                const subId = `kensaku-profiles-${Date.now()}-${this.seq++}`;

                relayManager.subscribe(subId, { kinds: [0], authors: pubkeys }, (type, ev) => {
                    if (type === 'EVENT' && ev?.kind === 0 && window.NostrTools.verifyEvent(ev)) {
                        try {
                            const prev = dataStore.profiles.get(ev.pubkey);
                            if (!prev || (prev._created_at || 0) < ev.created_at) {
                                const profile = JSON.parse(ev.content);
                                profile._created_at = ev.created_at;
                                dataStore.addProfile(ev.pubkey, profile);
                            }
                        } catch (e) {
                            console.error('❌ profile parse error', e);
                        }
                    } else if (type === 'EOSE') {
                        relayManager.unsubscribe(subId);
                        pubkeys.forEach(pk => this.inProgress.delete(pk));
                        render();
                    }
                });
            }
        },

        flushNow() {
            clearTimeout(this.timer);
            this.flush();
        }
    };

    /* ---------- 通常リレー接続 ---------- */
    async function connectNormalRelay(url) {
        if (!isValidRelayUrl(url)) return false;
        try {
            await relayManager.connect(url);
            localStorage.setItem(LS_NORMAL_RELAY, url);
            return true;
        } catch (e) {
            console.warn('⚠️ 通常リレー接続失敗:', url, e);
            return false;
        }
    }

    let searchSocket = null;
    let searchSeq = 0;
    let currentEvents = [];

    function closeSearchSocket() {
        if (!searchSocket) return;
        try { searchSocket.close(); } catch (_) { /* noop */ }
        searchSocket = null;
    }

    function setClearButtonVisible(visible) {
        const clearBtn = document.getElementById('clear-btn');
        const searchBtn = document.getElementById('search-btn');
        const shown = Boolean(visible);
        if (clearBtn) clearBtn.style.display = shown ? '' : 'none';
        if (searchBtn) searchBtn.textContent = shown ? '再検索' : '検索';
    }

    function setStatus(msg) {
        const el = document.getElementById('status');
        if (el) el.textContent = msg;
    }

    function toUnix(value, addSeconds = 0) {
        if (!value) return null;
        const ms = new Date(value).getTime();
        return Number.isNaN(ms) ? null : Math.floor(ms / 1000) + addSeconds;
    }

    function toDatetimeLocal(unixSec) {
        const d = new Date(unixSec * 1000);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
            `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    /* ---------- 検索（NIP-50） ---------- */
    function querySearchRelay(url, filter) {
        return new Promise((resolve, reject) => {
            const subId = 'kensaku_' + Math.random().toString(36).slice(2, 9);
            const events = new Map();
            let settled = false;
            let ws;

            const finish = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (searchSocket === ws) searchSocket = null;
                try {
                    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId]));
                    ws?.close();
                } catch (_) { /* noop */ }

                if (err && events.size === 0) reject(err);
                else resolve({ events: Array.from(events.values()), error: err || null });
            };

            try {
                ws = new WebSocket(url);
            } catch (e) {
                reject(e);
                return;
            }
            searchSocket = ws;

            const timer = setTimeout(() => finish(new Error('タイムアウトしました')), SEARCH_TIMEOUT_MS);

            ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
            ws.onmessage = (e) => {
                let msg;
                try { msg = JSON.parse(e.data); } catch { return; }
                if (!Array.isArray(msg) || msg[1] !== subId) return;

                if (msg[0] === 'EVENT') {
                    const ev = msg[2];
                    if (!ev || !SEARCH_KINDS.includes(ev.kind) || events.has(ev.id)) return;
                    if (!window.NostrTools.verifyEvent(ev)) return;
                    events.set(ev.id, ev);
                } else if (msg[0] === 'EOSE') {
                    finish();
                } else if (msg[0] === 'CLOSED') {
                    finish(new Error('リレーが検索を拒否しました: ' + (msg[2] || '')));
                }
            };
            ws.onerror = () => finish(new Error('リレーに接続できませんでした'));
            ws.onclose = () => finish(new Error('リレーとの接続が切れました'));
        });
    }

    function clearSearch() {
        searchSeq += 1;
        closeSearchSocket();

        ['keyword', 'since', 'until'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        const searchBtn = document.getElementById('search-btn');
        const moreBtn = document.getElementById('load-more-btn');
        if (searchBtn) searchBtn.disabled = false;
        if (moreBtn) moreBtn.disabled = false;

        currentEvents = [];
        dataStore.events.clear();
        dataStore.likedByMeIds.clear();

        const timelineEl = document.getElementById('timeline');
        if (timelineEl) timelineEl.innerHTML = '';

        setStatus('');
        render();
    }

    async function doSearch(append = false) {
        const isAppend = Boolean(append);
        const keyword = document.getElementById('keyword').value.trim();
        const searchRelay = document.getElementById('search-relay').value.trim();
        const normalRelay = document.getElementById('normal-relay').value.trim();
        const btn = document.getElementById('search-btn');
        const moreBtn = document.getElementById('load-more-btn');

        if (!keyword) { alert('検索ワードを入力してください'); return; }
        if (!isValidRelayUrl(searchRelay)) { alert('検索用リレーURL（wss://...）を入力してください'); return; }
        if (!isValidRelayUrl(normalRelay)) { alert('通常リレーURL（wss://...）を入力してください'); return; }

        const since = toUnix(document.getElementById('since').value);
        const until = toUnix(document.getElementById('until').value, 59);
        if (since !== null && until !== null && since > until) {
            alert('開始日時が終了日時より後になっています');
            return;
        }

        localStorage.setItem(LS_SEARCH_RELAY, searchRelay);

        const filter = { kinds: SEARCH_KINDS, search: keyword, limit: SEARCH_LIMIT };
        if (since !== null) filter.since = since;
        if (until !== null) filter.until = until;

        const seq = ++searchSeq;
        closeSearchSocket();

        if (btn) btn.disabled = true;
        if (moreBtn) moreBtn.disabled = true;
        setStatus(isAppend ? '追加読み込み中...' : '検索中...');

        const normalReady = connectNormalRelay(normalRelay);

        try {
            const { events, error } = await querySearchRelay(searchRelay, filter);
            if (seq !== searchSeq) return;

            events.sort((a, b) => b.created_at - a.created_at);

            let addedEvents = events;
            if (isAppend) {
                const existingIds = new Set(currentEvents.map(ev => ev.id));
                addedEvents = events.filter(ev => !existingIds.has(ev.id));
                currentEvents = currentEvents.concat(addedEvents);
            } else {
                currentEvents = events;
                dataStore.events.clear();
                dataStore.likedByMeIds.clear();
            }

            addedEvents.forEach(ev => dataStore.addEvent(ev));
            render();

            let msg = currentEvents.length === 0
                ? '該当する投稿は見つかりませんでした'
                : (isAppend
                    ? `表示中: ${currentEvents.length} 件（今回 +${addedEvents.length} 件）`
                    : `検索完了: ${currentEvents.length} 件`);
            if (error) msg += `（途中で終了: ${error.message}）`;
            setStatus(msg);

            const normalOk = await normalReady;
            if (seq !== searchSeq) return;

            if (!normalOk) {
                setStatus(msg + ' ／ 通常リレーに接続できないため、プロフィール取得・ふぁぼ・RTは使えません');
                return;
            }

            ensureCustomEmojisLoaded();
            if (normalizeUrl(normalRelay) === normalizeUrl(searchRelay)) {
                console.warn('⚠️ 通常リレーと検索用リレーが同じURLです');
            }

            addedEvents.forEach(ev => profileFetcher.request(ev.pubkey));
            profileFetcher.flushNow();
            fetchMyLikes(addedEvents);
        } catch (err) {
            if (seq !== searchSeq) return;
            console.error('❌ 検索失敗:', err);
            setStatus('エラー: ' + err.message);
        } finally {
            if (seq === searchSeq) {
                if (btn) btn.disabled = false;
                if (moreBtn) moreBtn.disabled = false;
            }
        }
    }

    function fetchMyLikes(events) {
        const myPubkey = window.nostrAuth?.pubkey;
        if (!myPubkey || !relayManager.isConnected() || events.length === 0) return;

        const ids = events.map(ev => ev.id);
        let pending = 0;

        for (let i = 0; i < ids.length; i += 100) {
            const chunk = ids.slice(i, i + 100);
            const subId = `kensaku-likes-${Date.now()}-${i}`;
            pending++;

            const ok = relayManager.subscribe(subId, { kinds: [7], authors: [myPubkey], '#e': chunk }, (type, ev) => {
                if (type === 'EVENT') {
                    if (ev.kind !== 7 || ev.pubkey !== myPubkey) return;
                    const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
                    if (targetId) dataStore.markAsLikedByMe(targetId);
                } else if (type === 'EOSE') {
                    relayManager.unsubscribe(subId);
                    if (--pending === 0) render();
                }
            });
            if (!ok) pending--;
        }
    }

    /* ---------- 描画 ---------- */
    let measureCtx = null;

    function formatTime(date) {
        return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ` +
            `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
    }

    function render() {
        const el = document.getElementById('timeline');
        el.innerHTML = '';

        if (!measureCtx) {
            measureCtx = document.createElement('canvas').getContext('2d');
            measureCtx.font = '14px sans-serif';
        }
        const maxNameWidth = measureCtx.measureText('[00:00:00]').width;
        const isDark = document.body.classList.contains('dark-mode');
        const relayHint = relayManager.url ? [relayManager.url] : [];

        for (const ev of currentEvents) {
            const li = document.createElement('li');
            li.className = 'event' + (dataStore.isLikedByMe(ev.id) ? ' event-liked' : '');
            li.setAttribute('data-id', ev.id);
            li.setAttribute('data-pubkey', ev.pubkey);

            const prof = dataStore.profiles.get(ev.pubkey);
            const fullName = MyNostrUtils.getDisplayName(prof, ev.pubkey);
            const color = MyNostrUtils.getHslColor(ev.pubkey, isDark);

            let truncatedName = '';
            let currentWidth = 0;
            let isTruncated = false;
            for (const char of fullName) {
                const charWidth = measureCtx.measureText(char).width;
                if (currentWidth + charWidth > maxNameWidth) { isTruncated = true; break; }
                truncatedName += char;
                currentWidth += charWidth;
            }
            const finalDisplayName = isTruncated ? truncatedName + '…' : fullName;

            const nevent = NostrTools.nip19.neventEncode({ id: ev.id, relays: relayHint });
            const npub = NostrTools.nip19.npubEncode(ev.pubkey);

            const timeSpan = document.createElement('span');
            timeSpan.className = 'time';
            timeSpan.innerHTML =
                `<a href="https://ompomz.github.io/flowgazer/tweet?id=${nevent}" target="_blank" style="color: inherit; text-decoration: none;">` +
                `[${formatTime(new Date(ev.created_at * 1000))}]</a>`;

            const authorSpan = document.createElement('span');
            authorSpan.className = 'author';
            authorSpan.style.color = color;
            authorSpan.style.fontWeight = 'normal';
            authorSpan.innerHTML =
                `<a href="https://ompomz.github.io/flowgazer/tweet?id=${npub}" target="_blank" style="color: inherit; text-decoration: none;">` +
                `${MyNostrUtils.escapeHtml(finalDisplayName)}</a>`;

            const separator = document.createElement('span');
            separator.className = 'separator';
            separator.textContent = ' > ';

            const contentSpan = document.createElement('span');
            contentSpan.className = 'post-content';
            contentSpan.innerHTML = MyNostrUtils.linkify(MyNostrUtils.escapeHtml(ev.content));

            li.appendChild(timeSpan);
            li.appendChild(document.createTextNode(' '));
            li.appendChild(authorSpan);
            li.appendChild(separator);
            li.appendChild(contentSpan);

            window.kensakuActionMenu.attach(li, ev);
            el.appendChild(li);
        }

        const moreWrapper = document.getElementById('more-wrapper');
        if (moreWrapper) moreWrapper.style.display = currentEvents.length > 0 ? '' : 'none';
    }

    window.kensaku = { render, doSearch, clearSearch };

    /* ---------- EventBus ---------- */
    window.eventBus.on(window.EVENTS.AUTH_LOGIN_COMPLETED, ({ pubkey, onComplete }) => {
        console.log('📨 ログイン完了通知を受信:', pubkey.substring(0, 8) + '...');
        ensureCustomEmojisLoaded();
        if (currentEvents.length > 0) fetchMyLikes(currentEvents);
        onComplete();
    });

    window.eventBus.on(window.EVENTS.RELAY_CONNECTED, () => {
        ensureCustomEmojisLoaded();
        profileFetcher.flushNow();
    });

    /* ---------- UI 初期化 ---------- */
    function updateScrollTopVisibility() {
        const scrollTopBtn = document.getElementById('scroll-top-btn');
        if (scrollTopBtn) {
            scrollTopBtn.style.display = window.scrollY > SCROLL_TOP_THRESHOLD ? 'flex' : 'none';
        }
    }

    function startNewSearch() {
        setClearButtonVisible(true);
        doSearch(false);
    }

    function init() {
        const searchRelayInput = document.getElementById('search-relay');
        const normalRelayInput = document.getElementById('normal-relay');
        const searchBtn = document.getElementById('search-btn');
        const clearBtn = document.getElementById('clear-btn');
        const keywordInput = document.getElementById('keyword');
        const loadMoreBtn = document.getElementById('load-more-btn');
        const scrollTopBtn = document.getElementById('scroll-top-btn');

        searchRelayInput.value = localStorage.getItem(LS_SEARCH_RELAY) || DEFAULT_SEARCH_RELAY;
        normalRelayInput.value = localStorage.getItem(LS_NORMAL_RELAY)
            || localStorage.getItem('relayUrl')
            || DEFAULT_NORMAL_RELAY;

        searchBtn?.addEventListener('click', startNewSearch);
        keywordInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) startNewSearch();
        });
        clearBtn?.addEventListener('click', clearSearch);

        loadMoreBtn?.addEventListener('click', () => {
            if (currentEvents.length === 0) return;
            const oldest = currentEvents[currentEvents.length - 1];
            document.getElementById('until').value = toDatetimeLocal(oldest.created_at);
            doSearch(true);
        });

        if (scrollTopBtn) {
            scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
            window.addEventListener('scroll', updateScrollTopVisibility, { passive: true });
            updateScrollTopVisibility();
        }

        normalRelayInput.addEventListener('change', async () => {
            const url = normalRelayInput.value.trim();
            if (!isValidRelayUrl(url)) return;
            const ok = await connectNormalRelay(url);
            if (ok) {
                ensureCustomEmojisLoaded();
                currentEvents.forEach(ev => profileFetcher.request(ev.pubkey));
                profileFetcher.flushNow();
                fetchMyLikes(currentEvents);
            } else {
                setStatus('通常リレーに接続できませんでした: ' + url);
            }
        });

        const favInput = document.getElementById('kind-7-content-input');
        if (favInput) {
            const saved = localStorage.getItem('favMark');
            if (saved) favInput.value = saved;
            favInput.addEventListener('change', (e) => {
                const chars = Array.from(e.target.value);
                const singleChar = chars.length > 0 ? chars[0] : '+';
                localStorage.setItem('favMark', singleChar);
                e.target.value = singleChar;
            });
        }

        const kind7FixedToggle = document.getElementById('kind-7-fixed-toggle');
        const kind7ContentWrapper = document.getElementById('kind-7-content-wrapper');
        if (kind7FixedToggle) {
            const pickerAvailable = !!window.customEmojiManager?.openPicker;
            const saved = localStorage.getItem('kind7Mode') || 'fixed';
            const isFixed = (saved !== 'picker') || !pickerAvailable;

            kind7FixedToggle.checked = isFixed;
            if (kind7ContentWrapper) kind7ContentWrapper.style.display = isFixed ? '' : 'none';
            if (!pickerAvailable) kind7FixedToggle.disabled = true;

            kind7FixedToggle.addEventListener('change', (e) => {
                localStorage.setItem('kind7Mode', e.target.checked ? 'fixed' : 'picker');
                if (kind7ContentWrapper) kind7ContentWrapper.style.display = e.target.checked ? '' : 'none';
            });
        }

        connectNormalRelay(normalRelayInput.value.trim()).then(ok => { if (ok) ensureCustomEmojisLoaded(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();