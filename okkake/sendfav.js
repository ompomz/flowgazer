/**
 * sendfav.js - 認証・UI・多機能長押しメニュー 統合モジュール
 */

(function () {
  /* --- 1. NostrAuth クラス (認証・署名) --- */
  class NostrAuth {
    constructor() {
      this.pubkey = null;
      this.nsec = null;
      this.useNIP07 = false;
      this.readOnly = true;
    }
    async loginWithExtension() {
      if (!window.nostr) throw new Error('NIP-07拡張機能が見つかりません');
      this.pubkey = await window.nostr.getPublicKey();
      this.useNIP07 = true;
      this.readOnly = false;
      this.save();
      return this.pubkey;
    }
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
      this.pubkey = null; this.nsec = null; this.useNIP07 = false; this.readOnly = true;
      localStorage.removeItem('nostr_auth');
    }
    save() {
      localStorage.setItem('nostr_auth', JSON.stringify({
        pubkey: this.pubkey, nsec: this.nsec, useNIP07: this.useNIP07, readOnly: this.readOnly
      }));
    }
    load() {
      const saved = localStorage.getItem('nostr_auth');
      if (saved) Object.assign(this, JSON.parse(saved));
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

  /* --- 2. スタイル注入 (CSS) --- */
  const injectStyles = () => {
    if (document.getElementById('sf-styles')) return;
    const style = document.createElement('style');
    style.id = 'sf-styles';
    style.textContent = `
            .lp-menu {
                position: fixed; z-index: 10000; width: 0; height: 0;
                pointer-events: none; transform: translate(-1.5rem, 5rem);
                display: none;
            }
            .lp-menu.active { display: flex; animation: sf-pop 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
            @keyframes sf-pop {
                from { opacity: 0; transform: translate(-1.5rem, 5rem) scale(0.5); }
                to { opacity: 1; transform: translate(-1.5rem, 5rem) scale(1); }
            }
            .lp-item {
                position: absolute; width: 3rem; height: 3rem; background: #fff;
                border-radius: 999px; display: flex; align-items: center; justify-content: center;
                font-size: 1.5rem; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.1);
                transition: all 0.2s ease; user-select: none; pointer-events: auto; border: none;
            }
            .lp-item svg { width: 1.5rem; height: 1.5rem; stroke: currentColor; fill: none; }
            .lp-item[data-action="like"] { top: -3rem; left: 0; color: #ffcc66; }
            .lp-item[data-action="repost"] { top: 0; left: -3rem; color: #66b3ff; }
            .lp-item[data-action="quote"] { top: 0; left: 3rem; color: #666; }
            .lp-item[data-action="reply"] { top: 3rem; left: 0; color: #66b3ff; }
            .lp-item.selected {
                transform: scale(1.06);
                box-shadow: 0 0 20px 12px rgba(120, 170, 255, 0.35), 0 0 40px 20px rgba(120, 170, 255, 0.25);
            }
            #lp-like-icon { font-family: "Apple Color Emoji", "Segoe UI Emoji", sans-serif; font-size: 1.25rem; }
        `;
    document.head.appendChild(style);
  };

  /* --- 3. UI生成とアクション --- */
  const createMenuUI = () => {
    if (document.getElementById('long-press-menu')) return;
    const menu = document.createElement('div');
    menu.id = 'long-press-menu';
    menu.className = 'lp-menu';
    menu.innerHTML = `
            <div class="lp-item" data-action="like" id="lp-like-icon" title="ふぁぼ">⭐</div>
            <div class="lp-item" data-action="repost" title="RT"><svg viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg></div>
            <div class="lp-item" data-action="quote" title="neventコピー"><svg viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5H4v8h4c0 2-1 4-4 4v4zm13 0c3 0 7-1 7-8V5h-6v8h4c0 2-1 4-4 4v4z"></path></svg></div>
            <div class="lp-item" data-action="reply" title="lumilumiで開く"><svg viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></div>
        `;
    document.body.appendChild(menu);
  };

  window.sendLikeEvent = async function (id, pk) {
    if (!window.nostrAuth.canWrite()) { window.showAuthUI(); return; }
    try {
      const reaction = document.getElementById("kind-7-content-input")?.value || "+";
      const event = { kind: 7, content: reaction, created_at: Math.floor(Date.now() / 1000), tags: [['e', id], ['p', pk]] };
      const signed = await window.nostrAuth.signEvent(event);
      window.relayManager.publish(signed);
      document.querySelector(`li[data-id="${id}"]`)?.classList.add('is-favored');
      console.log('Favored:', id);
    } catch (err) { alert('失敗: ' + err.message); }
  };

  const sendRepost = async (id, pk) => {
    if (!window.nostrAuth.canWrite()) { window.showAuthUI(); return; }
    if (!confirm('RTしますか？')) return;
    try {
      const event = { kind: 6, content: "", created_at: Math.floor(Date.now() / 1000), tags: [['e', id, window.relayManager?.url || ""], ['p', pk]] };
      const signed = await window.nostrAuth.signEvent(event);
      window.relayManager.publish(signed);
      alert('RTしました');
    } catch (err) { alert('失敗: ' + err.message); }
  };

  const handleAction = async (action, id, pk) => {
    const nevent = NostrTools.nip19.neventEncode({ id, relays: [window.relayManager?.url || ""] });
    switch (action) {
      case 'like': await window.sendLikeEvent(id, pk); break;
      case 'repost': await sendRepost(id, pk); break;
      case 'quote':
        await navigator.clipboard.writeText(`nostr:${nevent}`);
        alert('neventをコピーしました');
        break;
      case 'reply': window.open(`https://lumilumi.app/${nevent}`, '_blank'); break;
    }
  };

  /* --- 4. 長押しハンドラーロジック --- */
  window.attachLongPress = function (el) {
    let timer;
    let startPos = { x: 0, y: 0 };
    const THRESHOLD = 10;

    const trigger = (e) => {
      const menu = document.getElementById('long-press-menu');
      const customIcon = document.getElementById('kind-7-content-input')?.value || "⭐";
      const iconDisplay = document.getElementById('lp-like-icon');
      if (iconDisplay) iconDisplay.textContent = customIcon;

      menu.style.left = `${startPos.x}px`;
      menu.style.top = `${startPos.y - 20}px`;
      menu.classList.add('active');

      const close = (ev) => {
        if (ev && ev.target && menu.contains(ev.target)) return;
        menu.classList.remove('active');
        document.removeEventListener('pointerdown', close);
        menu.onclick = null;
      };

      menu.onclick = (ev) => {
        ev.stopPropagation(); ev.preventDefault();
        const item = ev.target.closest('.lp-item');
        if (item) {
          handleAction(item.dataset.action, el.dataset.id, el.dataset.pubkey);
          close();
        }
      };
      setTimeout(() => document.addEventListener('pointerdown', close), 100);
    };

    const start = (e) => {
      const touch = e.touches ? e.touches[0] : e;
      startPos = { x: touch.clientX, y: touch.clientY };
      timer = setTimeout(trigger, 400);
    };
    const move = (e) => {
      if (!timer) return;
      const touch = e.touches ? e.touches[0] : e;
      if (Math.hypot(touch.clientX - startPos.x, touch.clientY - startPos.y) > THRESHOLD) {
        clearTimeout(timer); timer = null;
      }
    };
    const stop = () => { clearTimeout(timer); timer = null; };

    el.addEventListener('mousedown', start);
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('mousemove', move);
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('mouseup', stop);
    el.addEventListener('mouseleave', stop);
    el.addEventListener('touchend', stop);
    el.addEventListener('touchcancel', stop);
  };

  // 自動バインド
  document.addEventListener('timeline-rendered', () => {
    document.querySelectorAll('.event').forEach(el => {
      if (!el.dataset.bound) { attachLongPress(el); el.dataset.bound = "true"; }
    });
  });

  // 起動時初期化
  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    createMenuUI();
    if (typeof createAuthUI === 'function') createAuthUI();
  });
})();