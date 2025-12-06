/**
 * ViewStateクラス
 *
 * NostrクライアントのUI状態（主にタイムラインのタブと表示イベント）を管理します。
 * - 各タブ（global, following, myposts, likes）の状態を持ちます。
 * - イベントの追加、タブの切り替え、描画のスケジューリング、フィルタリング処理を担当します。
 */

// NostrイベントのKind（種類）を定数として定義し、マジックナンバーを排除
const KIND_TEXT_NOTE = 1;
const KIND_REPOST = 6;
const KIND_REACTION = 7;
const RENDER_DELAY_MS = 300; // 描画遅延のデフォルト値 (ミリ秒)

class ViewState {
    constructor() {
        /**
         * @property {Object<string, TabState>} tabs - 各タブの状態を保持するオブジェクト
         * - visibleEventIds: UIに表示されるイベントIDのSet
         * - cursor: タイムラインのページングに使用する created_at の範囲 (until/since)
         * - filter: そのタブで表示されるべきイベントの種類 (kinds)
         * - pendingEventIds: プロフィール情報が未取得で描画保留中のイベントIDのSet
         */
        this.tabs = {
            global: {
                visibleEventIds: new Set(),
                cursor: null,
                filter: { kinds: [KIND_TEXT_NOTE, KIND_REPOST] },
                pendingEventIds: new Set(),
            },
            following: {
                visibleEventIds: new Set(),
                cursor: null,
                filter: { kinds: [KIND_TEXT_NOTE, KIND_REPOST] },
                pendingEventIds: new Set(),
            },
            myposts: {
                visibleEventIds: new Set(),
                cursor: null,
                filter: { kinds: [KIND_TEXT_NOTE] },
                pendingEventIds: new Set(),
            },
            likes: {
                visibleEventIds: new Set(),
                cursor: null,
                filter: { kinds: [KIND_REACTION] },
                pendingEventIds: new Set(),
            }
        };

        /** @property {Map<string, Object<string, boolean>>} eventContext - イベントIDごとに、どのタブに属するかを記録するマップ */
        this.eventContext = new Map();

        /** @property {string} currentTab - 現在アクティブなタブの名前 ('global', 'following'など) */
        this.currentTab = 'global';

        /** @property {number|null} renderTimer - 描画スケジューリング用のタイマーID */
        this.renderTimer = null;

        /** @property {number} renderDelay - 描画処理を遅延させる時間 (ミリ秒) */
        this.renderDelay = RENDER_DELAY_MS;

        console.log('✅ ViewState初期化完了');
    }

    /**
     * 現在アクティブなタブの状態オブジェクトを取得します。
     * @returns {TabState} 現在のタブの状態
     */
    getCurrentTabState() {
        return this.tabs[this.currentTab];
    }
    
    /**
     * 【ライブストリーム用】イベントを、該当するすべてのタブに追加します。
     * このメソッドは、すべてのイベントのターゲットタブを自動で判断します。
     * @param {Object} event - Nostrイベントオブジェクト
     */
    addEvent(event) {
        const myPubkey = window.nostrAuth?.pubkey;
        // ターゲットタブを自動判定
        const tabs = this._determineTargetTabs(event, myPubkey);

        let addedToCurrentTab = false;
        tabs.forEach(tab => {
            const added = this.addEventToTab(event, tab);
            if (added && tab === this.currentTab) {
                addedToCurrentTab = true;
            }
        });

        // 現在のタブにイベントが追加された場合のみ、描画をスケジュール
        if (addedToCurrentTab) {
            this.scheduleRender();
        }
    }

    /**
     * 【履歴/LoadMore用】イベントを指定された単一のタブにのみ追加します。
     * このイベントは、他のタブ（global, following）には自動ルーティングされません。
     * @param {Object} event - Nostrイベントオブジェクト
     * @param {string} tab - 対象のタブ名
     * @returns {boolean} イベントが追加された場合は true、そうでなければ false
     */
    addHistoryEventToTab(event, tab) {
        // isHistory=true を渡すことで、このイベントが履歴取得由来であることをマークする。
        const added = this.addEventToTab(event, tab, true); 

        if (added && tab === this.currentTab) {
            this.scheduleRender();
        }
        return added;
    }

    /**
     * 指定されたタブにイベントを追加します。
     * @param {Object} event - Nostrイベントオブジェクト
     * @param {string} tab - 対象のタブ名
     * @param {boolean} [isHistory=false] - 履歴（LoadMoreなど）として取得されたか
     * @returns {boolean} イベントが追加された場合は true、そうでなければ false
     */
    addEventToTab(event, tab, isHistory = false) {
        const tabState = this.tabs[tab];
        if (!tabState) {
            return false;
        }

        // 1. フィルタリングで弾かれるかチェック
        if (!this._shouldShowInTab(event, tab)) {
            return false;
        }
        
        // 2. イベントコンテキストを更新（このイベントはこのタブに属すると記録）
        if (!this.eventContext.has(event.id)) {
            this.eventContext.set(event.id, {});
        }
        const context = this.eventContext.get(event.id);
        
        // 履歴イベントの場合は、そのタブでの履歴フラグを立てる
        if (isHistory) {
            context[`${tab}History`] = true;
        }
        // タブに属するフラグを立てる
        context[tab] = true;
        
        // 3. すでに追加されている場合は、コンテキストの更新のみで終了
        if (tabState.visibleEventIds.has(event.id)) {
            return false;
        }

        // 4. visibleEventIds に追加
        tabState.visibleEventIds.add(event.id);

        // 5. カーソルを更新（ページング用）
        this._updateCursor(tabState, event.created_at);

        // 6. プロフィールが未取得であれば、保留リストに追加し、フェッチをリクエスト
        if (!window.dataStore.profiles.has(event.pubkey)) {
            tabState.pendingEventIds.add(event.id);
            window.profileFetcher.request(event.pubkey);
        }

        return true;
    }

    /**
     * 指定されたイベントが特定のタブに表示されるべきかを判断します。
     * @param {Object} event - Nostrイベント
     * @param {string} tab - タブ名
     * @returns {boolean} 表示すべきなら true
     * @private
     */
    _shouldShowInTab(event, tab) {
        const myPubkey = window.nostrAuth?.pubkey;
        const tabState = this.tabs[tab];

        // 1. kindフィルタリング
        if (!tabState.filter.kinds.includes(event.kind)) {
            return false;
        }

        // 2. タブ固有のフィルタリング
        switch (tab) {
            case 'global':
                // ★ 自分のkind:1は除外（kind:6は含む）
                if (event.kind === KIND_TEXT_NOTE && event.pubkey === myPubkey) {
                    return false;
                }
                return event.kind === KIND_TEXT_NOTE || event.kind === KIND_REPOST;

            case 'following':
                // ★ 自分のkind:1は除外
                if (event.kind === KIND_TEXT_NOTE && event.pubkey === myPubkey) {
                    return false;
                }
                return (event.kind === KIND_TEXT_NOTE || event.kind === KIND_REPOST) &&
                       window.dataStore.followingPubkeys.has(event.pubkey);

            case 'myposts':
                return event.kind === KIND_TEXT_NOTE && event.pubkey === myPubkey;

            case 'likes':
                if (event.kind !== KIND_REACTION) {
                    return false;
                }
                const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
                return targetPubkey === myPubkey;

            default:
                return false;
        }
    }

    /**
     * 受信したイベントがどのタブに属するかを判定し、タブ名の配列を返します。
     * @param {Object} event - Nostrイベント
     * @param {string|null} myPubkey - ログインユーザーの公開鍵
     * @returns {string[]} 該当するタブ名の配列
     * @private
     */
    _determineTargetTabs(event, myPubkey) {
        const tabs = [];

        // グローバル/フォロー/自分の投稿の判定
        if (event.kind === KIND_TEXT_NOTE || event.kind === KIND_REPOST) {
            
            // ★ 自分のkind:1はglobal/followingに追加しない（kind:6は追加する）
            if (event.pubkey !== myPubkey || event.kind === KIND_REPOST) {
                 tabs.push('global'); 
            }

            // フォローしているユーザーの投稿であれば
            if (window.dataStore.followingPubkeys.has(event.pubkey)) {
                // ★ 自分のkind:1は除外
                if (event.pubkey !== myPubkey || event.kind === KIND_REPOST) {
                    tabs.push('following');
                }
            }

            // 自分の投稿であれば
            if (event.kind === KIND_TEXT_NOTE && event.pubkey === myPubkey) {
                tabs.push('myposts');
            }
        }

        // いいね/リアクションの判定
        if (event.kind === KIND_REACTION && myPubkey) {
            const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
            // 自分の投稿に対するリアクションであれば
            if (targetPubkey === myPubkey) {
                tabs.push('likes');
            }
        }

        return tabs;
    }

    /**
     * タブの状態のカーソル（until/since）を更新します。
     * @param {TabState} tabState - 対象のタブの状態
     * @param {number} created_at - イベントの作成日時（UNIXタイムスタンプ）
     * @private
     */
    _updateCursor(tabState, created_at) {
        if (!tabState.cursor) {
            // カーソルが未設定の場合は初期化
            tabState.cursor = { until: created_at, since: created_at };
            return;
        }

        // 最も古いイベントの created_at を更新
        if (created_at < tabState.cursor.until) {
            tabState.cursor.until = created_at;
        }

        // 最も新しいイベントの created_at を更新
        if (created_at > tabState.cursor.since) {
            tabState.cursor.since = created_at;
        }
    }

    /**
     * プロフィール情報が取得されたときに呼び出されます。
     * @param {string} pubkey - 取得されたプロフィールを持つ公開鍵
     */
    onProfileFetched(pubkey) {
        const tabState = this.getCurrentTabState();
        const eventsToRemove = [];

        tabState.pendingEventIds.forEach(eventId => {
            const event = window.dataStore.events.get(eventId);
            if (event && event.pubkey === pubkey) {
                eventsToRemove.push(eventId);
            }
        });

        eventsToRemove.forEach(id => tabState.pendingEventIds.delete(id));

        if (eventsToRemove.length > 0) {
            this.scheduleRender();
        }
    }

    /**
     * タブを切り替えます。
     * @param {string} newTab - 新しいタブ名
     */
    switchTab(newTab) {
        if (!this.tabs[newTab]) {
            console.error(`❌ ViewState: 不明なタブ名: ${newTab}`);
            return;
        }

        const oldTab = this.currentTab;
        console.log(`📑 ViewState: タブ切り替え ${oldTab} → ${newTab}`);

        this.currentTab = newTab;

        // タブ切り替え時に、そのタブの表示イベントを再構築
        this._repopulateTab(newTab);

        // 新しいタブへの切り替えに伴い、即時描画
        this.renderNow();
    }

    /**
     * 指定されたタブの表示イベントリストを、既存の全イベントから再構築します。
     * (主にタブ切り替え時やフィルタ変更時に使用)
     * @param {string} tab - 再構築するタブ名
     * @private
     */
    _repopulateTab(tab) {
        const tabState = this.tabs[tab];
        if (!tabState) return;

        console.log(`🔄 タブ "${tab}" を再構築中...`);

        // リストをクリア
        tabState.visibleEventIds.clear();
        tabState.pendingEventIds.clear();
        tabState.cursor = null;

        const allEvents = Array.from(window.dataStore.events.values());
        
        allEvents.forEach(event => {
            if (this._shouldShowInTab(event, tab)) {
                
                // 1. visibleEventIds に追加
                tabState.visibleEventIds.add(event.id);

                // 2. カーソルを更新（ページング用）
                this._updateCursor(tabState, event.created_at);

                // 3. プロフィールがなければ保留リストに追加
                if (!window.dataStore.profiles.has(event.pubkey)) {
                    tabState.pendingEventIds.add(event.id);
                    window.profileFetcher.request(event.pubkey);
                }
            }
        });

        console.log(`✅ タブ "${tab}" 再構築完了: ${tabState.visibleEventIds.size}件`);
    }

    /**
     * ★ 修正: 指定されたタブに表示されるべきイベントを取得し、フィルタリングとソートを行います。
     * global/followingの場合は合成フィードを使用。
     * @param {string} tab - タブ名
     * @param {Object} filterOptions - 適用する追加のフィルタオプション
     * @returns {Object[]} フィルタリング・ソート済みのイベントの配列
     */
    getVisibleEvents(tab, filterOptions = {}) {
        const tabState = this.tabs[tab];
        if (!tabState) return [];

        let events;

        // ★ global/followingの場合は合成フィードを取得
        if (tab === 'global' || tab === 'following') {
            events = window.dataStore.getMergedFeedForTab(tab, filterOptions);
        } else {
            // 通常通り取得
            events = Array.from(tabState.visibleEventIds)
                .map(id => window.dataStore.events.get(id))
                .filter(Boolean);
        }

        // --- その他のフィルタリング処理 ---

        // 1. 卑猥な単語フィルタ（global/followingのみ）
        const forbiddenWords = window.app?.forbiddenWords || [];
        if ((tab === 'global' || tab === 'following') && forbiddenWords.length > 0) {
            events = events.filter(ev => {
                if (ev.kind !== KIND_TEXT_NOTE) return true;
                const content = ev.content.toLowerCase();
                return !forbiddenWords.some(word => content.includes(word.toLowerCase()));
            });
        }

        // 2. 短い投稿の制限
        if (tab === 'global' || tab === 'following') {
            events = events.filter(ev => {
                if (ev.kind !== KIND_TEXT_NOTE) return true;
                return ev.content.length <= 190;
            });
        }

        // 3. flowgazer専用フィルタ（'likes'以外）
        if (filterOptions.flowgazerOnly && tab !== 'likes') {
            events = events.filter(ev =>
                ev.kind === KIND_TEXT_NOTE &&
                ev.tags.some(tag => tag[0] === 'client' && tag[1] === 'flowgazer')
            );
        }

        // 4. 特定の著者フィルタ
        if (filterOptions.authors?.length > 0) {
            const authorSet = new Set(filterOptions.authors);
            events = events.filter(ev => authorSet.has(ev.pubkey));
        }

        // 5. プロフィール情報が取得済みのイベントのみに絞り込み
        events = events.filter(ev => window.dataStore.profiles.has(ev.pubkey));

        // --- ソート処理 ---
        // 作成日時 (created_at) の降順でソート（新しいものが先頭）
        return events.sort((a, b) => {
            const dateDiff = b.created_at - a.created_at;
            if (dateDiff !== 0) return dateDiff;
            return a.id.localeCompare(b.id); // created_at が同じ場合は ID で安定化
        });
    }

    /**
     * 指定されたタブのカーソルオブジェクト（until/since）を取得します。
     * @param {string} tab - タブ名
     * @returns {Object|undefined} カーソルオブジェクト
     */
    getCursor(tab) {
        return this.tabs[tab]?.cursor;
    }

    /**
     * 指定されたタブで現在表示されている最も古いイベントのタイムスタンプを取得します。
     * @param {string} tab - タブ名
     * @returns {number} 最も古いタイムスタンプ、または現在時刻（秒）
     */
    getOldestTimestamp(tab) {
        const cursor = this.tabs[tab]?.cursor;
        return cursor?.until || Math.floor(Date.now() / 1000);
    }
    
    /**
     * ページングのためのアンカータイムスタンプを返します。
     * @param {string} tab - 対象のタブ名
     * @returns {number} 次のリクエストで使用すべき until タイムスタンプ（anchor）
     */
    requestLoadMore(tab) {
        const oldest = this.getOldestTimestamp(tab);
        console.log(`⬇️ Tab "${tab}": LoadMoreリクエスト。アンカー時刻 ${oldest} を返します。`);
        return oldest;
    }

    /**
     * 遅延タイマーを設定し、描画処理 (window.timeline.refresh()) をスケジュールします。
     */
    scheduleRender() {
        if (!window.app?.isAutoUpdate) return;

        clearTimeout(this.renderTimer);
        this.renderTimer = setTimeout(() => {
            if (window.timeline && typeof window.timeline.refresh === 'function') {
                window.timeline.refresh();
            }
        }, this.renderDelay);
    }

    /**
     * スケジュールされている描画処理をキャンセルし、即座に描画を強制実行します。
     */
    renderNow() {
        clearTimeout(this.renderTimer);
        if (window.timeline && typeof window.timeline.refresh === 'function') {
            window.timeline.refresh();
        }
    }

    /**
     * 指定されたタブの表示イベントリストと保留リストをクリアし、カーソルをリセットします。
     * @param {string} tab - タブ名
     */
    clearTab(tab) {
        const tabState = this.tabs[tab];
        if (tabState) {
            tabState.visibleEventIds.clear();
            tabState.pendingEventIds.clear();
            tabState.cursor = null;
            
            // コンテキストマップから、このタブの履歴フラグを削除
            this.eventContext.forEach(context => {
                delete context[`${tab}History`];
                delete context[tab];
            });
            
            console.log(`🗑️ タブ "${tab}" の状態をクリアしました。`);
        }
    }
}

// グローバルスコープに ViewState のインスタンスを初期化してエクスポート
window.viewState = new ViewState();