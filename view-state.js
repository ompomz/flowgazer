/**
 * view-state.js
 * 【責務】: タブ状態管理、表示判定、フィルタリング
 * Baseline方式対応版（Cutoffロジック廃止）
 */

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
        filter: { kinds: [7, 6, 1, 42] }
      }
    };

    // ===== 現在の状態 =====
    this.currentTab = 'global';
    this.renderTimer = null;
    this.renderDelay = 300;

    console.log('✅ ViewState初期化完了');
  }

  // ========================================
  // イベント受信処理 (ライブストリーム)
  // ========================================

  /**
   * 新規イベントを受信したときの処理
   * @param {Object} event - Nostrイベント
   * @returns {boolean}
   */
  onEventReceived(event) {
    const myPubkey = window.nostrAuth?.pubkey;
    const tabs = this._determineTargetTabs(event, myPubkey);
    
    if (tabs.length === 0) return false;

    let addedToCurrentTab = false;
    tabs.forEach(tab => {
      const added = this._addEventToTab(event, tab, myPubkey);
      if (added && tab === this.currentTab) {
        addedToCurrentTab = true;
      }
    });

    if (addedToCurrentTab) {
      this.scheduleRender();
    }

    return tabs.length > 0;
  }

  /**
   * イベントがどのタブに属するかを判定
   * @private
   */
  _determineTargetTabs(event, myPubkey) {
    const tabs = [];

    // global, following, myposts の判定
    if ([1, 6, 42].includes(event.kind)) {
      tabs.push('global');

      if (window.dataStore.isFollowing(event.pubkey)) {
        tabs.push('following');
      }

      if ([1, 42].includes(event.kind) && event.pubkey === myPubkey) {
        tabs.push('myposts');
      }
    }

    // likes タブの判定（厳格化）
    if (myPubkey) {
      const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
      
      // kind:7, 6, 1, 42 で自分宛のイベント
      if ([7, 6, 1, 42].includes(event.kind) && targetPubkey === myPubkey) {
        tabs.push('likes');
      }
    }

    return tabs;
  }

  /**
   * イベントを指定タブに追加
   * @private
   */
  _addEventToTab(event, tab, myPubkey) {
    const tabState = this.tabs[tab];
    if (!tabState) return false;

    if (tabState.visibleEventIds.has(event.id)) {
      return false;
    }

    tabState.visibleEventIds.add(event.id);
    this._updateCursor(tabState, event.created_at);

    return true;
  }

  /**
   * カーソル (until/since) を単純に更新
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
    this._repopulateTab(newTab);
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

    tabState.visibleEventIds.clear();
    tabState.cursor = null;

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

    if (!tabState.filter.kinds.includes(event.kind)) {
      return false;
    }

    switch (tab) {
      case 'global':
      case 'following':
        if (tab === 'following') {
          if (!window.dataStore.isFollowing(event.pubkey)) {
            return false;
          }
        }
        return true;

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
   * @param {Object} filterOptions - { flowgazerOnly, authors, showKind42 }
   * @returns {Object[]}
   */
  getVisibleEvents(tab, filterOptions = {}) {
    const tabState = this.tabs[tab];
    if (!tabState) return [];

    let events = Array.from(tabState.visibleEventIds)
      .map(id => window.dataStore.getEvent(id))
      .filter(Boolean);

    events = this._applyFilters(events, tab, filterOptions);

    return events.sort((a, b) => {
      const dateDiff = b.created_at - a.created_at;
      if (dateDiff !== 0) return dateDiff;
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * 追加フィルタを適用
   * @private
   */
  _applyFilters(events, tab, options) {
    const { flowgazerOnly = false, authors = null, showKind42 = false } = options;

    // ===== likesタブの厳格化処理 =====
    if (tab === 'likes') {
      // 1. kind:7 のみを抽出して新しい順にソート
      const kind7Events = events
        .filter(e => e.kind === 7)
        .sort((a, b) => b.created_at - a.created_at);

      // 2. 50件目（またはそれ以下の最古）を基準とする
      let likesBaseline = 0;
      if (kind7Events.length > 0) {
        const baselineIndex = Math.min(49, kind7Events.length - 1);
        likesBaseline = kind7Events[baselineIndex].created_at;
        console.log(`📌 likesタブ基準: ${new Date(likesBaseline * 1000).toLocaleString()} (kind:7の${baselineIndex + 1}件目)`);
      }

      // 3. すべてのイベントをこの基準でフィルタ
      events = events.filter(e => e.created_at >= likesBaseline);
      
      return events;
    }

    // ===== 以下、他のタブの既存フィルタ処理 =====

    // 0. kind:42 フィルタ
    if ((tab === 'global' || tab === 'following') && !showKind42) {
      events = events.filter(ev => ev.kind !== 42);
    }

    // 1. 禁止ワードフィルタ
    const forbiddenWords = window.app?.forbiddenWords || [];
    if ((tab === 'global' || tab === 'following') && forbiddenWords.length > 0) {
      events = events.filter(ev => {
        if (ev.kind !== 1) return true;
        const content = ev.content.toLowerCase();
        return !forbiddenWords.some(word => content.includes(word.toLowerCase()));
      });
    }

    // 2. 短い投稿の制限
    if (tab === 'global' || tab === 'following') {
      events = events.filter(ev => {
        if (ev.kind !== 1) return true;
        return ev.content.length <= 190;
      });
    }

    // 3. flowgazerしぼりこみ
    if (flowgazerOnly && tab !== 'likes') {
      events = events.filter(ev =>
        ev.kind === 1 &&
        ev.tags.some(tag => tag[0] === 'client' && tag[1] === 'flowgazer')
      );
    }

    // 4. 投稿者しぼりこみ
    if (tab === 'global' && authors?.length > 0) {
      const authorSet = new Set(authors);
      events = events.filter(ev => authorSet.has(ev.pubkey));
      console.log(`🔍 globalタブ: 投稿者絞り込み適用（${authors.length}人）`);
    }

    // 5. kind:1基準のフィルタリング
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
  // カーソル管理
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

  /**
   * タブのカーソルを更新（LoadMore用）
   * @param {string} tab
   * @param {number} newUntil
   */
  updateTabCursor(tab, newUntil) {
    const tabState = this.tabs[tab];
    if (tabState?.cursor) {
      tabState.cursor.until = newUntil;
      console.log(`⏰ ${tab}タブ cursor.until更新: ${new Date(newUntil * 1000).toLocaleString()}`);
    }
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

window.viewState = new ViewState();