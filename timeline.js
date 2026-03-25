/**
 * timeline.js
 * 【責務】: DOM要素の生成とレンダリング・適切なクリーンアップ
 */

// ===== ユーティリティ（表示名用） =====

function lenb(str) {
    let length = 0;
    for (const char of str) {
        length += /[^\x01-\x7E]/.test(char) ? 2 : 1;
    }
    return length;
}

function truncateByLenb(str, maxLenb) {
    let result = '';
    let currentLenb = 0;

    for (const char of str) {
        const charLen = /[^\x01-\x7E]/.test(char) ? 2 : 1;

        if (currentLenb + charLen + 1 > maxLenb) {
            return result + '…';
        }

        result += char;
        currentLenb += charLen;
    }
    return result;
}

function hexToHue(hex6) {
    const r = parseInt(hex6.slice(0, 2), 16) / 255;
    const g = parseInt(hex6.slice(2, 4), 16) / 255;
    const b = parseInt(hex6.slice(4, 6), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;
    if (d !== 0) {
        switch (max) {
            case r:
                h = ((g - b) / d) % 6;
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            case b:
                h = (r - g) / d + 4;
                break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return Math.round(h);
}

// ===== Timeline クラス =====

class Timeline {
    constructor(containerElement) {
        this.container = containerElement;
        this.currentTab = 'global';
        // DOM要素の追跡用
        this.activeElements = new Set();
        // ★ 追加：チャンネル名キャッシュ
        this.channelNameMap = window.channelNameMap || new Map();
        // フィルターオプション
        this.filterOptions = {
            flowgazerOnly: false,
            authors: null
        };
        const canvas = document.createElement('canvas');
        this.measureCtx = canvas.getContext('2d');
        this.measureCtx.font = '14px sans-serif';

        const sampleText = "🎵🎵か～('□')ま～('□')ど～('ｏ')　か～('□')ま～('□')ど～('ｏ') 　瀬戸の海は　お母さん 　讃岐の山は　お父さん 　か～('□')ま～('□')ど～('ｏ')　か～('□')ま～('□')ど～('ｏ') 　丸い心は　かまどのお菓子 名物かまど";
        this.maxContentWidthPx = this.measureCtx.measureText(sampleText).width;
        this.maxNameWidthPx = this.measureCtx.measureText("[00:00:00]").width;
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

    refresh(force = false) {
        if (!force && !window.app?.isAutoUpdate) {
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
        const fullContent = event.content;
        const lineCount = (fullContent.match(/\n/g) || []).length;

        // 1. 絶対短いものは即座に返す
        // 100文字以下、かつ改行が少ない、かつ画像リンクらしきものがない場合
        const hasMedia = /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|mp4)/i.test(fullContent);
        if (fullContent.length < 100 && lineCount < 4 && !hasMedia) {
            return this.createContent(event);
        }

        // 2. 折りたたみ閾値の判定
        // ここでは Canvas を使わず、一旦 MyNostrUtils 側で「文字数」ベースで切る
        // (1行40文字想定で3行分 = 120文字くらいを閾値にする)
        const threshold = 120;
        const isPotentiallyLong = fullContent.length > threshold || lineCount >= 4;

        if (!isPotentiallyLong) {
            return this.createContent(event);
        }

        // 3. 短縮版のテキストを作成
        // MyNostrUtils.truncateByByte があればそれを使う
        const shortText = MyNostrUtils.truncateByByte(fullContent, threshold);
        const isLong = shortText.length < fullContent.length;

        if (!isLong) return this.createContent(event);

        // --- ここからDOM構築 ---
        const wrapper = document.createElement('span');
        wrapper.className = 'expandable-content';

        const render = (text) => {
            const tempEvent = { ...event, content: text };
            return this.createContent(tempEvent);
        };

        let currentContentNode = render(shortText);
        wrapper.appendChild(currentContentNode);

        // 全文表示ボタン
        const toggleLink = document.createElement('span');
        toggleLink.textContent = ' [全文を表示]';
        toggleLink.className = 'npub-link';
        toggleLink.style.cursor = 'pointer';

        toggleLink.onclick = (e) => {
            e.stopPropagation();
            const isExpanded = toggleLink.textContent.includes('とじる');

            // 切り替え
            const newNode = render(isExpanded ? shortText : fullContent);
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

        // 長押しハンドラー
        const longPressHandler = this.createLongPressHandler(event);
        longPressHandler.attach(li);

        // destroy メソッド
        li.destroy = () => {
            longPressHandler.detach();
            li.remove();
        };

        // メタデータ
        li.appendChild(this.createMetadata(event));

        // チャンネルマーク
        const badge = document.createElement('span');

        // channelId（取れなければ null）
        const channelId = event.tags?.find(t => t[0] === 'e')?.[1];

        // チャンネル名が取得できている場合だけ置き換える
        if (channelId && this.channelNameMap instanceof Map && this.channelNameMap.has(channelId)) {
            const channelName = this.channelNameMap.get(channelId);
            badge.textContent = `*${channelName} `;
        } else {
            // 今まで通り
            badge.textContent = '*kind:42 ';
        }

        badge.style.cssText = 'color: #B3A1FF; font-weight: normal;';
        li.appendChild(badge);

        // 本文
        li.appendChild(this.createContent(event));

        return li;
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

        // 長押しハンドラー
        const longPressHandler = this.createLongPressHandler(event);
        longPressHandler.attach(li);

        // destroy メソッド
        li.destroy = () => {
            longPressHandler.detach();
            li.remove();
        };

        // メタデータ
        li.appendChild(this.createMetadata(event));

        // 本文
        const cwTag = event.tags.find(tag => tag[0] === "content-warning");

        if (cwTag) {
            const reason = cwTag[1] ? `：${cwTag[1]}` : "";

            // ボタンではなく <a> タグで作る
            const cwLink = document.createElement('a');
            cwLink.href = '#';
            cwLink.className = 'nostr-ref';
            cwLink.textContent = `⚠️${reason} [内容を表示]`;

            cwLink.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();

                // ★ CW を開いたら createExpandableContent を使う
                const expandable = this.createExpandableContent(event);
                cwLink.replaceWith(expandable);
            };

            li.appendChild(cwLink);

        } else {
            // ★ CW が無い場合も createExpandableContent を使う
            const expandable = this.createExpandableContent(event);
            li.appendChild(expandable);
        }

        // リアクションバッジ
        if (this.currentTab === 'myposts') {
            const badge = this.createReactionBadge(event.id);
            if (badge) li.appendChild(badge);
        }

        return li;
    }

    createInlineRTElement(originalEvent) {
        const span = document.createElement('span');
        span.className = 'inline-rt';

        // "RT: "
        const prefix = document.createElement('span');
        prefix.textContent = 'RT: ';
        prefix.className = 'repost-prefix';
        span.appendChild(prefix);

        // author link
        const author = this.createAuthorLink(originalEvent.pubkey);
        span.appendChild(author);

        // " > "
        span.appendChild(document.createTextNode(' > '));

        // content（折りたたみ対応）
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

        li.destroy = () => {
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

        // 長押しハンドラー
        const longPressHandler = this.createLongPressHandler(event);
        longPressHandler.attach(li);

        // destroy メソッド
        li.destroy = () => {
            longPressHandler.detach();
            li.remove();
        };

        li.appendChild(this.createMetadata(event));

        // カスタム絵文字処理
        const content = event.content || '+';
        const isCustomEmoji =
            content.startsWith(':') &&
            content.endsWith(':') &&
            content.length > 2;

        if (isCustomEmoji) {
            const wrapper = document.createElement('span');
            wrapper.style.cssText =
                'display: inline-block; height: 1.5rem; vertical-align: middle; margin: 0 0.25rem;';

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

        // --- 【ここから修正】対象投稿へのリンク取得ロジック ---
        const eTags = event.tags?.filter(t => t[0] === 'e') || [];

        // 1. "reply" マーカーを最優先
        // 2. マーカーがない場合、eタグが複数あれば最後(最新の参照)を、1つならそれを採用
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
    // 長押しハンドラー（オブジェクト化）
    // ========================================

    /**
     * 長押しハンドラーオブジェクトを作成
     * @param {Object} event - Nostrイベント
     * @returns {Object} { attach, detach }
     */
    createLongPressHandler(event) {
        let timer;

        const start = () => {
            timer = setTimeout(() => {
                if (window.sendLikeEvent) {
                    if (confirm('☆ふぁぼる？')) {
                        window.sendLikeEvent(event.id, event.pubkey);
                    }
                }
            }, 900);
        };

        const cancel = () => clearTimeout(timer);

        return {
            attach(element) {
                element.addEventListener('mousedown', start);
                element.addEventListener('mouseup', cancel);
                element.addEventListener('mouseleave', cancel);
                element.addEventListener('touchstart', start, { passive: true });
                element.addEventListener('touchend', cancel);
                element.addEventListener('touchcancel', cancel);

                // ハンドラー参照を保存（detach用）
                element._longPressHandlers = { start, cancel };
            },

            detach() {
                const element = this.element;
                if (!element || !element._longPressHandlers) return;

                const { start, cancel } = element._longPressHandlers;
                element.removeEventListener('mousedown', start);
                element.removeEventListener('mouseup', cancel);
                element.removeEventListener('mouseleave', cancel);
                element.removeEventListener('touchstart', start);
                element.removeEventListener('touchend', cancel);
                element.removeEventListener('touchcancel', cancel);

                delete element._longPressHandlers;
                clearTimeout(timer);
            },

            // 後で detach するために element を保持
            element: null
        };
    }

    // ========================================
    // 共通要素作成（変更なし）
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

    createTimestamp(event) {
        const date = new Date(event.created_at * 1000);
        const timeStr = String(date.getHours()).padStart(2, '0') + ':' +
            String(date.getMinutes()).padStart(2, '0') + ':' +
            String(date.getSeconds()).padStart(2, '0');

        const nevent = window.NostrTools.nip19.neventEncode({
            id: event.id,
            relays: [window.relayManager.url]
        });

        const link = document.createElement('a');
        link.className = 'nostr-ref';
        link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${nevent}`;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = `[${timeStr}]`;

        return link;
    }

    createAuthorLink(pubkey) {
        const npub = window.NostrTools.nip19.npubEncode(pubkey);
        const displayName = window.dataStore.getDisplayName(pubkey);

        const link = document.createElement('a');
        link.className = 'pubkey-ref';
        link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${npub}`;
        link.target = '_blank';
        link.rel = 'noreferrer';

        // 💡 MyNostrUtils の関数を活用
        link.textContent = MyNostrUtils.truncateByByte(displayName, 20);
        link.style.color = MyNostrUtils.getHslColor(pubkey);

        return link;
    }

    createContent(event) {
        const div = document.createElement('div');
        div.className = 'post-content';
        const formattedContent = MyNostrUtils.linkify(event.content, { expandMedia: false });
        div.innerHTML = formattedContent;

        return div;
    }

    parseContent(content, tags) {
        const pattern = /(https?:\/\/[^\s]+)|(nostr:[\w]+1[ac-hj-np-z02-9]+)|(:[_a-zA-Z0-9]+:)/;
        const parts = content.split(pattern).filter(s => s);

        return parts.map(s => {
            if (!s) return document.createTextNode('');

            // --- URL ---
            if (s.startsWith('http')) {
                return this.createUrlLink(s);
            }

            // --- nostr:xxx 埋め込み ---
            if (s.startsWith('nostr:')) {
                const code = s.substring(6); // "nostr:" を除去

                try {
                    const decoded = NostrTools.nip19.decode(code);

                    // nevent / note → イベントIDが取れる
                    if (decoded.type === "nevent" || decoded.type === "note") {
                        const id = decoded.data.id;
                        if (id) {
                            const original = window.dataStore.getEvent(id);
                            if (original) {
                                // inline RT を生成
                                return this.createInlineRTElement(original);
                            }
                        }
                    }

                    // nprofile / naddr などは今は通常の nostr リンクとして扱う
                    return this.createNostrRef(code);

                } catch (e) {
                    // decode 失敗 → 通常の nostr リンク
                    return this.createNostrRef(code);
                }
            }

            // --- カスタム絵文字 ---
            if (s.startsWith(':') && s.endsWith(':')) {
                return this.createCustomEmoji(s, tags);
            }

            // --- 通常テキスト ---
            return document.createTextNode(s);
        });
    }

    createUrlLink(url) {
        const htmlString = MyNostrUtils.parseUrl(url);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlString;
        return tempDiv.firstElementChild;
    }

    createNostrRef(nip19) {
        const link = document.createElement('a');
        link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${nip19}`;
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
            img.className = 'custom-emoji';
            return img;
        }

        return document.createTextNode(shortcode);
    }

    createEventLink(eventId) {
        const nevent = window.NostrTools.nip19.neventEncode({
            id: eventId,
            relays: [window.relayManager.url]
        });

        const link = document.createElement('a');
        link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${nevent}`;
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

            // kindによって表示を少し調整
            let rawText = originalEvent.content || '';
            if (originalEvent.kind === 40) {
                // チャンネル作成イベントだった場合のフォールバック
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