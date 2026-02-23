/**
 * sendfav.js - 認証UI・長押し・送信 統合モジュール
 */


/* 1. NostrAuth クラス (認証・署名) */
class NostrAuth {
  constructor() {
    this.pubkey = null;
    this.nsec = null;
    this.useNIP07 = false;
    this.readOnly = true;
  }


  // NIP-07 (拡張機能)
  async loginWithExtension() {
    if (!window.nostr) throw new Error('NIP-07拡張機能が見つかりません');
    this.pubkey = await window.nostr.getPublicKey();
    this.useNIP07 = true;
    this.readOnly = false;
    this.save();
    return this.pubkey;
  }


  // nsec (秘密鍵)
  loginWithNsec(nsec) {
    const decoded = NostrTools.nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error('無効なnsecです');
    this.nsec = nsec;
    this.pubkey = NostrTools.getPublicKey(decoded.data);
    this.useNIP07 = false;
    this.readOnly = false;
    this.save();
    return this.pubkey;
  }


  // npub または NIP-05 (閲覧専用)
  async loginWithNpub(input) {
    if (input.includes('@')) {
      const [name, domain] = input.split('@');
      const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`);
      const data = await response.json();
      if (!data.names || !data.names[name]) throw new Error('NIP-05が見つかりません');
      this.pubkey = data.names[name];
    } else {
      const decoded = NostrTools.nip19.decode(input);
      if (decoded.type !== 'npub') throw new Error('無効なnpubです');
      this.pubkey = decoded.data;
    }
    this.nsec = null;
    this.useNIP07 = false;
    this.readOnly = true;
    this.save();
    return this.pubkey;
  }


  logout() {
    this.pubkey = null;
    this.nsec = null;
    this.useNIP07 = false;
    this.readOnly = true;
    localStorage.removeItem('nostr_auth');
  }


  save() {
    localStorage.setItem('nostr_auth', JSON.stringify({
      pubkey: this.pubkey, nsec: this.nsec, useNIP07: this.useNIP07, readOnly: this.readOnly
    }));
  }


  load() {
    const saved = localStorage.getItem('nostr_auth');
    if (saved) {
      const data = JSON.parse(saved);
      Object.assign(this, data);
    }
  }


  isLoggedIn() { return this.pubkey !== null; }
  canWrite() { return this.isLoggedIn() && !this.readOnly; }


  async signEvent(event) {
    if (this.useNIP07) return await window.nostr.signEvent(event);
    if (this.nsec) {
      const decoded = NostrTools.nip19.decode(this.nsec);
      return NostrTools.finalizeEvent(event, decoded.data);
    }
    throw new Error('署名できません');
  }
}


window.nostrAuth = new NostrAuth();
window.nostrAuth.load();


/* 2. 認証UI (Overlay) */
function createAuthUI() {
  if (document.getElementById('auth-overlay')) return;


  const overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  overlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);backdrop-filter:blur(5px);z-index:9998;display:none;justify-content:center;align-items:center;`;


  const panel = document.createElement('div');
  panel.style.cssText = `background:#fff;padding:1.5rem;border-radius:8px;max-width:400px;width:90%;color:#666;font-family:sans-serif;`;
  panel.innerHTML = `
    <div id="auth-login">
      <button id="nip07-login" style="width:100%;padding:0.5rem;margin-bottom:1rem;border-radius:999px;border:none;background:#e0f2f1;color:#00796b;font-weight:bold;cursor:pointer;">🔐 NIP-07でサインイン</button>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
        <form>
        <input type="text" name="username" style="display:none;" autocomplete="username">
        <input type="password" id="nsec-input" autocomplete="current-password" placeholder="nsec1..." style="flex:1;padding:0.4rem;border:1px solid #ddd;border-radius:4px;">
        </form>
        <button id="nsec-login" style="padding:0.4rem 1rem;border-radius:999px;border:none;background:#e0f2f1;color:#00796b;font-weight:bold;cursor:pointer;">🔑 nsec</button>
      </div>
      <div style="display:flex;gap:0.5rem;">
        <input type="text" id="npub-input" placeholder="npub or name@domain" style="flex:1;padding:0.4rem;border:1px solid #ddd;border-radius:4px;">
        <button id="npub-login" style="padding:0.4rem 1rem;border-radius:999px;border:none;background:#e0f2f1;color:#00796b;font-weight:bold;cursor:pointer;">👀 閲覧のみ</button>
      </div>
    </div>
    <div id="auth-info" style="display:none;">
      <p style="font-size:0.8rem;">ログイン中: <span id="auth-npub"></span></p>
      <button id="logout-btn" style="width:100%;padding:0.4rem;border-radius:999px;border:none;background:#ffebee;color:#c62828;cursor:pointer;">サインアウト</button>
    </div>
    <button id="close-auth" style="width:100%;margin-top:1rem;padding:0.4rem;border-radius:999px;border:none;background:#00796b;color:#fff;cursor:pointer;">とじる</button>
  `;


  overlay.appendChild(panel);
  document.body.appendChild(overlay);


  // イベント登録
  document.getElementById('nip07-login').onclick = async () => { try { await window.nostrAuth.loginWithExtension(); updateAuthUI(); } catch(e){ alert(e.message); } };
  document.getElementById('nsec-login').onclick = () => { try { window.nostrAuth.loginWithNsec(document.getElementById('nsec-input').value); updateAuthUI(); } catch(e){ alert(e.message); } };
  document.getElementById('npub-login').onclick = async () => { try { await window.nostrAuth.loginWithNpub(document.getElementById('npub-input').value); updateAuthUI(); } catch(e){ alert(e.message); } };
  document.getElementById('logout-btn').onclick = () => { window.nostrAuth.logout(); updateAuthUI(); };
  document.getElementById('close-auth').onclick = () => overlay.style.display = 'none';


  updateAuthUI();
}


function updateAuthUI() {
  const isLogged = window.nostrAuth.isLoggedIn();
  document.getElementById('auth-login').style.display = isLogged ? 'none' : 'block';
  document.getElementById('auth-info').style.display = isLogged ? 'block' : 'none';
  if (isLogged) {
    const npub = NostrTools.nip19.npubEncode(window.nostrAuth.pubkey);
    document.getElementById('auth-npub').textContent = npub.slice(0,10) + '...' + npub.slice(-4);
  }
}


window.showAuthUI = () => {
  createAuthUI();
  document.getElementById('auth-overlay').style.display = 'flex';
};


/* ==========================================
   3. ふぁぼ送信 & 長押し
   ========================================== */
window.sendLikeEvent = async function(id, pk) {
  if (!window.nostrAuth.canWrite()) {
    showAuthUI();
    return;
  }
  try {
    // HTMLの入力欄から現在の値を取得。もし空なら "+" をデフォルトにする
    const reactionContent = document.getElementById("kind-7-content-input").value || "+";


    const event = {
      kind: 7,
      content: reactionContent, // ここを固定の "+" から変数に変更！
      created_at: Math.floor(Date.now()/1000),
      tags: [['e', id], ['p', pk]]
    };


    const signed = await window.nostrAuth.signEvent(event);
    window.relayManager.publish(signed);


    // data-id属性を使って、今ふぁぼった投稿の要素を探す
    const targetEl = document.querySelector(`li[data-id="${id}"]`);
    if (targetEl) {
      targetEl.classList.add('is-favored');
    }


    // アラートの代わりにコンソールログ（または小さなトースト）にすると快適
    console.log('Favored:', id);
   
  } catch (err) { alert('失敗: ' + err.message); }
};


function attachLongPress(el) {
  let timer;
  const start = (e) => {
    if (e.type === 'mousedown' && e.button !== 0) return;
    timer = setTimeout(() => {
      if (confirm('☆ ふぁぼる？')) {
        window.sendLikeEvent(el.dataset.id, el.dataset.pubkey);
      }
    }, 900);
  };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('touchstart', start, {passive:true});
  el.addEventListener('touchend', cancel);
}


// 描画完了を検知してバインド
document.addEventListener('timeline-rendered', () => {
  document.querySelectorAll('.event').forEach(el => {
    if (!el.dataset.bound) {
      attachLongPress(el);
      el.dataset.bound = "true";
    }
  });
});


// 初期化
document.addEventListener('DOMContentLoaded', createAuthUI);