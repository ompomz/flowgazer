// cusemo.js

class CustomEmojiManager {
    constructor() {
        // shortcode -> { url, source }
        // source: 直接指定(own)なら null、30030由来なら "30030:pubkey:d" のアドレス文字列
        this.emojis = new Map();
        this._pendingSetRefs = [];

        // ピッカーからの選択結果を受け取るコールバック
        this._pickerCallback = null;
    }

    fetchMyEmojis(pubkey) {
        if (!pubkey) return;
        console.log('🔍 カスタム絵文字(kind:10030)を取得中...');

        const filter = { kinds: [10030], authors: [pubkey] };
        const receivedEvents = [];

        window.relayManager.subscribe('fetch-emojis', filter, (type, event) => {
            if (type === 'EVENT') {
                if (event && event.kind === 10030) receivedEvents.push(event);
            } else if (type === 'EOSE') {
                window.relayManager.unsubscribe('fetch-emojis');

                if (receivedEvents.length > 0) {
                    receivedEvents.sort((a, b) => b.created_at - a.created_at);
                    this.parseEmojiSet(receivedEvents[0]);
                    // 🆕 aタグで参照されたkind:30030を追加解決
                    this.fetchEmojiSets(this._pendingSetRefs);
                } else {
                    this._finishLoading();
                }
            }
        });
    }

    parseEmojiSet(event) {
        if (!event || event.kind !== 10030) return;

        this._pendingSetRefs = [];

        for (const tag of event.tags) {
            if (tag[0] === 'emoji' && tag[1] && tag[2]) {
                this.emojis.set(tag[1], { url: tag[2], source: null });

            } else if (tag[0] === 'a' && tag[1]) {
                // "30030:<pubkey>:<d-identifier>"
                const parts = tag[1].split(':');
                if (parts[0] === '30030' && parts[1]) {
                    this._pendingSetRefs.push({
                        pubkey: parts[1],
                        dTag: parts.slice(2).join(':'), // dにコロンが含まれる可能性を考慮
                        address: tag[1],
                        relayHint: tag[2] || null // 🆕 現状未使用（下記メモ参照）
                    });
                }
            }
        }

        console.log(`📦 直接指定の絵文字: ${this.emojis.size}件 / 外部セット参照: ${this._pendingSetRefs.length}件`);
    }

    // 🆕 aタグで参照された kind:30030 をまとめて取得
    fetchEmojiSets(refs) {
        if (!refs || refs.length === 0) {
            this._finishLoading();
            return;
        }

        const filters = refs.map(r => ({
            kinds: [30030],
            authors: [r.pubkey],
            '#d': [r.dTag],
            limit: 1
        }));

        window.relayManager.subscribe('fetch-emoji-sets', filters, (type, event) => {
            if (type === 'EVENT' && event?.kind === 30030) {
                this._mergeEmojiSet(event);
            } else if (type === 'EOSE') {
                window.relayManager.unsubscribe('fetch-emoji-sets');
                this._finishLoading();
            }
        });
    }

    _mergeEmojiSet(event) {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
        const address = `30030:${event.pubkey}:${dTag}`;

        for (const tag of event.tags) {
            if (tag[0] === 'emoji' && tag[1] && tag[2]) {
                // 直接指定(own)を優先し、まだ無いショートコードだけ追加
                if (!this.emojis.has(tag[1])) {
                    this.emojis.set(tag[1], { url: tag[2], source: address });
                }
            }
        }
    }

    _finishLoading() {
        console.log(`✨ カスタム絵文字を ${this.emojis.size} 件読み込みました`);
        // ピッカーが開いていれば再描画（読み込みが遅れて反映される場合のため）
        this.renderPicker();
    }

    getEmojiList() {
        return Array.from(this.emojis.entries()).map(([shortcode, data]) => ({
            shortcode,
            url: data.url,
            source: data.source
        }));
    }

    getUrl(shortcode) {
        return this.emojis.get(shortcode)?.url;
    }

    getSource(shortcode) {
        return this.emojis.get(shortcode)?.source || null;
    }

    // ==========================
    // 🆕 ピッカーUI制御
    // ==========================

    _ensurePickerDom() {
        // すでにHTML側にあればそれを使う（emoable.htmlは既にこのマークアップを持っている）
        if (document.getElementById('emoji-picker-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'emoji-picker-modal';
        modal.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:2000; align-items:center; justify-content:center;';
        modal.innerHTML = `
          <div style="background:#fff; border-radius:8px; padding:0.75rem; max-width:320px; width:90%; max-height:60vh; overflow-y:auto;">
            <div style="display:flex; gap:0.5rem; margin-bottom:0.5rem;">
              <input id="cusemo-manual-char" type="text" maxlength="8" placeholder="enter an emoji🌞"
                     style="flex-grow:1; padding:0.4rem; border:1px solid #ddd; border-radius:4px;">
              <button id="cusemo-manual-send" style="min-width:2rem; background: #66b3ff;; color: #fff; border: none; border-radius: 4px; cursor: pointer;">OK</button>
            </div>
            <div id="emoji-picker-list" style="display:flex; flex-wrap:wrap; gap:6px;"></div>
          </div>`;
        document.body.appendChild(modal);
    }

    _bindManualInput() {
        const btn = document.getElementById('cusemo-manual-send');
        const input = document.getElementById('cusemo-manual-char');
        if (!btn || !input || btn.dataset.bound) return;

        btn.dataset.bound = 'true';
        const submit = () => {
            const val = input.value.trim();
            if (!val) return;
            this.selectManual(val);
            input.value = '';
        };
        btn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
        });
    }

    openPicker(onSelect) {
        this._ensurePickerDom();
        this._bindManualInput();
        this._pickerCallback = onSelect;
        this.renderPicker();
        const modal = document.getElementById('emoji-picker-modal');
        if (modal) modal.style.display = 'flex';
    }

    closePicker() {
        const modal = document.getElementById('emoji-picker-modal');
        if (modal) modal.style.display = 'none';
        this._pickerCallback = null;
    }

    renderPicker() {
        const list = document.getElementById('emoji-picker-list');
        if (!list) return;
        list.innerHTML = '';

        this.getEmojiList().forEach(({ shortcode, url }) => {
            const img = document.createElement('img');
            img.src = url;
            img.alt = shortcode;
            img.title = shortcode;
            img.style.cssText = 'width:1.6rem; height:1.6rem; cursor:pointer; object-fit:contain;';
            img.addEventListener('click', () => this.selectCustomEmoji(shortcode));
            list.appendChild(img);
        });
    }

    selectCustomEmoji(shortcode) {
        const data = this.emojis.get(shortcode);
        if (!data) return;
        this._pickerCallback?.({ type: 'custom', shortcode, url: data.url, source: data.source });
        this.closePicker();
    }

    selectManual(char) {
        this._pickerCallback?.({ type: 'manual', content: char });
        this.closePicker();
    }
}

// 画面全体のどこがクリックされても監視し、それが #emoji-picker-modal 自身なら閉じる
document.addEventListener('click', (e) => {
    // e.target.closest('#emoji-picker-modal') でもよいですが、今回は「背景自身」なので直接チェック
    const modal = document.getElementById('emoji-picker-modal');
    if (modal && e.target === modal) {
        modal.style.display = 'none';
        if (window.customEmojiManager) {
            window.customEmojiManager._pickerCallback = null;
        }
    }
});

// ESCキーでの閉じ処理
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('emoji-picker-modal');
        if (modal && modal.style.display !== 'none') {
            modal.style.display = 'none';
            if (window.customEmojiManager) {
                window.customEmojiManager._pickerCallback = null;
            }
        }
    }
});

window.customEmojiManager = new CustomEmojiManager();