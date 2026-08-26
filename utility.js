/**
 * Nostr自分用ユーティリティライブラリ
 */
const MyNostrUtils = {
    // --- 1. 識別子・デコード系 ---

    /**
     * npub, nprofile, NIP-05, HexをHex(64文字)に正規化する
     */
    async normalizeToHex(input) {
        if (!input) return null;
        const str = input.trim();

        // NIP-05 (user@domain)
        if (str.includes('@')) {
            try {
                const profile = await window.NostrTools.nip05.queryProfile(str);
                return profile?.pubkey || null;
            } catch (e) {
                console.error("NIP-05解決エラー:", e);
                return null;
            }
        }

        // NIP-19 (npub, nprofile)
        if (str.startsWith('npub1') || str.startsWith('nprofile1')) {
            try {
                const decoded = window.NostrTools.nip19.decode(str);
                return decoded.type === 'nprofile' ? decoded.data.pubkey : decoded.data;
            } catch (e) {
                console.error("NIP-19デコードエラー:", e);
                return null;
            }
        }

        // 素のHex
        if (/^[a-f0-9]{64}$/i.test(str)) return str;

        return null;
    },

    // --- 2. 名前解決系 ---

    /**
     * プロフィールオブジェクトから最適な表示名を取得する
     */
    getDisplayName(profile, pubkey) {
        if (!profile) return pubkey.substring(0, 8); // プロフィールがなければHex短縮

        // 優先順位: name > display_name > nip05(ドメイン) > Hex短縮
        if (profile.name?.trim()) return profile.name;
        if (profile.display_name?.trim()) return profile.display_name;

        if (profile.nip05?.includes('@')) {
            return profile.nip05.split('@')[1];
        }

        return pubkey.substring(0, 8);
    },

    // --- 3. デザイン・色彩系 ---

    /**
     * 16進数6桁から色相(0-360)を算出（RGB→HSL変換）
     */
    hexToHue(hex6) {
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
    },

    /**
     * 公開鍵から色相(0-360)を算出
     */
    pubkeyToHue(pubkey) {
        const hex6 = pubkey.substring(0, 6);
        return this.hexToHue(hex6);
    },

    /**
     * 色相から読みやすいHSLカラーを生成（ダーク/ライトモード自動判定）
     */
    getHslColor(pubkey, isDark = null) {
        const hue = this.pubkeyToHue(pubkey);

        // isDark が null の場合、ブラウザの prefers-color-scheme を参照
        if (isDark === null) {
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                isDark = true;
            } else {
                isDark = false;
            }
        }
        // 黄色系(50-190)はライトモードで見づらいため明るさを調整
        const lightness = isDark ? 80 : ((hue >= 50 && hue <= 190) ? 45 : 60);
        return `hsl(${hue}, 95%, ${lightness}%)`;
    },

    // --- 4. テキスト処理・セキュリティ系 ---

    /**
     * HTMLエスケープ処理
     */
    escapeHtml(str) {
        if (!str) return '';
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return str.replace(/[&<>"']/g, m => map[m]);
    },

    /**
     * バイト数を考慮した文字列カット
     */
    truncateByByte(str, maxBytes) {
        let b = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            b += (c <= 0x7f) ? 1 : 2;
            if (b > maxBytes) return str.substring(0, i) + '...';
        }
        return str;
    },

    // --- 5. メディア・リンク処理系 ---

    /**
     * URLを判定して、画像/動画/リンクのHTML要素(または文字列)を返す
     */
    parseUrl(url, options = { expandMedia: false }) {
        const isImage = /\.(jpeg|jpg|gif|png|webp|avif|heic|svg)$/i.test(url);
        const isVideo = /\.(mp4|webm|ogv|mov)$/i.test(url);

        if (isImage || isVideo) {
            // オプションで「メディア展開」が有効な場合
            if (options.expandMedia) {
                if (isImage) return `<img src="${url}" alt="image" class="post-image" style="max-width:100%; height:auto; display:block; margin:10px 0;">`;
                if (isVideo) return `<video src="${url}" controls class="post-video" style="max-width:100%; height:auto; display:block; margin:10px 0;"></video>`;
            }

            // デフォルト（従来通り）：モーダル用のリンクを返す
            const label = isImage ? '[画像を表示]' : '[動画を表示]';
            return `<a href="#" class="nostr-ref" onclick="event.preventDefault(); if(window.openModal) window.openModal('${url}')">${label}</a>`;
        }

        // 画像・動画以外
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="nostr-ref">${url}</a>`;
    },

    // linkify も options を受け取る
    linkify(text, options = { expandMedia: false }) {
        const combinedRegex = /(https?:\/\/[\w/:%#\$&\?\(\)~\.=\+\-;\*!]+)|(nostr:[a-z0-9]+1[a-z0-9]+)/gi;

        return text.replace(combinedRegex, (match) => {
            if (match.toLowerCase().startsWith("nostr:")) {
                const nip19 = match.substring(6);
                return `<a href="https://ompomz.github.io/flowgazer/tweet?id=${nip19}" target="_blank" rel="noreferrer" class="nostr-ref">nostr:${nip19.substring(0, 10)}...</a>`;
            }
            // parseUrl にオプションを渡す
            return this.parseUrl(match, options);
        });
    },

    // --- 6. モーダル・初期化系 ---

    /**
     * モーダルのHTML/CSSを自動注入し、イベントを設定する
     */
    initModal() {
        // 1. CSSを自動注入
        if (!document.getElementById('my-nostr-modal-style')) {
            const style = document.createElement('style');
            style.id = 'my-nostr-modal-style';
            style.textContent = `
                .modal { display:none; position:fixed; z-index:9999; left:0; top:0; width:100%; height:100%; overflow:auto; background-color:rgba(0,0,0,0.2); backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px); }
                .modal-content { margin:auto; display:flex; align-items:center; justify-content:center; width:100%; height:100%; position:relative; }
                .modal-image { max-width:90%; max-height:90vh; object-fit:contain; }
                .close-button { position:absolute; top:20px; right:30px; color:#fff; font-size:40px; font-weight:bold; cursor:pointer; transition:0.3s; z-index:10001; }
                .close-button:hover { color:#ccc; }
            `;
            document.head.appendChild(style);
        }

        // 2. HTML構造を自動作成（placeholderがなければbody直下に追加）
        let placeholder = document.getElementById('modal-placeholder');
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.id = 'modal-placeholder';
            document.body.appendChild(placeholder);
        }

        placeholder.innerHTML = `
            <div id="modal" class="modal">
                <span class="close-button">&times;</span>
                <div class="modal-content">
                    <img id="modal-image" class="modal-image" src="" alt="image">
                </div>
            </div>
        `;

        // 3. イベントリスナーの設定
        const modal = document.getElementById('modal');
        const closeBtn = modal.querySelector('.close-button');

        const closeModal = () => { modal.style.display = 'none'; };

        closeBtn.onclick = closeModal;
        modal.onclick = (e) => { if (e.target === modal || e.target.classList.contains('modal-content') || e.target.id === 'modal-image') closeModal(); };

        document.addEventListener('keydown', (e) => {
            if (e.key === "Escape" && modal.style.display === "block") closeModal();
        });

        // 4. グローバル関数 openModal を定義（既存コードとの互換性のため）
        window.openModal = (imageUrl) => {
            const modalImg = document.getElementById('modal-image');
            if (modal && modalImg) {
                modalImg.src = imageUrl;
                modal.style.display = 'block';
            }
        };
    }
};

// utility.js が読み込まれたら自動で初期化を実行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => MyNostrUtils.initModal());
} else {
    MyNostrUtils.initModal();
}
