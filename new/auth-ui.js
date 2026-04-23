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
            <button id="nip07-login" style="margin-bottom: 0.5rem; font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">🔐 NIP-07でログイン</button>
            <button id="generate-trial-keypair" style="margin-bottom: 0.5rem; font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; border: none; border-radius: 999px; background-color: #f9c; color: #fff; cursor: pointer;">✨ 新規作成してはじめる</button>
            
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem;">
                <input type="password" id="nsec-input" placeholder="nsec1..." style="flex-grow: 1; font-size: 0.9rem; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px;">
                <button type="button" id="nsec-login" style="font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">🔑 nsec</button>
            </div>
            <small style="color: #999; display: block; margin-bottom: 0.5rem;">書き込み可能</small>

            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <input type="text" id="npub-input" placeholder="npub1... or name@domain.com" style="flex-grow: 1; font-size: 0.9rem; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px;">
                <button type="button" id="npub-login" style="font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">👀 npub</button>
            </div>
            <small style="color: #999; display: block;">読み取り専用</small>
        </div>

        <div id="auth-info" style="display: none;">
            <p><span id="auth-mode" style="color: #999; font-size: 0.8rem;"></span><span> 公開鍵: <span id="auth-npub" style="font-family: monospace;"></span></span></p>
            <div id="copy-nsec-container"></div>
            <button id="logout-btn" style="background-color: #ffebee; color: #c62828; border-radius: 999px; padding: 0.25rem 1rem; border: none; margin-top: 1rem; cursor: pointer;">サインアウト</button>
        </div>
        <button id="close-auth" style="margin-top: 1rem; background-color: #00796b; color: #fff; border-radius: 999px; padding: 0.25rem 1rem; border: none; cursor: pointer; width: 100%;">とじる</button>
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
        // 成功時の共通処理
        onAuthSuccess: (msg) => {
            console.log("Auth Success! Current pubkey:", window.nostrAuth.pubkey);

            if (msg) alert(msg);
            updateAuthUI();

            // 重要なポイント：少し待ってからアプリ側のUIを叩く
            setTimeout(() => {
                if (window.app && window.app.updateLoginUI) {
                    console.log("Calling app.updateLoginUI...");
                    window.app.updateLoginUI();
                }
                handlers.closeAuth();
            }, 300); // 0.3秒くらいしっかり待ってみる
        },

        nip07Login: async () => {
            try {
                await window.nostrAuth.loginWithExtension();
                handlers.onAuthSuccess('いけた！');
            } catch (e) { alert(e.message); }
        },

        nsecLogin: () => {
            const nsec = document.getElementById('nsec-input').value.trim();
            if (!nsec) return;
            try {
                window.nostrAuth.loginWithNsec(nsec);
                handlers.onAuthSuccess('いけた！');
            } catch (e) { alert(e.message); }
        },

        npubLogin: () => {
            const npub = document.getElementById('npub-input').value.trim();
            if (!npub) return;
            try {
                window.nostrAuth.loginWithNpub(npub);
                handlers.onAuthSuccess('welcome to nostr!');
            } catch (e) { alert(e.message); }
        },

        generateTrial: () => {
            if (!confirm(
                '新しい鍵ペアを生成します。\n' +
                '生成された秘密鍵（nsec）は失くすと見つからないので\n' +
                '大事に持っておいてね。')) return;
            try {
                const sk = window.NostrTools.generateSecretKey();
                const nsec = window.NostrTools.nip19.nsecEncode(sk);
                window.nostrAuth.loginWithNsec(nsec);
                handlers.onAuthSuccess('welcome to nostr!');
            } catch (e) { alert(e.message); }
        },

        logout: () => {
            window.nostrAuth.logout();
            alert('またきてね');
            updateAuthUI();
            if (window.app?.updateLoginUI) window.app.updateLoginUI();
            showAuthUI(); // ログアウト後に再度ログイン画面を見せる
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