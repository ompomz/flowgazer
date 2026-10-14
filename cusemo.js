// cusemo.js

class CustomEmojiManager {
    constructor() {
        // shortcode -> { url, source }
        // source: 直接指定(own)なら null、30030由来なら "30030:pubkey:d" のアドレス文字列
        this.emojis = new Map();
        this._pendingSetRefs = [];

        // ピッカーからの選択結果を受け取るコールバック
        this._pickerCallback = null;

        // 🆕 ピッカー用のキーボード操作ハンドラを登録
        this._bindPickerKeyboard();
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
        // すでにHTML側にあればそれを使う
        if (document.getElementById('emoji-picker-modal')) return;

        // 🆕 アプリのダークモード変数（--panel, --txt, --border等）に完全連動するスタイル
        const style = document.createElement('style');
        style.id = 'cusemo-picker-style';
        style.textContent = `
            .cusemo-picker-item {
                border: 2px solid transparent;
                border-radius: 4px;
                box-sizing: border-box;
                cursor: pointer;
            }
            .cusemo-picker-item.cusemo-selected {
                background-color: #f0eefe;
            }

            /* ダークモード時：既存のCSS変数に合わせる */
            body.dark-mode #emoji-picker-modal > div {
                background: var(--panel, #1b263b) !important;
                color: var(--txt, #ccc) !important;
                border: 1px solid var(--border, #444) !important;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
            }
            body.dark-mode #cusemo-manual-char {
                background: var(--bg, #132639) !important;
                color: var(--txt, #ccc) !important;
                border-color: var(--border, #444) !important;
            }
            body.dark-mode #cusemo-manual-send {
                color: #132639 !important; /* アクセントカラーが明るい場合の文字色調整 */
                font-weight: bold;
            }
            body.dark-mode .cusemo-picker-item.cusemo-selected {
                background-color: rgba(240, 173, 78, 0.2) !important; /* アクセントカラーを薄く敷く例 */
            }
        `;
        document.head.appendChild(style);

        const modal = document.createElement('div');
        modal.id = 'emoji-picker-modal';
        modal.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:2000; align-items:center; justify-content:center;';

        modal.innerHTML = `
          <div style="border-radius:8px; padding:0.75rem; max-width:320px; width:90%; max-height:60vh; overflow-y:auto; background:#fff; color:#333; box-shadow: 0 4px 16px rgba(0,0,0,0.2);">
            <div style="display:flex; gap:0.5rem; margin-bottom:0.5rem;">
              <input id="cusemo-manual-char" type="text" maxlength="8" placeholder="enter an emoji🌞"
                     style="flex-grow:1; padding:0.4rem; border:1px solid #ddd; border-radius:4px;">
              <button id="cusemo-manual-send" style="min-width:2rem; background: #66b3ff; color: #fff; border: none; border-radius: 4px; cursor: pointer;">OK</button>
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
            if (val) {
                // 入力欄に文字が入っているときは、入力された文字を優先して送信
                this.selectManual(val);
                input.value = '';
            } else {
                // 空欄のときは、現在選択されているアイテム（左上の★など）のクリックを発火
                const selectedItem = document.querySelector('#emoji-picker-modal .cusemo-picker-item.cusemo-selected');
                if (selectedItem) {
                    selectedItem.click();
                }
            }
        };

        btn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.isComposing) return; // IME変換中のEnterはスルー
                submit();
            }
        });
    }

    // ピッカー表示中のキーボード操作（矢印キーで移動、Enterで決定）
    _bindPickerKeyboard() {
        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('emoji-picker-modal');
            if (!modal || modal.style.display === 'none') return;

            // IME変換中や、入力欄にフォーカスがあるときはグローバル操作を無視
            if (e.isComposing) return;
            const manualInput = document.getElementById('cusemo-manual-char');
            if (document.activeElement === manualInput || e.target === manualInput) return;

            const items = Array.from(modal.querySelectorAll('.cusemo-picker-item'));
            if (items.length === 0) return;

            let currentIndex = items.findIndex(el => el.classList.contains('cusemo-selected'));
            if (currentIndex === -1) currentIndex = 0;

            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                items[currentIndex]?.click();
            } else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
                e.preventDefault();
                items[currentIndex].classList.remove('cusemo-selected');

                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    currentIndex = (currentIndex + 1) % items.length;
                } else {
                    currentIndex = (currentIndex - 1 + items.length) % items.length;
                }
                items[currentIndex].classList.add('cusemo-selected');
            } else if (e.key === 'Escape') {
                this.closePicker();
            }
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

        const inputElem = document.getElementById('kind-7-content-input');
        const favMark = (inputElem && inputElem.value) || localStorage.getItem('favMark') || '+';

        // 🆕 先頭の「固定ふぁぼマーク」（初期状態で cusemo-selected を付与してフォーカス状態にする）
        const favMarkItem = document.createElement('div');
        favMarkItem.className = 'cusemo-picker-item cusemo-selected';
        favMarkItem.textContent = favMark;
        favMarkItem.title = 'ふぁぼマーク: ' + favMark;
        favMarkItem.style.cssText =
            'width:1.6rem; height:1.6rem; display:flex; align-items:center; justify-content:center; ' +
            'font-size:1.1rem; cursor:pointer; border:none; border-radius:4px; box-sizing:border-box;';
        favMarkItem.addEventListener('click', () => this.selectManual(favMark));
        list.appendChild(favMarkItem);

        this.getEmojiList().forEach(({ shortcode, url }) => {
            const img = document.createElement('img');
            img.className = 'cusemo-picker-item';
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
    const modal = document.getElementById('emoji-picker-modal');
    if (modal && e.target === modal) {
        modal.style.display = 'none';
        if (window.customEmojiManager) {
            window.customEmojiManager._pickerCallback = null;
        }
    }
});

window.customEmojiManager = new CustomEmojiManager();
