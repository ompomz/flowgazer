/**
 * timeline.js
 * 【責務】: DOM要素の生成とレンダリング・適切なクリーンアップ
 */

// ===== Timeline クラス =====

class Timeline {
    constructor(containerElement, options = {}) {
        this.container = containerElement;
        this.currentTab = 'global';
        this.activeElements = new Set();
        this.channelNameMap = window.channelNameMap || new Map();
        this.filterOptions = {
            flowgazerOnly: false,
            authors: null,
            showKind42: window.app?.showKind42 || false
        };

        // 🆕 タイムスタンプ表示形式のカスタマイズ用フック。
        // 未指定時は従来通り HH:MM:SS 固定（メインタイムライン向け）。
        // プロフィール投稿一覧のように長期間の投稿が並ぶページでは、
        // 呼び出し側から日付付きフォーマッタを渡せるようにする。
        this.timestampFormatter = options.timestampFormatter || null;

        const canvas = document.createElement('canvas');
        this.measureCtx = canvas.getContext('2d');
        this.measureCtx.font = '14px sans-serif';

        this.maxNameWidthPx = this.measureCtx.measureText("[00:00:000]").width;
        this.maxContentWidthPx = 0;
    }

    // ========================================
    // 自動更新状態の取得
    // ========================================

    /**
     * 自動更新が有効かどうかを返す。
     * app.js への直接依存を1箇所に集約するためのヘルパー。
     * app が存在しない（テスト等）場合は true を返す。
     * @returns {boolean}
     * @private
     */
    _isAutoUpdate() {
        return window.app?.isAutoUpdate ?? true;
    }

    // ========================================
    // タブ管理
    // ========================================

    switchTab(tab) {
        this.currentTab = tab;
        this.refresh(true);
    }

    setFilter(options) {
        this.filterOptions = { ...this.filterOptions, ...options };
        this.refresh();
    }

    // ========================================
    // レンダリング
    // ========================================

    /**
     * タイムラインを再描画する。
     *
     * @param {boolean} force - true のとき isAutoUpdate を無視して強制描画する。
     *   - タブ切り替え・renderNow（即時描画）など、ユーザー操作起点の場合は true を渡す。
     *   - scheduleRender（遅延描画）経由の場合は app.js 側コールバックで isAutoUpdate を
     *     判定済みのため、ここでは常に true として呼ばれる。
     */
    refresh(force = false) {
        if (!force && !this._isAutoUpdate()) {
            console.log('⏸️ 自動更新OFF: 描画スキップ');
            return;
        }

        // 既存の要素をすべてクリーンアップ
        this.destroyAllElements();

        // ViewStateから表示対象を取得
        const events = window.viewState.getVisibleEvents(this.currentTab, this.filterOptions);

        // 描画
        events.forEach(event => {
            const element = this.createEventElement(event);
            if (element) {
                this.container.appendChild(element);
                this.activeElements.add(element);
            }
        });

        console.log(`📜 タイムライン描画: ${events.length}件 (${this.currentTab})`);
    }

    /**
     * すべてのアクティブな要素を破棄
     */
    destroyAllElements() {
        this.activeElements.forEach(element => {
            if (element.destroy) {
                element.destroy();
            }
        });
        this.activeElements.clear();

        // コンテナをクリア
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }
    }

    // ========================================
    // イベント要素作成
    // ========================================

    createEventElement(event) {
        switch (event.kind) {
            case 1:
                return this.createPostElement(event);
            case 6:
            case 16:
                return this.createRepostElement(event);
            case 7:
                return this.createLikeElement(event);
            case 42:
                return this.createChannelMessageElement(event);
            default:
                return null;
        }
    }

    createExpandableContent(event) {
        const fullContent = event.content || '';
        const lineCount = (fullContent.match(/\n/g) || []).length;

        // 1. 判定用の「実質的な長さ」を計算（識別子を無視）
        const virtualContent = fullContent.replace(/(https?:\/\/[^\s]+|nostr:[a-z0-9]+)/gi, 'L');

        const hasMedia = /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|mp4)/i.test(fullContent);

        // 判定（仮想的な長さが100未満かつ改行が少なければそのまま）
        if (virtualContent.length < 100 && lineCount < 4 && !hasMedia) {
            return this.createContent(event);
        }

        const threshold = 120;
        // 仮想的な長さで「長いかどうか」を決める
        const isPotentiallyLong = virtualContent.length > threshold || lineCount >= 4;

        if (!isPotentiallyLong) {
            return this.createContent(event);
        }

        // 2. 短縮版のテキスト作成
        let shortText = fullContent;
        if (fullContent.length > threshold) {
            shortText = fullContent.substring(0, threshold);
        }

        const isLong = shortText.length < fullContent.length;
        if (!isLong) return this.createContent(event);

        // --- DOM構築 ---
        const wrapper = document.createElement('span');
        wrapper.className = 'expandable-content';

        const render = (text) => {
            const tempEvent = { ...event, content: text };
            return this.createContent(tempEvent);
        };

        let currentContentNode = render(shortText + "...");
        wrapper.appendChild(currentContentNode);

        const toggleLink = document.createElement('span');
        toggleLink.textContent = ' [全文を表示]';
        toggleLink.className = 'npub-link';
        toggleLink.style.cursor = 'pointer';

        toggleLink.onclick = (e) => {
            e.stopPropagation();
            const isExpanded = toggleLink.textContent.includes('とじる');
            const newNode = render(isExpanded ? shortText + "..." : fullContent);
            currentContentNode.replaceWith(newNode);
            currentContentNode = newNode;
            toggleLink.textContent = isExpanded ? ' [全文を表示]' : ' [とじる]';
        };

        wrapper.appendChild(toggleLink);
        return wrapper;
    }

    /**
     * kind:42 (チャンネルメッセージ) 要素
     */
    createChannelMessageElement(event) {
        const li = document.createElement('li');
        li.className = 'event event-channel';
        li.id = event.id;

        if (window.dataStore.isLikedByMe(event.id)) {
            li.classList.add('event-liked');
        }

        // 🆕 共通アクションメニューの紐付け
        if (window.actionMenu) {
            window.actionMenu.attach(li, event);
        }

        // destroy メソッド
        li.destroy = () => {
            if (window.actionMenu) {
                window.actionMenu.detach(li);
            }
            li.remove();
        };

        // メタデータ
        li.appendChild(this.createMetadata(event));

        // channelId と relay ヒントを e タグから取得
        const channelTag = event.tags?.find(t => t[0] === 'e' && t[3] === 'root')
            || event.tags?.find(t => t[0] === 'e');
        const channelId = channelTag?.[1] || null;
        const relayHint = channelTag?.[2] || null;

        li.appendChild(this.createChannelBadge(channelId, relayHint));

        if (this._shouldBreakBeforeContent(event)) {
            li.appendChild(document.createElement('br'));
        }

        const content = this.createContent(event);
        li.appendChild(content);

        return li;
    }

    /**
     * チャンネルバッジを生成する。
     */
    createChannelBadge(channelId, relayHint) {
        const badge = document.createElement('span');
        badge.className = 'channel-badge';
        badge.style.cssText =
            'color: #B3A1FF; font-weight: normal; cursor: text; text-decoration: none; text-underline-offset: 2px;';

        if (channelId) {
            badge.dataset.channelId = channelId;
            if (relayHint) badge.dataset.channelRelay = relayHint;
        }

        if (channelId && this.channelNameMap instanceof Map && this.channelNameMap.has(channelId)) {
            badge.textContent = `*${this.channelNameMap.get(channelId)} `;
        } else {
            badge.textContent = '*kind:42 ';
            if (channelId) {
                window.app?.ensureChannelResolved?.(channelId, relayHint);
            }
        }

        if (channelId) {
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                window.app?.openChannelInEhagaki?.(channelId, relayHint);
            });
        }

        return badge;
    }

    updateChannelBadge(channelId, name) {
        if (!channelId) return;
        const selector = `.-badgchannele[data-channel-id="${CSS.escape(channelId)}"]`;
        this.container.querySelectorAll(selector).forEach(badge => {
            badge.textContent = `*${name} `;
        });
    }

    resolveName(pubkey) {
        let name = window.dataStore.getDisplayName(pubkey);

        const ctx = this.measureCtx;
        const maxWidth = this.maxNameWidthPx;

        let result = "";
        let width = 0;
        const ellipsis = "…";
        const ellipsisWidth = ctx.measureText(ellipsis).width;

        for (const char of name) {
            const charWidth = ctx.measureText(char).width;

            if (width + charWidth + ellipsisWidth > maxWidth) {
                result += ellipsis;
                return `@${result}`;
            }

            result += char;
            width += charWidth;
        }

        return `@${result}`;
    }

    /**
     * kind:1 (投稿) 要素
     */
    createPostElement(event) {
        const li = document.createElement('li');
        li.className = 'event event-post';
        li.id = event.id;

        if (window.dataStore.isLikedByMe(event.id)) {
            li.classList.add('event-liked');
        }

        // 🆕 共通アクションメニューの紐付け
        if (window.actionMenu) {
            window.actionMenu.attach(li, event);
        }

        // destroy メソッド
        li.destroy = () => {
            if (window.actionMenu) {
                window.actionMenu.detach(li);
            }
            li.remove();
        };

        // メタデータ
        li.appendChild(this.createMetadata(event));

        const replyTag = event.tags.find(tag => tag[0] === "p");
        if (replyTag) {
            const targetPubkey = replyTag[1];

            const replySpan = document.createElement('span');
            replySpan.className = 'reply-indicator';
            replySpan.appendChild(document.createTextNode(' '));

            const targetName = this.resolveName(targetPubkey);
            const targetLink = this.createAuthorLink(targetPubkey);
            targetLink.textContent = targetName;
            replySpan.appendChild(targetLink);

            li.appendChild(replySpan);
            li.appendChild(document.createTextNode(' '));
        }

        if (this._shouldBreakBeforeContent(event)) {
            li.appendChild(document.createElement('br'));
        }

        const cwTag = event.tags.find(tag => tag[0] === "content-warning");

        if (cwTag) {
            const reason = cwTag[1] ? `：${cwTag[1]}` : "";

            const cwLink = document.createElement('a');
            cwLink.href = '#';
            cwLink.className = 'nostr-ref';
            cwLink.textContent = `⚠️${reason} [内容を表示]`;

            cwLink.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();

                const expandable = this.createExpandableContent(event);
                cwLink.replaceWith(expandable);
            };

            li.appendChild(cwLink);

        } else {
            const expandable = this.createExpandableContent(event);
            li.appendChild(expandable);
        }

        if (this.currentTab === 'myposts') {
            const badge = this.createReactionBadge(event.id);
            if (badge) li.appendChild(badge);
        }

        return li;
    }

    createInlineRTElement(originalEvent) {
        const span = document.createElement('span');
        span.className = 'inline-rt';

        const prefix = document.createElement('span');
        prefix.textContent = 'RT: ';
        prefix.className = 'repost-prefix';
        span.appendChild(prefix);

        const author = this.createAuthorLink(originalEvent.pubkey);
        span.appendChild(author);

        span.appendChild(document.createTextNode(' > '));

        const content = this.createExpandableContent(originalEvent);
        span.appendChild(content);

        return span;
    }

    /**
     * kind:6（リポスト）要素
     */
    createRepostElement(event) {
        const li = document.createElement('li');
        li.className = 'event event-repost';

        // 🆕 共通アクションメニューの紐付け
        if (window.actionMenu) {
            window.actionMenu.attach(li, event);
        }

        li.destroy = () => {
            if (window.actionMenu) {
                window.actionMenu.detach(li);
            }
            li.remove();
        };

        li.appendChild(this.createMetadata(event));

        const prefix = document.createElement('span');
        prefix.textContent = 'RT: ';
        prefix.className = 'repost-prefix';
        li.appendChild(prefix);

        const targetId = event.tags.find(t => t[0] === 'e')?.[1];
        if (targetId) {
            const originalEvent = window.dataStore.getEvent(targetId);

            if (originalEvent) {
                const ts = this.createTimestamp(originalEvent);
                li.appendChild(ts);
                li.appendChild(document.createTextNode(' '));

                const authorLink = this.createAuthorLink(originalEvent.pubkey);
                li.appendChild(authorLink);

                const contentWrapper = document.createElement('span');
                contentWrapper.className = 'repost-content';
                contentWrapper.appendChild(document.createTextNode(' > '));
                const expandable = this.createExpandableContent(originalEvent);
                contentWrapper.appendChild(expandable);

                li.appendChild(contentWrapper);

            } else {
                const link = this.createEventLink(targetId);
                li.appendChild(link);
            }
        }

        return li;
    }

    /**
     * kind:7 (ふぁぼ) 要素
     */
    createLikeElement(event) {
        const li = document.createElement('li');
        li.className = 'event event-like';

        if (window.dataStore.isLikedByMe(event.id)) {
            li.classList.add('event-liked');
        }

        // 🆕 共通アクションメニューの紐付け
        if (window.actionMenu) {
            window.actionMenu.attach(li, event);
        }

        // destroy メソッド
        li.destroy = () => {
            if (window.actionMenu) {
                window.actionMenu.detach(li);
            }
            li.remove();
        };

        li.appendChild(this.createMetadata(event));

        const content = event.content || '+';
        const isCustomEmoji =
            content.startsWith(':') &&
            content.endsWith(':') &&
            content.length > 2;

        if (isCustomEmoji) {
            const wrapper = document.createElement('span');
            wrapper.style.cssText =
                'display: inline-block; height: 1.5rem; vertical-align: middle; margin: 0 0.25rem;';
            wrapper.title = content;

            const emojiElement =
                this.createCustomEmoji(content, event.tags || []);

            wrapper.appendChild(emojiElement);

            li.appendChild(document.createTextNode(' '));
            li.appendChild(wrapper);
            li.appendChild(document.createTextNode(' '));
        } else {
            const emoji = document.createElement('span');
            const displayContent =
                (content && content !== '+') ? content : '⭐';

            emoji.textContent = ' ' + displayContent + ' ';
            emoji.style.cssText =
                'font-size: 1rem; margin: 0 0.25rem;';

            li.appendChild(emoji);
        }

        const eTags = event.tags?.filter(t => t[0] === 'e') || [];
        const targetTag =
            eTags.find(t => t[3] === 'reply') ||
            (eTags.length > 0 ? eTags[eTags.length - 1] : null);

        const targetId = targetTag?.[1];

        if (targetId) {
            const link = this.createEventLink(targetId);
            link.textContent = '→ 投稿を見る';
            li.appendChild(link);

            const preview = this.createOriginalPostPreview(targetId);
            li.appendChild(preview);
        }

        return li;
    }

    // ========================================
    // 共通要素作成
    // ========================================

    createMetadata(event) {
        const span = document.createElement('span');
        const time = this.createTimestamp(event);
        span.appendChild(time);
        span.appendChild(document.createTextNode(' '));
        const author = this.createAuthorLink(event.pubkey);
        span.appendChild(author);
        span.appendChild(document.createTextNode(' > '));
        return span;
    }

    _shouldBreakBeforeContent(event) {
        return !!(window.app?.preWrapEnabled && (event.content || '').includes('\n'));
    }

    createTimestamp(event) {
        const date = new Date(event.created_at * 1000);

        // 🆕 timestampFormatter が渡されていればそちらを優先
        const timeStr = this.timestampFormatter
            ? this.timestampFormatter(date, event)
            : String(date.getHours()).padStart(2, '0') + ':' +
            String(date.getMinutes()).padStart(2, '0') + ':' +
            String(date.getSeconds()).padStart(2, '0');

        // 🆕 relayManager が存在しないページ（tweet.htmlなど）でも落ちないようにする
        const nevent = window.NostrTools.nip19.neventEncode({
            id: event.id,
            relays: window.relayManager?.url ? [window.relayManager.url] : []
        });

        const link = document.createElement('a');
        link.className = 'nostr-ref';
        link.href = `https://ompomz.github.io/flowgazer/tweet?id=${nevent}`;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = `[${timeStr}]`;

        return link;
    }

    createAuthorLink(pubkey) {
        const npub = window.NostrTools.nip19.npubEncode(pubkey);
        const rawName = window.dataStore.getDisplayName(pubkey) || pubkey.substring(0, 8);

        const link = document.createElement('a');
        link.className = 'pubkey-ref';
        link.href = `https://ompomz.github.io/flowgazer/tweet?id=${npub}`;
        link.target = '_blank';
        link.rel = 'noreferrer';

        let truncatedName = "";
        let currentWidth = 0;
        const ellipsis = "…";
        const ellipsisWidth = this.measureCtx.measureText(ellipsis).width;
        const maxWidth = this.maxNameWidthPx;

        for (const char of rawName) {
            const charWidth = this.measureCtx.measureText(char).width;

            if (currentWidth + charWidth > maxWidth) {
                if (truncatedName.length > 0) {
                    while (truncatedName.length > 0 && (this.measureCtx.measureText(truncatedName).width + ellipsisWidth) > maxWidth) {
                        truncatedName = truncatedName.slice(0, -1);
                    }
                    truncatedName += ellipsis;
                }
                break;
            }
            truncatedName += char;
            currentWidth += charWidth;
        }

        link.textContent = truncatedName;
        link.style.color = MyNostrUtils.getHslColor(pubkey);

        return link;
    }

    createContent(event) {
        const div = document.createElement('div');
        div.className = 'post-content';
        const rawContent = event.content || '';

        const escapedContent = MyNostrUtils.escapeHtml(rawContent);
        const formattedContent = MyNostrUtils.linkify(escapedContent, { expandMedia: false });
        div.innerHTML = formattedContent;

        const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null, false);
        const textNodes = [];

        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }

        textNodes.forEach(node => {
            const text = node.nodeValue;

            if (!text.includes(':')) return;

            const parts = text.split(/(:[a-zA-Z0-9_+-]+:)/g);
            if (parts.length === 1) return;

            const fragment = document.createDocumentFragment();

            parts.forEach(part => {
                if (/^:[a-zA-Z0-9_+-]+:$/.test(part)) {
                    const emojiEl = this.createCustomEmoji(part, event.tags || []);
                    fragment.appendChild(emojiEl);
                } else {
                    fragment.appendChild(document.createTextNode(part));
                }
            });

            node.replaceWith(fragment);
        });

        const links = div.querySelectorAll('a.nostr-ref');
        links.forEach(link => {
            if (link.textContent.startsWith('nostr:')) {
                const href = link.getAttribute('href');
                const urlParams = new URLSearchParams(new URL(href).search);
                const nip19 = urlParams.get('id');

                try {
                    const decoded = window.NostrTools.nip19.decode(nip19);
                    let targetId =
                        (decoded.type === 'nevent') ? decoded.data.id :
                            (decoded.type === 'note' ? decoded.data : null);

                    if (targetId) {
                        const originalEvent = window.dataStore.getEvent(targetId);
                        if (originalEvent) {
                            const inlineRT = this.createInlineRTElement(originalEvent);
                            link.replaceWith(inlineRT);
                        }
                    }
                } catch (e) { }
            }
        });

        return div;
    }

    createUrlLink(url) {
        const htmlString = MyNostrUtils.parseUrl(url);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlString;
        return tempDiv.firstElementChild;
    }

    createNostrRef(nip19) {
        const link = document.createElement('a');
        link.href = `https://ompomz.github.io/flowgazer/tweet?id=${nip19}`;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.className = 'nostr-ref';
        link.textContent = `nostr:${nip19.substring(0, 12)}...`;
        return link;
    }

    createCustomEmoji(shortcode, tags) {
        const name = shortcode.slice(1, -1);
        const emojiTag = tags.find(t => t[0] === 'emoji' && t[1] === name);

        if (emojiTag && emojiTag[2]) {
            const img = document.createElement('img');
            img.src = emojiTag[2];
            img.alt = shortcode;
            img.title = shortcode;
            img.className = 'custom-emoji';
            return img;
        }

        return document.createTextNode(shortcode);
    }

    createEventLink(eventId) {
        const nevent = window.NostrTools.nip19.neventEncode({
            id: eventId,
            // 🆕 同上
            relays: window.relayManager?.url ? [window.relayManager.url] : []
        });

        const link = document.createElement('a');
        link.href = `https://ompomz.github.io/flowgazer/tweet?id=${nevent}`;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.className = 'nostr-ref';
        link.textContent = `nostr:${eventId.substring(0, 12)}...`;
        return link;
    }

    createOriginalPostPreview(eventId) {
        const div = document.createElement('div');
        div.className = 'original-post-preview';
        div.style.cssText = `
            margin: 0.5rem 0;
            padding: 0.5rem;
            background-color: #F3F2F1;
            border-left: 3px solid #65A4D4;
            font-size: 0.85rem;
        `;

        const originalEvent = window.dataStore.getEvent(eventId);

        if (originalEvent) {
            const author = document.createElement('span');
            author.style.cssText = 'font-weight: bold; color: #0078D4;';
            author.textContent = window.dataStore.getDisplayName(originalEvent.pubkey);

            const content = document.createElement('span');

            let rawText = originalEvent.content || '';
            if (originalEvent.kind === 40) {
                try {
                    const parsed = JSON.parse(rawText);
                    rawText = `[Channel Create: ${parsed.name || 'Untitled'}]`;
                } catch (e) {
                    rawText = '[Channel Event]';
                }
            }

            const text = rawText.length > 150
                ? rawText.substring(0, 150) + '...'
                : rawText;

            content.textContent = ': ' + text;

            div.appendChild(author);
            div.appendChild(content);
        } else {
            div.textContent = '元投稿が見つかりませんでした';
        }

        return div;
    }

    createReactionBadge(eventId) {
        const counts = window.dataStore.getReactionCount(eventId);
        const parts = [];

        if (counts.reactions > 0) parts.push(`⭐${counts.reactions}`);
        if (counts.reposts > 0) parts.push(`🔁${counts.reposts}`);

        if (parts.length === 0) return null;

        const badge = document.createElement('span');
        badge.textContent = ' ' + parts.join(' ');
        badge.style.cssText = 'color: #999; margin-left: 0.5rem; font-size: 0.8rem;';
        return badge;
    }

    /**
     * タイムライン全体を破棄
     */
    destroy() {
        this.destroyAllElements();
        console.log('🗑️ Timeline破棄完了');
    }
}

window.Timeline = Timeline;