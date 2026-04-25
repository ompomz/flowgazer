/**
 * timeline.js
 * 【責務】: DOM要素の生成とレンダリング・適切なクリーンアップ
 */

// ===== Timeline クラス =====

class Timeline {
    constructor(containerElement) {
        this.container = containerElement;
        this.currentTab = 'global';
        // DOM要素の追跡用
        this.activeElements = new Set();
        // チャンネル名キャッシュ
        this.channelNameMap = window.channelNameMap || new Map();
        // フィルターオプション
        this.filterOptions = {
            flowgazerOnly: false,
            authors: null
        };

        // 1. Canvasを作成して、測るためのペン(measureCtx)を保存する
        const canvas = document.createElement('canvas');
        this.measureCtx = canvas.getContext('2d');
        this.measureCtx.font = '14px sans-serif';

        // 2. 時刻の幅を計算
        this.maxNameWidthPx = this.measureCtx.measureText("[00:00:000]").width;
        this.maxContentWidthPx = 0;
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
            // 簡易的には substring でも良いが、壊さないために慎重にカット
            shortText = fullContent.substring(0, threshold);
        }

        const isLong = shortText.length < fullContent.length;
        if (!isLong) return this.createContent(event);

        // --- DOM構築 ---
        const wrapper = document.createElement('span');
        wrapper.className = 'expandable-content';

        const render = (text) => {
            // text が短縮されていても、linkify が動くようにする
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
        li.appendChild(document.createElement('br'));

        // --- 本文（改行許可スタイルを適用） ---
        const content = this.createContent(event);
        // white-space: pre-wrap を指定することで \n を改行として表示し、端で折り返す設定になります
        content.style.whiteSpace = 'pre-wrap';
        li.appendChild(content);

        return li;
    }

    // pubkeyを元に、表示用の短い名前（@nameなど）を返す
    resolveName(pubkey) {
        const profile = window.dataStore.getProfile(pubkey);

        let name = null;

        if (profile) {
            name =
                profile.display_name ||
                profile.name ||
                profile.nip05?.split('@')[0];
        }

        if (!name) {
            const npub = window.NostrTools.nip19.npubEncode(pubkey);
            name = npub.substring(0, 10) + "...";
        }

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
                return `@${result}`; // ←ここで @付与
            }

            result += char;
            width += charWidth;
        }

        return `@${result}`; // ←通常時も @付与
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

        // リプライ先（pタグ）の表示を追加
        // 最初に見つかった p タグをリプライ先とみなす（または自分以外のpubkeyを探す）
        const replyTag = event.tags.find(tag => tag[0] === "p");
        if (replyTag) {
            const targetPubkey = replyTag[1];

            const replySpan = document.createElement('span');
            replySpan.className = 'reply-indicator';
            replySpan.appendChild(document.createTextNode(' '));

            // リプライ先の名前をリンクにする
            const targetName = this.resolveName(targetPubkey);
            const targetLink = this.createAuthorLink(targetPubkey);
            targetLink.textContent = targetName;
            replySpan.appendChild(targetLink);

            li.appendChild(replySpan);
            li.appendChild(document.createTextNode(' '));
        }

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
        let startPos = { x: 0, y: 0 };
        const THRESHOLD = 10;

        const triggerAction = () => {
            const menu = document.getElementById('long-press-menu');

            // ふぁぼアイコンの反映
            const customLikeIcon = document.getElementById('kind-7-content-input')?.value || "⭐";
            const likeDisplay = document.getElementById('lp-like-icon');
            if (likeDisplay) likeDisplay.textContent = customLikeIcon;

            // 表示位置設定
            menu.style.left = `${startPos.x}px`;
            menu.style.top = `${startPos.y - 20}px`;
            menu.style.display = 'flex';

            // 初期選択状態（like）の設定
            const items = menu.querySelectorAll('.lp-item');
            items.forEach(i => i.classList.remove('selected'));
            menu.querySelector('[data-action="like"]')?.classList.add('selected');

            // --- 共通の閉じる処理 ---
            const closeMenu = (e) => {
                if (e && e.target && menu.contains(e.target)) return;
                menu.style.display = 'none';
                // リスナー解除
                document.removeEventListener('pointerdown', closeMenu);
                document.removeEventListener('keydown', handleKeyDown);
                menu.onclick = null; // 委譲リスナーも掃除
            };

            // --- キーボード操作 ---
            const handleKeyDown = (e) => {
                if (e.key === 'Enter') {
                    const selected = menu.querySelector('.lp-item.selected');
                    if (selected) this.executeNostrAction(selected.getAttribute('data-action'), event);
                    closeMenu();
                } else if (e.key === 'Escape') closeMenu();
            };

            // --- イベント委譲によるクリック一括管理 ---
            menu.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();

                // クリックされた要素から一番近い .lp-item を探す
                const item = e.target.closest('.lp-item');
                const action = item?.getAttribute('data-action');

                if (action) {
                    this.executeNostrAction(action, event);
                    closeMenu();
                }
            };

            setTimeout(() => {
                document.addEventListener('pointerdown', closeMenu);
                document.addEventListener('keydown', handleKeyDown);
            }, 100);
        };

        const start = (e) => {
            const touch = e.touches ? e.touches[0] : e;
            startPos = { x: touch.clientX, y: touch.clientY };
            timer = setTimeout(() => triggerAction(e), 400);
        };

        const move = (e) => {
            if (!timer) return;
            const touch = e.touches ? e.touches[0] : e;
            const dist = Math.hypot(touch.clientX - startPos.x, touch.clientY - startPos.y);

            // 設定したしきい値を超えて動いたらキャンセル
            if (dist > THRESHOLD) {
                clearTimeout(timer);
                timer = null;
            }
        };

        const cancel = () => {
            clearTimeout(timer);
            timer = null;
        };

        return {
            element: null,
            attach(element) {
                this.element = element;
                element.addEventListener('mousedown', start);
                element.addEventListener('touchstart', start, { passive: true });

                // 移動検知（しきい値判定用）
                element.addEventListener('mousemove', move);
                element.addEventListener('touchmove', move, { passive: true });

                // 中断イベント
                element.addEventListener('mouseup', cancel);
                element.addEventListener('mouseleave', cancel);
                element.addEventListener('touchend', cancel);
                element.addEventListener('touchcancel', cancel);

                element._longPressHandlers = { start, move, cancel };
            },
            detach() {
                const el = this.element;
                if (!el || !el._longPressHandlers) return;
                const { start, move, cancel } = el._longPressHandlers;
                el.removeEventListener('mousedown', start);
                el.removeEventListener('touchstart', start);
                el.removeEventListener('mousemove', move);
                el.removeEventListener('touchmove', move);
                el.removeEventListener('mouseup', cancel);
                el.removeEventListener('mouseleave', cancel);
                el.removeEventListener('touchend', cancel);
                el.removeEventListener('touchcancel', cancel);
                delete el._longPressHandlers;
                clearTimeout(timer);
            }
        };
    }

    /**
     * Nostrアクション（like, repost, quote, reply）を実行
     */
    async executeNostrAction(action, originalEvent) {
        // neventの生成（共通ロジック）
        const nevent = window.NostrTools.nip19.neventEncode({
            id: originalEvent.id,
            relays: [window.relayManager.url]
        });

        switch (action) {
            case 'like':
                if (window.sendLikeEvent) window.sendLikeEvent(originalEvent.id, originalEvent.pubkey);
                break;

            case 'repost':
                if (!confirm('RTしますか？')) return;

                const isTextNote = originalEvent.kind === 1;
                const repostKind = isTextNote ? 6 : 16;

                const repostEv = {
                    kind: repostKind,
                    content: "",
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                        ["e", originalEvent.id, window.relayManager.url],
                        ["p", originalEvent.pubkey]
                    ]
                };

                if (!isTextNote) {
                    repostEv.tags.push(["k", String(originalEvent.kind)]);
                }

                // クライアントタグ
                repostEv.tags.push([
                    'client',
                    'flowgazer',
                    '31990:a19caaa8404721584746fb0e174cf971a94e0f51baaf4c4e8c6e54fa88985eaf:1755917022711',
                    'wss://relay.nostr.band/'
                ]);

                try {
                    const signed = await window.nostrAuth.signEvent(repostEv);
                    window.relayManager.publish(signed);
                    // alertはUXを阻害する場合があるため、必要に応じてトースト通知等へ
                    console.log('RT成功');
                } catch (err) {
                    console.error('RT失敗:', err);
                    alert('RTに失敗しました');
                }
                break;

            case 'quote':
                // マネージャーを呼び出すだけ
                window.ehagakiManager.open({
                    quotes: [nevent],
                    reply: null
                });
                break;

            case 'reply':
                // マネージャーを呼び出すだけ
                window.ehagakiManager.open({
                    reply: nevent,
                    quotes: []
                });
                break;
        }
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
        const rawName = window.dataStore.getDisplayName(pubkey) || pubkey.substring(0, 8);

        const link = document.createElement('a');
        link.className = 'pubkey-ref';
        link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${npub}`;
        link.target = '_blank';
        link.rel = 'noreferrer';

        let truncatedName = "";
        let currentWidth = 0;
        const ellipsis = "…";
        const ellipsisWidth = this.measureCtx.measureText(ellipsis).width;
        const maxWidth = this.maxNameWidthPx;

        for (const char of rawName) {
            const charWidth = this.measureCtx.measureText(char).width;

            // 次の文字を足すと maxWidth を超える可能性がある場合
            if (currentWidth + charWidth > maxWidth) {
                // すでに1文字以上あるなら、末尾を三点リーダーにする余裕があるか判定してカット
                if (truncatedName.length > 0) {
                    // 三点リーダー込みで幅に収まる位置まで削る（安全策）
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

        // 1. HTMLエスケープ + linkify
        const escapedContent = MyNostrUtils.escapeHtml(rawContent);
        const formattedContent = MyNostrUtils.linkify(escapedContent, { expandMedia: false });
        div.innerHTML = formattedContent;

        // :emoji: を探して置換
        const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null, false);
        const textNodes = [];

        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }

        textNodes.forEach(node => {
            const text = node.nodeValue;

            // :xxx: パターン検出
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