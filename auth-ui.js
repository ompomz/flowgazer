/**
 * auth-ui.js
 * 認証UIの管理とイベントハンドリング
 */

let authEventHandlers = null;

/**
 * 認証UIを作成しDOMに追加
 */
function createAuthUI() {
    if (document.getElementById('auth-overlay')) {
        destroyAuthUI();
    }

    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); backdrop-filter: blur(5px);
        z-index: 9998; display: none; justify-content: center; align-items: center;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
        background: #fff; padding: 1.5rem; border-radius: 8px;
        max-width: 400px; width: 90%; color: #666; font-size: .9rem;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    `;

    panel.innerHTML = `
    <div id="auth-status"></div>
    <div id="auth-login">
        <button id="nip07-login" style="margin-bottom: 0.5rem; margin-right: 0.5rem; font-size: 0.8rem; font-weight: bold; padding: 0 1rem; height: 2.2rem; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;">🔐 NIP-07でログイン</button>
        <button id="generate-trial-keypair" style="margin-bottom: 0.5rem; font-size: 0.8rem; font-weight: bold; padding: 0 1rem; height: 2.2rem; border: none; border-radius: 999px; background-color: #f9c; color: #fff; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;">✨ 新規作成してはじめる</button>
        
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem;">
            <form onsubmit="return false;" style="display: flex; gap: 0.5rem; flex-grow: 1; align-items: center;">
                <input type="text" name="username" autocomplete="username" style="display:none;">
                <input type="password" id="nsec-input" autocomplete="current-password" placeholder="nsec1..." style="flex-grow: 1; font-size: 0.9rem; padding: 0 0.5rem; height: 2.2rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;"> 
                <button type="button" id="nsec-login" style="font-size: 0.8rem; font-weight: bold; padding: 0 1rem; height: 2.2rem; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap;">🔑 nsec</button>
            </form>
        </div>
        <small style="color: #999; display: block; margin-bottom: 0.5rem;">書き込み可能</small>

        <div style="display: flex; align-items: center; gap: 0.5rem;">
            <input type="text" id="npub-input" placeholder="npub1... or name@domain.com" style="flex-grow: 1; font-size: 0.9rem; padding: 0 0.5rem; height: 2.2rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
            <button type="button" id="npub-login" style="font-size: 0.8rem; font-weight: bold; padding: 0 1rem; height: 2.2rem; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap;">👀 npub</button>
        </div>
        <small style="color: #999; display: block;">読み取り専用</small>
    </div>

    <div id="auth-info" style="display: none;">
        <p><span id="auth-mode" style="color: #999; font-size: 0.8rem;"></span><span> 公開鍵: <span id="auth-npub" style="font-family: monospace;"></span></span></p>
        <div id="copy-nsec-container"></div>
        <button id="logout-btn" style="background-color: #ffebee; color: #c62828; border-radius: 999px; padding: 0 1rem; height: 2.2rem; border: none; margin-top: 1rem; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;">サインアウト</button>
    </div>
    <button id="close-auth" style="margin-top: 1rem; background-color: #00796b; color: #fff; border-radius: 999px; padding: 0 1rem; height: 2.2rem; border: none; cursor: pointer; width: 100%; display: inline-flex; align-items: center; justify-content: center;">とじる</button>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    setupAuthEvents();
    updateAuthUI();
}

/**
 * 認証イベントのセットアップ
 */
function setupAuthEvents() {
    const handlers = {

        // ----------------------------------------
        // ローディング表示ヘルパー
        // ----------------------------------------

        /** モーダル内にローディングメッセージを表示し、入力UIを隠す */
        showLoading(msg) {
            const status = document.getElementById('auth-status');
            if (status) {
                status.textContent = msg;
                status.style.cssText = 'margin-bottom: 0.75rem; color: #00796b; font-size: 0.85rem;';
            }
            document.getElementById('auth-login').style.display = 'none';
            document.getElementById('close-auth').style.display = 'none';
        },

        /** ローディング表示をリセットする */
        clearLoading() {
            const status = document.getElementById('auth-status');
            if (status) {
                status.textContent = '';
                status.style.cssText = '';
            }
            document.getElementById('close-auth').style.display = '';
        },

        // ----------------------------------------
        // pubkey 確定後の共通処理
        // kind:3 を待ってからモーダルを閉じる
        // ----------------------------------------

        /**
         * ログイン成功後の共通処理。
         * kind:3 (フォローリスト) の取得を試みて、
         * 結果によらず取得完了後にモーダルを閉じる。
         *
         * @param {string} welcomeMsg - alert に表示するメッセージ（空文字なら表示しない）
         */
        onAuthSuccess: async (welcomeMsg) => {
            const myPubkey = window.nostrAuth.pubkey;
            if (!myPubkey) {
                console.error('onAuthSuccess: pubkey が未確定です');
                return;
            }
            console.log('Auth Success! pubkey:', myPubkey.substring(0, 8) + '...');

            if (welcomeMsg) alert(welcomeMsg);

            updateAuthUI();

            // ---- UI 更新だけ先に行う ----
            if (window.app?.updateLoginUI) window.app.updateLoginUI();

            // ---- kind:3 を待ちながらローディング表示 ----
            handlers.showLoading('📡 フォロー情報を取得中...');

            const TIMEOUT_MS = 8000;
            let resolved = false;

            await new Promise((resolve) => {
                const done = (hasFollowing) => {
                    if (resolved) return;
                    resolved = true;
                    window.relayManager.unsubscribe('auth-following-check');
                    console.log(`👥 kind:3 取得完了 (フォロー: ${hasFollowing ? 'あり' : 'なし'})`);
                    resolve();
                };

                const timeoutId = setTimeout(() => {
                    console.warn('⏱️ kind:3 タイムアウト → グローバルタイムラインで続行');
                    done(false);
                }, TIMEOUT_MS);

                window.relayManager.subscribe('auth-following-check', {
                    kinds: [3],
                    authors: [myPubkey],
                    limit: 1
                }, (type, event) => {
                    if (type === 'EVENT') {
                        clearTimeout(timeoutId);
                        // DataStore にフォローリストを反映
                        const pubkeys = event.tags
                            .filter(t => t[0] === 'p')
                            .map(t => t[1]);
                        window.dataStore.setFollowingList(pubkeys);
                        window.profileFetcher.requestMultiple(pubkeys);
                        done(pubkeys.length > 0);
                    } else if (type === 'EOSE') {
                        // EVENT が来ないまま EOSE → フォローなし or kind:3 未投稿
                        clearTimeout(timeoutId);
                        done(false);
                    }
                });
            });

            // ---- フォロー情報確定後に Stream Phase を再起動 ----
            window.relayManager.unsubscribe('stream-phase');
            if (window.app?.executeStreamPhase) window.app.executeStreamPhase();

            // ---- following タブ初期表示を構築（遡及登録 → 必要なら補完取得）----
            if (window.app?.fetchFollowingInitial) {
                await window.app.fetchFollowingInitial();
            }

            // ---- onLogin の残り処理（タブフラグリセット・チャンネル取得）を実行 ----
            // ※ フォローリストは上で取得済みなので fetchInitialData() は呼ばない
            if (window.app) {
                window.app.tabDataFetched.following = false;
                window.app.tabDataFetched.myposts = false;
                window.app.tabDataFetched.likes = false;
                window.app.updateLoginUI();
            }
            if (typeof fetchMyChannels === 'function') fetchMyChannels();

            window.viewState?.renderNow();

            // ---- ローディングを消してモーダルを閉じる ----
            handlers.clearLoading();
            handlers.closeAuth();
        },

        // ----------------------------------------
        // 各ログイン方法（すべて async に統一）
        // ----------------------------------------

        nip07Login: async () => {
            try {
                await window.nostrAuth.loginWithExtension();
                await handlers.onAuthSuccess('いけた！');
            } catch (e) {
                handlers.clearLoading();
                alert(e.message);
            }
        },

        nsecLogin: async () => {
            const nsec = document.getElementById('nsec-input').value.trim();
            if (!nsec) return;
            try {
                window.nostrAuth.loginWithNsec(nsec); // 同期
                await handlers.onAuthSuccess('いけた！');
            } catch (e) {
                handlers.clearLoading();
                alert(e.message);
            }
        },

        npubLogin: async () => {
            const npub = document.getElementById('npub-input').value.trim();
            if (!npub) return;
            try {
                // loginWithNpub は async（NIP-05 解決に fetch が必要）なので await する
                await window.nostrAuth.loginWithNpub(npub);
                await handlers.onAuthSuccess('welcome to nostr!');
            } catch (e) {
                handlers.clearLoading();
                alert(e.message);
            }
        },

        generateTrial: async () => {
            if (!confirm(
                '新しい鍵ペアを生成します。\n' +
                '生成された秘密鍵（nsec）は失くすと見つからないので\n' +
                '大事に持っておいてね。')) return;
            try {
                const sk = window.NostrTools.generateSecretKey();
                const nsec = window.NostrTools.nip19.nsecEncode(sk);
                window.nostrAuth.loginWithNsec(nsec); // 同期
                await handlers.onAuthSuccess('welcome to nostr!');
            } catch (e) {
                handlers.clearLoading();
                alert(e.message);
            }
        },

        logout: () => {
            window.nostrAuth.logout();
            alert('またきてね');
            updateAuthUI();
            if (window.app?.updateLoginUI) window.app.updateLoginUI();
            showAuthUI();
        },

        closeAuth: () => {
            document.getElementById('auth-overlay').style.display = 'none';
            document.getElementById('nsec-input').value = '';
            document.getElementById('npub-input').value = '';
        }
    };

    // リスナー登録
    const bind = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    bind('nip07-login', handlers.nip07Login);
    bind('nsec-login', handlers.nsecLogin);
    bind('npub-login', handlers.npubLogin);
    bind('generate-trial-keypair', handlers.generateTrial);
    bind('logout-btn', handlers.logout);
    bind('close-auth', handlers.closeAuth);

    // Escapeキー対応
    const escHandler = (e) => {
        if (e.key === 'Escape' && document.getElementById('auth-overlay').style.display === 'flex') {
            handlers.closeAuth();
        }
    };
    document.addEventListener('keydown', escHandler);
    handlers._escHandler = escHandler;

    authEventHandlers = handlers;
}

/**
 * 状態に応じたUI更新
 */
function updateAuthUI() {
    const isLogin = window.nostrAuth.isLoggedIn();
    document.getElementById('auth-login').style.display = isLogin ? 'none' : 'block';
    document.getElementById('auth-info').style.display = isLogin ? 'block' : 'none';

    if (isLogin) {
        const npub = NostrTools.nip19.npubEncode(window.nostrAuth.pubkey);
        document.getElementById('auth-npub').textContent = `${npub.slice(0, 10)}...${npub.slice(-4)}`;

        const mode = window.nostrAuth.readOnly ? 'ROM' : (window.nostrAuth.useNIP07 ? 'NIP-07' : 'nsec');
        const modeSpan = document.getElementById('auth-mode');
        modeSpan.textContent = mode;
        modeSpan.style.color = window.nostrAuth.readOnly ? '#999' : '#00796b';

        // 秘密鍵コピーボタンの制御
        const container = document.getElementById('copy-nsec-container');
        container.innerHTML = '';
        if (window.nostrAuth.nsec && !window.nostrAuth.useNIP07) {
            const btn = document.createElement('button');
            btn.textContent = '秘密鍵をコピー';
            btn.style.cssText = 'width: 100%; margin: 0.5rem 0; padding: 0.25rem; border-radius: 999px; border: 1px solid #00796b; background: #fff; color: #00796b; cursor: pointer; font-size: 0.8rem;';
            btn.onclick = () => {
                navigator.clipboard.writeText(window.nostrAuth.nsec);
                alert('コピーしました！');
            };
            container.appendChild(btn);
        }
    }
}

/**
 * モーダル表示
 */
function showAuthUI() {
    updateAuthUI();
    const overlay = document.getElementById('auth-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
        const target = window.nostrAuth.isLoggedIn() ? 'logout-btn' : 'nip07-login';
        setTimeout(() => document.getElementById(target)?.focus(), 50);
    }
}

/**
 * 破棄
 */
function destroyAuthUI() {
    if (authEventHandlers?._escHandler) {
        document.removeEventListener('keydown', authEventHandlers._escHandler);
    }
    document.getElementById('auth-overlay')?.remove();
    authEventHandlers = null;
}

// 初期化
document.addEventListener('DOMContentLoaded', createAuthUI);
window.addEventListener('beforeunload', destroyAuthUI);