/**
 * ehagaki-manager.js
 * 【責務】: eHagaki埋め込みモーダルの管理・postMessage仲介・storage/idb委譲
 *
 * kit-ten.html 専用のオプション機能。
 * app.js / timeline.js からは window.ehagakiManager?.xxx?.() の形で
 * 疎結合に呼び出される前提のため、このファイルを読み込まない
 * index.html / index2.html でも安全に動作する（何も起きないだけ）。
 *
 * 元々 kit-ten.html 内のインラインスクリプトだった内容を、
 * 他ページから独立したモジュールとして切り出したもの。
 */
(function () {
    'use strict';

    console.log('✅ ehagaki-manager.js 読み込み完了');

    // --- eHagaki 管理マネージャー ---
    window.ehagakiManager = {
        ORIGIN: 'https://lokuyow.github.io',
        NS: 'ehagaki.embed',
        VERSION: 1,

        // 🆕 チャンネル投稿モードで開いている場合の channelId を保持する。
        // post.success 受信時にタイムラインの該当チャンネルタブを自動で開くために使う。
        _activeChannelId: null,

        // 🆕 preloadedEvents付きcomposer.setContextの送信予約。
        // open()でURLクエリ起動した直後は iframe がまだ ready を送っていないため、
        // ready受信後に送るためにここへ一時保持する。
        _pendingPreload: null,

        get modal() { return document.getElementById('ehagaki-modal'); },
        get iframe() { return document.getElementById('ehagaki-iframe'); },

        /**
         * 一意な requestId を生成する。
         * crypto.randomUUID が使える環境ではそれを優先し、
         * 使えない環境（非セキュアコンテキスト等）では時刻+乱数でフォールバックする。
         * どちらの場合も空文字にはならない。
         * @param {string} prefix
         * @returns {string}
         */
        _generateRequestId(prefix) {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return `${prefix}-${crypto.randomUUID()}`;
            }
            return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        },

        /**
         * 🆕 originalEvent配列から preloadedEvents 辞書を組み立てる。
         * composer.setContext の payload.preloadedEvents は
         * { [eventId]: { id, pubkey, created_at, kind, tags, content, sig } } の形式。
         * 署名フィールド(sig)が無いイベント（未検証・未取得）は対象外にする。
         * @param {Object[]} events - originalEvent の配列（null/undefined混在可）
         * @returns {Object|null} 1件も無ければ null
         */
        _buildPreloadedEvents(events) {
            const list = (events || []).filter(ev => ev?.id && ev?.sig);
            if (list.length === 0) return null;

            const result = {};
            for (const ev of list) {
                result[ev.id] = {
                    id: ev.id,
                    pubkey: ev.pubkey,
                    created_at: ev.created_at,
                    kind: ev.kind,
                    tags: ev.tags,
                    content: ev.content,
                    sig: ev.sig
                };
            }
            return result;
        },

        /**
         * 🆕 open()で予約したpreloadedEvents付きcomposer.setContextを送信する。
         * iframeの'ready'受信後に呼ぶ想定。
         */
        flushPendingPreload() {
            if (!this._pendingPreload) return;
            const payload = this._pendingPreload;
            this._pendingPreload = null;

            this.post('composer.setContext', {
                requestId: this._generateRequestId('preload'),
                payload
            });
        },

        /**
         * eHagakiモーダルを開く。
         * @param {Object|null} payload
         * @param {string} [payload.reply] - リプライ先nevent/note
         * @param {string[]} [payload.quotes] - 引用先nevent/note配列
         * @param {Object} [payload.replyEvent] - 🆕 リプライ対象のoriginalEvent（preloadedEvents用）
         * @param {Object[]} [payload.quoteEvents] - 🆕 引用対象のoriginalEvent配列（preloadedEvents用）
         * @param {string} [payload.content]
         * @param {Object} [payload.channel]
         */
        open(payload = null) {
            const parentUrl = window.location.origin + window.location.pathname;
            const url = new URL(`${this.ORIGIN}/ehagaki/`);

            url.searchParams.set('parentOrigin', parentUrl);

            if (payload) {
                if (payload.reply) {
                    url.searchParams.set('reply', payload.reply);
                    // 🆕 リプライ時、継承pタグの通知もいったん強制ONにする
                    url.searchParams.set('embedReplyNotification', 'true');
                }
                if (payload.quotes) {
                    payload.quotes.forEach(q => url.searchParams.append('quote', q));
                    url.searchParams.set('embedQuoteNotification', 'false');
                }
                if (payload.content) url.searchParams.set('content', payload.content);

                // チャンネル（パブリックチャット）起動時パラメータ
                if (payload.channel) {
                    const ch = payload.channel;
                    if (ch.reference) url.searchParams.set('channel', ch.reference);
                    if (ch.relays?.length) url.searchParams.set('channelRelays', ch.relays.join(','));
                    if (ch.name) url.searchParams.set('channelName', ch.name);
                    if (ch.about) url.searchParams.set('channelAbout', ch.about);
                    if (ch.picture) url.searchParams.set('channelPicture', ch.picture);
                }
            }

            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            url.searchParams.set('embedTheme', prefersDark ? 'dark' : 'light');

            console.log('🔍 eHagakiへ渡すURL:', url.toString());
            console.log('📦 受け取ったpayload:', payload);

            // 🆕 replyEvent / quoteEvents（親アプリがすでに保持しているoriginalEvent）から
            // preloadedEventsを組み立て、ready受信後に送るpatchとして予約する。
            // URLクエリには preloadedEvents を含められないため、
            // reply/quotes/channelも一緒に再送する（composer.setContextはpatchなので
            // 起動時URLクエリと内容が重複しても無害）。
            const preloadedEvents = payload
                ? this._buildPreloadedEvents([
                    payload.replyEvent,
                    ...(payload.quoteEvents || [])
                ])
                : null;

            this._pendingPreload = preloadedEvents ? {
                ...(payload.reply ? { reply: payload.reply } : {}),
                ...(payload.quotes ? { quotes: payload.quotes } : {}),
                ...(payload.channel ? { channel: payload.channel } : {}),
                preloadedEvents
            } : null;

            this.iframe.src = url.toString();
            this.modal.style.display = 'flex';
        },

        close() {
            this.modal.style.display = 'none';
            // 🆕 モーダルを閉じたらチャンネルコンテキストの記憶もクリア
            this._activeChannelId = null;
            // 🆕 未送信のpreload予約が残っていればクリア（次回openで作り直すため）
            this._pendingPreload = null;
        },

        post(type, data = {}) {
            if (!this.iframe.contentWindow) return;

            const message = {
                namespace: this.NS,
                version: this.VERSION,
                type: type,
                ...data
            };
            this.iframe.contentWindow.postMessage(message, this.ORIGIN);
        },

        setContext(payload) {
            this.post('composer.setContext', {
                requestId: this._generateRequestId('mgr'),
                payload: {
                    reply: payload.reply || null,
                    quotes: payload.quotes || [],
                    content: payload.content ?? ""
                }
            });
        },

        /**
         * hex の channelId を nevent1... にエンコードする。
         *
         * eHagaki側は channel.reference / URLクエリ channel= に
         * note1... または nevent1... のみを受け付け、生のhexは
         * バリデーションでreject（またはURLクエリとして無視）される。
         * そのため flowgazer 内部で保持している hex channelId は、
         * eHagakiへ渡す直前に必ずここでエンコードする。
         *
         * 投稿先リレーの取りこぼしを防ぐため、現在接続中のリレー
         * （window.relayManager.url）を relay hint として埋め込む。
         *
         * @param {string} channelId - 生のhex event id
         * @returns {string|null} nevent1... 文字列。エンコード失敗時は null
         */
        _encodeChannelReference(channelId) {
            const connectedRelay = window.relayManager?.url || null;
            try {
                return window.NostrTools.nip19.neventEncode({
                    id: channelId,
                    relays: connectedRelay ? [connectedRelay] : []
                });
            } catch (e) {
                console.error('❌ channelId の nevent エンコードに失敗:', e);
                return null;
            }
        },

        /**
         * 🆕 channelId から eHagaki へ渡す channel payload を組み立てる共通ヘルパー。
         * openChannelContext / openReplyToChannel の両方から使う。
         * @param {string} channelId
         * @param {string|null} relayHint
         * @returns {Object|null} channel payload。エンコード失敗時は null
         */
        _buildChannelPayload(channelId, relayHint = null) {
            const reference = this._encodeChannelReference(channelId);
            if (!reference) return null;

            const meta = window.channelMetaMap?.get(channelId) || {};
            const name = window.channelNameMap?.get(channelId) || meta.name || null;

            const connectedRelay = window.relayManager?.url || null;
            const candidateRelays = [];
            if (relayHint) candidateRelays.push(relayHint);
            if (connectedRelay && connectedRelay !== relayHint) candidateRelays.push(connectedRelay);
            const relays = candidateRelays.slice(0, 3);

            return {
                reference,
                relays,
                name: name || null,
                about: meta.about || null,
                picture: meta.picture || null
            };
        },

        /**
         * タイムラインのチャンネルバッジクリック用エントリポイント。
         * - モーダル未表示: URLクエリ付きで新規起動（初回描画のチラつき防止のため name/about/picture も渡す）
         * - モーダル表示中: 再読み込みせず composer.setContext で切り替える
         *
         * @param {string} channelId - 生のhex event id（eタグの値）
         * @param {string|null} relayHint - eタグ3番目の要素
         */
        openChannelContext(channelId, relayHint = null) {
            if (!channelId) return;

            // 🆕 post.success時にどのチャンネルタブを開くべきか判定するために保存
            this._activeChannelId = channelId;

            const channel = this._buildChannelPayload(channelId, relayHint);
            if (!channel) return;

            const isOpen = this.modal.style.display === 'flex';

            if (isOpen) {
                this.post('composer.setContext', {
                    requestId: this._generateRequestId('channel-switch'),
                    payload: { reply: null, quotes: [], channel }
                });
            } else {
                this.open({ channel });
            }
        },

        /**
         * 🆕 kind:42（チャンネルメッセージ）へのリプライ用エントリポイント。
         * リプライ対象がチャンネルメッセージの場合、reply nevent と同時に
         * channel context も渡すことで、eHagaki側がkind:42として送信できるようにする。
         *
         * @param {string} replyNevent - リプライ対象のnevent
         * @param {string|null} channelId - リプライ対象が属するチャンネルの hex event id（root eタグの値）
         * @param {string|null} relayHint - eタグ3番目の要素
         * @param {Object|null} replyEvent - 🆕 リプライ対象のoriginalEvent（preloadedEvents用）
         */
        openReplyToChannel(replyNevent, channelId, relayHint = null, replyEvent = null) {
            if (!channelId) {
                this.open({ reply: replyNevent, quotes: [], replyEvent });
                return;
            }

            this._activeChannelId = channelId;

            const channel = this._buildChannelPayload(channelId, relayHint);
            if (!channel) {
                this.open({ reply: replyNevent, quotes: [], replyEvent });
                return;
            }

            const isOpen = this.modal.style.display === 'flex';

            if (isOpen) {
                // 🆕 モーダルが開いている場合は composer.setContext に直接 preloadedEvents を含める
                const preloadedEvents = this._buildPreloadedEvents([replyEvent]);
                this.post('composer.setContext', {
                    requestId: this._generateRequestId('reply-channel'),
                    payload: {
                        reply: replyNevent,
                        quotes: [],
                        channel,
                        ...(preloadedEvents ? { preloadedEvents } : {})
                    }
                });
            } else {
                this.open({ reply: replyNevent, quotes: [], channel, replyEvent });
            }
        },

        /**
         * パブリックチャットモードを解除し、通常の投稿状態に戻す。
         * モーダルが開いていない場合は何もしない（reload不要のため）。
         */
        closeChannelContext() {
            // 🆕 モーダルの開閉に関わらず、パブリックチャットモード解除時は記憶をクリア
            this._activeChannelId = null;

            if (this.modal.style.display !== 'flex') return;

            this.post('composer.setContext', {
                requestId: this._generateRequestId('channel-close'),
                payload: { reply: null, quotes: [], channel: null }
            });
        },

        /**
         * モーダルの開閉ボタン・背景クリックのイベント配線を行う。
         * kit-ten.html の DOMContentLoaded から一度だけ呼ばれる想定
         * （このファイル自体は要素の存在を前提にしないよう、init()内でnullチェックする）。
         */
        init() {
            const openBtn = document.getElementById('open-ehagaki-modal');
            const closeBtn = document.getElementById('close-ehagaki-modal');

            if (openBtn) openBtn.onclick = () => this.open();
            if (closeBtn) closeBtn.onclick = () => this.close();

            if (this.modal) {
                this.modal.onclick = (e) => {
                    if (e.target === this.modal) this.close();
                };
            }
        }
    };

    // =========================
    // 🆕 storage委譲ハンドラ
    // =========================
    const STORAGE_PREFIX = 'ehagaki.embed.storage.v1:';

    const ALLOWED_KEYS = new Set([
        'locale',
        'themeMode',
        'darkMode',
        'uploadEndpoint',
        'clientTagEnabled',
        'quoteNotificationEnabled',
        'imageCompressionLevel',
        'videoCompressionLevel',
        'mediaFreePlacement',
        'showMascot',
        'showFlavorText',
        'settingsPreferenceMetadata',
        'firstVisit',
        'sharedMediaProcessed',
    ]);

    function handleStorage(data) {
        const mgr = window.ehagakiManager;

        const respond = (msg) => {
            mgr.iframe.contentWindow.postMessage({
                namespace: mgr.NS,
                version: mgr.VERSION,
                requestId: data.requestId,
                ...msg
            }, mgr.ORIGIN);
        };

        // GET
        if (data.type === 'storage.get') {
            const values = {};

            for (const key of data.payload.keys) {
                if (!ALLOWED_KEYS.has(key)) continue;
                values[key] = localStorage.getItem(STORAGE_PREFIX + key);
            }

            respond({
                type: 'storage.result',
                payload: { timestamp: Date.now(), values }
            });
        }

        // SET
        if (data.type === 'storage.set') {
            const applied = [];

            for (const [key, value] of Object.entries(data.payload.values)) {
                if (!ALLOWED_KEYS.has(key)) continue;
                if (typeof value !== 'string') continue;

                localStorage.setItem(STORAGE_PREFIX + key, value);
                applied.push(key);
            }

            respond({
                type: 'storage.result',
                payload: { timestamp: Date.now(), applied }
            });
        }

        // REMOVE
        if (data.type === 'storage.remove') {
            const removed = [];

            for (const key of data.payload.keys) {
                if (!ALLOWED_KEYS.has(key)) continue;

                localStorage.removeItem(STORAGE_PREFIX + key);
                removed.push(key);
            }

            respond({
                type: 'storage.result',
                payload: { timestamp: Date.now(), removed }
            });
        }
    }

    // ========================================
    // 🗄️ IndexedDB 委譲 (idb.*) のハンドラ
    // ========================================
    function handleIdb(data) {
        const mgr = window.ehagakiManager;
        if (!data.requestId) return;

        const replyToIframe = (type, payload) => {
            mgr.iframe.contentWindow.postMessage({
                namespace: mgr.NS,
                version: 1,
                type: type,
                requestId: data.requestId,
                payload: payload
            }, mgr.ORIGIN);
        };

        // 1. uploadDestinations ストアからの取得要求に対して、タイムアウトさせないためのスナップショット構造を返す
        if (data.type === 'idb.getAll' || data.type === 'idb.get') {
            if (data.payload?.store === 'uploadDestinations') {
                // eHagaki が求めているデフォルトのアップロード先設定のモック構造
                replyToIframe('idb.result', {
                    timestamp: Date.now(),
                    result: [], // またはデフォルトのアップロード先オブジェクト
                    snapshot: {
                        destinations: [],
                        defaultId: null
                    }
                });
            } else {
                replyToIframe('idb.result', { timestamp: Date.now(), result: [] });
            }
            return;
        }

        // 2. 書き込み・削除系
        if (data.type === 'idb.set' || data.type === 'idb.delete' || data.type === 'idb.clear') {
            replyToIframe('idb.result', { timestamp: Date.now(), success: true });
            return;
        }
    }

    // --- メッセージ受信ハンドラ ---
    window.addEventListener('message', async (event) => {
        const mgr = window.ehagakiManager;
        const auth = window.nostrAuth;

        if (event.origin !== mgr.ORIGIN) return;
        if (event.source !== mgr.iframe.contentWindow) return;

        const data = event.data;
        if (data?.namespace !== mgr.NS) return;

        // 🆕 ここでstorageを先に処理（重要）
        if (data.type?.startsWith('storage.')) {
            handleStorage(data);
            return;
        }

        // 🆕 idb.* の処理を追加
        if (data.type?.startsWith('idb.')) {
            handleIdb(data);
            return;
        }

        switch (data.type) {
            case 'ready':
                if (auth.pubkey) {
                    mgr.post('auth.login', { payload: { pubkeyHex: auth.pubkey } });
                }
                // 🆕 open()で予約されたpreloadedEvents付きsetContextがあれば送る
                mgr.flushPendingPreload();
                break;

            case 'auth.request':
                if (auth.pubkey) {
                    mgr.post('auth.result', {
                        requestId: data.requestId,
                        payload: {
                            pubkeyHex: auth.pubkey,
                            capabilities: ['signEvent']
                        }
                    });
                }
                break;

            case 'rpc.request':
                if (data.payload?.method === 'signEvent') {
                    try {
                        const signed = await auth.signEvent(data.payload.params.event);
                        mgr.post('rpc.result', {
                            requestId: data.requestId,
                            payload: { result: signed }
                        });
                    } catch (err) {
                        mgr.post('rpc.error', {
                            requestId: data.requestId,
                            payload: { message: err.message }
                        });
                    }
                }
                break;

            case 'post.success':
                console.log('投稿成功:', data.payload);

                // 🆕 チャンネル投稿モードだった場合、そのチャンネルタブを自動で開く
                if (mgr._activeChannelId) {
                    window.app?.switchToChannelTab?.(mgr._activeChannelId);
                }

                // 🆕 投稿成功したら自動でモーダルを閉じる（close()内で_activeChannelIdもリセットされる）
                window.ehagakiManager.close();
                break;

            // 🆕 composer.setContext の適用成功通知
            case 'composer.contextApplied':
                if (data.requestId?.startsWith('channel-switch-') || data.requestId?.startsWith('reply-channel-')) {
                    console.log('✅ チャンネル切り替え・リプライ設定成功:', data.requestId, data.payload);
                } else if (data.requestId?.startsWith('channel-close-')) {
                    console.log('✅ チャンネル解除成功:', data.requestId, data.payload);
                } else if (data.requestId?.startsWith('preload-')) {
                    console.log('✅ preloadedEvents付きコンテキスト反映完了:', data.requestId, data.payload);
                } else {
                    console.log('✅ composer context 反映完了:', data.requestId, data.payload);
                }
                break;

            // 🆕 composer.setContext の適用失敗通知
            case 'composer.contextError':
                if (data.requestId?.startsWith('channel-switch-') || data.requestId?.startsWith('reply-channel-') || data.requestId?.startsWith('channel-close-')) {
                    console.error('❌ チャンネル関連のコンテキスト設定失敗:', data.payload);
                } else if (data.requestId?.startsWith('preload-')) {
                    console.error('❌ preloadedEvents付きコンテキスト設定失敗:', data.payload);
                } else {
                    console.error('❌ composer context 反映失敗:', data.requestId, data.payload);
                }
                break;

            // 🆕 iframe内でユーザーが手動でcomposer contextを変更した場合の通知
            case 'composer.contextUpdated':
                console.log('🔄 iframe側でコンテキスト変更:', data.payload);
                break;
        }
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = window.ehagakiManager?.modal;
            // display が 'none' でなければ（flexやblock等でも）閉じる
            if (modal && modal.style.display && modal.style.display !== 'none') {
                window.ehagakiManager.close();
            }
        }
    });

})();
