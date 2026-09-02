/**
 * action-menu.js
 * 【責務】: 長押しメニュー・ふぁぼ/RT送信・引用/リプライ委譲・イエローライン演出
 * tweet.js / timeline.js / sendfav.js に散らばっていた同種ロジックの統合版。
 * ページごとの違いは constructor の config だけで吸収する。
 *
 * 🆕 長押しメニューのDOMを動的生成する場合（HTML側に #long-press-menu が無いページ、
 *    例: tweet.html / okkake.html）に限り、コンポーザーの有無で項目数・見た目を切り替える。
 *      - hasComposer() === false（例: okkake.html。引用/リプライを出せない）
 *          → 4項目・十字型の円形メニュー（ふぁぼ/RT/neventコピー/lumilumiで開く）
 *      - hasComposer() === true（例: tweet.html。引用/リプライをeHagakiに委譲できる）
 *          → 6項目の縦長リスト（ふぁぼ/RT/引用/リプライ/neventコピー/lumilumiで開く）
 *    HTML側に #long-press-menu が既にある場合は
 *    そのページ自身の静的マークアップ・CSSがそのまま使われるため、この分岐の影響を受けない。
 */
(function () {
    'use strict';

    class NostrActionMenu {
        constructor(config = {}) {
            this.menuId = config.menuId || 'long-press-menu';
            this.likeIconId = config.likeIconId || 'lp-like-icon';
            this.favMarkKey = config.favMarkStorageKey || 'favMark';
            this.likedClassName = config.likedClassName || 'event-liked';
            this.clientTag = config.clientTag || null;

            this.getRelayUrl = config.getRelayUrl
                || (() => window.relayManager?.url || '');
            this.signEvent = config.signEvent
                || ((ev) => window.nostrAuth.signEvent(ev));
            this.publish = config.publish
                || ((ev) => window.relayManager.publish(ev));
            this.requireWriteAccess = config.requireWriteAccess
                || (() => {
                    if (!window.nostrAuth?.canWrite?.()) {
                        alert('この操作には秘密鍵でのログインが必要です。');
                        if (typeof showAuthUI === 'function') showAuthUI();
                        return false;
                    }
                    return true;
                });
            this.onLiked = config.onLiked || ((eventId) => this._defaultOnLiked(eventId));

            // eHagakiが使えるページかどうか（quote/reply項目の出し分けと、
            // 長押しメニューを円形/リストどちらで生成するかの判定に使用）
            this.hasComposer = config.hasComposer ?? (() => !!window.ehagakiManager?.open);

            this._attached = new WeakMap();
            this._ensureMenuDom();
        }

        /**
         * 現在有効な kind:7 送信モードを返す。
         * 
         * localStorage の 'kind7Mode' はページを跨いで共有される値のため、
         * 'picker'（カスタム絵文字選択）が保存されていても、
         * このページに customEmojiManager（cusemo.js）が読み込まれていなければ
         * 機能を提供できない。
         * その場合は「設定UIが無いページでも安全に動く」よう 'fixed' にフォールバックする。
         * 判定にDOM（#kind-7-mode-select等）ではなく window.customEmojiManager の
         * 存在を使うのは、ehagakiManager と同じ「グローバルの有無でページの機能差を
         * 判定する」既存パターンに合わせるため。
         *
         * @returns {'fixed'|'picker'}
         */
        _getKind7Mode() {
            const saved = localStorage.getItem('kind7Mode') || 'fixed';
            if (saved === 'picker' && !window.customEmojiManager?.openPicker) {
                return 'fixed';
            }
            return saved;
        }

        // ---------- ふぁぼ ----------
        async sendLike(originalEvent) {
            if (!this.requireWriteAccess()) return;

            const mode = this._getKind7Mode(); // 🆕 直接localStorageを見ない

            if (mode === 'picker' && window.customEmojiManager) {
                window.customEmojiManager.openPicker((selection) => {
                    this._publishLike(originalEvent, selection);
                });
                return;
            }

            await this._publishLike(originalEvent, null);
        }

        // 🆕 実際の送信処理を切り出し
        async _publishLike(originalEvent, selection) {
            try {
                let content;
                const extraTags = [];

                if (selection?.type === 'custom') {
                    content = `:${selection.shortcode}:`;
                    const emojiTag = ['emoji', selection.shortcode, selection.url];
                    if (selection.source) emojiTag.push(selection.source); // NIP-30拡張: emoji-set-address
                    extraTags.push(emojiTag);
                } else if (selection?.type === 'manual') {
                    content = selection.content;
                } else {
                    content = localStorage.getItem(this.favMarkKey) || '+';
                }

                const event = {
                    kind: 7,
                    content,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['e', originalEvent.id], ['p', originalEvent.pubkey], ...extraTags]
                };
                const signed = await this.signEvent(event);
                await this.publish(signed);
                this.onLiked(originalEvent.id, signed);
                alert('ふぁぼった!');
            } catch (err) {
                console.error('ふぁぼ失敗:', err);
                alert('ふぁぼれませんでした: ' + err.message);
            }
        }

        _defaultOnLiked(eventId) {
            // dataStoreがあれば正式に記録（timeline.jsの再描画に反映される）
            if (window.dataStore?.markAsLikedByMe) {
                window.dataStore.markAsLikedByMe(eventId);
            }
            // 今画面にある要素は即座にハイライト（tweet.html/okkake.htmlのようにdataStoreが無くても効く）
            document.querySelectorAll(`[data-id="${eventId}"], #${CSS.escape(eventId)}`)
                .forEach(el => el.classList.add(this.likedClassName));
        }

        // ---------- RT ----------
        async sendRepost(originalEvent) {
            if (!confirm('RTしますか？')) return;
            if (!this.requireWriteAccess()) return;

            const isTextNote = originalEvent.kind === 1;
            const repostEvent = {
                kind: isTextNote ? 6 : 16,
                content: '',
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['e', originalEvent.id, this.getRelayUrl()],
                    ['p', originalEvent.pubkey]
                ]
            };
            if (!isTextNote) repostEvent.tags.push(['k', String(originalEvent.kind)]);
            if (this.clientTag) repostEvent.tags.push(this.clientTag);

            try {
                const signed = await this.signEvent(repostEvent);
                await this.publish(signed);
                console.log('RT成功');
            } catch (err) {
                console.error('RT失敗:', err);
                alert('RTに失敗しました: ' + err.message);
            }
        }

        // ---------- nevent系 ----------
        buildNevent(ev) {
            return window.NostrTools.nip19.neventEncode({
                id: ev.id,
                author: ev.pubkey,
                kind: ev.kind,
                relays: this.getRelayUrl() ? [this.getRelayUrl()] : []
            });
        }

        async copyNevent(ev) {
            try {
                await navigator.clipboard.writeText(this.buildNevent(ev));
                alert('neventをコピーしました');
            } catch (e) {
                alert('コピーに失敗しました');
            }
        }

        openLumilumi(ev) {
            window.open(`https://lumilumi.app/${this.buildNevent(ev)}`, '_blank');
        }

        // ---------- 引用/リプライ（eHagakiがあれば委譲、無ければフォールバック） ----------
        async quote(ev) {
            if (window.ehagakiManager?.open) {
                if (!this.requireWriteAccess()) return;
                window.ehagakiManager.open({
                    quotes: [this.buildNevent(ev)],
                    quoteEvents: [ev],
                    reply: null
                });
            } else {
                await this.copyNevent(ev);
            }
        }

        async reply(ev) {
            if (window.ehagakiManager?.open) {
                if (!this.requireWriteAccess()) return;
                const nevent = this.buildNevent(ev);
                if (ev.kind === 42) {
                    const channelTag = ev.tags?.find(t => t[0] === 'e' && t[3] === 'root')
                        || ev.tags?.find(t => t[0] === 'e');
                    window.ehagakiManager.openReplyToChannel?.(
                        nevent, channelTag?.[1] || null, channelTag?.[2] || null, ev
                    );
                } else {
                    window.ehagakiManager.open({ reply: nevent, quotes: [], replyEvent: ev });
                }
            } else {
                this.openLumilumi(ev);
            }
        }

        async execute(action, ev) {
            switch (action) {
                case 'like': return this.sendLike(ev);
                case 'repost': return this.sendRepost(ev);
                case 'quote': return this.quote(ev);
                case 'reply': return this.reply(ev);
                case 'copy': return this.copyNevent(ev);
                case 'lumilumi': return this.openLumilumi(ev);
            }
        }

        // ---------- DOM要素への長押し紐付け ----------
        attach(element, event) {
            if (!element || !event) return;
            this._attached.get(element)?.detach();
            const handler = this._createHandler(event);
            handler.attach(element);
            this._attached.set(element, handler);
        }

        detach(element) {
            this._attached.get(element)?.detach();
            this._attached.delete(element);
        }

        _createHandler(event) {
            let timer;
            let startPos = { x: 0, y: 0 };
            const THRESHOLD = 10;
            const self = this;

            const triggerAction = () => {
                const menu = document.getElementById(self.menuId);
                if (!menu) return;

                const likeDisplay = document.getElementById(self.likeIconId);
                if (likeDisplay) {
                    const mode = self._getKind7Mode(); // 🆕
                    likeDisplay.textContent = mode === 'picker'
                        ? '🙂'
                        : (localStorage.getItem(self.favMarkKey) || '⭐');
                }

                // 🆕 円形メニュー（circularクラス付き＝動的生成された4項目メニュー）かどうかで
                // 配置ロジックと表示/非表示の切り替え方法を分ける。
                // 静的HTML側で用意されたメニュー（index2.html等）はこのクラスを持たないため、
                // 従来どおりのリスト用ロジック（クランプ配置 + display切替）がそのまま適用される。
                const isCircular = menu.classList.contains('circular');

                if (isCircular) {
                    // 円形メニュー：指の位置にそのままコンテナを置き、
                    // CSS側のtransformでオフセット（十字の中心を指からずらす）を行う。
                    menu.style.left = `${startPos.x}px`;
                    menu.style.top = `${startPos.y}px`;
                    menu.classList.add('is-open');
                } else {
                    // リストメニュー：画面端でクランプして配置する（従来ロジック）
                    const menuWidth = menu.offsetWidth || 190;
                    const x = Math.min(Math.max(8, startPos.x), window.innerWidth - menuWidth - 8);
                    const y = Math.min(startPos.y - 20, window.innerHeight - 260);
                    menu.style.left = `${x}px`;
                    menu.style.top = `${Math.max(8, y)}px`;
                    menu.style.display = 'flex';
                }

                menu.querySelectorAll('.lp-item').forEach(i => i.classList.remove('selected'));
                menu.querySelector('[data-action="like"]')?.classList.add('selected');

                const closeMenu = (e) => {
                    if (e && e.target && menu.contains(e.target)) return;
                    if (isCircular) {
                        menu.classList.remove('is-open');
                    } else {
                        menu.style.display = 'none';
                    }
                    document.removeEventListener('pointerdown', closeMenu);
                    document.removeEventListener('keydown', handleKeyDown);
                    menu.onclick = null;
                };

                const handleKeyDown = (e) => {
                    if (e.key === 'Enter') {
                        const selected = menu.querySelector('.lp-item.selected');
                        if (selected) self.execute(selected.getAttribute('data-action'), event);
                        closeMenu();
                    } else if (e.key === 'Escape') closeMenu();
                };

                menu.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const item = e.target.closest('.lp-item');
                    const action = item?.getAttribute('data-action');
                    if (action) { self.execute(action, event); closeMenu(); }
                };

                setTimeout(() => {
                    document.addEventListener('pointerdown', closeMenu);
                    document.addEventListener('keydown', handleKeyDown);
                }, 100);
            };

            const start = (e) => {
                const touch = e.touches ? e.touches[0] : e;
                startPos = { x: touch.clientX, y: touch.clientY };
                timer = setTimeout(triggerAction, 400);
            };
            const move = (e) => {
                if (!timer) return;
                const touch = e.touches ? e.touches[0] : e;
                if (Math.hypot(touch.clientX - startPos.x, touch.clientY - startPos.y) > THRESHOLD) {
                    clearTimeout(timer); timer = null;
                }
            };
            const cancel = () => { clearTimeout(timer); timer = null; };

            return {
                element: null,
                attach(el) {
                    this.element = el;
                    el.addEventListener('mousedown', start);
                    el.addEventListener('touchstart', start, { passive: true });
                    el.addEventListener('mousemove', move);
                    el.addEventListener('touchmove', move, { passive: true });
                    el.addEventListener('mouseup', cancel);
                    el.addEventListener('mouseleave', cancel);
                    el.addEventListener('touchend', cancel);
                    el.addEventListener('touchcancel', cancel);
                    el._lpHandlers = { start, move, cancel };
                    el.classList.add('long-pressable');
                },
                detach() {
                    const el = this.element;
                    if (!el || !el._lpHandlers) return;
                    const { start, move, cancel } = el._lpHandlers;
                    el.removeEventListener('mousedown', start);
                    el.removeEventListener('touchstart', start);
                    el.removeEventListener('mousemove', move);
                    el.removeEventListener('touchmove', move);
                    el.removeEventListener('mouseup', cancel);
                    el.removeEventListener('mouseleave', cancel);
                    el.removeEventListener('touchend', cancel);
                    el.removeEventListener('touchcancel', cancel);
                    delete el._lpHandlers;
                    clearTimeout(timer);
                }
            };
        }

        // ---------- メニューDOM/CSSの自動注入 ----------
        /**
         * 長押しメニューのDOM・CSSを生成する。
         *
         * 【分岐】
         * すでにHTML側に #long-press-menu がある場合（index2.html / lite.html / kit-ten.html など）は
         * そのページ固有の静的マークアップ・CSSをそのまま使うため、ここでは何もしない。
         *
         * 動的生成が必要なページ（tweet.html / okkake.html 等）では、hasComposer() の結果によって
         * 項目数と見た目を切り替える:
         *   - hasComposer() === false（例: okkake.html。eHagakiが無く引用/リプライを出せない）
         *       → 4項目・十字型の円形メニュー（ふぁぼ/RT/neventコピー/lumilumiで開く）
         *   - hasComposer() === true（例: tweet.html。eHagakiで引用/リプライが使える）
         *       → 6項目の縦長リスト（ふぁぼ/RT/引用/リプライ/neventコピー/lumilumiで開く）
         */
        _ensureMenuDom() {
            if (document.getElementById(this.menuId)) return; // 既にHTML側にあればそれを使う

            const showComposer = this.hasComposer();
            const isCircular = !showComposer; // コンポーザー無し＝4項目＝円形

            const style = document.createElement('style');
            style.id = 'nostr-action-menu-style';
            style.textContent = `
                /* ---- 縦長リスト形式（コンポーザーあり・6項目）---- */
                .lp-menu:not(.circular) { display: none; position: fixed; flex-direction: column; background: #fff;
                    border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); padding: 0.35rem;
                    z-index: 10000; min-width: 170px; overflow: hidden; }
                .lp-menu:not(.circular) .lp-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.6rem;
                    border-radius: 6px; font-size: 0.85rem; color: #444; cursor: pointer; }
                .lp-menu:not(.circular) .lp-item:hover, .lp-menu:not(.circular) .lp-item.selected { background-color: #f0eefe; }
                .lp-menu:not(.circular) .lp-item span:first-child { width: 1.2rem; text-align: center; }

                /* ---- 十字型・円形メニュー（コンポーザーなし・4項目）---- */
                .lp-menu.circular {
                    display: none;
                    position: fixed;
                    z-index: 10000;
                    width: 0;
                    height: 0;
                    pointer-events: none;
                    transform: translate(-1.5rem, 5rem);
                }
                .lp-menu.circular.is-open {
                    display: block;
                    animation: nostr-lp-menu-pop 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                }
                @keyframes nostr-lp-menu-pop {
                    from { opacity: 0; transform: translate(-1.5rem, 5rem) scale(0.5); }
                    to { opacity: 1; transform: translate(-1.5rem, 5rem) scale(1); }
                }
                .lp-menu.circular .lp-item {
                    position: absolute;
                    width: 3rem;
                    height: 3rem;
                    background: #ffffff;
                    border-radius: 999px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.5rem;
                    cursor: pointer;
                    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
                    border: none;
                    transition: all 0.2s ease;
                    user-select: none;
                    pointer-events: auto;
                }
                .lp-menu.circular .lp-item svg { width: 1.5rem; height: 1.5rem; display: block; }
                .lp-menu.circular .lp-item[data-action="like"] { top: -3rem; left: 0; color: #ffcc66;
                    font-family: "Apple Color Emoji", "Segoe UI Emoji", sans-serif; font-size: 1.25rem; line-height: 1; }
                .lp-menu.circular .lp-item[data-action="repost"] { top: 0; left: -3rem; color: #66b3ff; }
                .lp-menu.circular .lp-item[data-action="copy"] { top: 0; left: 3rem; color: #666666; }
                .lp-menu.circular .lp-item[data-action="lumilumi"] { top: 3rem; left: 0; color: #66b3ff; }
                .lp-menu.circular .lp-item.selected { background: #fff; transform: scale(1.06); }
                .long-pressable { cursor: default; transition: background-color 0.15s ease; }
                .long-pressable:active { background-color: rgba(124,111,224,0.08); }
                .event-liked, .is-favored { border-right: 5px solid #ffeb3b; }
            `;
            document.head.appendChild(style);

            const menu = document.createElement('div');
            menu.id = this.menuId;

            if (isCircular) {
                // ---- 円形メニュー（4項目: ふぁぼ/RT/neventコピー/lumilumiで開く） ----
                // コンポーザーが無い（引用/リプライを出せない）ページ向け。okkake.html 想定。
                menu.className = 'lp-menu circular';
                menu.innerHTML = `
                    <div class="lp-item" data-action="like" id="${this.likeIconId}" title="ふぁぼ"></div>

                    <div class="lp-item" data-action="repost" title="RT">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                            stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="17 1 21 5 17 9"></polyline>
                            <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                            <polyline points="7 23 3 19 7 15"></polyline>
                            <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                        </svg>
                    </div>

                    <div class="lp-item" data-action="copy" title="neventコピー">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                            stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 21c3 0 7-1 7-8V5H4v8h4c0 2-1 4-4 4v4zm13 0c3 0 7-1 7-8V5h-6v8h4c0 2-1 4-4 4v4z"></path>
                        </svg>
                    </div>

                    <div class="lp-item" data-action="lumilumi" title="lumilumiで開く">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                            stroke-linecap="round" stroke-linejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                            <polyline points="15 3 21 3 21 9"></polyline>
                            <line x1="10" y1="14" x2="21" y2="3"></line>
                        </svg>
                    </div>
                `;
            } else {
                // ---- 縦長リスト（6項目: ふぁぼ/RT/引用/リプライ/neventコピー/lumilumiで開く） ----
                // コンポーザーがある（引用/リプライをeHagakiに委譲できる）ページ向け。tweet.html 想定。
                menu.className = 'lp-menu';
                menu.innerHTML = `
                    <div class="lp-item" data-action="like"><span id="${this.likeIconId}">⭐</span><span>ふぁぼ</span></div>
                    <div class="lp-item" data-action="repost"><span>🔁</span><span>RT</span></div>
                    <div class="lp-item" data-action="quote"><span>💬</span><span>引用</span></div>
                    <div class="lp-item" data-action="reply"><span>↩️</span><span>リプライ</span></div>
                    <div class="lp-item" data-action="copy"><span>📋</span><span>neventをコピー</span></div>
                    <div class="lp-item" data-action="lumilumi"><span>🔗</span><span>lumilumiで開く</span></div>
                `;
            }

            document.body.appendChild(menu);
        }
    }

    window.NostrActionMenu = NostrActionMenu;
})();