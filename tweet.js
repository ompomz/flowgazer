/**
 * tweet.js
 * 【責務】: tweet.html の起点（エントリーポイント）
 *   - 初期化 / ルーティング（startWorkflow）
 *   - ログインUI・eHagaki・長押しアクション(window.tweetActionMenu)の配線
 *   - 別リレーでの再試行など「制御」ロジック
 *
 * 描画・UI構築は tweet-view.js（window.TweetView）、
 * データ取得・キャッシュは tweet-api.js（window.tweetApi）、
 * 純粋関数・定数は tweet-utils.js（window.TweetUtils）に分離している。
 *
 * 読み込み順: ... → timeline.js → tweet-utils.js → tweet-api.js → tweet-view.js → tweet.js
 */
'use strict';

// ========================================
// 依存の取り込み
// ========================================
const { FALLBACK_RELAYS, CLIENT_TAG } = window.TweetUtils.CONFIG;

const tweetApi = window.tweetApi;
const getPriorityRelays = tweetApi.getPriorityRelays.bind(tweetApi);
const getMainRelayUrl = tweetApi.getMainRelayUrl.bind(tweetApi);
const publishToMainRelay = tweetApi.publishToMainRelay.bind(tweetApi);
const fetchEventById = tweetApi.fetchEventById.bind(tweetApi);
const resolveInput = tweetApi.resolveInput.bind(tweetApi);

const TweetView = window.TweetView;

const statusElement = document.getElementById('status');

// ========================================
// グローバル状態・外部モジュールとの橋渡し
// ========================================

// auth-ui.js は window.app?.updateLoginUI を呼ぶ（存在すれば）設計になっている。
// tweet.html は本体の FlowgazerApp を読み込まないため、
// ログインUI更新用の最小限のスタブをここで用意して橋渡しする
// （kit-ten.html等の「ページ固有の上書きはwindow.appを介して行う」既存パターンに準拠）。
window.app = {
    // プロフィール投稿一覧の改行表示を、従来のhasLineBreakロジックと同じにするため常時ON
    preWrapEnabled: true,
    updateLoginUI() {
        updateTweetPageLoginUI();
    }
};

// 長押しメニュー（ふぁぼ・RT・返信・引用）。tweet-view.js が描画時に window.tweetActionMenu を遅延参照する
window.tweetActionMenu = new NostrActionMenu({
    clientTag: CLIENT_TAG,
    getRelayUrl: getMainRelayUrl,
    publish: publishToMainRelay,
    // 通常の「ふぁぼ」は常に固定マーク。絵文字は7つ目の専用項目(likePick)から選ぶ
    getKind7Mode: () => 'fixed'
});

// timeline.js（Timelineクラス）は window.actionMenu を参照する設計のため、
// 同じインスタンスをそちらの名前でも公開する
window.actionMenu = window.tweetActionMenu;

// cusemo.js の取得経路を tweetApi（SimplePool）に差し替える（tweet.html は relayManager を持たないため）
if (window.customEmojiManager) {
    window.customEmojiManager.queryProvider = (filters) => tweetApi.queryEmojiEvents(filters);
}

// ログインユーザーの絵文字を一度だけ読み込む（ユーザーが変わったら入れ替え）
let cusemoLoadedFor = null;
function ensureCustomEmojisLoaded() {
    const mgr = window.customEmojiManager;
    const auth = window.nostrAuth;
    if (!mgr || !auth?.pubkey || !auth.canWrite()) return;
    if (cusemoLoadedFor === auth.pubkey) return;

    if (cusemoLoadedFor) mgr.emojis.clear(); // 前ユーザーの絵文字を引き継がない
    cusemoLoadedFor = auth.pubkey;
    mgr.fetchMyEmojis(auth.pubkey);
}

// ========================================
// ヘッダー操作（tweet.html の onclick から直接呼ばれるためグローバルのまま）
// ========================================

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

// ========================================
// ログインUI・書き込みアクションの配線
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
    ensureCustomEmojisLoaded();
    onComplete();
});

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

// ========================================
// フォールバック表示と「別のリレーで再試行」
// ========================================

/**
 * フォールバックUIを出す。再試行ボタンの中身（retryFetchWithRelay）をここで結び付ける。
 * ビュー側は onRetry を呼ぶだけで、tweet.js を直接は知らない。
 */
function showNotFound({ originalId, parsed, triedRelays, errorMessage = null, rawEvent = null, retryMessage = '' }) {
    TweetView.renderNotFoundFallback({
        originalId, parsed, triedRelays, errorMessage, rawEvent, retryMessage,
        onRetry: (relay) => retryFetchWithRelay(parsed, originalId, relay)
    });
}

/**
 * 「別のリレーで再試行」ボタン用。
 * fetchEventById()のキャッシュ（未検出=null）を踏まないよう、
 * api 側の fetchEventFromRelays / fetchAddrEvent で指定リレーのみに直接問い合わせる。
 */
async function retryFetchWithRelay(parsed, originalId, relay) {
    const notFoundHere = () => showNotFound({
        originalId, parsed, triedRelays: [relay],
        retryMessage: `${relay} でも見つかりませんでした`
    });

    try {
        if (parsed.kind === 'profile') {
            const found = await TweetView.renderProfilePage(parsed.pubkey, [relay]);
            if (found) { showStatus(''); return; }
            notFoundHere();
            return;
        }

        let event;
        if (parsed.kind === 'addr') {
            event = await tweetApi.fetchAddrEvent(parsed, [relay], 10000, '再取得タイムアウト');
        } else {
            event = await tweetApi.fetchEventFromRelays(parsed.id, [relay]);
        }

        if (!event) {
            notFoundHere();
            return;
        }

        try {
            await TweetView.renderEventByKind(event, originalId);
            showStatus('');
        } catch (renderErr) {
            showNotFound({ originalId, parsed, triedRelays: [relay], errorMessage: renderErr.message, rawEvent: event });
        }
    } catch (err) {
        showNotFound({ originalId, parsed, triedRelays: [relay], errorMessage: err.message });
    }
}

// ========================================
// ルーティング（起点）
// ========================================
async function startWorkflow(originalId) {
    showStatus('読み込み中...');
    const parsed = await resolveInput(originalId);

    if (parsed?.kind === 'nip05-error') {
        TweetView.renderInputForm();
        showStatus(`NIP-05「${parsed.nip05}」を解決できませんでした（${parsed.message}）`);
        return;
    }

    if (!parsed) {
        showStatus('');
        TweetView.renderInputForm();
        return;
    }

    // NIP-05 経由で解決できた場合、外部ビューア用リンクなどのフォールバックUIには
    // npub を使う（lumilumi 等が NIP-05 を受け付けるとは限らないため）
    if (parsed.nip05) {
        originalId = NostrTools.nip19.npubEncode(parsed.pubkey);
    }

    // 実際に問い合わせるリレー一覧を先に確定させ、失敗時のフォールバックUIでも使い回す
    const triedRelays = getPriorityRelays(parsed.relays);

    try {
        if (parsed.kind === 'profile') {
            const found = await TweetView.renderProfilePage(parsed.pubkey, parsed.relays);
            if (!found) {
                showNotFound({ originalId, parsed, triedRelays });
                return;
            }
            showStatus('');
            return;
        }

        let event;
        if (parsed.kind === 'addr') {
            event = await tweetApi.fetchAddrEvent(parsed, triedRelays, 10000, '記事取得タイムアウト');
        } else {
            event = await fetchEventById(parsed.id, parsed.relays);
        }

        if (!event) {
            showNotFound({ originalId, parsed, triedRelays });
            return;
        }

        try {
            await TweetView.renderEventByKind(event, originalId);
            showStatus('');
        } catch (renderErr) {
            console.error('描画エラー:', renderErr);
            showNotFound({ originalId, parsed, triedRelays, errorMessage: renderErr.message, rawEvent: event });
        }
    } catch (err) {
        console.error('ワークフローエラー:', err);
        showNotFound({ originalId, parsed, triedRelays, errorMessage: err.message });
    }
}

function initializeApp() {
    const relayStatusText = document.getElementById('relay-status-text');
    if (relayStatusText) relayStatusText.textContent = `接続先リレー候補: ${FALLBACK_RELAYS.length}件`;

    // 本体(flowgazer)ですでにログイン済みなら、ここでバッジに即反映される
    updateTweetPageLoginUI();
    ensureCustomEmojisLoaded();

    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');

    if (!id) {
        TweetView.renderInputForm();
        return;
    }
    startWorkflow(id.trim());
}

window.addEventListener('load', initializeApp);

// ページ離脱時にリレー接続を解放
window.addEventListener('beforeunload', () => {
    tweetApi.close();
});