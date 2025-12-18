/**
 * view-state.js
 * 【責務】: タブ状態管理、表示判定、フィルタリング
 */

const RENDER_DELAY_MS = 300;
const CUTOFF_OFFSET_MINUTES = 15; // 初回ロード時のcutoff基準（現在時刻からのオフセット）

class ViewState {
  constructor() {
    // ===== タブ状態管理 =====
    this.tabs = {
      global: {
        visibleEventIds: new Set(),
        cursor: null,
        filter: { kinds: [1, 6] }
      },
      following: {
        visibleEventIds: new Set(),
        cursor: null,
        filter: { kinds: [1, 6] }
      },
      myposts: {
        visibleEventIds: new Set(),
        cursor: null,
        filter: { kinds: [1, 42] }
      },
      likes: {
        visibleEventIds: new Set(),
        cursor: null,
        filter: { kinds: [7, 6, 1] }
      }
    };

    // ===== 現在の状態 =====
    this.currentTab = 'global';
    this.renderTimer = null;
    this.renderDelay = RENDER_DELAY_MS;

    console.log('✅ ViewState初期化完了');
  }

  // ========================================
  // イベント受信処理 (ライブストリーム)
  // ========================================

  /**
   * 新規イベントを受信したときの処理
   * @param {Object} event - Nostrイベント
   * @returns {boolean} いずれかのタブに追加された場合true
   */
  onEventReceived(event) {
    const myPubkey = window.nostrAuth?.pubkey;
    
    // 振り分け先タブを判定
    const tabs = this._determineTargetTabs(event, myPubkey);
    
    if (tabs.length === 0) {
      return false;
    }

    // 各タブに追加
    let addedToCurrentTab = false;
    tabs.forEach(tab => {
      const added = this._addEventToTab(event, tab, myPubkey);
      if (added && tab === this.currentTab) {
        addedToCurrentTab = true;
      }
    });

    // 現在のタブに追加された場合のみ描画スケジュール
    if (addedToCurrentTab) {
      this.scheduleRender();
    }

    return tabs.length > 0;
  }

  /**
   * イベントがどのタブに属するかを判定
   * @private
   * @param {Object} event
   * @param {string|null} myPubkey
   * @returns {string[]} タブ名の配列
   */
  _determineTargetTabs(event, myPubkey) {
    const tabs = [];

    // === Global / Following / MyPosts ===
    if ([1, 6, 42].includes(event.kind)) {

      // global に入れる条件を緩める
      tabs.push('global');

      // following は「フォローリストに従う」ので、自分が入っていたら含める
      if (window.dataStore.isFollowing(event.pubkey)) {
        tabs.push('following');
      }

      // 自分の投稿は myposts にも入れる
      if ([1, 42].includes(event.kind) && event.pubkey === myPubkey) {
        tabs.push('myposts');
      }
    }

    // === Likes (自分宛のリアクション/リポスト/メンション) ===
    if ([7, 6, 1].includes(event.kind) && myPubkey) {
      const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
      if (targetPubkey === myPubkey) {
        tabs.push('likes');
      }
    }

    return tabs;
  }

  /**
   * イベントを指定タブに追加
   * @private
   */
  /**
 * イベントを指定タブに追加
 * @private
 */
  _addEventToTab(event, tab, myPubkey) {
    const tabState = this.tabs[tab];
    if (!tabState) return false;

    // 重複チェック
    if (tabState.visibleEventIds.has(event.id)) {
      return false;
    }

    // 追加
    tabState.visibleEventIds.add(event.id);

    // カーソル更新
    if (tab === 'global' || tab === 'following') {
      this._updateCursorForMainTabs(tabState, event, myPubkey);
    } else if (tab === 'likes') {
      this._updateCursorForLikesTab(tabState, event, myPubkey);
    } else {
      this._updateCursor(tabState, event.created_at);
    }

    return true;
  }

  /**
   * カーソル (until/since) を更新
   * @private
   */
  _updateCursor(tabState, created_at) {
    if (!tabState.cursor) {
      tabState.cursor = { until: created_at, since: created_at };
      return;
    }

    if (created_at < tabState.cursor.until) {
      tabState.cursor.until = created_at;
    }
    if (created_at > tabState.cursor.since) {
      tabState.cursor.since = created_at;
    }
  }

  /**
   * global/followingタブ専用のカーソル更新
   * cursor.untilは「自分以外 かつ pタグに自分なし」のイベントのみで更新
   * @private
   */
  _updateCursorForMainTabs(tabState, event, myPubkey) {
    const mentionsMe = event.tags.some(t => t[0] === 'p' && t[1] === myPubkey);
    const isOthersEvent = event.pubkey !== myPubkey && !mentionsMe;

    if (!tabState.cursor) {
      if (isOthersEvent) {
        // 他人イベントでカーソル初期化
        tabState.cursor = { until: event.created_at, since: event.created_at };
      } else {
        // 初回が自分関連イベントの場合は15分前を設定
        const now = Math.floor(Date.now() / 1000);
        const cutoffTime = now - (CUTOFF_OFFSET_MINUTES * 60);
        tabState.cursor = { until: cutoffTime, since: event.created_at };
        console.log(`⏰ ${tabState === this.tabs.global ? 'global' : 'following'}タブ: 初回cutoffを15分前に設定 (${new Date(cutoffTime * 1000).toLocaleString()})`);
      }
      return;
    }

    // 他人イベントのみでuntilを更新
    if (isOthersEvent && event.created_at < tabState.cursor.until) {
      tabState.cursor.until = event.created_at;
    }

    // sinceは全イベントで更新
    if (event.created_at > tabState.cursor.since) {
      tabState.cursor.since = event.created_at;
    }
  }

  /**
 * likesタブ専用のカーソル更新
 * cursor.untilは kind:7 の最新50件目の created_at を基準にする
 * @private
 */
  _updateCursorForLikesTab(tabState, event, myPubkey) {
    // まず基本的なカーソル更新
    this._updateCursor(tabState, event.created_at);

    // kind:7 のイベントが追加された場合、cursor.until を再計算
    if (event.kind === 7) {
      // kind:7 のイベントを全て取得してソート
      const kind7Events = Array.from(tabState.visibleEventIds)
        .map(id => window.dataStore.getEvent(id))
        .filter(ev => ev && ev.kind === 7)
        .sort((a, b) => b.created_at - a.created_at);

      // 50件以上ある場合、50件目の created_at を cursor.until に設定
      if (kind7Events.length >= 50) {
        const fiftiethEvent = kind7Events[49];
        if (tabState.cursor) {
          tabState.cursor.until = fiftiethEvent.created_at;
          console.log(`⏰ likesタブ: cursor.until更新 (kind:7の50件目: ${new Date(fiftiethEvent.created_at * 1000).toLocaleString()})`);
        }
      }
    }
  }

  // ========================================
  // 履歴イベント処理 (LoadMore)
  // ========================================

  /**
   * 履歴イベントを指定タブに追加
   * @param {Object} event
   * @param {string} tab
   * @returns {boolean}
   */
  addHistoryEventToTab(event, tab) {
    const myPubkey = window.nostrAuth?.pubkey;
    const added = this._addEventToTab(event, tab, myPubkey);

    if (added && tab === this.currentTab) {
      this.scheduleRender();
    }

    return added;
  }

  // ========================================
  // タブ切り替え
  // ========================================

  /**
   * タブを切り替え
   * @param {string} newTab
   */
  switchTab(newTab) {
    if (!this.tabs[newTab]) {
      console.error(`❌ ViewState: 不明なタブ名: ${newTab}`);
      return;
    }

    const oldTab = this.currentTab;
    console.log(`📑 ViewState: タブ切り替え ${oldTab} → ${newTab}`);

    this.currentTab = newTab;

    // タブの表示内容を再構築
    this._repopulateTab(newTab);

    // 即座に描画
    this.renderNow();
  }

  /**
   * タブの表示内容を全イベントから再構築
   * @private
   */
  _repopulateTab(tab) {
    const tabState = this.tabs[tab];
    if (!tabState) return;

    console.log(`🔄 タブ "${tab}" を再構築中...`);

    // クリア
    tabState.visibleEventIds.clear();
    tabState.cursor = null;

    // 全イベントから対象を抽出
    const allEvents = window.dataStore.getAllEvents();
    const myPubkey = window.nostrAuth?.pubkey;

    allEvents.forEach(event => {
      if (this._shouldShowInTab(event, tab, myPubkey)) {
        this._addEventToTab(event, tab, myPubkey);
      }
    });

    console.log(`✅ タブ "${tab}" 再構築完了: ${tabState.visibleEventIds.size}件`);
  }

  /**
   * イベントが指定タブに表示されるべきかを判定
   * @private
   */
  _shouldShowInTab(event, tab, myPubkey) {
    const tabState = this.tabs[tab];

    // kind制約
    if (!tabState.filter.kinds.includes(event.kind)) {
      return false;
    }

    switch (tab) {
      case 'global':
      case 'following': {

        // followingタブの追加条件
        if (tab === 'following') {
          // フォロー中のユーザーのみ
          if (!window.dataStore.isFollowing(event.pubkey)) {
            return false;
          }
        }

        return true;
      }

      case 'myposts':
        return event.pubkey === myPubkey;

      case 'likes':
        const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
        return targetPubkey === myPubkey;

      default:
        return false;
    }
  }

  // ========================================
  // 表示用イベント取得
  // ========================================

  /**
   * 指定タブの表示イベントを取得 (フィルタリング済み・ソート済み)
   * @param {string} tab
   * @param {Object} filterOptions - { flowgazerOnly, authors }
   * @returns {Object[]}
   */
  /**
 * 指定タブの表示イベントを取得 (フィルタリング済み・ソート済み)
 * @param {string} tab
 * @param {Object} filterOptions - { flowgazerOnly, authors }
 * @returns {Object[]}
 */
  getVisibleEvents(tab, filterOptions = {}) {
    const tabState = this.tabs[tab];
    if (!tabState) return [];

    // 通常取得
    let events = Array.from(tabState.visibleEventIds)
      .map(id => window.dataStore.getEvent(id))
      .filter(Boolean);

    // === cutoffフィルタ (global/following/likes) ===
    if (tab === 'global' || tab === 'following' || tab === 'likes') {
      events = this._applyCutoffFilter(events, tabState, tab);
    }

    // === 追加フィルタリング ===
    events = this._applyFilters(events, tab, filterOptions);

    // === ソート ===
    return events.sort((a, b) => {
      const dateDiff = b.created_at - a.created_at;
      if (dateDiff !== 0) return dateDiff;
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * cutoffフィルタを適用
   * @private
   */
  /**
 * cutoffフィルタを適用
 * @private
 */
  _applyCutoffFilter(events, tabState, tab) {
    if (!tabState.cursor?.until) {
      // cursor.untilがない場合は15分前を基準にする
      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - (CUTOFF_OFFSET_MINUTES * 60);
      console.log(`⏰ cutoff基準なし: 15分前 (${new Date(cutoff * 1000).toLocaleString()}) を使用`);

      // likesタブの場合は kind:7 を除外してフィルタ
      if (tab === 'likes') {
        return events.filter(ev => ev.kind === 7 || ev.created_at >= cutoff);
      }
      return events.filter(ev => ev.created_at >= cutoff);
    }

    const cutoff = tabState.cursor.until;
    const beforeCount = events.length;

    // likesタブの場合は kind:7 を残し、kind:1 と kind:6 のみフィルタ
    let filtered;
    if (tab === 'likes') {
      filtered = events.filter(ev => {
        if (ev.kind === 7) return true; // kind:7 は全て残す
        return ev.created_at >= cutoff; // kind:1, kind:6 は cutoff でフィルタ
      });
    } else {
      filtered = events.filter(ev => ev.created_at >= cutoff);
    }

    if (beforeCount !== filtered.length) {
      console.log(`✂️ cutoffフィルタ適用 (${tab}): ${beforeCount}件 → ${filtered.length}件 (基準: ${new Date(cutoff * 1000).toLocaleString()})`);
    }

    return filtered;
  }

  /**
   * 追加フィルタを適用
   * @private
   */
  _applyFilters(events, tab, options) {
    const { flowgazerOnly = false, authors = null, showKind42 = false } = options;

    // 0. kind:42 フィルタ (global/following のみ)
    if ((tab === 'global' || tab === 'following') && !showKind42) {
      events = events.filter(ev => ev.kind !== 42);
      console.log(`🚫 kind:42を非表示 (${tab}タブ)`);
    }

    // 1. 禁止ワードフィルタ (global/following)
    const forbiddenWords = window.app?.forbiddenWords || [];
    if ((tab === 'global' || tab === 'following') && forbiddenWords.length > 0) {
      events = events.filter(ev => {
        if (ev.kind !== 1) return true;
        const content = ev.content.toLowerCase();
        return !forbiddenWords.some(word => content.includes(word.toLowerCase()));
      });
    }

    // 2. 短い投稿の制限 (global/following)
    if (tab === 'global' || tab === 'following') {
      events = events.filter(ev => {
        if (ev.kind !== 1) return true;
        return ev.content.length <= 190;
      });
    }

    // 3. flowgazerしぼりこみ (likes以外)
    if (flowgazerOnly && tab !== 'likes') {
      events = events.filter(ev =>
        ev.kind === 1 &&
        ev.tags.some(tag => tag[0] === 'client' && tag[1] === 'flowgazer')
      );
    }

    // 4. 投稿者しぼりこみ (globalのみ)
    if (tab === 'global' && authors?.length > 0) {
      const authorSet = new Set(authors);
      events = events.filter(ev => authorSet.has(ev.pubkey));
      console.log(`🔍 globalタブ: 投稿者絞り込み適用（${authors.length}人）`);
    }

    // 5. kind:1基準のフィルタリング (global/following)
    if (tab === 'global' || tab === 'following') {
      const kind1Events = events.filter(e => e.kind === 1);
      
      if (kind1Events.length > 0) {
        const kind1Oldest = kind1Events[Math.min(149, kind1Events.length - 1)]?.created_at || 0;
        
        events = events.filter(e => {
          if (e.kind === 1) return true;
          if ([6, 42].includes(e.kind)) {
            return e.created_at >= kind1Oldest;
          }
          return true;
        });
      }
    }

    return events;
  }

  // ========================================
  // LoadMoreフィルタ構築
  // ========================================

  /**
   * LoadMore用フィルタを構築
   * @param {string} tab
   * @param {number} untilTimestamp
   * @returns {Object|null} フィルタオブジェクト
   */
  buildLoadMoreFilter(tab, untilTimestamp) {
    const myPubkey = window.nostrAuth?.pubkey;

    const filter = {
      until: untilTimestamp - 1,
      limit: 50
    };

    switch (tab) {
      case 'global':
        filter.kinds = [1, 6];
        break;
        
      case 'following':
        if (window.dataStore.followingPubkeys.size === 0) {
            console.warn('フォローリストが空です');
            return null;
        }
        filter.kinds = [1, 6];
        const followingAuthors = Array.from(window.dataStore.followingPubkeys);
        if (myPubkey) {
            if (window.dataStore.isFollowing(myPubkey)) {
                filter.authors = followingAuthors;
            } else {
                filter.authors = followingAuthors.filter(pk => pk !== myPubkey);
            }
        } else {
            filter.authors = followingAuthors;
        }
        break;

      case 'myposts':
        if (!myPubkey) {
          console.warn('ログインが必要です');
          return null;
        }
        filter.kinds = [1];
        filter.authors = [myPubkey];
        break;

      case 'likes':
        if (!myPubkey) {
          console.warn('ログインが必要です');
          return null;
        }
        filter.kinds = [7];
        filter['#p'] = [myPubkey];
        break;

      default:
        console.error('Unknown tab:', tab);
        return null;
    }

    return filter;
  }

  // ========================================
  // カーソル/タイムスタンプ管理
  // ========================================

  /**
   * 指定タブの最古タイムスタンプを取得
   * @param {string} tab
   * @returns {number}
   */
  getOldestTimestamp(tab) {
    const cursor = this.tabs[tab]?.cursor;
    return cursor?.until || Math.floor(Date.now() / 1000);
  }

  // ========================================
  // 描画スケジューリング
  // ========================================

  /**
   * 遅延描画をスケジュール
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
   * 即座に描画
   */
  renderNow() {
    clearTimeout(this.renderTimer);
    if (window.timeline && typeof window.timeline.refresh === 'function') {
      window.timeline.refresh();
    }
  }

  // ========================================
  // ユーティリティ
  // ========================================

  /**
   * タブをクリア
   * @param {string} tab
   */
  clearTab(tab) {
    const tabState = this.tabs[tab];
    if (tabState) {
      tabState.visibleEventIds.clear();
      tabState.cursor = null;
      console.log(`🗑️ タブ "${tab}" の状態をクリアしました。`);
    }
  }

  /**
   * すべてをクリア
   */
  clearAll() {
    Object.keys(this.tabs).forEach(tab => this.clearTab(tab));
    console.log('🗑️ ViewState全体をクリアしました');
  }

  /**
   * 破棄処理
   */
  destroy() {
    clearTimeout(this.renderTimer);
    this.clearAll();
    console.log('🗑️ ViewState破棄完了');
  }
}

// グローバルインスタンス
window.viewState = new ViewState();
