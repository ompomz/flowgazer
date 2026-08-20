/**
 * url-cleaner.js
 * 【責務】: 投稿本文中のURLからトラッキングパラメータ（utm_*, fbclid等）を検出し、
 *          「削ると？」ボタンで確認・除去できるようにする
 *
 * 外部ライブラリや app.js / ehagaki-manager.js への依存はなく、
 * #new-post-content / #clean-url-action / #clean-url-result /
 * #clean-url-preview-link のDOM要素が存在するページであれば
 * そのまま動作する自己完結型モジュール。
 *
 * 元々 kit-ten.html 内のインラインスクリプトだった内容を、
 * 他ページから独立したモジュールとして切り出したもの。
 */
(function () {
    'use strict';

    console.log("URLクリーナー読み込みOK");

    const CLEAN_URL_PARAMS = new Set([
        "si",
        "context",
        "fbclid",
        "gclid",
        "dclid",
        "msclkid",
        "mc_cid",
        "mc_eid",
        "_ga",
        "_gl",
        "igshid",
        "ref_src",
        "ref_url",
        "yclid",
        "mkt_tok",
        "trk",
        "trkCampaign",
        "trkInfo"
    ]);

    /*
     * 削除対象かどうか
     */
    function shouldRemoveCleanUrlParam(name) {

        const lowerName = name.toLowerCase();

        // utm_source / utm_medium / utm_campaign など
        if (lowerName.startsWith("utm_")) {
            return true;
        }

        return CLEAN_URL_PARAMS.has(name)
            || CLEAN_URL_PARAMS.has(lowerName);
    }


    /*
     * URLを削る
     */
    function cleanUrl(urlString) {

        const url = new URL(urlString);

        const removed = [];

        for (const [key] of [...url.searchParams.entries()]) {

            if (shouldRemoveCleanUrlParam(key)) {

                removed.push(key);

                url.searchParams.delete(key);
            }
        }

        return {
            url: url.toString(),
            removed: removed
        };
    }


    /*
     * 投稿本文からURLを探す
     */
    function findUrlsInPost(text) {

        const urlRegex = /https?:\/\/[^\s<>"']+/gi;

        return [...text.matchAll(urlRegex)].map(match => ({
            url: match[0],
            index: match.index
        }));
    }


    /*
     * URL末尾の句読点などを除去
     */
    function normalizeDetectedUrl(url) {

        return url.replace(
            /[。、，．,.!?！？)）\]}」』]+$/g,
            ""
        );
    }


    /*
     * 投稿本文から「削れるURL」を探す
     */
    function findCleanableUrls(text) {

        const urls = findUrlsInPost(text);

        const cleanable = [];

        for (const item of urls) {

            const normalizedUrl =
                normalizeDetectedUrl(item.url);

            try {

                const result =
                    cleanUrl(normalizedUrl);

                if (result.removed.length > 0) {

                    cleanable.push({
                        originalUrl: normalizedUrl,
                        cleanedUrl: result.url,
                        removed: result.removed,
                        index: item.index
                    });

                }

            } catch (error) {

                console.debug(
                    "URLを解析できませんでした:",
                    normalizedUrl
                );

            }
        }

        return cleanable;
    }


    /* =========================================================
       DOM
       ========================================================= */

    const newPostContent =
        document.getElementById("new-post-content");

    const cleanUrlAction =
        document.getElementById("clean-url-action");

    const cleanUrlResult =
        document.getElementById("clean-url-result");

    const cleanUrlPreviewLink =
        document.getElementById("clean-url-preview-link");

    // このページに対象DOMが存在しない場合は何もしない
    // （index.html / index2.html にこのファイルを追加した際、
    //   #clean-url-action 等のHTMLがまだ無くても安全に読み込めるようにするため）
    if (!newPostContent || !cleanUrlAction || !cleanUrlResult || !cleanUrlPreviewLink) {
        console.warn('⚠️ url-cleaner.js: 対象DOM要素が見つからないため初期化をスキップしました');
        return;
    }


    /*
     * 現在プレビューしているURL
     */
    let currentCleanUrlData = null;


    /* =========================================================
       投稿欄の監視
       ========================================================= */

    function updateCleanUrlButton() {

        const text =
            newPostContent.value;

        const cleanableUrls =
            findCleanableUrls(text);


        /*
         * 削れるURLがない
         */
        if (cleanableUrls.length === 0) {

            cleanUrlAction.style.display =
                "none";

            cleanUrlResult.style.display =
                "none";

            currentCleanUrlData = null;

            return;
        }


        /*
         * 削れるURLがある
         */
        cleanUrlAction.style.display =
            "inline-block";


        /*
         * 投稿内容が変わったら
         * 前回のプレビューをリセット
         */
        cleanUrlAction.textContent =
            "削ると？";

        cleanUrlResult.style.display =
            "none";

        currentCleanUrlData = null;
    }


    /* =========================================================
       「削ると？」 / 「削る」
       ========================================================= */

    cleanUrlAction.addEventListener(
        "click",
        function () {

            /*
             * すでにプレビュー中なら
             * 「削る」ボタンとして動作
             */
            if (currentCleanUrlData) {

                applyCleanUrl();

                return;
            }


            const cleanableUrls =
                findCleanableUrls(
                    newPostContent.value
                );


            if (cleanableUrls.length === 0) {

                updateCleanUrlButton();

                return;
            }


            /*
             * 現在は最初のURLを対象にする
             */
            currentCleanUrlData =
                cleanableUrls[0];


            /*
             * プレビューリンクを作る
             */
            cleanUrlPreviewLink.href =
                currentCleanUrlData.cleanedUrl;

            cleanUrlPreviewLink.textContent =
                currentCleanUrlData.cleanedUrl;


            /*
             * プレビュー表示
             */
            cleanUrlResult.style.display =
                "block";


            /*
             * ボタンを「削る」に変更
             */
            cleanUrlAction.textContent =
                "削る";
        }
    );


    /* =========================================================
       「削る」
       ========================================================= */

    function applyCleanUrl() {

        if (!currentCleanUrlData) {
            return;
        }


        const original =
            currentCleanUrlData.originalUrl;

        const cleaned =
            currentCleanUrlData.cleanedUrl;

        const text =
            newPostContent.value;


        const index =
            text.indexOf(original);


        /*
         * 投稿欄の内容が変更されていた場合
         */
        if (index === -1) {

            updateCleanUrlButton();

            return;
        }


        /*
         * URLだけを置き換える
         */
        newPostContent.value =
            text.slice(0, index)
            + cleaned
            + text.slice(
                index + original.length
            );


        /*
         * 既存のinput監視処理を発火
         */
        newPostContent.dispatchEvent(
            new Event("input", {
                bubbles: true
            })
        );


        /*
         * UIをリセット
         */
        cleanUrlResult.style.display =
            "none";

        currentCleanUrlData =
            null;


        /*
         * ボタンも再び「削ると？」へ
         *
         * ただし、まだ別の削れるURLが
         * 残っている可能性があるので、
         * updateCleanUrlButton() に任せる。
         */
        updateCleanUrlButton();


        /*
         * 投稿欄にフォーカス
         */
        newPostContent.focus();
    }


    /* =========================================================
       投稿欄の入力を監視
       ========================================================= */

    newPostContent.addEventListener(
        "input",
        updateCleanUrlButton
    );


    /* =========================================================
       初期状態
       ========================================================= */

    updateCleanUrlButton();

})();