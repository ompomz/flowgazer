/**
 * view-state.js
 * 【責務】: タブ状態管理、表示判定、フィルタリング
 * channel タブ動的生成対応版
 */

class ViewState {
  constructor() {
    // ===== タブ状態管理 =====
    this.tabs = {
      global: {
        visibleEventIds: new Set(),
        cursor: null,
        timeRange: { oldest: null, newest: null }
      },
      following: {
        visibleEventIds: new Set(),
        cursor: null,
        timeRange: { oldest: null, newest: null }
      },
      myposts: {
        visibleEventIds: new Set(),
        cursor: null,
        timeRange: { oldest: null, newest: null }
      },
      likes: {
        visibleEventIds: new Set(),
        cursor: null,
        timeRange: { oldest: null, newest: null },
        baseline: null
      }
    };

    // ===== 現在の状態 =====
    this.currentTab = 'global';
    this.renderTimer = null;
    this.renderDelay = 300;

    console.log('✅ ViewState初期化完了');
  }

  // ========================================
  // チャンネルタブ管理
  // ========================================

  /**
   * チャンネルタブを取得または作成する
   * @param {string} channelId
   * @returns {Object} tabState
   */
  getOrCreateChannelTab(channelId) {
    const key = `channel:${channelId}`;
    if (!this.tabs[key]) {
      this.tabs[key] = {
        visibleEventIds: new Set(),
        cursor: null,
        timeRange: { oldest: null, newest: null },
        channelId
      };
      console.log(`📺 チャンネルタブ作成: ${key}`);
    }
    return this.tabs[key];
  }

  /**
   * 指定タブがチャンネルタブかどうか
   * @param {string} tab
   * @returns {boolean}
   */
  isChannelTab(tab) {
    return tab.startsWith('channel:');
  }

  /**
   * チャンネルタブのchannelIdを取得
   * @param {string} tab
   * @returns {string|null}
   */
  getChannelId(tab) {
    return this.isChannelTab(tab) ? tab.replace('channel:', '') : null;
  }

  // ========================================
  // イベント受信処理 (ライブストリーム)
  // ========================================

  onEventReceived(event) {
    const myPubkey = window.nostrAuth?.pubkey;
    const tabs = this._determineTargetTabs(event, myPubkey);

    if (tabs.length === 0) return false;

    let addedToCurrentTab = false;
    tabs.forEach(tab => {
      const added = this._addEventToTab(event, tab);
      if (added && tab === this.currentTab) {
        addedToCurrentTab = true;
      }
    });

    if (addedToCurrentTab) {
      this.scheduleRender();
    }

    return tabs.length > 0;
  }

  _determineTargetTabs(event, myPubkey) {
    const tabs = [];

    // global, following の判定
    if ([1, 6, 42].includes(event.kind)) {
      tabs.push('global');

      if (window.dataStore.isFollowing(event.pubkey)) {
        tabs.push('following');
      }
    }

    // myposts タブの判定
    if (myPubkey) {
      if ([1, 42].includes(event.kind) && event.pubkey === myPubkey) {
        tabs.push('myposts');
      }
      if (event.kind === 6 && event.pubkey === myPubkey) {
        tabs.push('myposts');
      }
    }

    // likes タブの判定
    if (myPubkey) {
      const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
      if ([7, 6, 1, 42].includes(event.kind) && targetPubkey === myPubkey) {
        tabs.push('likes');
      }
    }

    // ===== チャンネルタブへの振り分け =====
    if (event.kind === 42) {
      const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root')
                   || event.tags.find(t => t[0] === 'e');
      if (rootTag?.[1]) {
        const channelTabKey = `channel:${rootTag[1]}`;
        // そのチャンネルタブがすでに作成済みの場合のみ振り分ける
        if (this.tabs[channelTabKey]) {
          tabs.push(channelTabKey);
        }
      }
    }

    return tabs;
  }

  _addEventToTab(event, tab) {
    // チャンネルタブの場合は動的生成
    if (this.isChannelTab(tab)) {
      this.getOrCreateChannelTab(this.getChannelId(tab));
    }

    const tabState = this.tabs[tab];
    if (!tabState) return false;

    if (tabState.visibleEventIds.has(event.id)) {
      this._updateCursor(tabState, event.created_at);
      this._updateTimeRange(tabState, event.created_at);
      return false;
    }

    tabState.visibleEventIds.add(event.id);
    this._updateCursor(tabState, event.created_at);
    this._updateTimeRange(tabState, event.created_at);

    return true;
  }

  _updateCursor(tabState, created_at) {
    if (!tabState.cursor) {
      tabState.cursor = { until: created_at, since: created_at };
      return;
    }
    if (created_at < tabState.cursor.until) tabState.cursor.until = created_at;
    if (created_at > tabState.cursor.since) tabState.cursor.since = created_at;
  }

  _updateTimeRange(tabState, created_at) {
    if (!tabState.timeRange.oldest || created_at < tabState.timeRange.oldest) {
      tabState.timeRange.oldest = created_at;
    }
    if (!tabState.timeRange.newest || created_at > tabState.timeRange.newest) {
      tabState.timeRange.newest = created_at;
    }
  }

  // ========================================
  // 履歴イベント処理 (LoadMore)
  // ========================================

  addHistoryEventToTab(event, tab) {
    const added = this._addEventToTab(event, tab);
    if (added && tab === this.currentTab) {
      this.scheduleRender();
    }
    return added;
  }

  // ========================================
  // タブ切り替え
  // ========================================

  switchTab(newTab) {
    // チャンネルタブなら事前に作成しておく
    if (this.isChannelTab(newTab)) {
      this.getOrCreateChannelTab(this.getChannelId(newTab));
    } else if (!this.tabs[newTab]) {
      console.error(`❌ ViewState: 不明なタブ名: ${newTab}`);
      return;
    }

    const oldTab = this.currentTab;
    console.log(`📑 ViewState: タブ切り替え ${oldTab} → ${newTab}`);
    this.currentTab = newTab;
    this.renderNow();
  }

  _shouldShowInTab(event, tab, myPubkey) {
    // チャンネルタブ
    if (this.isChannelTab(tab)) {
      if (event.kind !== 42) return false;
      const channelId = this.getChannelId(tab);
      const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root')
                   || event.tags.find(t => t[0] === 'e');
      return rootTag?.[1] === channelId;
    }

    const kindFilters = {
      global: [1, 6, 42],
      following: [1, 6, 42],
      myposts: [1, 6, 42],
      likes: [7, 6, 1, 42]
    };

    if (!kindFilters[tab]?.includes(event.kind)) return false;

    switch (tab) {
      case 'global':   return true;
      case 'following': return window.dataStore.isFollowing(event.pubkey);
      case 'myposts':  return event.pubkey === myPubkey;
      case 'likes': {
        const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
        return targetPubkey === myPubkey;
      }
      default: return false;
    }
  }

  // ========================================
  // 表示用イベント取得
  // ========================================

  getVisibleEvents(tab, filterOptions = {}) {
    const myPubkey = window.nostrAuth?.pubkey;
    const tabState = this.tabs[tab];
    if (!tabState) return [];

    let events = window.dataStore.getAllEvents();

    // 時間範囲フィルタ
    if (tabState.timeRange.oldest && tabState.timeRange.newest) {
      events = events.filter(event =>
        event.created_at >= tabState.timeRange.oldest &&
        event.created_at <= tabState.timeRange.newest
      );
    }

    // タブ固有フィルタ
    events = events.filter(event => this._shouldShowInTab(event, tab, myPubkey));

    // 追加フィルタ
    events = this._applyFilters(events, tab, filterOptions);

    return events.sort((a, b) => {
      const dateDiff = b.created_at - a.created_at;
      if (dateDiff !== 0) return dateDiff;
      return a.id.localeCompare(b.id);
    });
  }

  _applyFilters(events, tab, options) {
    const flowgazerOnly = options?.flowgazerOnly || false;
    const authors = options?.authors || null;
    const showKind42 = options?.showKind42 || false;

    // チャンネルタブはフィルタ追加なし（_shouldShowInTab で完結）
    if (this.isChannelTab(tab)) return events;

    // likesタブ
    if (tab === 'likes') {
      const tabState = this.tabs.likes;
      if (tabState.baseline === null && events.length > 0) {
        const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
        const baselineIndex = Math.min(49, sorted.length - 1);
        tabState.baseline = sorted[baselineIndex].created_at;
        console.log(`📌 likesタブの初期Baselineを確定: ${new Date(tabState.baseline * 1000).toLocaleString()}`);
      }
      const baseline = tabState.baseline || 0;
      return events.filter(e => e.created_at >= baseline);
    }

    // kind:42 フィルタ
    if ((tab === 'global' || tab === 'following') && !showKind42) {
      events = events.filter(ev => ev.kind !== 42);
    }

    // 禁止ワードフィルタ
    const forbiddenWords = window.app?.forbiddenWords || [];
    if ((tab === 'global' || tab === 'following') && forbiddenWords.length > 0) {
      events = events.filter(ev => {
        if (ev.kind !== 1) return true;
        const content = ev.content.toLowerCase();
        return !forbiddenWords.some(word => content.includes(word.toLowerCase()));
      });
    }

    // 長い投稿の制限
    if (tab === 'global' || tab === 'following') {
      events = events.filter(ev => {
        if (ev.kind !== 1) return true;
        return ev.content.length <= 1000;
      });
    }

    // flowgazer絞り込み
    if (flowgazerOnly && tab !== 'likes') {
      events = events.filter(ev =>
        ev.kind === 1 &&
        ev.tags.some(tag => tag[0] === 'client' && tag[1] === 'flowgazer')
      );
    }

    // 投稿者絞り込み
    if (tab === 'global' && authors?.length > 0) {
      const authorSet = new Set(authors);
      events = events.filter(ev => authorSet.has(ev.pubkey));
    }

    return events;
  }

  // ========================================
  // カーソル管理
  // ========================================

  getOldestTimestamp(tab) {
    const cursor = this.tabs[tab]?.cursor;
    return cursor?.until || Math.floor(Date.now() / 1000);
  }

  updateTabCursor(tab, newUntil) {
    const tabState = this.tabs[tab];
    if (tabState?.cursor) {
      tabState.cursor.until = newUntil;
      this._updateTimeRange(tabState, newUntil);
      console.log(`⏰ ${tab}タブ cursor.until更新: ${new Date(newUntil * 1000).toLocaleString()}`);
    }
  }

  // ========================================
  // 描画スケジューリング
  // ========================================

  scheduleRender() {
    if (!window.app?.isAutoUpdate) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      if (window.timeline && typeof window.timeline.refresh === 'function') {
        window.timeline.refresh();
      }
    }, this.renderDelay);
  }

  renderNow() {
    clearTimeout(this.renderTimer);
    if (window.timeline && typeof window.timeline.refresh === 'function') {
      window.timeline.refresh();
    }
  }

  // ========================================
  // ユーティリティ
  // ========================================

  clearTab(tab) {
    const tabState = this.tabs[tab];
    if (tabState) {
      tabState.visibleEventIds.clear();
      tabState.cursor = null;
      tabState.timeRange = { oldest: null, newest: null };
      if (tabState.baseline !== undefined) tabState.baseline = null;
      console.log(`🗑️ タブ "${tab}" の状態をクリアしました。`);
    }
  }

  clearAll() {
    Object.keys(this.tabs).forEach(tab => this.clearTab(tab));
    console.log('🗑️ ViewState全体をクリアしました');
  }

  destroy() {
    clearTimeout(this.renderTimer);
    this.clearAll();
    console.log('🗑️ ViewState破棄完了');
  }
}

window.viewState = new ViewState();