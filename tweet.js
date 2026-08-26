
'use strict';

// ========================================
// 定数・グローバル状態
// ========================================
const FALLBACK_RELAYS = ['wss://r.kojira.io/', 'wss://nos.lol'];
const DEFAULT_PROFILE_IMAGE = 'https://ompomz.github.io/favicon.ico';
const MAX_RELAYS_PER_QUERY = 6;

// nostr-tools v2: SimplePool は 'wss://relay/' のような複数リレーを
// 横断してイベントを探す責務を持つ（単一接続専用のRelayManagerとは役割が異なる）
const pool = new NostrTools.SimplePool({ eoseSubTimeout: 6000 });

// キャッシュ（同一セッション内での再取得を防ぐ）
const profileCache = new Map();   // pubkey -> profile object | null
const eventCache = new Map();     // eventId -> event | undefined(未取得)
const channelMetaCache = new Map(); // channelId -> { name, about, picture }

// 🆕 プロフィールページの投稿一覧：もっと見る用の状態
let profilePostsState = null; // { pubkey, hintRelays, oldestTimestamp, isLoading }

const mainEventContainer = document.getElementById('main-event');
const statusElement = document.getElementById('status');
const reactionsSection = document.getElementById('reactions-section');
const reactionsList = document.getElementById('reactions-list');
const relatedEventsSection = document.getElementById('related-events-section');
const relatedEventsList = document.getElementById('related-events-list');

// ========================================
// 書き込みアクション用の定数
// ========================================

// 本体(flowgazer)と同じclientタグ（NIP-89 アプリ参照）
const CLIENT_TAG = ['client', 'flowgazer', '31990:a19caaa8404721584746fb0e174cf971a94e0f51baaf4c4e8c6e54fa88985eaf:1755917022711', 'wss://relay.nostr.band/'];

// 本体のデフォルトリレー（app.js の初期値と同じ）。
// 本体ですでにリレーを変更している場合は、共有されている localStorage の 'relayUrl' が優先される。
const DEFAULT_MAIN_RELAY = 'wss://r.kojira.io/';

// auth-ui.js は window.app?.updateLoginUI を呼ぶ（存在すれば）設計になっている。
// tweet.html は本体の FlowgazerApp を読み込まないため、
// ログインUI更新用の最小限のスタブをここで用意して橋渡しする
// （kit-ten.html等の「ページ固有の上書きはwindow.appを介して行う」既存パターンに準拠）。
window.app = {
    // 🆕 プロフィール投稿一覧の改行表示を、従来のhasLineBreakロジックと同じにするため常時ON
    preWrapEnabled: true,
    updateLoginUI() {
        updateTweetPageLoginUI();
    }
};

// tweet.js 冒頭あたりで一度だけ生成
window.tweetActionMenu = new NostrActionMenu({
    clientTag: CLIENT_TAG,
    getRelayUrl: getMainRelayUrl,
    publish: publishToMainRelay
});

// timeline.js（Timelineクラス）は window.actionMenu を参照する設計のため、
// 同じインスタンスをそちらの名前でも公開する
window.actionMenu = window.tweetActionMenu;

// 古い関数名で呼ばれても tweetActionMenu に転送する橋渡し関数
function attachActionHandler(element, event) {
    if (window.tweetActionMenu && element) {
        window.tweetActionMenu.attach(element, event);
    }
}

// ========================================
// 共通ユーティリティ
// ========================================

function withTimeout(promise, ms, message) {
    const label = message || '通信';
    const startedAt = Date.now();
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            console.warn(`⏱️ [${label}] タイムアウト (${ms}ms経過)`);
            reject(new Error(message || 'タイムアウトしました'));
        }, ms);
    });

    return Promise.race([promise, timeoutPromise])
        .then((result) => {
            clearTimeout(timeoutId);
            const elapsed = Date.now() - startedAt;
            const count = Array.isArray(result) ? `${result.length}件` : (result ? '取得あり' : '該当なし');
            console.log(`✅ [${label}] 完了 (${elapsed}ms, ${count})`);
            return result;
        })
        .catch((err) => {
            clearTimeout(timeoutId);
            if (!/タイムアウト/.test(err.message || '')) {
                console.warn(`❌ [${label}] 通信エラー:`, err.message || err);
            }
            throw err;
        });
}

function getPriorityRelays(hintRelays) {
    const cleaned = (hintRelays || []).filter(Boolean);
    const combined = [...new Set([...cleaned, ...FALLBACK_RELAYS])];
    const relays = combined.slice(0, MAX_RELAYS_PER_QUERY);
    console.log('🔌 使用リレー:', relays);
    return relays;
}

function showStatus(message) {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.classList.toggle('hidden', !message);
}

function goBack() {
    if (window.history.length > 1) {
        window.history.back();
    } else {
        window.location.href = 'https://ompomz.github.io/flowgazer/tweet';
    }
}

function copyUrl() {
    navigator.clipboard.writeText(window.location.href)
        .then(() => alert('URLがコピーされました！'))
        .catch(err => { console.error('URLのコピーに失敗:', err); alert('URLのコピーに失敗しました。'); });
}

function copyCurrentId() {
    const params = new URLSearchParams(window.location.search);
    const id = (params.get('id') || '').trim();
    if (!id) { alert('コピーできるIDが見つかりません。'); return; }
    navigator.clipboard.writeText(id)
        .then(() => alert('Nostr IDをコピーしました！'))
        .catch(err => { console.error('コピー失敗:', err); alert('コピーに失敗しました。'); });
}

function showCopyButton() {
    const btn = document.getElementById('copy-nevent-btn');
    if (btn) btn.style.display = 'inline-block';
}

function showJumpButton(pubkey, originalId) {
    const jumpBtn = document.getElementById('jump-to-okkake');
    if (!jumpBtn) return;
    try {
        const npub = NostrTools.nip19.npubEncode(pubkey);
        const okkakeUrl = `https://ompomz.github.io/flowgazer/okkake.html?id=${encodeURIComponent(originalId)}&follow=${npub}`;
        jumpBtn.style.display = 'inline-block';
        jumpBtn.onclick = () => window.open(okkakeUrl, '_blank');
    } catch (e) {
        console.warn('jumpボタン設定失敗:', e);
    }
}

// ========================================
// 書き込みアクション（ふぁぼ・RT・返信・引用）
// ========================================

/**
 * ログインUIの状態表示をヘッダーバッジに反映する。
 * auth-ui.js の onAuthSuccess / logout から window.app.updateLoginUI() 経由で呼ばれる他、
 * ページ読み込み時にも一度呼ぶ。
 */
function updateTweetPageLoginUI() {
    const badge = document.getElementById('auth-status-badge');
    if (!badge || !window.nostrAuth) return;

    if (window.nostrAuth.isLoggedIn()) {
        const npub = NostrTools.nip19.npubEncode(window.nostrAuth.pubkey);
        const mode = window.nostrAuth.readOnly ? '（閲覧のみ）' : '';
        badge.textContent = `${npub.substring(0, 10)}...${mode}`;
    } else {
        badge.textContent = '未ログイン';
    }
}

// auth-ui.js のログイン完了処理は、ビジネス層の完了を EventBus 経由で待つ設計になっている
// （auth:login-completed を emit し、受け手が onComplete() を呼ぶまでモーダルが閉じない）。
// 本体(app.js)はここでフォローリスト取得等を行うが、tweet.htmlではログインUIの更新だけで十分なため、
// 受け取ったら即座に onComplete() を呼んでモーダルを閉じられるようにする。
// 【重要】このハンドラを登録しないと、auth-ui.js側のPromiseが永久に解決されず
// ログインモーダルが「フォロー情報を取得中...」のまま固まってしまう。
window.eventBus.on(window.EVENTS.AUTH_LOGIN_COMPLETED, ({ pubkey, onComplete }) => {
    console.log('📨 ログイン完了通知を受信:', pubkey.substring(0, 8) + '...');
    updateTweetPageLoginUI();
    onComplete();
});

/**
 * 本体(flowgazer)が使っているメインリレーのURLを取得する。
 * localStorage の 'relayUrl' は本体(app.js)と共有されるキーなので、
 * 本体でリレーを変更していればそれを引き継ぎ、未設定ならデフォルトに揃える。
 */
function getMainRelayUrl() {
    return localStorage.getItem('relayUrl') || DEFAULT_MAIN_RELAY;
}

/**
 * 署名済みイベントを本体と同じメインリレーへpublishする。
 * SimplePool.publish() はリレーごとのPromiseを配列で返すため、
 * 1件でも成功すればOKとする（Promise.any）。
 */
async function publishToMainRelay(signedEvent) {
    const relay = getMainRelayUrl();
    const results = pool.publish([relay], signedEvent);
    await withTimeout(Promise.any(results), 8000, 'リレーへの送信がタイムアウトしました');
    return relay;
}

/**
 * 書き込み操作の前提条件（署名可能な鍵があるか）をチェックする。
 * 満たさない場合はログインモーダルを開いて false を返す。
 */
function requireWriteAccess() {
    if (!window.nostrAuth || !window.nostrAuth.canWrite()) {
        alert('この操作には秘密鍵でのログインが必要です。');
        if (typeof showAuthUI === 'function') showAuthUI();
        return false;
    }
    return true;
}

// 要素ごとに長押しハンドラーを使い回さないよう、対象要素に紐づけて管理する
const attachedHandlers = new WeakMap();


// eHagakiモーダルの閉じるボタン・背景クリック配線
document.getElementById('close-ehagaki-modal')?.addEventListener('click', () => {
    window.ehagakiManager?.close?.();
});
document.getElementById('ehagaki-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'ehagaki-modal') window.ehagakiManager?.close?.();
});

// eHagakiでの投稿成功をtweet.html側でも検知し、簡易フィードバックを表示する
// （ehagaki-manager.js自体は変更せず、同じpostMessageを別リスナーで横取りする）
window.addEventListener('message', (event) => {
    const mgr = window.ehagakiManager;
    if (!mgr || event.origin !== mgr.ORIGIN) return;
    if (event.source !== mgr.iframe?.contentWindow) return;
    if (event.data?.namespace !== mgr.NS) return;
    if (event.data.type === 'post.success') {
        alert('投稿しました！最新の状態を見るにはページを再読み込みしてください。');
    }
});

function getPostTypeLabel(kind) {
    switch (kind) {
        case 1: return '投稿';
        case 6: return 'リポスト';
        case 7: return 'リアクション';
        case 16: return '引用リポスト';
        case 30023: return '記事';
        case 40: return 'チャンネル作成';
        case 41: return 'チャンネル情報更新';
        case 42: return 'チャンネルメッセージ';
        default: return 'イベント';
    }
}

// --- カスタム絵文字置換（:shortcode: -> <img>） ---
function replaceCustomEmojis(html, customEmojiMap) {
    if (!html || customEmojiMap.size === 0) return html;
    let result = html;
    customEmojiMap.forEach((url, shortcode) => {
        const escaped = shortcode.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`(?<=\\s|^|>)${escaped}(?=\\s|$|<)`, 'g');
        result = result.replace(regex, `<img src="${url}" alt="${shortcode}" title="${shortcode}" class="custom-emoji custom-emoji-hover">`);
    });
    return result;
}

// ========================================
// データ取得（プロフィール・イベント・チャンネル情報）
// ========================================

async function fetchProfile(pubkey, hintRelays) {
    if (profileCache.has(pubkey)) return profileCache.get(pubkey);
    const relays = getPriorityRelays(hintRelays);
    try {
        const event = await withTimeout(
            pool.get(relays, { kinds: [0], authors: [pubkey] }),
            8000, 'プロフィール取得タイムアウト'
        );
        if (event) {
            const profile = JSON.parse(event.content);
            profileCache.set(pubkey, profile);
            return profile;
        }
    } catch (e) {
        console.warn('プロフィール取得失敗:', pubkey.substring(0, 8), e.message);
    }
    profileCache.set(pubkey, null);
    return null;
}

async function fetchProfilesBatch(pubkeys, hintRelays) {
    const uncached = [...new Set(pubkeys)].filter(pk => pk && !profileCache.has(pk));
    if (uncached.length === 0) return;
    const relays = getPriorityRelays(hintRelays);
    const latestByPubkey = new Map();
    try {
        const events = await withTimeout(
            pool.querySync(relays, { kinds: [0], authors: uncached }),
            8000, 'プロフィール一括取得タイムアウト'
        );
        events.forEach(ev => {
            const current = latestByPubkey.get(ev.pubkey);
            if (!current || ev.created_at > current.created_at) latestByPubkey.set(ev.pubkey, ev);
        });
    } catch (e) {
        console.warn('プロフィール一括取得失敗:', e.message);
    }

    uncached.forEach(pk => {
        const ev = latestByPubkey.get(pk);
        if (ev) {
            try { profileCache.set(pk, JSON.parse(ev.content)); }
            catch (e) { profileCache.set(pk, null); }
        } else if (!profileCache.has(pk)) {
            profileCache.set(pk, null);
        }
    });
}

async function fetchEventById(id, hintRelays) {
    if (eventCache.has(id)) return eventCache.get(id);
    const relays = getPriorityRelays(hintRelays);
    try {
        const event = await withTimeout(
            pool.get(relays, { ids: [id] }),
            10000, 'イベント取得タイムアウト'
        );
        eventCache.set(id, event || null);
        return event || null;
    } catch (e) {
        console.warn('イベント取得失敗:', id.substring(0, 8), e.message);
        eventCache.set(id, null);
        return null;
    }
}

async function fetchChannelMeta(channelId, hintRelays) {
    if (channelMetaCache.has(channelId)) return channelMetaCache.get(channelId);
    const relays = getPriorityRelays(hintRelays);
    let meta = null;

    // kind:41（チャンネル情報更新）を優先
    try {
        const metaEvents = await withTimeout(
            pool.querySync(relays, { kinds: [41], '#e': [channelId] }),
            6000, 'チャンネル情報(kind41)取得タイムアウト'
        );
        if (metaEvents.length > 0) {
            metaEvents.sort((a, b) => b.created_at - a.created_at);
            const parsed = JSON.parse(metaEvents[0].content);
            meta = { name: parsed.name || null, about: parsed.about || null, picture: parsed.picture || null };
        }
    } catch (e) {
        console.warn('kind41取得失敗:', e.message);
    }

    // 名前が取れなければ kind:40（チャンネル作成）で補完
    if (!meta || !meta.name) {
        try {
            const createEvent = await withTimeout(
                pool.get(relays, { kinds: [40], ids: [channelId] }),
                6000, 'チャンネル情報(kind40)取得タイムアウト'
            );
            if (createEvent) {
                const parsed = JSON.parse(createEvent.content);
                meta = meta || {};
                meta.name = meta.name || parsed.name || null;
                meta.about = meta.about || parsed.about || null;
                meta.picture = meta.picture || parsed.picture || null;
            }
        } catch (e) {
            console.warn('kind40取得失敗:', e.message);
        }
    }

    const result = meta || {};
    result.name = result.name || `Channel ${channelId.substring(0, 8)}`;
    result.about = result.about || null;
    result.picture = result.picture || null;
    channelMetaCache.set(channelId, result);
    return result;
}

// ========================================
// ID解析（npub / nprofile / note / nevent / naddr）
// ========================================

function parseInput(raw) {
    const input = (raw || '').trim();
    if (!input) return null;
    try {
        const decoded = NostrTools.nip19.decode(input);
        switch (decoded.type) {
            case 'npub':
                return { kind: 'profile', pubkey: decoded.data, relays: [] };
            case 'nprofile':
                return { kind: 'profile', pubkey: decoded.data.pubkey, relays: decoded.data.relays || [] };
            case 'note':
                return { kind: 'event', id: decoded.data, relays: [] };
            case 'nevent':
                return { kind: 'event', id: decoded.data.id, relays: decoded.data.relays || [] };
            case 'naddr':
                return {
                    kind: 'addr',
                    pubkey: decoded.data.pubkey,
                    addrKind: decoded.data.kind,
                    identifier: decoded.data.identifier,
                    relays: decoded.data.relays || []
                };
            default:
                return null;
        }
    } catch (e) {
        console.error('NIP-19デコードエラー:', e);
        return null;
    }
}

// ========================================
// 本文フォーマット（エスケープ → linkify → 絵文字 → 引用カード展開）
// ========================================

async function formatPostContent(content, tags, options) {
    const opts = options || { expandMedia: true };
    let html = MyNostrUtils.escapeHtml(content || '');
    html = html.replace(/\n/g, '<br>');
    html = MyNostrUtils.linkify(html, opts);

    const customEmojiMap = new Map();
    (tags || []).filter(t => t[0] === 'emoji' && t[1] && t[2]).forEach(([, shortcode, url]) => {
        customEmojiMap.set(`:${shortcode}:`, url);
    });
    html = replaceCustomEmojis(html, customEmojiMap);

    // nostr:xxxx 参照をカード化する。
    // 【重要】MyNostrUtils.linkify は表示テキストを10文字+"..."に短縮するため、
    // 表示テキストからIDを取り出すと壊れる。hrefのクエリに完全なIDが入っているのでそちらを使う。
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const nostrLinks = Array.from(temp.querySelectorAll('a.nostr-ref'));
    const tasks = nostrLinks.map(async (link) => {
        const text = link.textContent || '';
        if (!text.startsWith('nostr:')) return;
        try {
            const href = link.getAttribute('href');
            const url = new URL(href, window.location.href);
            const nip19Id = url.searchParams.get('id');
            if (!nip19Id) return;
            const cardHtml = await createNostrCard(nip19Id);
            if (cardHtml) link.outerHTML = cardHtml;
        } catch (e) {
            console.warn('引用カード生成失敗:', e.message);
        }
    });
    if (tasks.length > 0) await Promise.all(tasks);

    return temp.innerHTML;
}

async function formatEmojiOnly(content, tags) {
    if (content === '+') return '⭐';
    if (/^:[a-zA-Z0-9_+-]+:$/.test(content)) {
        const map = new Map();
        (tags || []).filter(t => t[0] === 'emoji' && t[1] && t[2]).forEach(([, code, url]) => map.set(`:${code}:`, url));
        if (map.has(content)) {
            return `<img src="${map.get(content)}" class="custom-emoji" alt="${content}" title="${content}">`;
        }
    }
    return MyNostrUtils.escapeHtml(content);
}

// ========================================
// プロフィール投稿一覧用の日付フォーマット
// ========================================

/**
 * プロフィール投稿一覧専用のタイムスタンプ整形。
 * Timelineクラス標準の HH:MM:SS だけだと年をまたぐ投稿の判別ができないため、
 * 今年の投稿は「月/日 時:分」、それ以前は「年/月/日 時:分」で表示する。
 * @param {Date} date
 * @returns {string}
 */
function formatProfileDate(date) {
    const now = new Date();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');

    if (date.getFullYear() < now.getFullYear()) {
        return `${date.getFullYear()}/${m}/${d} ${time}`;
    }
    return `${m}/${d} ${time}`;
}

// ========================================
// プロフィール表示の共通部品
// ========================================

function createProfileHtml(pubkey, profile, isLink) {
    const link = isLink === undefined ? true : isLink;
    const picture = (profile && profile.picture && profile.picture.trim() !== '') ? profile.picture : DEFAULT_PROFILE_IMAGE;
    const npub = NostrTools.nip19.npubEncode(pubkey);
    const name = MyNostrUtils.getDisplayName(profile, pubkey);
    const nip05 = (profile && profile.nip05) ? MyNostrUtils.escapeHtml(profile.nip05) : `${npub.substring(0, 13)}...`;

    const inner = `
        <div class="profile">
          <img src="${picture}" class="profile-image" alt="" onerror="this.src='${DEFAULT_PROFILE_IMAGE}'">
          <div>
            <span class="profile-name" style="color:${MyNostrUtils.getHslColor(pubkey)}">${MyNostrUtils.escapeHtml(name)}</span>
            <span class="profile-nip05">${nip05}</span>
          </div>
        </div>`;

    if (!link) return inner;
    return `<a href="?id=${npub}" class="profile-link" style="text-decoration:none; color:inherit;">${inner}</a>`;
}

// ========================================
// 引用カード（nostr: 参照の展開・入れ子は1階層まで）
// ========================================

async function buildEventPreviewCard(event, nip19Id) {
    const profile = await fetchProfile(event.pubkey);
    const date = new Date(event.created_at * 1000).toLocaleString();
    const label = getPostTypeLabel(event.kind);
    const rawContent = event.kind === 40 || event.kind === 41
        ? (() => { try { return JSON.parse(event.content).name || event.content; } catch (e) { return event.content; } })()
        : (event.content || '');
    const shortContent = rawContent.length > 150 ? rawContent.substring(0, 150) + '...' : rawContent;

    // 入れ子カードはこれ以上展開しない（無限再帰防止）簡易フォーマット
    let contentHtml = MyNostrUtils.escapeHtml(shortContent).replace(/\n/g, '<br>');
    contentHtml = MyNostrUtils.linkify(contentHtml, { expandMedia: false });

    return `
        <a href="?id=${nip19Id}" class="quote-link">
          <div class="related-post-card">
            ${createProfileHtml(event.pubkey, profile, false)}
            <div class="post-info">
              <span>${date}</span>
              <span>${label}</span>
            </div>
            <div class="post-content"><p class="post-text">${contentHtml}</p></div>
          </div>
        </a>`;
}

async function createNostrCard(nip19Id) {
    let decoded;
    try {
        decoded = NostrTools.nip19.decode(nip19Id);
    } catch (e) {
        return `<div class="related-post-card">無効なNostr IDです</div>`;
    }

    if (decoded.type === 'npub' || decoded.type === 'nprofile') {
        const pubkey = decoded.data.pubkey || decoded.data;
        const hintRelays = decoded.data.relays || [];
        const profile = await fetchProfile(pubkey, hintRelays);
        const npub = NostrTools.nip19.npubEncode(pubkey);
        return `
          <a href="?id=${npub}" class="quote-link">
            <div class="related-post-card">
              ${createProfileHtml(pubkey, profile, false)}
              <div class="post-content">${MyNostrUtils.escapeHtml((profile && profile.about) || '')}</div>
            </div>
          </a>`;
    }

    if (decoded.type === 'naddr') {
        const relays = getPriorityRelays(decoded.data.relays || []);
        try {
            const ev = await withTimeout(
                pool.get(relays, {
                    kinds: [decoded.data.kind],
                    authors: [decoded.data.pubkey],
                    '#d': [decoded.data.identifier]
                }),
                8000, '記事取得タイムアウト'
            );
            if (!ev) return `<div class="related-post-card">記事が見つかりませんでした</div>`;
            return await buildEventPreviewCard(ev, nip19Id);
        } catch (e) {
            return `<div class="related-post-card">記事の取得に失敗しました</div>`;
        }
    }

    let eventId = null;
    let hintRelays = [];
    if (decoded.type === 'note') {
        eventId = decoded.data;
    } else if (decoded.type === 'nevent') {
        eventId = decoded.data.id;
        hintRelays = decoded.data.relays || [];
    } else {
        return null;
    }

    const event = await fetchEventById(eventId, hintRelays);
    if (!event) return `<div class="related-post-card">イベントが見つかりませんでした</div>`;
    return await buildEventPreviewCard(event, nip19Id);
}

// ========================================
// メインイベント種別ごとのレンダリング
// ========================================

// 🆕 リプライ先のeタグを取得
// - kind:1  → NIP-10: reply優先 → root → 末尾フォールバック
// - kind:42 → NIP-28: root eタグは「チャンネル自体」を指すためリプライ先の対象外。
//             reply マーカー付きタグのみを正式なリプライ先とし、
//             マーカーが無い旧式データ向けに「root以外のeタグ」をフォールバックとして扱う
function getReplyTargetTag(event) {
    if (event.kind !== 1 && event.kind !== 42) return null;

    const eTags = (event.tags || []).filter(t => t[0] === 'e');
    if (eTags.length === 0) return null;

    if (event.kind === 42) {
        const replyMarked = eTags.find(t => t[3] === 'reply');
        if (replyMarked) return replyMarked;

        // 旧式フォールバック: root（無ければ先頭）以外のeタグがあればリプライ先とみなす
        const rootId = (eTags.find(t => t[3] === 'root') || eTags[0])?.[1];
        return eTags.find(t => t[1] !== rootId) || null;
    }

    // kind:1
    return eTags.find(t => t[3] === 'reply')
        || eTags.find(t => t[3] === 'root')
        || eTags[eTags.length - 1];
}

async function renderStandardPost(event, originalId) {
    const profile = await fetchProfile(event.pubkey);
    const contentHtml = (event.kind === 30023 && window.marked)
        ? window.marked.parse(event.content || '')
        : await formatPostContent(event.content, event.tags);

    const date = new Date(event.created_at * 1000).toLocaleString();
    const client = (event.tags.find(t => t[0] === 'client') || [])[1] || '';

    // 🆕 リプライ元プレビュー
    let replyBannerHtml = '';
    const replyTag = getReplyTargetTag(event);
    if (replyTag) {
        const targetId = replyTag[1];
        const hintRelay = replyTag[2] ? [replyTag[2]] : [];
        const targetEvent = await fetchEventById(targetId, hintRelay);
        if (targetEvent) {
            const targetNevent = NostrTools.nip19.neventEncode({
                id: targetEvent.id,
                author: targetEvent.pubkey,
                kind: targetEvent.kind,
                relays: hintRelay
            });
            const card = await buildEventPreviewCard(targetEvent, targetNevent);
            replyBannerHtml = `<div class="reply-context">${card}<p class="post-link-label">　</p></div>`;
        } else {
            replyBannerHtml = `<div class="reply-context"><p class="post-link-label">↩️ リプライ先</p><div class="related-post-card">元投稿（${targetId.substring(0, 8)}）が見つかりませんでした</div></div>`;
        }
    }

    mainEventContainer.innerHTML = `
        ${replyBannerHtml}
        <div class="own-post">
            ${createProfileHtml(event.pubkey, profile)}
            <div class="post-content">${contentHtml}</div>
            <div class="post-info">
                <span>${date}</span>
                ${client ? `<span>via ${MyNostrUtils.escapeHtml(client)}</span>` : ''}
            </div>
        </div>`;

    showCopyButton();
    if (event.kind === 1) showJumpButton(event.pubkey, originalId);

    // 🆕 長押しアクションは自分の投稿部分だけに限定（リプライ先カードのクリックと競合させないため）
    const ownPostEl = mainEventContainer.querySelector('.own-post');
    attachActionHandler(ownPostEl, event);

    await loadRelatedData(event.id);
}

async function renderRepost(event) {
    const profile = await fetchProfile(event.pubkey);
    const date = new Date(event.created_at * 1000).toLocaleString();
    const targetTag = event.tags.find(t => t[0] === 'e');
    const targetId = targetTag ? targetTag[1] : null;
    const hintRelay = (targetTag && targetTag[2]) ? [targetTag[2]] : [];

    mainEventContainer.innerHTML = `
        <div class="repost-banner">
          ${createProfileHtml(event.pubkey, profile)}
          <div class="post-info"><span>${date}</span><span>${event.kind === 6 ? 'リポストしました' : '引用リポストしました'}</span></div>
        </div>
        <div id="repost-target"><p style="color:#888;">元投稿を読み込み中...</p></div>`;

    showCopyButton();
    // ネストされた元投稿プレビューと長押し操作が競合しないよう、
    // リポストイベント自体へのアクションは .repost-banner だけに限定する
    const bannerEl = mainEventContainer.querySelector('.repost-banner');
    attachActionHandler(bannerEl, event);

    if (!targetId) return;
    const targetEvent = await fetchEventById(targetId, hintRelay);
    const targetContainer = document.getElementById('repost-target');
    if (!targetEvent) {
        targetContainer.innerHTML = `<p style="color:#ccc; padding:0.5rem;">元投稿（${targetId.substring(0, 8)}）が見つかりませんでした</p>`;
        return;
    }
    const targetProfile = await fetchProfile(targetEvent.pubkey);
    const targetContentHtml = await formatPostContent(targetEvent.content, targetEvent.tags);
    targetContainer.innerHTML = `
        <div class="related-post-card">
          ${createProfileHtml(targetEvent.pubkey, targetProfile)}
          <div class="post-content">${targetContentHtml}</div>
          <div class="post-info"><span>${new Date(targetEvent.created_at * 1000).toLocaleString()}</span></div>
        </div>`;

    await loadRelatedData(event.id);
}

async function renderReactionEvent(event) {
    const profile = await fetchProfile(event.pubkey);
    const rawEmoji = (event.content && event.content.trim() !== '') ? event.content.trim() : '+';
    const emojiHtml = await formatEmojiOnly(rawEmoji, event.tags);
    const date = new Date(event.created_at * 1000).toLocaleString();

    const eTags = (event.tags || []).filter(t => t[0] === 'e');
    const targetTag = eTags.find(t => t[3] === 'reply') || eTags[eTags.length - 1] || null;
    const targetId = targetTag ? targetTag[1] : null;
    const hintRelay = (targetTag && targetTag[2]) ? [targetTag[2]] : [];

    mainEventContainer.innerHTML = `
        <div class="reaction-container">
          <div class="reaction-headline">
            <span class="reaction-headline-emoji">${emojiHtml}</span>
            <span></span>
          </div>
          ${createProfileHtml(event.pubkey, profile)}
          <div class="post-info"><span>${date}</span></div>
        </div>
        <div id="reaction-target"><p style="color:#888;">対象の投稿を読み込み中...</p></div>`;

    showCopyButton();
    const reactionEl = mainEventContainer.querySelector('.reaction-container');
    attachActionHandler(reactionEl, event);

    if (!targetId) return;
    const targetEvent = await fetchEventById(targetId, hintRelay);
    const targetContainer = document.getElementById('reaction-target');
    if (!targetEvent) {
        targetContainer.innerHTML = `<p style="color:#ccc; padding:0.5rem;">対象の投稿（${targetId.substring(0, 8)}）が見つかりませんでした</p>`;
        return;
    }
    const targetProfile = await fetchProfile(targetEvent.pubkey);
    const targetContentHtml = await formatPostContent(targetEvent.content, targetEvent.tags);
    targetContainer.innerHTML = `
        <div class="related-post-card">
          ${createProfileHtml(targetEvent.pubkey, targetProfile)}
          <div class="post-content">${targetContentHtml}</div>
          <div class="post-info"><span>${new Date(targetEvent.created_at * 1000).toLocaleString()}</span></div>
        </div>`;
}

async function renderChannelRoot(event) {
    let metadata = {};
    try { metadata = JSON.parse(event.content); } catch (e) { /* noop */ }

    const channelId = event.kind === 40 ? event.id : ((event.tags.find(t => t[0] === 'e') || [])[1] || event.id);
    const meta = await fetchChannelMeta(channelId);
    const name = metadata.name || meta.name;
    const about = metadata.about || meta.about || '説明はありません';
    const picture = metadata.picture || meta.picture || '';

    mainEventContainer.innerHTML = `
        <div class="channel-card">
          <div class="channel-card-header">
            ${picture
            ? `<img src="${picture}" class="channel-picture" onerror="this.style.display='none'">`
            : `<div class="channel-picture channel-picture-placeholder">💬</div>`}
            <div>
              <h2 class="channel-name">${MyNostrUtils.escapeHtml(name)}</h2>
              <code class="channel-kind-label">${event.kind === 40 ? 'Kind 40（チャンネル作成）' : 'Kind 41（チャンネル情報更新）'}</code>
            </div>
          </div>
          <p class="channel-about">${MyNostrUtils.escapeHtml(about)}</p>
          <button id="load-channel-messages" class="channel-load-btn">このチャンネルのメッセージを読み込む</button>
        </div>
        <div id="channel-messages"></div>`;

    showCopyButton();
    document.getElementById('load-channel-messages')?.addEventListener('click', () => loadChannelMessages(channelId));
}

async function loadChannelMessages(channelId) {
    const container = document.getElementById('channel-messages');
    container.innerHTML = `<p style="color:#888; padding:0.5rem;">メッセージを読み込み中...</p>`;
    const relays = getPriorityRelays();
    try {
        const events = await withTimeout(
            pool.querySync(relays, { kinds: [42], '#e': [channelId], limit: 50 }),
            10000, 'メッセージ取得タイムアウト'
        );
        events.sort((a, b) => a.created_at - b.created_at);

        if (events.length === 0) {
            container.innerHTML = `<p style="color:#888; padding:0.5rem;">メッセージが見つかりませんでした</p>`;
            return;
        }

        await fetchProfilesBatch(events.map(e => e.pubkey));
        const rows = await Promise.all(events.map(ev => buildChatRow(ev)));
        container.innerHTML = `<div class="chat-list">${rows.join('')}</div>`;
    } catch (e) {
        console.error('チャンネルメッセージ取得失敗:', e);
        container.innerHTML = `<p style="color:#c00; padding:0.5rem;">メッセージの取得に失敗しました</p>`;
    }
}

async function buildChatRow(event) {
    const profile = profileCache.get(event.pubkey);
    const name = MyNostrUtils.getDisplayName(profile, event.pubkey);
    const picture = (profile && profile.picture) ? profile.picture : DEFAULT_PROFILE_IMAGE;
    const npub = NostrTools.nip19.npubEncode(event.pubkey);
    const time = new Date(event.created_at * 1000).toLocaleTimeString();
    const contentHtml = await formatPostContent(event.content, event.tags, { expandMedia: false });
    const nevent = NostrTools.nip19.neventEncode({ id: event.id, author: event.pubkey, kind: 42 });

    return `
        <div class="chat-row" id="msg-${event.id}">
          <img src="${picture}" class="chat-avatar" onerror="this.src='${DEFAULT_PROFILE_IMAGE}'">
          <div class="chat-body">
            <div class="chat-meta">
              <a href="?id=${npub}" class="chat-name">${MyNostrUtils.escapeHtml(name)}</a>
              <a href="?id=${nevent}" class="chat-time">${time}</a>
            </div>
            <div class="chat-bubble">${contentHtml}</div>
          </div>
        </div>`;
}

async function renderChannelMessage(event) {
    const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root') || event.tags.find(t => t[0] === 'e');
    const channelId = rootTag ? rootTag[1] : null;
    const relayHint = (rootTag && rootTag[2]) ? [rootTag[2]] : [];

    const profile = await fetchProfile(event.pubkey);
    const contentHtml = await formatPostContent(event.content, event.tags);
    const date = new Date(event.created_at * 1000).toLocaleString();

    let channelBannerHtml = '';
    if (channelId) {
        const meta = await fetchChannelMeta(channelId, relayHint);
        const channelNevent = NostrTools.nip19.neventEncode({ id: channelId, relays: relayHint });
        channelBannerHtml = `
          <a href="?id=${channelNevent}" class="channel-context-banner">
            💬 チャンネル: <span class="channel-context-name">${MyNostrUtils.escapeHtml(meta.name)}</span>
          </a>`;
    }

    // 🆕 リプライ元プレビュー（kind:42同士の相互リプライに対応）
    let replyBannerHtml = '';
    const replyTag = getReplyTargetTag(event);
    if (replyTag) {
        const targetId = replyTag[1];
        const hintRelay = replyTag[2] ? [replyTag[2]] : [];
        const targetEvent = await fetchEventById(targetId, hintRelay);
        if (targetEvent) {
            const targetNevent = NostrTools.nip19.neventEncode({
                id: targetEvent.id,
                author: targetEvent.pubkey,
                kind: targetEvent.kind,
                relays: hintRelay
            });
            const card = await buildEventPreviewCard(targetEvent, targetNevent);
            replyBannerHtml = `<div class="reply-context">${card}<p class="post-link-label">　</p></div>`;
        } else {
            replyBannerHtml = `<div class="reply-context"><p class="post-link-label">↩️ リプライ先</p><div class="related-post-card">元投稿（${targetId.substring(0, 8)}）が見つかりませんでした</div></div>`;
        }
    }

    mainEventContainer.innerHTML = `
        ${channelBannerHtml}
        ${replyBannerHtml}
        <div class="own-post">
            ${createProfileHtml(event.pubkey, profile)}
            <div class="post-content">${contentHtml}</div>
            <div class="post-info"><span>${date}</span></div>
        </div>`;

    showCopyButton();

    // 🆕 長押しアクションは自分のメッセージ部分だけに限定
    // （channel-context-banner・reply-contextの<a>クリックと競合させないため）
    const ownPostEl = mainEventContainer.querySelector('.own-post');
    attachActionHandler(ownPostEl, event);

    await loadRelatedData(event.id);
}

function renderGenericEvent(event) {
    mainEventContainer.innerHTML = `
        <div class="generic-event-card">
          <h3>未対応のイベント種別です（Kind: ${event.kind}）</h3>
          <pre class="generic-event-json">${MyNostrUtils.escapeHtml(JSON.stringify(event, null, 2))}</pre>
        </div>`;
    showCopyButton();
}

// ========================================
// 関連データ（リプライ・リアクション・リポスト）
// ========================================

async function loadRelatedData(eventId) {
    const relays = getPriorityRelays();
    try {
        const [replies, reactions, reposts] = await Promise.all([
            withTimeout(pool.querySync(relays, { kinds: [1, 42], '#e': [eventId] }), 10000, '返信取得タイムアウト')
                .catch(e => { console.warn('返信取得失敗:', e.message); return []; }),
            withTimeout(pool.querySync(relays, { kinds: [7], '#e': [eventId] }), 10000, 'リアクション取得タイムアウト')
                .catch(e => { console.warn('リアクション取得失敗:', e.message); return []; }),
            withTimeout(pool.querySync(relays, { kinds: [6, 16], '#e': [eventId] }), 10000, 'リポスト取得タイムアウト')
                .catch(e => { console.warn('リポスト取得失敗:', e.message); return []; })
        ]);

        const filteredReplies = replies.filter(e => e.id !== eventId);
        const allPubkeys = [...filteredReplies, ...reactions, ...reposts].map(e => e.pubkey);
        await fetchProfilesBatch(allPubkeys);

        if (reactions.length > 0) renderReactionsList(reactions);
        if (filteredReplies.length > 0 || reposts.length > 0) {
            await renderRelatedList(filteredReplies, reposts);
        }
    } catch (e) {
        console.error('関連データ取得失敗:', e);
    }
}

function renderReactionsList(reactions) {
    const groups = new Map();
    reactions.forEach(r => {
        const emoji = (r.content || '+').trim() || '+';
        if (!groups.has(emoji)) groups.set(emoji, { pubkeys: new Set(), tags: r.tags });
        groups.get(emoji).pubkeys.add(r.pubkey);
    });

    let html = '';
    for (const [emoji, group] of groups.entries()) {
        const displayEmoji = emoji === '+' ? '⭐' : emoji;
        const emojiMap = new Map();
        (group.tags || []).filter(t => t[0] === 'emoji' && t[1] && t[2]).forEach(([, code, url]) => emojiMap.set(`:${code}:`, url));
        const emojiHtml = emojiMap.has(displayEmoji)
            ? `<img src="${emojiMap.get(displayEmoji)}" class="custom-emoji" alt="${displayEmoji}">`
            : MyNostrUtils.escapeHtml(displayEmoji);

        const avatars = Array.from(group.pubkeys).map(pk => {
            const profile = profileCache.get(pk);
            const pic = (profile && profile.picture) ? profile.picture : DEFAULT_PROFILE_IMAGE;
            const npub = NostrTools.nip19.npubEncode(pk);
            const name = MyNostrUtils.getDisplayName(profile, pk);
            return `<a href="?id=${npub}"><img src="${pic}" class="reaction-avatar" title="${MyNostrUtils.escapeHtml(name)}" onerror="this.src='${DEFAULT_PROFILE_IMAGE}'"></a>`;
        }).join('');

        html += `
          <div class="reaction-group">
            <span class="reaction-emoji">${emojiHtml}</span>
            <div class="reaction-avatars">${avatars}</div>
          </div>`;
    }
    reactionsList.innerHTML = html;
    reactionsSection.style.display = 'block';
}

async function renderRelatedList(replies, reposts) {
    const all = [
        ...replies.map(e => ({ event: e, label: e.kind === 42 ? 'チャンネル返信' : 'リプライ' })),
        ...reposts.map(e => ({ event: e, label: e.kind === 6 ? 'リポスト' : '引用リポスト' }))
    ];
    all.sort((a, b) => a.event.created_at - b.event.created_at);

    const cards = await Promise.all(all.map(async ({ event, label }) => {
        const profile = profileCache.get(event.pubkey);
        const date = new Date(event.created_at * 1000).toLocaleString();
        let bodyHtml;
        if (event.kind === 6) {
            const repostUser = MyNostrUtils.getDisplayName(profile, event.pubkey);
            bodyHtml = `<div class="post-content">${MyNostrUtils.escapeHtml(repostUser)}さんがリポストしました</div>`;
        } else {
            bodyHtml = `<div class="post-content">${await formatPostContent(event.content, event.tags, { expandMedia: false })}</div>`;
        }
        const nevent = NostrTools.nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind });
        // 【変更】カード全体を<a>で覆う構造は、長押し操作（このカード自体へのいいね/RT等）と
        // クリックナビゲーションが競合するためやめ、詳細ページへのリンクはラベル部分だけに限定する。
        // カードの id にイベントIDを埋め込み、挿入後に長押しハンドラーを紐付けられるようにする。
        return `
          <div class="related-post-card long-pressable" id="related-${event.id}">
            ${createProfileHtml(event.pubkey, profile, false)}
            <div class="post-info">
              <span>${date}</span>
              <a href="?id=${nevent}" class="post-link-label">${label}</a>
            </div>
            ${bodyHtml}
          </div>`;
    }));

    relatedEventsList.innerHTML = cards.join('');
    relatedEventsSection.style.display = 'block';

    // 挿入後のDOMに対して、カードごとに長押しアクションを紐付ける
    all.forEach(({ event }) => {
        const card = document.getElementById(`related-${event.id}`);
        if (card) attachActionHandler(card, event);
    });
}

// ========================================
// プロフィールページ
// ========================================

async function renderProfilePage(pubkey, hintRelays) {
    const relays = getPriorityRelays(hintRelays);
    const profileEvent = await withTimeout(
        pool.get(relays, { kinds: [0], authors: [pubkey] }),
        10000, 'プロフィール取得タイムアウト'
    );

    if (!profileEvent) {
        showStatus('プロフィールが見つかりませんでした');
        return;
    }

    let profile;
    try { profile = JSON.parse(profileEvent.content); } catch (e) { profile = {}; }
    profileCache.set(pubkey, profile);

    const npub = NostrTools.nip19.npubEncode(pubkey);
    const aboutHtml = await formatPostContent(profile.about || '', profileEvent.tags);

    mainEventContainer.innerHTML = `
        <div class="profile-card">
          <div class="profile-header">
            <img src="${profile.picture || DEFAULT_PROFILE_IMAGE}" class="profile-picture" onerror="this.src='${DEFAULT_PROFILE_IMAGE}'">
            <div class="profile-info-container">
              <h2 class="profile-name">${MyNostrUtils.escapeHtml(profile.name || profile.display_name || 'No Name')}</h2>
              <div class="npub-container">
                <span id="npub-text">${npub}</span>
                <span class="copy-icon" id="copy-npub-icon" title="npubをコピー" aria-label="npubをコピー">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" > <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect> <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </span>
                </div>
              <p class="nip05">${profile.nip05 ? MyNostrUtils.escapeHtml(profile.nip05) : 'NIP-05未設定'}</p>
            </div>
          </div>
          <p class="about-text">${aboutHtml}</p>
        </div>
        <div id="profile-posts-section" class="profile-posts-section">
        <p id="profile-posts-status" class="profile-posts-status">投稿を読み込み中...</p>
        <div id="profile-posts-list"></div>
        <button id="profile-posts-load-more" class="hidden">もっと見る</button>
        </div>`;

    document.getElementById('copy-npub-icon')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(npub); alert('npubをコピーしました！'); }
        catch (e) { alert('コピーに失敗しました。'); }
    });
    showCopyButton();

    // 🆕 プロフィールページ：kind:1一覧を追加読み込み
    loadUserPostsList(pubkey, hintRelays);
}

/**
 * プロフィールページ用：対象ユーザーのkind:1投稿一覧を取得して表示する
 * Timelineクラス（timeline.js）のDOM生成をそのまま流用する。
 * @param {string} pubkey
 * @param {string[]} hintRelays
 */
async function loadUserPostsList(pubkey, hintRelays) {
    const listContainer = document.getElementById('profile-posts-list');
    const statusEl = document.getElementById('profile-posts-status');
    const loadMoreBtn = document.getElementById('profile-posts-load-more');
    if (!listContainer || !statusEl) return;

    profilePostsState = { pubkey, hintRelays: hintRelays || [], oldestTimestamp: null, isLoading: false };

    // 🆕 この一覧専用のTimelineインスタンスを生成する。
    // containerは renderProfilePage() の innerHTML 差し替えのたびに作り直されるため、
    // 都度 new し直す（前回分の activeElements 参照は自然に破棄される）。
    window.profileTimeline = new Timeline(listContainer, { timestampFormatter: formatProfileDate });

    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');

    const relays = getPriorityRelays(hintRelays);

    try {
        const events = await withTimeout(
            pool.querySync(relays, { kinds: [1], authors: [pubkey], limit: 50 }),
            10000, '投稿一覧取得タイムアウト'
        );

        if (events.length === 0) {
            statusEl.textContent = '投稿が見つかりませんでした';
            return;
        }

        events.sort((a, b) => b.created_at - a.created_at);
        profilePostsState.oldestTimestamp = events[events.length - 1].created_at;

        await prefetchNostrReferences(events, relays);

        renderProfilePostBatch(events);
        statusEl.textContent = '';

        if (loadMoreBtn) {
            const hasRenderedPosts = listContainer.children.length > 0;
            loadMoreBtn.classList.toggle('hidden', !(hasRenderedPosts && events.length >= 50));
            loadMoreBtn.onclick = () => loadMoreProfilePosts();
        }

    } catch (e) {
        console.warn('ユーザー投稿一覧取得失敗:', e.message);
        statusEl.textContent = '投稿の取得に失敗しました';
        if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    }
}

/**
 * 🆕 イベント配列を dataStore に登録した上で Timeline#createPostElement に渡し、
 * 生成された <li> を一覧に追加する共通処理。
 * dataStore に登録しておくことで、Timeline側の isLikedByMe（いいね済みハイライト）や
 * createContent の引用カード解決（すでにキャッシュ済みの場合のみ）が機能する。
 * @param {Object[]} events
 */
function renderProfilePostBatch(events) {
    const listContainer = document.getElementById('profile-posts-list');
    if (!window.profileTimeline) return;

    events.forEach(ev => {
        window.dataStore.addEvent(ev);

        const li = window.profileTimeline.createPostElement(ev);
        if (li) {
            // 🆕 改行が含まれていない場合、Timelineが入れた強制改行（<br>など）を消す処理
            const hasLineBreak = /\r?\n/.test(ev.content);
            if (!hasLineBreak) {
                // 例: Timelineがメタデータと本文の間に入れている改行要素を見つけて非表示にする
                const br = li.querySelector('br'); // または該当するbr要素
                if (br) br.remove(); // あるいは style.display = 'none';
            }

            listContainer.appendChild(li);
        }
    });
}

/**
 * プロフィールページの投稿一覧：もっと見る
 */
async function loadMoreProfilePosts() {
    if (!profilePostsState || profilePostsState.isLoading) return;

    const listContainer = document.getElementById('profile-posts-list');
    const loadMoreBtn = document.getElementById('profile-posts-load-more');
    if (!listContainer || !loadMoreBtn || !window.profileTimeline) return;

    profilePostsState.isLoading = true;
    loadMoreBtn.classList.add('loading');

    const relays = getPriorityRelays(profilePostsState.hintRelays);

    try {
        const events = await withTimeout(
            pool.querySync(relays, {
                kinds: [1],
                authors: [profilePostsState.pubkey],
                until: profilePostsState.oldestTimestamp - 1,
                limit: 50
            }),
            10000, '投稿一覧取得タイムアウト'
        );

        if (events.length === 0) {
            alert('これ以上ありません');
            loadMoreBtn.classList.add('hidden');
            return;
        }

        events.sort((a, b) => b.created_at - a.created_at);
        profilePostsState.oldestTimestamp = events[events.length - 1].created_at;

        await prefetchNostrReferences(events, relays);

        renderProfilePostBatch(events);

        const hasRenderedPosts = listContainer.children.length > 0;
        loadMoreBtn.classList.toggle('hidden', !(hasRenderedPosts && events.length >= 50));

        if (events.length < 50) {
            loadMoreBtn.classList.add('hidden');
        }

    } catch (e) {
        console.warn('もっと見る失敗:', e.message);
        alert('データの取得に失敗しました');
    } finally {
        profilePostsState.isLoading = false;
        loadMoreBtn.classList.remove('loading');
    }
}

/**
 * 取得したイベント群の本文中にある nostr: 参照（nevent, noteなど）をスキャンし、
 * まだデータストアにないものをリレーから一括で先読みしてキャッシュする。
 * これにより、タイムライン描画時に引用プレビューやインラインRTが正しく機能するようになる。
 */
async function prefetchNostrReferences(events, relays) {
    const targetIds = new Set();
    const nip19Regex = /nostr:(npub1|nevent1|note1|nprofile1|nrelay1)[a-zA-Z0-9]+/g;

    // 1. 全イベントの本文から nostr: リンクを探してIDを抽出する
    events.forEach(ev => {
        if (!ev.content) return;
        const matches = ev.content.match(nip19Regex);
        if (!matches) return;

        matches.forEach(match => {
            const nip19Str = match.replace('nostr:', '');
            try {
                const decoded = window.NostrTools.nip19.decode(nip19Str);
                if (decoded.type === 'nevent' && decoded.data?.id) {
                    targetIds.add(decoded.data.id);
                } else if (decoded.type === 'note' && decoded.data) {
                    targetIds.add(decoded.data);
                }
            } catch (e) {
                // デコード失敗は無視
            }
        });
    });

    if (targetIds.size === 0) return;

    // 2. すでに dataStore にあるものは省く
    const missingIds = Array.from(targetIds).filter(id => !window.dataStore.getEvent(id));
    if (missingIds.length === 0) return;

    console.log(`🔍 引用先の投稿を先読みします: ${missingIds.length}件`);

    try {
        // 3. 不足しているものをリレーに問い合せる
        const referencedEvents = await pool.querySync(relays, {
            ids: missingIds
        });

        // 4. dataStore に突っ込んでおく
        referencedEvents.forEach(ev => {
            window.dataStore.addEvent(ev);
        });
        console.log(`✨ 引用先の先読み完了: ${referencedEvents.length}件取得`);
    } catch (e) {
        console.warn('引用先の先読み失敗:', e.message);
    }
}

// ========================================
// 入力フォーム
// ========================================

function renderInputForm() {
    mainEventContainer.innerHTML = `
        <div class="input-form-container">
          <p class="form-title">イベントまたはユーザーのNostr IDを入力してください</p>
          <form id="nostr-form" class="nostr-form">
            <input type="text" id="nostr-id-input" placeholder="nevent1..., npub1..." required class="form-input">
            <button type="submit" class="form-button">表示</button>
          </form>
        </div>`;

    const form = document.getElementById('nostr-form');
    form?.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('nostr-id-input').value.trim();
        const validPrefixes = ['note1', 'nevent1', 'naddr1', 'npub1', 'nprofile1'];
        if (validPrefixes.some(p => input.startsWith(p))) {
            window.location.href = `?id=${input}`;
        } else {
            alert('有効なNostr ID (note1, nevent1, naddr1, npub1, nprofile1) を入力してください。');
        }
    });
}

// ========================================
// ルーティング（起点）
// ========================================

async function startWorkflow(originalId) {
    showStatus('読み込み中...');
    const parsed = parseInput(originalId);

    if (!parsed) {
        showStatus('');
        renderInputForm();
        return;
    }

    try {
        if (parsed.kind === 'profile') {
            await renderProfilePage(parsed.pubkey, parsed.relays);
            showStatus('');
            return;
        }

        let event;
        if (parsed.kind === 'addr') {
            const relays = getPriorityRelays(parsed.relays);
            event = await withTimeout(
                pool.get(relays, { kinds: [parsed.addrKind], authors: [parsed.pubkey], '#d': [parsed.identifier] }),
                10000, '記事取得タイムアウト'
            );
        } else {
            event = await fetchEventById(parsed.id, parsed.relays);
        }

        if (!event) {
            showStatus('イベントが見つかりませんでした。しばらく待ってから再読み込みしてください。');
            return;
        }

        switch (event.kind) {
            case 1:
            case 30023:
                await renderStandardPost(event, originalId);
                break;
            case 6:
            case 16:
                await renderRepost(event);
                break;
            case 7:
                await renderReactionEvent(event);
                break;
            case 40:
            case 41:
                await renderChannelRoot(event);
                break;
            case 42:
                await renderChannelMessage(event);
                break;
            default:
                renderGenericEvent(event);
        }
        showStatus('');
    } catch (err) {
        console.error('ワークフローエラー:', err);
        showStatus('エラーが発生しました: ' + err.message);
    }
}

function initializeApp() {
    const relayStatusText = document.getElementById('relay-status-text');
    if (relayStatusText) relayStatusText.textContent = `接続先リレー候補: ${FALLBACK_RELAYS.length}件`;

    // 本体(flowgazer)ですでにログイン済みなら、ここでバッジに即反映される
    updateTweetPageLoginUI();

    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');

    if (!id) {
        renderInputForm();
        return;
    }
    startWorkflow(id.trim());
}

window.addEventListener('load', initializeApp);

// ページ離脱時にリレー接続を解放
window.addEventListener('beforeunload', () => {
    try { pool.close(FALLBACK_RELAYS); } catch (e) { /* noop */ }
});