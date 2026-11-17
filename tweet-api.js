/**
 * tweet-api.js
 * 【責務】: tweet.html 用の Nostr データ取得・通信・キャッシュ（DOM には触れない）
 *
 * - SimplePool（複数リレー横断検索）とキャッシュはすべてここが持つ。
 * - 呼び出し側（tweet.js）は pool やキャッシュに直接触れず、window.tweetApi のメソッドだけを使う。
 * - 例外的に、引用先の先読み（prefetchNostrReferences）だけは共有モデル window.dataStore に書き込む。
 * - 読み込み順: nostr-tools → data-store.js → tweet-utils.js → tweet-api.js → tweet.js
 */
(function () {
    'use strict';

    const { withTimeout, normalizeNip05, parseInput, CONFIG } = window.TweetUtils;
    const { FALLBACK_RELAYS, MAX_RELAYS_PER_QUERY, DEFAULT_MAIN_RELAY } = CONFIG;

    class TweetApi {
        constructor() {
            // nostr-tools v2: SimplePool は 'wss://relay/' のような複数リレーを
            // 横断してイベントを探す責務を持つ（単一接続専用のRelayManagerとは役割が異なる）
            this.pool = new NostrTools.SimplePool({ eoseSubTimeout: 6000 });

            // キャッシュ（同一セッション内での再取得を防ぐ）
            this.profileCache = new Map();     // pubkey -> profile object | null
            this.eventCache = new Map();       // eventId -> event | null
            this.channelMetaCache = new Map(); // channelId -> { name, about, picture }
        }

        // ========================================
        // リレー選択（リレー選択ロジックの唯一の関所）
        // ========================================

        getPriorityRelays(hintRelays) {
            const cleaned = (hintRelays || []).filter(Boolean);
            const combined = [...new Set([...cleaned, ...FALLBACK_RELAYS])];
            const relays = combined.slice(0, MAX_RELAYS_PER_QUERY);
            console.log('🔌 使用リレー:', relays);
            return relays;
        }

        /**
         * 本体(flowgazer)が使っているメインリレーのURLを取得する。
         * localStorage の 'relayUrl' は本体(app.js)と共有されるキーなので、
         * 本体でリレーを変更していればそれを引き継ぎ、未設定ならデフォルトに揃える。
         */
        getMainRelayUrl() {
            return localStorage.getItem('relayUrl') || DEFAULT_MAIN_RELAY;
        }

        /**
         * 署名済みイベントを本体と同じメインリレーへpublishする。
         * SimplePool.publish() はリレーごとのPromiseを配列で返すため、
         * 1件でも成功すればOKとする（Promise.any）。
         */
        async publishToMainRelay(signedEvent) {
            const relay = this.getMainRelayUrl();
            const results = this.pool.publish([relay], signedEvent);
            await withTimeout(Promise.any(results), 8000, 'リレーへの送信がタイムアウトしました');
            return relay;
        }

        close() {
            try { this.pool.close(FALLBACK_RELAYS); } catch (e) { /* noop */ }
        }

        // ========================================
        // プロフィール
        // ========================================

        /** キャッシュ済みプロフィールを返す（未取得なら undefined、取得失敗なら null） */
        getCachedProfile(pubkey) {
            return this.profileCache.get(pubkey);
        }

        async fetchProfile(pubkey, hintRelays) {
            if (this.profileCache.has(pubkey)) return this.profileCache.get(pubkey);
            const relays = this.getPriorityRelays(hintRelays);
            try {
                const event = await withTimeout(
                    this.pool.get(relays, { kinds: [0], authors: [pubkey] }),
                    8000, 'プロフィール取得タイムアウト'
                );
                if (event) {
                    const profile = JSON.parse(event.content);
                    this.profileCache.set(pubkey, profile);
                    return profile;
                }
            } catch (e) {
                console.warn('プロフィール取得失敗:', pubkey.substring(0, 8), e.message);
            }
            this.profileCache.set(pubkey, null);
            return null;
        }

        /**
         * プロフィールページ用：kind:0 イベント本体（tags が必要なため）とパース済みプロフィールを返す。
         * 見つからなければ null。タイムアウト等の例外は握りつぶさず呼び出し側に伝える。
         * @returns {Promise<{event:Object, profile:Object}|null>}
         */
        async fetchProfileEvent(pubkey, hintRelays) {
            const relays = this.getPriorityRelays(hintRelays);
            const event = await withTimeout(
                this.pool.get(relays, { kinds: [0], authors: [pubkey] }),
                10000, 'プロフィール取得タイムアウト'
            );
            if (!event) return null;

            let profile;
            try { profile = JSON.parse(event.content); } catch (e) { profile = {}; }
            this.profileCache.set(pubkey, profile);
            return { event, profile };
        }

        async fetchProfilesBatch(pubkeys, hintRelays) {
            const uncached = [...new Set(pubkeys)].filter(pk => pk && !this.profileCache.has(pk));
            if (uncached.length === 0) return;
            const relays = this.getPriorityRelays(hintRelays);
            const latestByPubkey = new Map();
            try {
                const events = await withTimeout(
                    this.pool.querySync(relays, { kinds: [0], authors: uncached }),
                    8000, 'プロフィール一括取得タイムアウト'
                );
                events.forEach(ev => {
                    const current = latestByPubkey.get(ev.pubkey);
                    if (!current || ev.created_at > current.created_at) latestByPubkey.set(ev.pubkey, ev);
                });
            } catch (e) {
                console.warn('プロフィール一括取得失敗:', e.message);
            }

            uncached.forEach(pk => {
                const ev = latestByPubkey.get(pk);
                if (ev) {
                    try { this.profileCache.set(pk, JSON.parse(ev.content)); }
                    catch (e) { this.profileCache.set(pk, null); }
                } else if (!this.profileCache.has(pk)) {
                    this.profileCache.set(pk, null);
                }
            });
        }

        // ========================================
        // イベント
        // ========================================

        async fetchEventById(id, hintRelays) {
            if (this.eventCache.has(id)) return this.eventCache.get(id);
            const relays = this.getPriorityRelays(hintRelays);
            try {
                const event = await withTimeout(
                    this.pool.get(relays, { ids: [id] }),
                    10000, 'イベント取得タイムアウト'
                );
                this.eventCache.set(id, event || null);
                return event || null;
            } catch (e) {
                console.warn('イベント取得失敗:', id.substring(0, 8), e.message);
                this.eventCache.set(id, null);
                return null;
            }
        }

        /**
         * 「別のリレーで再試行」用。fetchEventById() のキャッシュ（未検出=null）を踏まないよう、
         * 指定リレーのみに直接問い合わせる。見つかればキャッシュを更新する。
         * 例外は呼び出し側に伝える。
         */
        async fetchEventFromRelays(id, relays) {
            const event = await withTimeout(
                this.pool.get(relays, { ids: [id] }),
                10000, '再取得タイムアウト'
            );
            if (event) this.eventCache.set(id, event);
            return event || null;
        }

        /**
         * naddr（アドレサブルイベント）を取得する。
         * @param {{addrKind:number, pubkey:string, identifier:string}} addr
         * @param {string[]} relays - 解決済みのリレー一覧（呼び出し側で getPriorityRelays 済み）
         */
        fetchAddrEvent(addr, relays, timeoutMs = 10000, label = '記事取得タイムアウト') {
            return withTimeout(
                this.pool.get(relays, {
                    kinds: [addr.addrKind],
                    authors: [addr.pubkey],
                    '#d': [addr.identifier]
                }),
                timeoutMs, label
            );
        }

        // ========================================
        // チャンネル
        // ========================================

        async fetchChannelMeta(channelId, hintRelays) {
            if (this.channelMetaCache.has(channelId)) return this.channelMetaCache.get(channelId);
            const relays = this.getPriorityRelays(hintRelays);
            let meta = null;

            // kind:41（チャンネル情報更新）を優先
            try {
                const metaEvents = await withTimeout(
                    this.pool.querySync(relays, { kinds: [41], '#e': [channelId] }),
                    6000, 'チャンネル情報(kind41)取得タイムアウト'
                );
                if (metaEvents.length > 0) {
                    metaEvents.sort((a, b) => b.created_at - a.created_at);
                    const parsed = JSON.parse(metaEvents[0].content);
                    meta = { name: parsed.name || null, about: parsed.about || null, picture: parsed.picture || null };
                }
            } catch (e) {
                console.warn('kind41取得失敗:', e.message);
            }

            // 名前が取れなければ kind:40（チャンネル作成）で補完
            if (!meta || !meta.name) {
                try {
                    const createEvent = await withTimeout(
                        this.pool.get(relays, { kinds: [40], ids: [channelId] }),
                        6000, 'チャンネル情報(kind40)取得タイムアウト'
                    );
                    if (createEvent) {
                        const parsed = JSON.parse(createEvent.content);
                        meta = meta || {};
                        meta.name = meta.name || parsed.name || null;
                        meta.about = meta.about || parsed.about || null;
                        meta.picture = meta.picture || parsed.picture || null;
                    }
                } catch (e) {
                    console.warn('kind40取得失敗:', e.message);
                }
            }

            const result = meta || {};
            result.name = result.name || `Channel ${channelId.substring(0, 8)}`;
            result.about = result.about || null;
            result.picture = result.picture || null;
            this.channelMetaCache.set(channelId, result);
            return result;
        }

        /**
         * チャンネルのメッセージ(kind:42)を古い順で取得し、投稿者のプロフィールも先読みする。
         * 例外は呼び出し側に伝える。
         */
        async fetchChannelMessages(channelId) {
            const relays = this.getPriorityRelays();
            const events = await withTimeout(
                this.pool.querySync(relays, { kinds: [42], '#e': [channelId], limit: 50 }),
                10000, 'メッセージ取得タイムアウト'
            );
            events.sort((a, b) => a.created_at - b.created_at);
            if (events.length > 0) {
                await this.fetchProfilesBatch(events.map(e => e.pubkey));
            }
            return events;
        }

        // ========================================
        // 関連データ（リプライ・リアクション・リポスト）
        // ========================================

        /**
         * 指定イベントへの返信・リアクション・リポストを取得する。
         * 個々の取得失敗は空配列として扱い、全体は止めない。
         * 関連イベントの投稿者プロフィールも先読みする。
         * @returns {Promise<{replies:Object[], reactions:Object[], reposts:Object[]}>}
         */
        async fetchRelated(eventId) {
            const relays = this.getPriorityRelays();
            const query = (filter, label) =>
                withTimeout(this.pool.querySync(relays, filter), 10000, `${label}タイムアウト`)
                    .catch(e => { console.warn(`${label}失敗:`, e.message); return []; });

            const [replies, rootComments, reactions, reposts] = await Promise.all([
                // 親が自分（kind:1 / 42 の返信 + kind:1111 の直接コメント）
                query({ kinds: [1, 42, 1111], '#e': [eventId] }, '返信取得'),
                // ルートが自分の kind:1111（孫コメント以降も含める。大文字 E）
                query({ kinds: [1111], '#E': [eventId] }, 'コメント取得'),
                query({ kinds: [7], '#e': [eventId] }, 'リアクション取得'),
                query({ kinds: [6, 16], '#e': [eventId] }, 'リポスト取得')
            ]);

            // id で重複排除してマージし、自分自身は除く
            const mergedReplies = [...new Map(
                [...replies, ...rootComments].map(e => [e.id, e])
            ).values()].filter(e => e.id !== eventId);

            await this.fetchProfilesBatch(
                [...mergedReplies, ...reactions, ...reposts].map(e => e.pubkey)
            );

            return { replies: mergedReplies, reactions, reposts };
        }

        // ========================================
        // プロフィールページの投稿一覧
        // ========================================

        /**
         * ユーザーの kind:1 / 1111 投稿を新しい順で取得する。
         * 本文中の nostr: 引用先も先読みする（1件以上取得できたときのみ）。
         * @param {string} pubkey
         * @param {string[]} hintRelays
         * @param {Object} [options]
         * @param {number} [options.until] - この時刻以前（含む）のみ取得。「もっと見る」では oldest - 1 を渡す
         * @param {number} [options.limit=50]
         * @returns {Promise<Object[]>}
         */
        async fetchUserPosts(pubkey, hintRelays, { until = null, limit = 50 } = {}) {
            const relays = this.getPriorityRelays(hintRelays);
            const filter = { kinds: [1, 1111], authors: [pubkey], limit };
            if (until !== null) filter.until = until;

            const events = await withTimeout(
                this.pool.querySync(relays, filter),
                10000, '投稿一覧取得タイムアウト'
            );
            if (events.length === 0) return events;

            events.sort((a, b) => b.created_at - a.created_at);
            await this.prefetchNostrReferences(events, relays);
            return events;
        }

        /**
         * 取得したイベント群の本文中にある nostr: 参照（nevent, noteなど）をスキャンし、
         * まだデータストアにないものをリレーから一括で先読みしてキャッシュする。
         * これにより、タイムライン描画時に引用プレビューやインラインRTが正しく機能するようになる。
         */
        async prefetchNostrReferences(events, relays) {
            const targetIds = new Set();
            const nip19Regex = /nostr:(npub1|nevent1|note1|nprofile1|nrelay1)[a-zA-Z0-9]+/g;

            // 1. 全イベントの本文から nostr: リンクを探してIDを抽出する
            events.forEach(ev => {
                if (!ev.content) return;
                const matches = ev.content.match(nip19Regex);
                if (!matches) return;

                matches.forEach(match => {
                    const nip19Str = match.replace('nostr:', '');
                    try {
                        const decoded = window.NostrTools.nip19.decode(nip19Str);
                        if (decoded.type === 'nevent' && decoded.data?.id) {
                            targetIds.add(decoded.data.id);
                        } else if (decoded.type === 'note' && decoded.data) {
                            targetIds.add(decoded.data);
                        }
                    } catch (e) {
                        // デコード失敗は無視
                    }
                });
            });

            if (targetIds.size === 0) return;

            // 2. すでに dataStore にあるものは省く
            const missingIds = Array.from(targetIds).filter(id => !window.dataStore.getEvent(id));
            if (missingIds.length === 0) return;

            console.log(`🔍 引用先の投稿を先読みします: ${missingIds.length}件`);

            try {
                // 3. 不足しているものをリレーに問い合せる
                const referencedEvents = await this.pool.querySync(relays, { ids: missingIds });

                // 4. dataStore に突っ込んでおく
                referencedEvents.forEach(ev => window.dataStore.addEvent(ev));
                console.log(`✨ 引用先の先読み完了: ${referencedEvents.length}件取得`);
            } catch (e) {
                console.warn('引用先の先読み失敗:', e.message);
            }
        }

        // ========================================
        // 入力の解決（NIP-05 は通信が必要なためここに置く）
        // ========================================

        /**
         * parseInput の非同期ラッパー。
         * NIP-05（省略形含む）なら .well-known/nostr.json を引いて { kind:'profile' } に正規化する。
         * 解決に失敗した場合は { kind:'nip05-error' } を返す。
         */
        async resolveInput(raw) {
            const input = (raw || '').trim();
            if (!input) return null;

            const nip05 = normalizeNip05(input);
            if (nip05) {
                try {
                    const p = await withTimeout(
                        NostrTools.nip05.queryProfile(nip05),
                        8000, 'NIP-05解決タイムアウト'
                    );
                    if (!p?.pubkey) {
                        return { kind: 'nip05-error', nip05, message: 'アドレスが見つかりませんでした' };
                    }
                    return { kind: 'profile', pubkey: p.pubkey, relays: p.relays || [], nip05 };
                } catch (e) {
                    return { kind: 'nip05-error', nip05, message: e.message };
                }
            }

            return parseInput(input);
        }

        // ========================================
        // カスタム絵文字（cusemo.js の取得経路差し替え用）
        // ========================================

        /**
         * cusemo.js の queryProvider として使う。
         * tweet.html は relayManager を持たないため、SimplePool 経由で取得する。
         * @param {Object[]} filters
         * @returns {Promise<Object[]>}
         */
        async queryEmojiEvents(filters) {
            const relays = this.getPriorityRelays([this.getMainRelayUrl()]);
            const results = await Promise.all(filters.map(f =>
                withTimeout(this.pool.querySync(relays, f), 8000, 'カスタム絵文字取得タイムアウト')
                    .catch(() => [])
            ));
            return results.flat();
        }
    }

    window.TweetApi = TweetApi;
    window.tweetApi = new TweetApi();

    console.log('✅ tweet-api.js 読み込み完了');
})();