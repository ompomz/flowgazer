/**
 * action-menu.js
 * 【責務】: 長押しメニュー・ふぁぼ/RT送信・引用/リプライ委譲・イエローライン演出
 * tweet.js / timeline.js / sendfav.js に散らばっていた同種ロジックの統合版。
 * ページごとの違いは constructor の config だけで吸収する。
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

            // eHagakiが使えるページかどうか（quote/reply項目の出し分けに使用）
            this.hasComposer = config.hasComposer ?? (() => !!window.ehagakiManager?.open);

            this._attached = new WeakMap();
            this._ensureMenuDom();
        }

        // ---------- ふぁぼ ----------
        async sendLike(originalEvent) {
            if (!this.requireWriteAccess()) return;
            try {
                const favMark = localStorage.getItem(this.favMarkKey) || '+';
                const event = {
                    kind: 7,
                    content: favMark,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['e', originalEvent.id], ['p', originalEvent.pubkey]]
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
                    likeDisplay.textContent = localStorage.getItem(self.favMarkKey) || '⭐';
                }

                const menuWidth = menu.offsetWidth || 190;
                const x = Math.min(Math.max(8, startPos.x), window.innerWidth - menuWidth - 8);
                const y = Math.min(startPos.y - 20, window.innerHeight - 260);
                menu.style.left = `${x}px`;
                menu.style.top = `${Math.max(8, y)}px`;
                menu.style.display = 'flex';

                menu.querySelectorAll('.lp-item').forEach(i => i.classList.remove('selected'));
                menu.querySelector('[data-action="like"]')?.classList.add('selected');

                const closeMenu = (e) => {
                    if (e && e.target && menu.contains(e.target)) return;
                    menu.style.display = 'none';
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
        _ensureMenuDom() {
            if (document.getElementById(this.menuId)) return; // 既にHTML側にあればそれを使う

            const style = document.createElement('style');
            style.id = 'nostr-action-menu-style';
            style.textContent = `
                .lp-menu { display: none; position: fixed; flex-direction: column; background: #fff;
                    border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); padding: 0.35rem;
                    z-index: 10000; min-width: 170px; overflow: hidden; }
                .lp-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.6rem;
                    border-radius: 6px; font-size: 0.85rem; color: #444; cursor: pointer; }
                .lp-item:hover, .lp-item.selected { background-color: #f0eefe; }
                .lp-item span:first-child { width: 1.2rem; text-align: center; }
                .long-pressable { cursor: default; transition: background-color 0.15s ease; }
                .long-pressable:active { background-color: rgba(124,111,224,0.08); }
                .event-liked, .is-favored { border-right: 5px solid #ffeb3b; }
            `;
            document.head.appendChild(style);

            const showComposer = this.hasComposer();
            const menu = document.createElement('div');
            menu.id = this.menuId;
            menu.className = 'lp-menu';
            menu.innerHTML = `
                <div class="lp-item" data-action="like"><span id="${this.likeIconId}">⭐</span><span>ふぁぼ</span></div>
                <div class="lp-item" data-action="repost"><span>🔁</span><span>RT</span></div>
                ${showComposer ? `<div class="lp-item" data-action="quote"><span>💬</span><span>引用</span></div>` : ''}
                ${showComposer ? `<div class="lp-item" data-action="reply"><span>↩️</span><span>リプライ</span></div>` : ''}
                <div class="lp-item" data-action="copy"><span>📋</span><span>neventをコピー</span></div>
                <div class="lp-item" data-action="lumilumi"><span>🔗</span><span>lumilumiで開く</span></div>
            `;
            document.body.appendChild(menu);
        }
    }

    window.NostrActionMenu = NostrActionMenu;
})();