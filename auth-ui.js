/**
 * 認証UI（オーバーレイ、パネル）を作成し、DOMに追加する関数
 */
function createAuthUI() {
    // オーバーレイ要素の作成とスタイリング
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
    // 認証パネル要素の作成とスタイリング
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

    // パネルのinnerHTML（コンテンツ）設定
panel.innerHTML = `
  <div id="auth-status"></div>  
  <div id="auth-login" style="display: none;">
      <button id="nip07-login" class="container-button" style="margin-bottom: 0.5rem; white-space: nowrap; font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; margin: 0.5rem 0; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">
      🔐 NIP-07（ツイート&ふぁぼ可）
    </button>
    <input type="password" id="nsec-input" placeholder="nsec1..."  
      style="margin: 0.5rem 0; width: 100%; transition: background-color 0.3s, color 0.3s; cursor: pointer; font-size: 0.9rem; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; color: #666; background-color: #fff;">
    <button id="nsec-login" class="container-button" style="margin-bottom: 0.5rem; white-space: nowrap; font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; margin: 0.5rem 0; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">
      🔑 nsec（ツイート&ふぁぼ可）
    </button>
    <input type="text" id="npub-input" placeholder="npub1... or name@domain.com"  
      style="margin: 0.5rem 0; width: 100%; transition: background-color 0.3s, color 0.3s; cursor: pointer; font-size: 0.9rem; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; color: #666; background-color: #fff;">
    <button id="npub-login" class="container-button" style="margin-bottom: 0.5rem; white-space: nowrap; font-size: 0.8rem; font-weight: bold; padding: 0.25rem 1rem; margin: 0.5rem 0; border: none; border-radius: 999px; background-color: #e0f2f1; color: #00796b; cursor: pointer;">
      👀 npub（フォローリスト取得可）
    </button>
    <small style="color: #999; display: block; margin-top: 0.25rem;">
      ※イベントを流す以外のことができます
    </small>
  </div>
  <div id="auth-info" style="display: none;">
    <p><span id="auth-mode" style="color: #999; font-size: 0.8rem;"></span><span>　公開鍵: <span id="auth-npub"></span></span></p>
    <button id="logout-btn" class="container-button" style="background-color: #e0f2f1; color: #00796b; border-radius: 999px; padding: 0.25rem 1rem; border: none;">サインアウト</button>
  </div>
  <button id="close-auth" class="container-button" style="margin-top: 1rem; background-color: #00796b; color: #e0f2f1; border-radius: 999px; padding: 0.25rem 1rem; border: none;">とじる </button>
`;

    // DOMに追加
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // UIの初期状態を更新
    updateAuthUI();

    // イベントリスナーを設定
    setupAuthEvents();
}

// ---

/**
 * 鍵入力状況に基づいて認証UIの表示を更新する関数
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
    
    // 鍵入力モードを表示
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
    nsecBtn.onclick = () => {
        navigator.clipboard.writeText(window.nostrAuth.nsec)
            .then(() => alert('秘密鍵をコピーしました！大事に持っておいてね。'))
            .catch(err => alert('コピーに失敗しました: ' + err.message));
    };
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
    if (nsecBtn) nsecBtn.remove();
  }
}

// ---

/**
 * 認証に関する各種イベントリスナーを設定する関数
 */
function setupAuthEvents() {
    // NIP-07
    document.getElementById('nip07-login').addEventListener('click', async () => {
        try {
            await window.nostrAuth.loginWithExtension();
            updateAuthUI();
            window.app.updateLoginUI();
            alert('いけた！');
        } catch (e) {
            alert(e.message);
        }
    });

    // nsec入力
    document.getElementById('nsec-login').addEventListener('click', () => {
        const nsec = document.getElementById('nsec-input').value;
        try {
            window.nostrAuth.loginWithNsec(nsec);
            updateAuthUI();
            window.app.updateLoginUI();
            alert('いけた！');
        } catch (e) {
            alert(e.message);
        }
    });
    
      // npub入力
  document.getElementById('npub-login').addEventListener('click', () => {
    const npub = document.getElementById('npub-input').value.trim();
    if (!npub) {
      alert('npubを入力してください');
      return;
    }
    try {
      window.nostrAuth.loginWithNpub(npub);
      updateAuthUI();
      alert('welcome to Nostr！');
      location.reload(); // ページをリロードして状態を反映
    } catch (e) {
      alert(e.message);
    }
  });

    // サインアウト
    document.getElementById('logout-btn').addEventListener('click', () => {
        window.nostrAuth.logout();
        updateAuthUI();
        window.app.updateLoginUI();
        alert('またきてね');
    });

    // UIを閉じる
    document.getElementById('close-auth').addEventListener('click', () => {
        document.getElementById('auth-overlay').style.display = 'none';
    });
}

// ---

/**
 * 認証UI全体を表示する関数
 */
function showAuthUI() {
    document.getElementById('auth-overlay').style.display = 'flex';
}

// ---

// DOMContentLoaded後に初期化関数を実行
document.addEventListener('DOMContentLoaded', () => {
    createAuthUI();
});
