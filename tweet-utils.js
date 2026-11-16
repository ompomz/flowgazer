/**
 * tweet-utils.js
 * 【責務】: tweet.html 用の純粋関数と定数（DOM・ネットワークに触れない）
 *
 * - 他の tweet-*.js や tweet.js から window.TweetUtils 経由で利用する。
 * - NostrTools（nip19 / nip05）にのみ依存する。それ以外の依存は持たない。
 * - 読み込み順: nostr-tools → tweet-utils.js → tweet.js
 */
(function () {
    'use strict';

    // ========================================
    // 定数
    // ========================================
    const CONFIG = Object.freeze({
        FALLBACK_RELAYS: ['wss://r.kojira.io/', 'wss://nos.lol'],
        DEFAULT_PROFILE_IMAGE: 'https://ompomz.github.io/favicon.ico',
        MAX_RELAYS_PER_QUERY: 6,

        // 本体(flowgazer)と同じclientタグ（NIP-89 アプリ参照）
        CLIENT_TAG: ['client', 'flowgazer', '31990:a19caaa8404721584746fb0e174cf971a94e0f51baaf4c4e8c6e54fa88985eaf:1755917022711', 'wss://relay.nostr.band/'],

        // 本体のデフォルトリレー（app.js の初期値と同じ）。
        // 本体ですでにリレーを変更している場合は、共有されている localStorage の 'relayUrl' が優先される。
        DEFAULT_MAIN_RELAY: 'wss://r.kojira.io/'
    });

    // ========================================
    // 通信制御
    // ========================================

    function withTimeout(promise, ms, message) {
        const label = message || '通信';
        const startedAt = Date.now();
        let timeoutId;

        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                console.warn(`⏱️ [${label}] タイムアウト (${ms}ms経過)`);
                reject(new Error(message || 'タイムアウトしました'));
            }, ms);
        });

        return Promise.race([promise, timeoutPromise])
            .then((result) => {
                clearTimeout(timeoutId);
                const elapsed = Date.now() - startedAt;
                const count = Array.isArray(result) ? `${result.length}件` : (result ? '取得あり' : '該当なし');
                console.log(`✅ [${label}] 完了 (${elapsed}ms, ${count})`);
                return result;
            })
            .catch((err) => {
                clearTimeout(timeoutId);
                if (!/タイムアウト/.test(err.message || '')) {
                    console.warn(`❌ [${label}] 通信エラー:`, err.message || err);
                }
                throw err;
            });
    }

    // ========================================
    // 表示用ラベル・フォーマット
    // ========================================

    function getPostTypeLabel(kind) {
        switch (kind) {
            case 1: return '投稿';
            case 6: return 'リポスト';
            case 7: return 'リアクション';
            case 16: return '引用リポスト';
            case 40: return 'チャンネル作成';
            case 41: return 'チャンネル情報更新';
            case 42: return 'チャンネルメッセージ';
            case 1111: return 'コメント';
            case 30023: return '記事';
            default: return 'イベント';
        }
    }

    /**
     * プロフィール投稿一覧専用のタイムスタンプ整形。
     * Timelineクラス標準の HH:MM:SS だけだと年をまたぐ投稿の判別ができないため、
     * 今年の投稿は「月/日 時:分」、それ以前は「年/月/日 時:分」で表示する。
     * @param {Date} date
     * @returns {string}
     */
    function formatProfileDate(date) {
        const now = new Date();
        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');

        if (date.getFullYear() < now.getFullYear()) {
            return `${date.getFullYear()}/${m}/${d} ${time}`;
        }
        return `${m}/${d} ${time}`;
    }

    // --- カスタム絵文字置換（:shortcode: -> <img>） ---
    function replaceCustomEmojis(html, customEmojiMap) {
        if (!html || customEmojiMap.size === 0) return html;
        let result = html;
        customEmojiMap.forEach((url, shortcode) => {
            const escaped = shortcode.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(`(?<=\\s|^|>)${escaped}(?=\\s|$|<)`, 'g');
            result = result.replace(regex, `<img src="${url}" alt="${shortcode}" title="${shortcode}" class="custom-emoji custom-emoji-hover">`);
        });
        return result;
    }

    // ========================================
    // ID解析（npub / nprofile / note / nevent / naddr）
    // ========================================

    function parseInput(raw) {
        const input = (raw || '').trim();
        if (!input) return null;
        try {
            const decoded = NostrTools.nip19.decode(input);
            switch (decoded.type) {
                case 'npub':
                    return { kind: 'profile', pubkey: decoded.data, relays: [] };
                case 'nprofile':
                    return { kind: 'profile', pubkey: decoded.data.pubkey, relays: decoded.data.relays || [] };
                case 'note':
                    return { kind: 'event', id: decoded.data, relays: [] };
                case 'nevent':
                    return { kind: 'event', id: decoded.data.id, relays: decoded.data.relays || [] };
                case 'naddr':
                    return {
                        kind: 'addr',
                        pubkey: decoded.data.pubkey,
                        addrKind: decoded.data.kind,
                        identifier: decoded.data.identifier,
                        relays: decoded.data.relays || []
                    };
                default:
                    return null;
            }
        } catch (e) {
            console.error('NIP-19デコードエラー:', e);
            return null;
        }
    }

    // ========================================
    // NIP-05 対応（name@domain / @domain / domain）
    // ========================================

    const NIP05_FULL_REGEX = /^[a-z0-9_.+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
    const NIP05_DOMAIN_REGEX = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

    /**
     * NIP-05 らしい入力を "name@domain" に正規化する。
     * NIP-05 と解釈できなければ null。
     */
    function normalizeNip05(str) {
        const s = (str || '').trim();
        if (!s) return null;

        if (NIP05_FULL_REGEX.test(s)) return s;
        if (s.startsWith('@') && NIP05_DOMAIN_REGEX.test(s.slice(1))) return `_${s}`;
        if (NIP05_DOMAIN_REGEX.test(s)) return `_@${s}`;
        return null;
    }

    function isNip05(str) {
        return normalizeNip05(str) !== null;
    }

    // ========================================
    // 返信先タグの特定
    // ========================================

    // リプライ先のeタグを取得
    // - kind:1  → NIP-10: reply優先 → root → 末尾フォールバック
    // - kind:42 → NIP-28: root eタグは「チャンネル自体」を指すためリプライ先の対象外。
    //             reply マーカー付きタグのみを正式なリプライ先とし、
    //             マーカーが無い旧式データ向けに「root以外のeタグ」をフォールバックとして扱う
    function getReplyTargetTag(event) {
        if (event.kind !== 1 && event.kind !== 42 && event.kind !== 1111) return null;

        // NIP-22 コメント: 親は小文字 'e'（大文字 'E' はスレッドのルートなので無視）。
        // 4番目の要素は marker ではなく pubkey のため、NIP-10 の marker 判定は使わない。
        // 'e' が無い（URLや記事などへのコメント）場合は表示するリプライ先なし。
        if (event.kind === 1111) {
            return (event.tags || []).find(t => t[0] === 'e' && t[1]) || null;
        }

        const eTags = (event.tags || []).filter(t => t[0] === 'e');
        if (eTags.length === 0) return null;

        if (event.kind === 42) {
            const replyMarked = eTags.find(t => t[3] === 'reply');
            if (replyMarked) return replyMarked;
            const rootId = (eTags.find(t => t[3] === 'root') || eTags[0])?.[1];
            return eTags.find(t => t[1] !== rootId) || null;
        }

        // kind:1
        return eTags.find(t => t[3] === 'reply')
            || eTags.find(t => t[3] === 'root')
            || eTags[eTags.length - 1];
    }

    // ========================================
    // 公開
    // ========================================
    window.TweetUtils = {
        CONFIG,
        withTimeout,
        getPostTypeLabel,
        formatProfileDate,
        replaceCustomEmojis,
        parseInput,
        normalizeNip05,
        isNip05,
        getReplyTargetTag
    };

    console.log('✅ tweet-utils.js 読み込み完了');
})();