/**
 * tweet-view.js
 * 【責務】: tweet.html の「画面の描画・UI構築」のみ（HTML文字列の組み立て・DOM描画・長押しアクションの紐付け）
 *
 * - 取得・キャッシュは window.tweetApi、純粋関数は window.TweetUtils に任せる。
 * - ルーティング・初期化・ログイン/eHagaki配線・リレー再試行などの「制御」は tweet.js 側。
 *   このファイルは tweet.js を知らない（逆方向の依存を作らない）。
 *   そのため「再試行」のような制御が必要な箇所は、呼び出し側からコールバック(onRetry)を受け取る。
 * - 外部に公開するのは window.TweetView のみ。
 * - 実行時に参照するグローバル:
 *     window.tweetApi / window.TweetUtils / window.MyNostrUtils / window.NostrTools /
 *     window.Timeline / window.dataStore / window.tweetActionMenu（長押しアクション。呼び出し時に遅延参照）
 *   window.profileTimeline は従来どおりここで生成・公開する。
 * - 読み込み順: nostr-tools → utility.js → data-store.js → timeline.js → tweet-utils.js → tweet-api.js
 *               → tweet-view.js → tweet.js
 */
(function () {
    'use strict';

    // ========================================
    // 依存の取り込み
    // ========================================
    const {
        getPostTypeLabel, formatProfileDate, replaceCustomEmojis,
        isNip05, getReplyTargetTag, CONFIG
    } = window.TweetUtils;
    const { DEFAULT_PROFILE_IMAGE } = CONFIG;

    const tweetApi = window.tweetApi;
    const getPriorityRelays = tweetApi.getPriorityRelays.bind(tweetApi);
    const fetchProfile = tweetApi.fetchProfile.bind(tweetApi);
    const fetchEventById = tweetApi.fetchEventById.bind(tweetApi);
    const fetchChannelMeta = tweetApi.fetchChannelMeta.bind(tweetApi);

    // ========================================
    // 描画先の要素・ビュー内部状態
    // ========================================
    const mainEventContainer = document.getElementById('main-event');
    const reactionsSection = document.getElementById('reactions-section');
    const reactionsList = document.getElementById('reactions-list');
    const relatedEventsSection = document.getElementById('related-events-section');
    const relatedEventsList = document.getElementById('related-events-list');

    // プロフィールページの投稿一覧：もっと見る用の状態
    let profilePostsState = null; // { pubkey, hintRelays, oldestTimestamp, isLoading }

    // ========================================
    // 小さなUI部品（ヘッダーのボタン・長押しアクション）
    // ========================================

    function showCopyButton() {
        const btn = document.getElementById('copy-nevent-btn');
        if (btn) btn.style.display = 'inline-block';
    }

    function showJumpButton(pubkey, originalId) {
        const jumpBtn = document.getElementById('jump-to-okkake');
        if (!jumpBtn) return;
        try {
            const npub = NostrTools.nip19.npubEncode(pubkey);
            const okkakeUrl = `https://ompomz.github.io/flowgazer/okkake.html?id=${encodeURIComponent(originalId)}&follow=${npub}`;
            jumpBtn.style.display = 'inline-block';
            jumpBtn.onclick = () => window.open(okkakeUrl, '_blank');
        } catch (e) {
            console.warn('jumpボタン設定失敗:', e);
        }
    }

    /**
     * 要素に長押しアクション（ふぁぼ・RT・返信・引用）を紐付ける。
     * window.tweetActionMenu は tweet.js が生成するため、描画時に遅延参照する
     * （このファイルの読み込み時点では未生成でもよい）。
     */
    function attachActionHandler(element, event) {
        if (window.tweetActionMenu && element) {
            window.tweetActionMenu.attach(element, event);
        }
    }

    // ========================================
    // 本文フォーマット（エスケープ → linkify → 絵文字 → 引用カード展開）
    // ========================================

    async function formatPostContent(content, tags, options) {
        const opts = options || { expandMedia: true };
        let html = MyNostrUtils.escapeHtml(content || '');
        html = html.replace(/\n/g, '<br>');
        html = MyNostrUtils.linkify(html, opts);

        const customEmojiMap = new Map();
        (tags || []).filter(t => t[0] === 'emoji' && t[1] && t[2]).forEach(([, shortcode, url]) => {
            customEmojiMap.set(`:${shortcode}:`, url);
        });
        html = replaceCustomEmojis(html, customEmojiMap);

        // nostr:xxxx 参照をカード化する。
        // 【重要】MyNostrUtils.linkify は表示テキストを10文字+"..."に短縮するため、
        // 表示テキストからIDを取り出すと壊れる。hrefのクエリに完全なIDが入っているのでそちらを使う。
        const temp = document.createElement('div');
        temp.innerHTML = html;
        const nostrLinks = Array.from(temp.querySelectorAll('a.nostr-ref'));
        const tasks = nostrLinks.map(async (link) => {
            const text = link.textContent || '';
            if (!text.startsWith('nostr:')) return;
            try {
                const href = link.getAttribute('href');
                const url = new URL(href, window.location.href);
                const nip19Id = url.searchParams.get('id');
                if (!nip19Id) return;
                const cardHtml = await createNostrCard(nip19Id);
                if (cardHtml) link.outerHTML = cardHtml;
            } catch (e) {
                console.warn('引用カード生成失敗:', e.message);
            }
        });
        if (tasks.length > 0) await Promise.all(tasks);

        return temp.innerHTML;
    }

    async function formatEmojiOnly(content, tags) {
        if (content === '+') return '⭐';
        if (/^:[a-zA-Z0-9_+-]+:$/.test(content)) {
            const map = new Map();
            (tags || []).filter(t => t[0] === 'emoji' && t[1] && t[2]).forEach(([, code, url]) => map.set(`:${code}:`, url));
            if (map.has(content)) {
                return `<img src="${map.get(content)}" class="custom-emoji" alt="${content}" title="${content}">`;
            }
        }
        return MyNostrUtils.escapeHtml(content);
    }

    // ========================================
    // プロフィール表示の共通部品
    // ========================================

    function createProfileHtml(pubkey, profile, isLink) {
        const link = isLink === undefined ? true : isLink;
        const picture = (profile && profile.picture && profile.picture.trim() !== '') ? profile.picture : DEFAULT_PROFILE_IMAGE;
        const npub = NostrTools.nip19.npubEncode(pubkey);
        const name = MyNostrUtils.getDisplayName(profile, pubkey);
        const nip05 = (profile && profile.nip05) ? MyNostrUtils.escapeHtml(profile.nip05) : `${npub.substring(0, 13)}...`;

        const inner = `
        <div class="profile">
          <img src="${picture}" class="profile-image" alt="" onerror="this.src='${DEFAULT_PROFILE_IMAGE}'">
          <div>
            <span class="profile-name" style="color:${MyNostrUtils.getHslColor(pubkey)}">${MyNostrUtils.escapeHtml(name)}</span>
            <span class="profile-nip05">${nip05}</span>
          </div>
        </div>`;

        if (!link) return inner;
        return `<a href="?id=${npub}" class="profile-link" style="text-decoration:none; color:inherit;">${inner}</a>`;
    }

    // ========================================
    // 引用カード（nostr: 参照の展開・入れ子は1階層まで）
    // ========================================

    async function buildEventPreviewCard(event, nip19Id) {
        const profile = await fetchProfile(event.pubkey);
        const date = new Date(event.created_at * 1000).toLocaleString();
        const label = getPostTypeLabel(event.kind);
        const rawContent = event.kind === 40 || event.kind === 41
            ? (() => { try { return JSON.parse(event.content).name || event.content; } catch (e) { return event.content; } })()
            : (event.content || '');
        const shortContent = rawContent.length > 150 ? rawContent.substring(0, 150) + '...' : rawContent;

        // 入れ子カードはこれ以上展開しない（無限再帰防止）簡易フォーマット
        let contentHtml = MyNostrUtils.escapeHtml(shortContent).replace(/\n/g, '<br>');
        contentHtml = MyNostrUtils.linkify(contentHtml, { expandMedia: false });

        return `
        <a href="?id=${nip19Id}" class="quote-link">
          <div class="related-post-card">
            ${createProfileHtml(event.pubkey, profile, false)}
            <div class="post-info">
              <span>${date}</span>
              <span>${label}</span>
            </div>
            <div class="post-content"><p class="post-text">${contentHtml}</p></div>
          </div>
        </a>`;
    }

    async function createNostrCard(nip19Id) {
        let decoded;
        try {
            decoded = NostrTools.nip19.decode(nip19Id);
        } catch (e) {
            return `<div class="related-post-card">無効なNostr IDです</div>`;
        }

        if (decoded.type === 'npub' || decoded.type === 'nprofile') {
            const pubkey = decoded.data.pubkey || decoded.data;
            const hintRelays = decoded.data.relays || [];
            const profile = await fetchProfile(pubkey, hintRelays);
            const npub = NostrTools.nip19.npubEncode(pubkey);
            return `
          <a href="?id=${npub}" class="quote-link">
            <div class="related-post-card">
              ${createProfileHtml(pubkey, profile, false)}
              <div class="post-content">${MyNostrUtils.escapeHtml((profile && profile.about) || '')}</div>
            </div>
          </a>`;
        }

        if (decoded.type === 'naddr') {
            const relays = getPriorityRelays(decoded.data.relays || []);
            try {
                const ev = await tweetApi.fetchAddrEvent(
                    { addrKind: decoded.data.kind, pubkey: decoded.data.pubkey, identifier: decoded.data.identifier },
                    relays, 8000, '記事取得タイムアウト'
                );
                if (!ev) return `<div class="related-post-card">記事が見つかりませんでした</div>`;
                return await buildEventPreviewCard(ev, nip19Id);
            } catch (e) {
                return `<div class="related-post-card">記事の取得に失敗しました</div>`;
            }
        }

        let eventId = null;
        let hintRelays = [];
        if (decoded.type === 'note') {
            eventId = decoded.data;
        } else if (decoded.type === 'nevent') {
            eventId = decoded.data.id;
            hintRelays = decoded.data.relays || [];
        } else {
            return null;
        }

        const event = await fetchEventById(eventId, hintRelays);
        if (!event) return `<div class="related-post-card">イベントが見つかりませんでした</div>`;
        return await buildEventPreviewCard(event, nip19Id);
    }

    // ========================================
    // リプライ元プレビュー（kind:1 / 1111 / 42 で共通）
    // ========================================

    /**
     * リプライ先があれば、プレビューカード入りの .reply-context の HTML を返す。
     * リプライ先が無ければ空文字。取得できなかった場合は「見つかりませんでした」表示。
     */
    async function buildReplyBannerHtml(event) {
        const replyTag = getReplyTargetTag(event);
        if (!replyTag) return '';

        const targetId = replyTag[1];
        const hintRelay = replyTag[2] ? [replyTag[2]] : [];
        const targetEvent = await fetchEventById(targetId, hintRelay);

        if (targetEvent) {
            const targetNevent = NostrTools.nip19.neventEncode({
                id: targetEvent.id,
                author: targetEvent.pubkey,
                kind: targetEvent.kind,
                relays: hintRelay
            });
            const card = await buildEventPreviewCard(targetEvent, targetNevent);
            return `<div class="reply-context">${card}<p class="post-link-label">　</p></div>`;
        }
        return `<div class="reply-context"><p class="post-link-label">↩️ リプライ先</p><div class="related-post-card">元投稿（${targetId.substring(0, 8)}）が見つかりませんでした</div></div>`;
    }

    // ========================================
    // メインイベント種別ごとのレンダリング
    // ========================================

    async function renderStandardPost(event, originalId) {
        const profile = await fetchProfile(event.pubkey);
        const contentHtml = (event.kind === 30023 && window.marked)
            ? window.marked.parse(event.content || '')
            : await formatPostContent(event.content, event.tags);

        const date = new Date(event.created_at * 1000).toLocaleString();
        const client = (event.tags.find(t => t[0] === 'client') || [])[1] || '';

        // リプライ元プレビュー
        const replyBannerHtml = await buildReplyBannerHtml(event);

        mainEventContainer.innerHTML = `
        ${replyBannerHtml}
        <div class="own-post">
            ${createProfileHtml(event.pubkey, profile)}
            <div class="post-content">${contentHtml}</div>
            <div class="post-info">
                <span>${date}</span>
                ${client ? `<span>via ${MyNostrUtils.escapeHtml(client)}</span>` : ''}
            </div>
        </div>`;

        showCopyButton();
        if (event.kind === 1 || event.kind === 1111) showJumpButton(event.pubkey, originalId);

        // 長押しアクションは自分の投稿部分だけに限定（リプライ先カードのクリックと競合させないため）
        const ownPostEl = mainEventContainer.querySelector('.own-post');
        attachActionHandler(ownPostEl, event);

        await loadRelatedData(event.id);
    }

    async function renderRepost(event) {
        const profile = await fetchProfile(event.pubkey);
        const date = new Date(event.created_at * 1000).toLocaleString();
        const targetTag = event.tags.find(t => t[0] === 'e');
        const targetId = targetTag ? targetTag[1] : null;
        const hintRelay = (targetTag && targetTag[2]) ? [targetTag[2]] : [];

        mainEventContainer.innerHTML = `
        <div class="repost-banner">
          ${createProfileHtml(event.pubkey, profile)}
          <div class="post-info"><span>${date}</span><span>${event.kind === 6 ? 'リポストしました' : '引用リポストしました'}</span></div>
        </div>
        <div id="repost-target"><p style="color:#888;">元投稿を読み込み中...</p></div>`;

        showCopyButton();
        // ネストされた元投稿プレビューと長押し操作が競合しないよう、
        // リポストイベント自体へのアクションは .repost-banner だけに限定する
        const bannerEl = mainEventContainer.querySelector('.repost-banner');
        attachActionHandler(bannerEl, event);

        if (!targetId) return;
        const targetEvent = await fetchEventById(targetId, hintRelay);
        const targetContainer = document.getElementById('repost-target');
        if (!targetEvent) {
            targetContainer.innerHTML = `<p style="color:#ccc; padding:0.5rem;">元投稿（${targetId.substring(0, 8)}）が見つかりませんでした</p>`;
            return;
        }
        const targetProfile = await fetchProfile(targetEvent.pubkey);
        const targetContentHtml = await formatPostContent(targetEvent.content, targetEvent.tags);
        targetContainer.innerHTML = `
        <div class="related-post-card">
          ${createProfileHtml(targetEvent.pubkey, targetProfile)}
          <div class="post-content">${targetContentHtml}</div>
          <div class="post-info"><span>${new Date(targetEvent.created_at * 1000).toLocaleString()}</span></div>
        </div>`;

        await loadRelatedData(event.id);
    }

    async function renderReactionEvent(event) {
        const profile = await fetchProfile(event.pubkey);
        const rawEmoji = (event.content && event.content.trim() !== '') ? event.content.trim() : '+';
        const emojiHtml = await formatEmojiOnly(rawEmoji, event.tags);
        const date = new Date(event.created_at * 1000).toLocaleString();

        const eTags = (event.tags || []).filter(t => t[0] === 'e');
        const targetTag = eTags.find(t => t[3] === 'reply') || eTags[eTags.length - 1] || null;
        const targetId = targetTag ? targetTag[1] : null;
        const hintRelay = (targetTag && targetTag[2]) ? [targetTag[2]] : [];

        mainEventContainer.innerHTML = `
        <div class="reaction-container">
          <div class="reaction-headline">
            <span class="reaction-headline-emoji">${emojiHtml}</span>
            <span></span>
          </div>
          ${createProfileHtml(event.pubkey, profile)}
          <div class="post-info"><span>${date}</span></div>
        </div>
        <div id="reaction-target"><p style="color:#888;">対象の投稿を読み込み中...</p></div>`;

        showCopyButton();
        const reactionEl = mainEventContainer.querySelector('.reaction-container');
        attachActionHandler(reactionEl, event);

        if (!targetId) return;
        const targetEvent = await fetchEventById(targetId, hintRelay);
        const targetContainer = document.getElementById('reaction-target');
        if (!targetEvent) {
            targetContainer.innerHTML = `<p style="color:#ccc; padding:0.5rem;">対象の投稿（${targetId.substring(0, 8)}）が見つかりませんでした</p>`;
            return;
        }
        const targetProfile = await fetchProfile(targetEvent.pubkey);
        const targetContentHtml = await formatPostContent(targetEvent.content, targetEvent.tags);
        targetContainer.innerHTML = `
        <div class="related-post-card">
          ${createProfileHtml(targetEvent.pubkey, targetProfile)}
          <div class="post-content">${targetContentHtml}</div>
          <div class="post-info"><span>${new Date(targetEvent.created_at * 1000).toLocaleString()}</span></div>
        </div>`;
    }

    async function renderChannelRoot(event) {
        let metadata = {};
        try { metadata = JSON.parse(event.content); } catch (e) { /* noop */ }

        const channelId = event.kind === 40 ? event.id : ((event.tags.find(t => t[0] === 'e') || [])[1] || event.id);
        const meta = await fetchChannelMeta(channelId);
        const name = metadata.name || meta.name;
        const about = metadata.about || meta.about || '説明はありません';
        const picture = metadata.picture || meta.picture || '';

        mainEventContainer.innerHTML = `
        <div class="channel-card">
          <div class="channel-card-header">
            ${picture
                ? `<img src="${picture}" class="channel-picture" onerror="this.style.display='none'">`
                : `<div class="channel-picture channel-picture-placeholder">💬</div>`}
            <div>
              <h2 class="channel-name">${MyNostrUtils.escapeHtml(name)}</h2>
              <code class="channel-kind-label">${event.kind === 40 ? 'Kind 40（チャンネル作成）' : 'Kind 41（チャンネル情報更新）'}</code>
            </div>
          </div>
          <p class="channel-about">${MyNostrUtils.escapeHtml(about)}</p>
          <button id="load-channel-messages" class="channel-load-btn">このチャンネルのメッセージを読み込む</button>
        </div>
        <div id="channel-messages"></div>`;

        showCopyButton();
        document.getElementById('load-channel-messages')?.addEventListener('click', () => loadChannelMessages(channelId));
    }

    async function loadChannelMessages(channelId) {
        const container = document.getElementById('channel-messages');
        container.innerHTML = `<p style="color:#888; padding:0.5rem;">メッセージを読み込み中...</p>`;
        try {
            // 取得・古い順ソート・投稿者プロフィールの先読みまで api 側で行う
            const events = await tweetApi.fetchChannelMessages(channelId);

            if (events.length === 0) {
                container.innerHTML = `<p style="color:#888; padding:0.5rem;">メッセージが見つかりませんでした</p>`;
                return;
            }

            const rows = await Promise.all(events.map(ev => buildChatRow(ev)));
            container.innerHTML = `<div class="chat-list">${rows.join('')}</div>`;
        } catch (e) {
            console.error('チャンネルメッセージ取得失敗:', e);
            container.innerHTML = `<p style="color:#c00; padding:0.5rem;">メッセージの取得に失敗しました</p>`;
        }
    }

    async function buildChatRow(event) {
        const profile = tweetApi.getCachedProfile(event.pubkey);
        const name = MyNostrUtils.getDisplayName(profile, event.pubkey);
        const picture = (profile && profile.picture) ? profile.picture : DEFAULT_PROFILE_IMAGE;
        const npub = NostrTools.nip19.npubEncode(event.pubkey);
        const time = new Date(event.created_at * 1000).toLocaleTimeString();
        const contentHtml = await formatPostContent(event.content, event.tags, { expandMedia: false });
        const nevent = NostrTools.nip19.neventEncode({ id: event.id, author: event.pubkey, kind: 42 });

        return `
        <div class="chat-row" id="msg-${event.id}">
          <img src="${picture}" class="chat-avatar" onerror="this.src='${DEFAULT_PROFILE_IMAGE}'">
          <div class="chat-body">
            <div class="chat-meta">
              <a href="?id=${npub}" class="chat-name">${MyNostrUtils.escapeHtml(name)}</a>
              <a href="?id=${nevent}" class="chat-time">${time}</a>
            </div>
            <div class="chat-bubble">${contentHtml}</div>
          </div>
        </div>`;
    }

    async function renderChannelMessage(event) {
        const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root') || event.tags.find(t => t[0] === 'e');
        const channelId = rootTag ? rootTag[1] : null;
        const relayHint = (rootTag && rootTag[2]) ? [rootTag[2]] : [];

        const profile = await fetchProfile(event.pubkey);
        const contentHtml = await formatPostContent(event.content, event.tags);
        const date = new Date(event.created_at * 1000).toLocaleString();

        let channelBannerHtml = '';
        if (channelId) {
            const meta = await fetchChannelMeta(channelId, relayHint);
            const channelNevent = NostrTools.nip19.neventEncode({ id: channelId, relays: relayHint });
            channelBannerHtml = `
          <a href="?id=${channelNevent}" class="channel-context-banner">
            💬 チャンネル: <span class="channel-context-name">${MyNostrUtils.escapeHtml(meta.name)}</span>
          </a>`;
        }

        // リプライ元プレビュー（kind:42同士の相互リプライに対応）
        const replyBannerHtml = await buildReplyBannerHtml(event);

        mainEventContainer.innerHTML = `
        ${channelBannerHtml}
        ${replyBannerHtml}
        <div class="own-post">
            ${createProfileHtml(event.pubkey, profile)}
            <div class="post-content">${contentHtml}</div>
            <div class="post-info"><span>${date}</span></div>
        </div>`;

        showCopyButton();

        // 長押しアクションは自分のメッセージ部分だけに限定
        // （channel-context-banner・reply-contextの<a>クリックと競合させないため）
        const ownPostEl = mainEventContainer.querySelector('.own-post');
        attachActionHandler(ownPostEl, event);

        await loadRelatedData(event.id);
    }

    function renderGenericEvent(event) {
        mainEventContainer.innerHTML = `
        <div class="generic-event-card">
          <h3>未対応のイベント種別です（Kind: ${event.kind}）</h3>
          <pre class="generic-event-json">${MyNostrUtils.escapeHtml(JSON.stringify(event, null, 2))}</pre>
        </div>`;
        showCopyButton();
    }

    /**
     * kind に応じて描画関数を振り分ける。
     * @returns {Promise<void>|void}
     */
    function renderEventByKind(event, originalId) {
        switch (event.kind) {
            case 1:
            case 1111:
            case 30023:
                return renderStandardPost(event, originalId);
            case 6:
            case 16:
                return renderRepost(event);
            case 7:
                return renderReactionEvent(event);
            case 40:
            case 41:
                return renderChannelRoot(event);
            case 42:
                return renderChannelMessage(event);
            default:
                return renderGenericEvent(event);
        }
    }

    // ========================================
    // 関連データ（リプライ・リアクション・リポスト）
    // ========================================

    async function loadRelatedData(eventId) {
        try {
            // 取得・重複排除・自分自身の除外・プロフィール先読みまで api 側で行う
            const { replies, reactions, reposts } = await tweetApi.fetchRelated(eventId);

            if (reactions.length > 0) renderReactionsList(reactions);
            if (replies.length > 0 || reposts.length > 0) {
                await renderRelatedList(replies, reposts);
            }
        } catch (e) {
            console.error('関連データ取得失敗:', e);
        }
    }

    function renderReactionsList(reactions) {
        const groups = new Map();
        reactions.forEach(r => {
            const emoji = (r.content || '+').trim() || '+';
            if (!groups.has(emoji)) groups.set(emoji, { pubkeys: new Set(), tags: r.tags });
            groups.get(emoji).pubkeys.add(r.pubkey);
        });

        let html = '';
        for (const [emoji, group] of groups.entries()) {
            const displayEmoji = emoji === '+' ? '⭐' : emoji;
            const emojiMap = new Map();
            (group.tags || []).filter(t => t[0] === 'emoji' && t[1] && t[2]).forEach(([, code, url]) => emojiMap.set(`:${code}:`, url));
            const emojiHtml = emojiMap.has(displayEmoji)
                ? `<img src="${emojiMap.get(displayEmoji)}" class="custom-emoji" alt="${displayEmoji}">`
                : MyNostrUtils.escapeHtml(displayEmoji);

            const avatars = Array.from(group.pubkeys).map(pk => {
                const profile = tweetApi.getCachedProfile(pk);
                const pic = (profile && profile.picture) ? profile.picture : DEFAULT_PROFILE_IMAGE;
                const npub = NostrTools.nip19.npubEncode(pk);
                const name = MyNostrUtils.getDisplayName(profile, pk);
                return `<a href="?id=${npub}"><img src="${pic}" class="reaction-avatar" title="${MyNostrUtils.escapeHtml(name)}" onerror="this.src='${DEFAULT_PROFILE_IMAGE}'"></a>`;
            }).join('');

            html += `
          <div class="reaction-group">
            <span class="reaction-emoji">${emojiHtml}</span>
            <div class="reaction-avatars">${avatars}</div>
          </div>`;
        }
        reactionsList.innerHTML = html;
        reactionsSection.style.display = 'block';
    }

    async function renderRelatedList(replies, reposts) {
        const all = [
            ...replies.map(e => ({ event: e, label: e.kind === 42 ? 'チャンネル返信' : 'リプライ' })),
            ...reposts.map(e => ({ event: e, label: e.kind === 6 ? 'リポスト' : '引用リポスト' }))
        ];
        all.sort((a, b) => a.event.created_at - b.event.created_at);

        const cards = await Promise.all(all.map(async ({ event, label }) => {
            const profile = tweetApi.getCachedProfile(event.pubkey);
            const date = new Date(event.created_at * 1000).toLocaleString();
            let bodyHtml;
            if (event.kind === 6) {
                const repostUser = MyNostrUtils.getDisplayName(profile, event.pubkey);
                bodyHtml = `<div class="post-content">${MyNostrUtils.escapeHtml(repostUser)}さんがリポストしました</div>`;
            } else {
                bodyHtml = `<div class="post-content">${await formatPostContent(event.content, event.tags, { expandMedia: false })}</div>`;
            }
            const nevent = NostrTools.nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind });
            // カード全体を<a>で覆う構造は、長押し操作（このカード自体へのいいね/RT等）と
            // クリックナビゲーションが競合するためやめ、詳細ページへのリンクはラベル部分だけに限定する。
            // カードの id にイベントIDを埋め込み、挿入後に長押しハンドラーを紐付けられるようにする。
            return `
          <div class="related-post-card long-pressable" id="related-${event.id}">
            ${createProfileHtml(event.pubkey, profile, false)}
            <div class="post-info">
              <span>${date}</span>
              <a href="?id=${nevent}" class="post-link-label">${label}</a>
            </div>
            ${bodyHtml}
          </div>`;
        }));

        relatedEventsList.innerHTML = cards.join('');
        relatedEventsSection.style.display = 'block';

        // 挿入後のDOMに対して、カードごとに長押しアクションを紐付ける
        all.forEach(({ event }) => {
            const card = document.getElementById(`related-${event.id}`);
            if (card) attachActionHandler(card, event);
        });
    }

    // ========================================
    // プロフィールページ
    // ========================================

    /**
     * @returns {Promise<boolean>} プロフィールが見つかって描画できたら true、見つからなければ false
     *   （false の場合のフォールバックUIは呼び出し側が判断して出す）
     */
    async function renderProfilePage(pubkey, hintRelays) {

        // 取得・パース・キャッシュ登録は api 側。タイムアウト等の例外はそのまま呼び出し側へ伝わる
        const result = await tweetApi.fetchProfileEvent(pubkey, hintRelays);

        if (!result) {
            return false;
        }
        const { event: profileEvent, profile } = result;

        const npub = NostrTools.nip19.npubEncode(pubkey);
        const aboutHtml = await formatPostContent(profile.about || '', profileEvent.tags);

        mainEventContainer.innerHTML = `
        <div class="profile-card">
          <div class="profile-header">
            <img src="${profile.picture || DEFAULT_PROFILE_IMAGE}" class="profile-picture" onerror="this.src='${DEFAULT_PROFILE_IMAGE}'">
            <div class="profile-info-container">
              <h2 class="profile-name">${MyNostrUtils.escapeHtml(profile.name || profile.display_name || 'No Name')}</h2>
              <div class="npub-container">
                <span id="npub-text">${npub}</span>
                <span class="copy-icon" id="copy-npub-icon" title="npubをコピー" aria-label="npubをコピー">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" > <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect> <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </span>
                </div>
              <p class="nip05">${profile.nip05 ? MyNostrUtils.escapeHtml(profile.nip05) : 'NIP-05未設定'}</p>
            </div>
          </div>
          <p class="about-text">${aboutHtml}</p>
        </div>
        <div id="profile-posts-section" class="profile-posts-section">
        <p id="profile-posts-status" class="profile-posts-status">投稿を読み込み中...</p>
        <div id="profile-posts-list"></div>
        <button id="profile-posts-load-more" class="hidden">もっと見る</button>
        </div>`;

        document.getElementById('copy-npub-icon')?.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(npub); alert('npubをコピーしました！'); }
            catch (e) { alert('コピーに失敗しました。'); }
        });
        showCopyButton();

        // プロフィールページ：kind:1一覧を追加読み込み（待たずに非同期で進める）
        loadUserPostsList(pubkey, hintRelays);
        return true;
    }

    /**
     * プロフィールページ用：対象ユーザーのkind:1投稿一覧を取得して表示する
     * Timelineクラス（timeline.js）のDOM生成をそのまま流用する。
     */
    async function loadUserPostsList(pubkey, hintRelays) {
        const listContainer = document.getElementById('profile-posts-list');
        const statusEl = document.getElementById('profile-posts-status');
        const loadMoreBtn = document.getElementById('profile-posts-load-more');
        if (!listContainer || !statusEl) return;

        profilePostsState = { pubkey, hintRelays: hintRelays || [], oldestTimestamp: null, isLoading: false };

        // この一覧専用のTimelineインスタンスを生成する。
        // containerは renderProfilePage() の innerHTML 差し替えのたびに作り直されるため、
        // 都度 new し直す（前回分の activeElements 参照は自然に破棄される）。
        window.profileTimeline = new Timeline(listContainer, {
            timestampFormatter: formatProfileDate,
            hideAuthorInMetadata: true
        });

        if (loadMoreBtn) loadMoreBtn.classList.add('hidden');

        try {
            // 新しい順・引用先の先読み済みで返ってくる
            const events = await tweetApi.fetchUserPosts(pubkey, hintRelays);

            if (events.length === 0) {
                statusEl.textContent = '投稿が見つかりませんでした';
                return;
            }

            profilePostsState.oldestTimestamp = events[events.length - 1].created_at;

            renderProfilePostBatch(events);
            statusEl.textContent = '';

            if (loadMoreBtn) {
                const hasRenderedPosts = listContainer.children.length > 0;
                loadMoreBtn.classList.toggle('hidden', !(hasRenderedPosts && events.length >= 50));
                loadMoreBtn.onclick = () => loadMoreProfilePosts();
            }

        } catch (e) {
            console.warn('ユーザー投稿一覧取得失敗:', e.message);
            statusEl.textContent = '投稿の取得に失敗しました';
            if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
        }
    }

    /**
     * イベント配列を dataStore に登録した上で Timeline#createPostElement に渡し、
     * 生成された <li> を一覧に追加する共通処理。
     * dataStore に登録しておくことで、Timeline側の isLikedByMe（いいね済みハイライト）や
     * createContent の引用カード解決（すでにキャッシュ済みの場合のみ）が機能する。
     */
    function renderProfilePostBatch(events) {
        const listContainer = document.getElementById('profile-posts-list');
        if (!window.profileTimeline) return;

        events.forEach(ev => {
            window.dataStore.addEvent(ev);

            const li = window.profileTimeline.createPostElement(ev);
            if (li) {
                // 改行が含まれていない場合、Timelineが入れた強制改行（<br>）を消す
                const hasLineBreak = /\r?\n/.test(ev.content);
                if (!hasLineBreak) {
                    const br = li.querySelector('br');
                    if (br) br.remove();
                }

                listContainer.appendChild(li);
            }
        });
    }

    /**
     * プロフィールページの投稿一覧：もっと見る
     */
    async function loadMoreProfilePosts() {
        if (!profilePostsState || profilePostsState.isLoading) return;

        const listContainer = document.getElementById('profile-posts-list');
        const loadMoreBtn = document.getElementById('profile-posts-load-more');
        if (!listContainer || !loadMoreBtn || !window.profileTimeline) return;

        profilePostsState.isLoading = true;
        loadMoreBtn.classList.add('loading');

        try {
            const events = await tweetApi.fetchUserPosts(
                profilePostsState.pubkey,
                profilePostsState.hintRelays,
                { until: profilePostsState.oldestTimestamp - 1 }
            );

            if (events.length === 0) {
                alert('これ以上ありません');
                loadMoreBtn.classList.add('hidden');
                return;
            }

            profilePostsState.oldestTimestamp = events[events.length - 1].created_at;

            renderProfilePostBatch(events);

            const hasRenderedPosts = listContainer.children.length > 0;
            loadMoreBtn.classList.toggle('hidden', !(hasRenderedPosts && events.length >= 50));

            if (events.length < 50) {
                loadMoreBtn.classList.add('hidden');
            }

        } catch (e) {
            console.warn('もっと見る失敗:', e.message);
            alert('データの取得に失敗しました');
        } finally {
            profilePostsState.isLoading = false;
            loadMoreBtn.classList.remove('loading');
        }
    }

    // ========================================
    // 入力フォーム
    // ========================================

    function renderInputForm() {
        mainEventContainer.innerHTML = `
        <div class="input-form-container">
          <p class="form-title">イベントまたはユーザーのNostr IDを入力してください</p>
          <form id="nostr-form" class="nostr-form">
            <input type="text" id="nostr-id-input" placeholder="nevent1..., npub1..." required class="form-input">
            <button type="submit" class="form-button">表示</button>
          </form>
        </div>`;

        const form = document.getElementById('nostr-form');
        form?.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('nostr-id-input').value.trim();
            const validPrefixes = ['note1', 'nevent1', 'naddr1', 'npub1', 'nprofile1'];
            if (validPrefixes.some(p => input.startsWith(p)) || isNip05(input)) {
                window.location.href = `?id=${encodeURIComponent(input)}`;
            } else {
                alert('有効なNostr ID (note1, nevent1, naddr1, npub1, nprofile1) または NIP-05 (name@domain) を入力してください。');
            }
        });
    }

    // ========================================
    // フォールバックUI（イベント未検出・エラー時）
    // ========================================

    /**
     * originalId（入力されたnip19文字列）をそのまま各外部ビューアのURLに付与する。
     * note1/nevent1/npub1/nprofile1/naddr1 はどの形式でもlumilumi/njumpがそのまま受け付ける。
     */
    function buildExternalViewerLinks(originalId) {
        return [
            { label: 'lumilumi でひらく', url: `https://lumilumi.app/${originalId}` },
            { label: 'njump.me でひらく', url: `https://njump.me/${originalId}` },
        ];
    }

    /**
     * イベント未検出・取得エラー・描画エラー時に表示するリッチなフォールバックUI。
     *
     * 【再試行について】
     * 再試行の「中身」（どのリレーで何を取り直すか）は制御ロジックなので tweet.js の責務。
     * このビューは onRetry(relayUrl) を呼ぶだけで、tweet.js を直接参照しない。
     *
     * @param {Object} options
     * @param {string} options.originalId - URLクエリのid（nevent1...など、そのまま）
     * @param {Object} options.parsed - parseInput()の結果
     * @param {string[]} [options.triedRelays] - 実際に問い合わせたリレー一覧
     * @param {string} [options.errorMessage] - エラーメッセージ（あれば警告表示に切り替え）
     * @param {Object} [options.rawEvent] - 取得はできたが描画に失敗した場合の生イベント
     * @param {(relay:string)=>Promise<void>} [options.onRetry] - 「再試行」ボタン押下時に呼ばれる
     * @param {string} [options.retryMessage] - 再試行欄の下に出す一言（例: 「〜でも見つかりませんでした」）
     */
    function renderNotFoundFallback({
        originalId, parsed, triedRelays = [], errorMessage = null, rawEvent = null,
        onRetry = null, retryMessage = ''
    }) {
        const links = buildExternalViewerLinks(originalId);
        const linksHtml = links
            .map(l => `<a href="${l.url}" target="_blank" rel="noreferrer" class="fallback-link-btn">${MyNostrUtils.escapeHtml(l.label)}</a>`)
            .join('');

        const relayBadges = triedRelays
            .map(r => `<code class="fallback-relay-badge">${MyNostrUtils.escapeHtml(r)}</code>`)
            .join(' ') || '（なし）';

        const parsedJson = MyNostrUtils.escapeHtml(JSON.stringify(parsed, null, 2));
        const rawEventSection = rawEvent ? `
          <div class="fallback-section">
            <details>
              <summary class="fallback-label" style="cursor:pointer;">取得できた生イベント（描画に失敗）</summary>
              <pre class="fallback-json">${MyNostrUtils.escapeHtml(JSON.stringify(rawEvent, null, 2))}</pre>
            </details>
          </div>` : '';

        mainEventContainer.innerHTML = `
        <div class="fallback-card">
          <h3 class="fallback-title">${errorMessage ? '⚠️ エラーが発生しました' : '🔍 イベントが見つかりませんでした'}</h3>
          ${errorMessage ? `<p class="fallback-error-msg">${MyNostrUtils.escapeHtml(errorMessage)}</p>` : ''}

          <div class="fallback-section">
            <p class="fallback-label">入力されたID</p>
            <div class="fallback-id-row">
              <code class="fallback-id-text">${MyNostrUtils.escapeHtml(originalId)}</code>
              <button type="button" class="fallback-copy-btn" data-copy="${MyNostrUtils.escapeHtml(originalId)}">コピー</button>
            </div>
          </div>

          <div class="fallback-section">
            <p class="fallback-label">問い合わせたリレー</p>
            <div class="fallback-relay-list">${relayBadges}</div>
          </div>

          <div class="fallback-section">
            <p class="fallback-label">別のリレーで再試行</p>
            <div class="fallback-retry-row">
              <input type="text" id="fallback-retry-relay" placeholder="wss://relay.example.com/" class="fallback-retry-input">
              <button type="button" id="fallback-retry-btn" class="fallback-retry-btn">再試行</button>
            </div>
            <p id="fallback-retry-status" class="fallback-retry-status"></p>
          </div>

          <div class="fallback-section">
            <p class="fallback-label">外部クライアントで開く</p>
            <div class="fallback-link-row">${linksHtml}</div>
          </div>

          ${rawEventSection}

          <div class="fallback-section">
            <details>
              <summary class="fallback-label" style="cursor:pointer;">解析データ (JSON)</summary>
              <pre class="fallback-json">${parsedJson}</pre>
            </details>
          </div>
        </div>`;

        showCopyButton();

        // コピー機能
        mainEventContainer.querySelectorAll('.fallback-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.copy)
                    .then(() => {
                        const original = btn.textContent;
                        btn.textContent = 'コピーしました';
                        setTimeout(() => { btn.textContent = original; }, 1500);
                    })
                    .catch(() => alert('コピーに失敗しました'));
            });
        });

        // 再試行
        const retryBtn = document.getElementById('fallback-retry-btn');
        const retryInput = document.getElementById('fallback-retry-relay');
        const retryStatus = document.getElementById('fallback-retry-status');

        if (retryMessage && retryStatus) retryStatus.textContent = retryMessage;

        retryBtn?.addEventListener('click', async () => {
            const relay = retryInput.value.trim();
            if (!relay || !/^wss?:\/\//i.test(relay)) {
                retryStatus.textContent = '有効なリレーURL（wss://...）を入力してください';
                return;
            }
            if (typeof onRetry !== 'function') {
                retryStatus.textContent = 'この画面では再試行できません';
                return;
            }
            retryStatus.textContent = '取得中...';
            retryBtn.disabled = true;
            try {
                await onRetry(relay);
            } finally {
                // 成功時はDOMごと差し替わるため、失敗時のみここに戻ってくる
                if (document.getElementById('fallback-retry-btn')) {
                    retryBtn.disabled = false;
                }
            }
        });
    }

    // ========================================
    // 公開
    // ========================================
    window.TweetView = {
        // tweet.js（ルーティング）から呼ばれる入口
        renderEventByKind,
        renderProfilePage,
        renderInputForm,
        renderNotFoundFallback,

        // 他モジュール・デバッグ用に公開しておく部品
        createNostrCard,
        formatPostContent,
        createProfileHtml,
        loadChannelMessages
    };

    console.log('✅ tweet-view.js 読み込み完了');
})();