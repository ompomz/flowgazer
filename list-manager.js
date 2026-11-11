/**
 * list-manager.js
 * 【責務】: NIP-51 リストの取得・復号・判定
 *
 * - 取得対象: 秘密鍵ログイン / NIP-07 ログインのときのみ
 *   （Pubkeyログイン・未ログイン・ROM+一時nsec では取得しない）
 * - 復号結果はメモリのみ保持（localStorage には保存しない）
 * - 復号失敗/拒否時は、パブリックタグのみで動作（セッション中は再試行しない）
 *
 * app.js / view-state.js からは window.listManager?.xxx?.() の形で
 * 疎結合に呼ばれる前提。このファイルを読み込まないページでは何も起きない。
 */
(function () {
    'use strict';

    /**
     * NIP-51 のタグ配列を、判定しやすい形にパースする（kind 非依存の汎用関数）。
     * kind:30000 など他リストを足すときも、これを再利用できる。
     * @param {Array[]} tags
     * @returns {{pubkeys:Set<string>, eventIds:Set<string>, hashtags:Set<string>, words:Set<string>}}
     */
    function parseListTags(tags) {
        const result = {
            pubkeys: new Set(),
            eventIds: new Set(),
            hashtags: new Set(),
            words: new Set()
        };
        for (const tag of tags || []) {
            if (!Array.isArray(tag) || !tag[1]) continue;
            switch (tag[0]) {
                case 'p': result.pubkeys.add(tag[1]); break;
                case 'e': result.eventIds.add(tag[1]); break;
                case 't': result.hashtags.add(tag[1].toLowerCase()); break;
                case 'word': {
                    const w = tag[1].trim().toLowerCase();
                    if (w) result.words.add(w);
                    break;
                }
            }
        }
        return result;
    }

    function emptyMute() {
        return { pubkeys: new Set(), eventIds: new Set(), hashtags: new Set(), words: [], isEmpty: true };
    }

    // 判定対象にする本文系 kind（ワード・ハッシュタグ判定を行う）
    const TEXT_KINDS = new Set([1, 1111, 42]);

    class ListManager {
        constructor() {
            this.mute = emptyMute();
            this._fetchSeq = 0;           // 古い取得結果を捨てるための世代番号
            this._decryptDenied = false;  // 復号失敗/拒否後は、同一セッション中は再試行しない
            console.log('✅ ListManager初期化完了');
        }

        // ========================================
        // 取得条件
        // ========================================

        /**
         * 取得してよいログイン状態か。
         * 秘密鍵ログイン or NIP-07 のみ。readOnly（npub/NIP-05）は不可。
         * ※ ROM + sessionNsec（lite.html の一時nsec）は Pubkeyログイン扱いで対象外。
         */
        _canFetch() {
            const auth = window.nostrAuth;
            if (!auth?.isLoggedIn() || auth.readOnly) return false;
            return !!auth.nsec || !!auth.useNIP07;
        }

        // ========================================
        // kind:10000 取得
        // ========================================

        /**
         * 自分の kind:10000 を取得し、パブリック+プライベートタグを合成して保持する。
         * @returns {Promise<boolean>} 再描画が必要な場合 true
         */
        async fetchMuteList() {
            if (!this._canFetch()) {
                return this.clear();
            }

            const myPubkey = window.nostrAuth.pubkey;
            const seq = ++this._fetchSeq;

            const event = await this._fetchLatestEvent(myPubkey, 10000);

            // 取得中にログアウト/再ログインされていたら結果を捨てる
            if (seq !== this._fetchSeq) return false;

            if (!event) {
                console.log('📭 kind:10000 が見つかりませんでした');
                return this.clear();
            }

            // パブリックタグ
            const merged = [...event.tags];

            // プライベートタグ（content）。失敗しても publicのみで続行する
            if (event.content) {
                const privateTags = await this._decryptPrivateTags(event, myPubkey);
                if (seq !== this._fetchSeq) return false; // 復号待ち（NIP-07ポップアップ）中の変化も考慮
                merged.push(...privateTags);
            }

            const parsed = parseListTags(merged);
            this.mute = {
                pubkeys: parsed.pubkeys,
                eventIds: parsed.eventIds,
                hashtags: parsed.hashtags,
                words: Array.from(parsed.words),
                isEmpty: parsed.pubkeys.size + parsed.eventIds.size +
                    parsed.hashtags.size + parsed.words.size === 0
            };

            console.log(
                `🔇 kind:10000反映: pubkey=${this.mute.pubkeys.size} ` +
                `word=${this.mute.words.length} tag=${this.mute.hashtags.size} ` +
                `event=${this.mute.eventIds.size}`
            );
            return true;
        }

        /**
         * 指定 kind の最新イベントを1件取得する（1回取得。購読は取得後に解除）。
         * リレー未接続・タイムアウト時は null。
         */
        _fetchLatestEvent(pubkey, kind, timeoutMs = 8000) {
            return new Promise((resolve) => {
                const subId = `list-${kind}-${Date.now()}`;
                let latest = null;
                let done = false;
                let timer = null;

                const finish = () => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    window.relayManager.unsubscribe(subId);
                    resolve(latest);
                };

                timer = setTimeout(() => {
                    console.warn(`⏱️ kind:${kind} 取得タイムアウト`);
                    finish();
                }, timeoutMs);

                const ok = window.relayManager.subscribe(
                    subId,
                    { kinds: [kind], authors: [pubkey], limit: 1 },
                    (type, ev) => {
                        if (type === 'EVENT') {
                            if (ev?.kind !== kind || ev.pubkey !== pubkey) return;
                            if (!window.NostrTools.verifyEvent(ev)) return; // 署名検証
                            if (!latest || ev.created_at > latest.created_at) latest = ev;
                        } else if (type === 'EOSE') {
                            finish();
                        }
                    }
                );
                if (!ok) finish(); // 未接続など
            });
        }

        // ========================================
        // 復号（NIP-04 / NIP-44）
        // ========================================

        /**
         * content を復号し、タグ配列として返す。
         * 失敗・拒否・形式不正はすべて [] を返し、例外は投げない（パブリックのみで続行）。
         */
        async _decryptPrivateTags(event, myPubkey) {
            if (this._decryptDenied) return [];

            // NIP-04 の暗号文は "base64?iv=base64" 形式。それ以外は NIP-44 とみなす。
            const scheme = event.content.includes('?iv=') ? 'nip04' : 'nip44';

            try {
                const plain = await window.nostrAuth.decrypt(myPubkey, event.content, scheme);
                const arr = JSON.parse(plain);
                if (!Array.isArray(arr)) throw new Error('復号結果がタグ配列ではありません');
                return arr.filter(Array.isArray);
            } catch (err) {
                // 画面通知はしない（console.warn のみ）。同セッション中は再試行しない。
                console.warn(`⚠️ プライベートリストの復号に失敗（${scheme}）→ パブリックのみで動作します:`, err?.message || err);
                this._decryptDenied = true;
                return [];
            }
        }

        // ========================================
        // 判定ヘルパー
        // ========================================

        /** 1件以上あるかどうか（フィルタ側の早期スキップ用） */
        hasMutes() {
            return !this.mute.isEmpty;
        }

        /**
         * 🆕 イベント単体について「どこが対象か」を返す。
         * 該当なしなら null。リポストの元ポスト判定（UIの折りたたみ）にも使う。
         *
         * 判定順: 作者(p) → イベントID(e) → ハッシュタグ(t) → ワード(w)
         * ※ リポスト(kind:6/16)自体の中身は見ない。元ポストを渡して呼ぶこと。
         *
         * @param {Object} ev
         * @returns {{type:'p'|'e'|'t'|'w', value:string}|null}
         */
        getMuteReason(ev) {
            const m = this.mute;
            if (m.isEmpty || !ev) return null;

            // 作者
            if (m.pubkeys.has(ev.pubkey)) return { type: 'p', value: ev.pubkey };

            // スレッド（自身 or 参照先）
            if (m.eventIds.size > 0) {
                if (m.eventIds.has(ev.id)) return { type: 'e', value: ev.id };
                const eTag = ev.tags?.find(t => t[0] === 'e' && m.eventIds.has(t[1]));
                if (eTag) return { type: 'e', value: eTag[1] };
            }

            // 本文系：ハッシュタグ・ワード
            if (TEXT_KINDS.has(ev.kind)) return this._matchReason(ev);

            return null;
        }

        /**
         * イベントを「完全に非表示にするか」の判定。
         *
         * 🔄 変更点（リポストの扱い）:
         *  - リポスト(kind:6/16): リポストした本人が対象のときだけ true（完全非表示）。
         *    元ポストの作者・本文・CW等は完全非表示にせず、timeline.js 側で
         *    getMuteReason(original) を使って折りたたみ表示にする。
         *  - それ以外: 従来どおり getMuteReason() が非nullなら true。
         *
         * @param {Object} ev
         * @returns {boolean}
         */
        isMutedEvent(ev) {
            const m = this.mute;
            if (m.isEmpty || !ev) return false;

            if (ev.kind === 6 || ev.kind === 16) {
                return m.pubkeys.has(ev.pubkey);
            }

            return this.getMuteReason(ev) !== null;
        }

        /** ハッシュタグ・ワードの該当理由を返す（なければ null） */
        _matchReason(ev) {
            const m = this.mute;

            if (m.hashtags.size > 0) {
                const tTag = ev.tags?.find(t => t[0] === 't' && t[1] && m.hashtags.has(t[1].toLowerCase()));
                if (tTag) return { type: 't', value: tTag[1] };
            }

            if (m.words.length > 0) {
                const content = (ev.content || '').toLowerCase();
                const hit = m.words.find(w => content.includes(w));
                if (hit) return { type: 'w', value: hit };
            }
            return null;
        }

        // 既存呼び出しとの互換のため残す
        _matchesWordOrTag(ev) {
            return this._matchReason(ev) !== null;
        }

        // ========================================
        // クリア
        // ========================================

        /**
         * 状態を破棄する（サインアウト時など）。
         * 進行中の取得結果も無効化する。
         * @returns {boolean} 再描画が必要な場合 true
         */
        clear() {
            const hadMutes = this.hasMutes();
            this._fetchSeq++;
            this._decryptDenied = false;
            this.mute = emptyMute();
            return hadMutes;
        }
    }

    window.ListManager = ListManager;
    window.listManager = new ListManager();
})();