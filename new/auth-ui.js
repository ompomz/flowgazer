/**
 * auth-ui.js
 * 認証UI（オーバーレイ、パネル）を作成し、DOMに追加する関数
 */

// グローバルなイベントハンドラー参照を保持
let authEventHandlers = null;

/**
 * 認証UIを作成
 */
function createAuthUI() {
    // 既存のUIがあれば破棄
    if (authEventHandlers) {
        destroyAuthUI();
    }

    // オーバーレイ要素の作成
    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        backdrop-filter: blur(5px);
        z-index: 9998;
        display: none;
        justify-content: center;
        align-items: center;
    `;

    // パネル要素の作成
    const panel = document.createElement('div');
    panel.style.cssText = `
        background: #fff;
        padding: 1.5rem;
        border-radius: 8px;
        max-width: 400px;
        width: 90%;
        color: #666;
        font-size: .9rem;
        line-height: 1.3;
        font-weight: normal;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    `;

    panel.innerHTML = `
<div id="auth-status"></div>
<div id="auth-login" style="display: none;">
<button id="nip07-login" class="container-button" style="margin-bottom: 0.5rem; white-space: nowrap; font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; margin: 0.5rem 0; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">🔐 NIP-07</button>

    <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem;"><form onsubmit="return false;"><input type="text" name="username" autocomplete="username" style="display: none;">
        <input type="password" id="nsec-input" autocomplete="current-password" placeholder="nsec1..."
            style="flex-grow: 1; margin: 0; transition: background-color 0.3s, color 0.3s; cursor: pointer; font-size: 0.9rem; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; color: #666; background-color: #fff;">
            <button type="button" id="nsec-login" style="white-space: nowrap; font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">🔑 nsec</button></form>
    </div><small style="color: #999; display: block; margin-top: 0.25rem;">書き込み可能</small>

    <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem;"><form onsubmit="return false;">
        <input type="text" id="npub-input" autocomplete="username" placeholder="npub1... or name@domain.com"
            style="flex-grow: 1; margin: 0; transition: background-color 0.3s, color 0.3s; cursor: pointer; font-size: 0.9rem; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; color: #666; background-color: #fff;">
            <button type="button" id="npub-login" style="white-space: nowrap; font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">👀 npub</button></form>
    </div><small style="color: #999; display: block; margin-top: 0.25rem;">読み取り専用</small>

</div>
<div id="auth-info" style="display: none;">
    <p><span id="auth-mode" style="color: #999; font-size: 0.8rem;"></span><span>　公開鍵: <span id="auth-npub"></span></span></p>
    <button id="logout-btn" class="container-button" style="background-color: #e0f2f1; color: #00796b; border-radius: 999px; padding: 0.25rem 1rem; border: none; margin-top: 1rem; ">サインアウト</button>
</div>
<button id="close-auth" class="container-button" style="margin-top: 1rem; background-color: #00796b; color: #e0f2f1; border-radius: 999px; padding: 0.25rem 1rem; border: none;">とじる</button>
`;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // UIの初期状態を更新
    updateAuthUI();

    // イベントリスナーを設定
    setupAuthEvents();
}

/**
 * 認証UIの表示を更新
 */
function updateAuthUI() {
    const loginDiv = document.getElementById('auth-login');
    const infoDiv = document.getElementById('auth-info');
    const npubSpan = document.getElementById('auth-npub');
    const modeSpan = document.getElementById('auth-mode');

    if (window.nostrAuth.isLoggedIn()) {
        loginDiv.style.display = 'none';
        infoDiv.style.display = 'block';
        const npub = NostrTools.nip19.npubEncode(window.nostrAuth.pubkey);
        npubSpan.textContent = npub.substring(0, 12) + '...' + npub.slice(-4);

        if (modeSpan) {
            if (window.nostrAuth.readOnly) {
                modeSpan.textContent = 'ROM';
                modeSpan.style.color = '#999';
            } else if (window.nostrAuth.useNIP07) {
                modeSpan.textContent = 'NIP-07';
                modeSpan.style.color = '#66b3ff';
            } else {
                modeSpan.textContent = 'nsec';
                modeSpan.style.color = '#66b3ff';
            }
        }

        // 秘密鍵コピーボタンの処理
        const existingNsecBtn = document.getElementById('copy-nsec-btn');
        if (window.nostrAuth.nsec && !window.nostrAuth.useNIP07 && !existingNsecBtn) {
            const nsecBtn = document.createElement('button');
            nsecBtn.id = 'copy-nsec-btn';
            nsecBtn.className = 'container-button full-width';
            nsecBtn.textContent = '秘密鍵をコピー';
            nsecBtn.style.backgroundColor = '#00796b';
            nsecBtn.style.color = '#e0f2f1';
            nsecBtn.style.margin = '1rem 0';
            nsecBtn.style.borderRadius = '999px';
            nsecBtn.style.padding = '0.25rem 1rem';
            nsecBtn.style.border = 'none';

            const copyHandler = () => {
                navigator.clipboard.writeText(window.nostrAuth.nsec)
                    .then(() => alert('秘密鍵をコピーしました！大事に持っておいてね。'))
                    .catch(err => alert('コピーに失敗しました: ' + err.message));
            };
            nsecBtn.addEventListener('click', copyHandler);

            // ハンドラー参照を保存
            nsecBtn._copyHandler = copyHandler;

            const logoutBtn = document.getElementById('logout-btn');
            infoDiv.insertBefore(nsecBtn, logoutBtn);
            logoutBtn.style.marginTop = '0.5rem';
        } else if (existingNsecBtn) {
            document.getElementById('logout-btn').style.marginTop = '0.5rem';
        }
    } else {
        loginDiv.style.display = 'block';
        infoDiv.style.display = 'none';
        const nsecBtn = document.getElementById('copy-nsec-btn');
        if (nsecBtn) {
            // イベントリスナーを解除
            if (nsecBtn._copyHandler) {
                nsecBtn.removeEventListener('click', nsecBtn._copyHandler);
                delete nsecBtn._copyHandler;
            }
            nsecBtn.remove();
        }
    }
}

/**
 * 認証イベントリスナーを設定
 */
function setupAuthEvents() {
    // ハンドラー定義
    const handlers = {
        nip07Login: async () => {
            try {
                await window.nostrAuth.loginWithExtension();
                updateAuthUI();
                window.app.updateLoginUI();
                alert('いけた！');
            } catch (e) {
                alert(e.message);
            }
        },

        nsecLogin: () => {
            const nsec = document.getElementById('nsec-input').value;
            try {
                window.nostrAuth.loginWithNsec(nsec);
                updateAuthUI();
                window.app.updateLoginUI();
                alert('いけた！');
            } catch (e) {
                alert(e.message);
            }
        },

        npubLogin: () => {
            const npub = document.getElementById('npub-input').value.trim();
            if (!npub) {
                alert('npubを入力してください');
                return;
            }
            try {
                window.nostrAuth.loginWithNpub(npub);
                updateAuthUI();
                alert('welcome to Nostr！');
                location.reload();
            } catch (e) {
                alert(e.message);
            }
        },

        logout: () => {
            window.nostrAuth.logout();
            updateAuthUI();
            window.app.updateLoginUI();
            alert('またきてね');
        },

        closeAuth: () => {
            document.getElementById('auth-overlay').style.display = 'none';
        }
    };

    // イベントリスナーを登録
    document.getElementById('nip07-login').addEventListener('click', handlers.nip07Login);
    document.getElementById('nsec-login').addEventListener('click', handlers.nsecLogin);
    document.getElementById('npub-login').addEventListener('click', handlers.npubLogin);
    document.getElementById('logout-btn').addEventListener('click', handlers.logout);
    document.getElementById('close-auth').addEventListener('click', handlers.closeAuth);

    // グローバル参照に保存
    authEventHandlers = handlers;
}

/**
 * 認証UIを破棄
 */
function destroyAuthUI() {
    if (!authEventHandlers) return;

    // イベントリスナーを解除
    const nip07Btn = document.getElementById('nip07-login');
    const nsecBtn = document.getElementById('nsec-login');
    const npubBtn = document.getElementById('npub-login');
    const logoutBtn = document.getElementById('logout-btn');
    const closeBtn = document.getElementById('close-auth');
    const copyNsecBtn = document.getElementById('copy-nsec-btn');

    if (nip07Btn) nip07Btn.removeEventListener('click', authEventHandlers.nip07Login);
    if (nsecBtn) nsecBtn.removeEventListener('click', authEventHandlers.nsecLogin);
    if (npubBtn) npubBtn.removeEventListener('click', authEventHandlers.npubLogin);
    if (logoutBtn) logoutBtn.removeEventListener('click', authEventHandlers.logout);
    if (closeBtn) closeBtn.removeEventListener('click', authEventHandlers.closeAuth);

    if (copyNsecBtn && copyNsecBtn._copyHandler) {
        copyNsecBtn.removeEventListener('click', copyNsecBtn._copyHandler);
        delete copyNsecBtn._copyHandler;
    }

    // オーバーレイを削除
    const overlay = document.getElementById('auth-overlay');
    if (overlay) {
        overlay.remove();
    }

    authEventHandlers = null;
    console.log('🗑️ 認証UI破棄完了');
}

/**
 * 認証UIを表示
 */
function showAuthUI() {
    updateAuthUI();

    const overlay = document.getElementById('auth-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

/**
 * 新しい鍵ペアを生成してログインする
 * index.html の onclick 属性から直接呼ばれるためグローバルに公開する
 */
function generateAndLoginWithNewKeypair() {
    const confirmed = confirm(
        '新しい鍵ペアを生成します。\n' +
        '生成された秘密鍵（nsec）は失くすと見つからないので\n' +
        '大事に持っておいてね。'
    );

    if (!confirmed) return;

    const seckey = window.NostrTools.generateSecretKey();
    const nsec = window.NostrTools.nip19.nsecEncode(seckey);

    // ログイン処理
    window.nostrAuth.loginWithNsec(nsec);

    // 「すでに鍵をお持ちの方」ボタンを「秘密鍵はこちら」に書き換える
    const loginBtn = document.querySelector('.btn-grow');
    if (loginBtn) {
        loginBtn.textContent = '秘密鍵はこちら';
        loginBtn.style.backgroundColor = '#66b3ff';
        loginBtn.style.color = '#fff';

        // クリック時は認証UIを開く（showAuthUI は同ファイル内で定義済み）
        loginBtn.onclick = (e) => {
            e.preventDefault();
            showAuthUI();
        };
    }

    // 「新しい鍵ペアを生成して試す！」ボタンを無効化
    const genBtn = document.getElementById('generate-trial-keypair');
    if (genBtn) {
        genBtn.disabled = true;
        genBtn.style.opacity = '0.6';
    }

    // app が読み込み済みであれば再初期化
    // app.js の読み込み順に依存しないよう存在確認してから呼ぶ
    if (typeof window.app !== 'undefined' && typeof window.app.init === 'function') {
        window.app.init();
    }
}

// グローバルに公開（HTML の onclick 属性から参照されるため）
window.generateAndLoginWithNewKeypair = generateAndLoginWithNewKeypair;

// DOMContentLoaded後に初期化
document.addEventListener('DOMContentLoaded', () => {
    createAuthUI();
});

// ページアンロード時にクリーンアップ
window.addEventListener('beforeunload', () => {
    destroyAuthUI();
});