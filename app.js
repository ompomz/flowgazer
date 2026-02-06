/**
 * app.js
 * 【責務】: アプリケーション制御、リレー接続、ユーザーアクション処理
 * Baseline方式対応版
 */

class FlowgazerApp {
  constructor() {
    // ===== アプリケーション状態 =====
    this.currentTab = 'global';
    this.isAutoUpdate = true;
    this.filterAuthors = null;
    this.flowgazerOnly = false;
    this.forbiddenWords = [];
    this.showKind42 = false;
    
    // ===== データ取得済みフラグ =====
    this.tabDataFetched = {
      global: false,
      following: false,
      myposts: false,
      likes: false
    };
    
    // ===== Baseline方式用 =====
    this.isInitializing = false;
    this.cursorSince = null; // Anchor Phaseで確定した基準時刻
  }

  // ========================================
  // 初期化
  // ========================================

  async init() {

    console.log('🚀 flowgazer起動中...');
    
    // ログインUI更新
    this.updateLoginUI();

    // リレー接続
    const savedRelay = localStorage.getItem('relayUrl');
    const defaultRelay = 'wss://nos.lol/';
    const relay = savedRelay || defaultRelay;
    await this.connectRelay(relay);

    // 禁止ワード取得
    await this.fetchForbiddenWords();

    // ログイン済みなら初期データ取得
    if (window.nostrAuth.isLoggedIn()) {
      this.fetchInitialData();
    }

    // Baseline方式でタイムライン初期化
    await this.initializeTimelineBaseline();

    console.log('✅ flowgazer起動完了');
  }

  // ========================================
  // Baseline方式タイムライン初期化
  // ========================================

  /**
   * Baseline方式でタイムラインを初期化（2段階処理）
   */
  async initializeTimelineBaseline() {
    if (this.isInitializing) {
      console.warn('⚠️ すでに初期化中です');
      return;
    }

    this.isInitializing = true;
    console.log('📡 Baseline方式: Anchor Phase開始');

    // ===== 第1段階: Anchor Phase =====
    const anchorResult = await this.executeAnchorPhase();
    
    if (!anchorResult.success) {
      this.isInitializing = false;
      if (anchorResult.isEmpty) {
        alert('これで全部です');
      }
      return;
    }

    this.cursorSince = anchorResult.oldestTimestamp;
    console.log(`✅ Anchor Phase完了: cursor_since=${new Date(this.cursorSince * 1000).toLocaleString()}`);

    // ===== 第2段階: Stream Phase =====
    this.executeStreamPhase();
    
    this.isInitializing = false;
  }

  /**
   * Anchor Phase: kind:1のみを150件取得
   * @returns {Object} { success, oldestTimestamp, isEmpty }
   */
  async executeAnchorPhase() {
    return new Promise((resolve) => {
      const events = [];
      let resolved = false;
      const TIMEOUT_MS = 10000; // 10秒

      const resolveOnce = (result) => {
        if (resolved) return;
        resolved = true;
        window.relayManager.unsubscribe('anchor-phase');
        resolve(result);
      };

      // タイムアウト設定
      const timeoutId = setTimeout(() => {
        console.log('⏱️ Anchor Phase: タイムアウト');
        if (events.length === 0) {
          resolveOnce({ success: false, isEmpty: true });
        } else {
          const oldest = Math.min(...events.map(e => e.created_at));
          resolveOnce({ success: true, oldestTimestamp: oldest });
        }
      }, TIMEOUT_MS);

      // 購読開始
      window.relayManager.subscribe('anchor-phase', {
        kinds: [1],
        limit: 150
      }, (type, event) => {
        if (type === 'EVENT') {
          const added = window.dataStore.addEvent(event);
          if (added) {
            events.push(event);
            window.viewState.onEventReceived(event);
            window.profileFetcher.request(event.pubkey);

            // 150件到達で終了
            if (events.length >= 150) {
              clearTimeout(timeoutId);
              const oldest = Math.min(...events.map(e => e.created_at));
              resolveOnce({ success: true, oldestTimestamp: oldest });
            }
          }
        } else if (type === 'EOSE') {
          clearTimeout(timeoutId);
          console.log(`📡 Anchor Phase EOSE: ${events.length}件取得`);
          
          if (events.length === 0) {
            resolveOnce({ success: false, isEmpty: true });
          } else {
            const oldest = Math.min(...events.map(e => e.created_at));
            resolveOnce({ success: true, oldestTimestamp: oldest });
          }
        }
      });
    });
  }

  /**
   * Stream Phase: since指定でリアルタイム購読
   */
  executeStreamPhase() {
    console.log('📡 Stream Phase開始');

    const filters = this._buildStreamPhaseFilters();

    window.relayManager.subscribe('stream-phase', filters, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.onEventReceived(event);
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('📡 Stream Phase EOSE受信');
        window.profileFetcher.flushNow();
      }
    });
  }

  /**
   * Stream Phase用フィルタ構築
   * @private
   */
  _buildStreamPhaseFilters() {
    const filters = [];
    const myPubkey = window.nostrAuth.isLoggedIn() ? window.nostrAuth.pubkey : null;

    // === Global フィルタ ===
    const globalFilter = {
      kinds: this.showKind42 ? [1, 6, 42] : [1, 6],
      since: this.cursorSince
    };

    if (this.filterAuthors && this.filterAuthors.length > 0) {
      globalFilter.authors = this.filterAuthors;
    }

    filters.push(globalFilter);

    // === Following フィルタ ===
    if (window.dataStore.followingPubkeys.size > 0) {
      const followingAuthors = Array.from(window.dataStore.followingPubkeys);
      let filteredFollowing;
      
      if (myPubkey) {
        if (window.dataStore.isFollowing(myPubkey)) {
          filteredFollowing = followingAuthors;
        } else {
          filteredFollowing = followingAuthors.filter(pk => pk !== myPubkey);
        }
      } else {
        filteredFollowing = followingAuthors;
      }

      if (filteredFollowing.length > 0) {
        filters.push({
          kinds: this.showKind42 ? [1, 6, 42] : [1, 6],
          authors: filteredFollowing,
          since: this.cursorSince
        });
      }
    }

    // === Likes フィルタ (自分宛のリアクション等) ===
    if (myPubkey) {
      filters.push({
        kinds: [7],
        '#p': [myPubkey],
        since: this.cursorSince
      });

      filters.push({
        kinds: [6],
        '#p': [myPubkey],
        since: this.cursorSince
      });

      filters.push({
        kinds: [1],
        '#p': [myPubkey],
        since: this.cursorSince
      });

      const myPostIds = Array.from(window.dataStore.getEventIdsByAuthor(myPubkey));
      if (myPostIds.length > 0) {
        filters.push({
          kinds: [6, 7],
          '#e': myPostIds.slice(0, 100),
          since: this.cursorSince
        });
      }
    }

    return filters;
  }

  // ========================================
  // リレー接続管理
  // ========================================

  /**
   * リレーに接続
   * @param {string} url
   */
  async connectRelay(url) {
    try {
      document.getElementById('relay-url').value = url;
      await window.relayManager.connect(url);
      localStorage.setItem('relayUrl', url);
    } catch (err) {
      console.error('❌ リレー接続失敗:', err);
      alert('リレーに接続できませんでした: ' + url);
    }
  }

  // ========================================
  // 初期データ取得
  // ========================================

  /**
   * ログイン後の初期データ取得
   */
  fetchInitialData() {
    const myPubkey = window.nostrAuth.pubkey;

    // 1. フォローリスト取得
    window.relayManager.subscribe('following-list', {
      kinds: [3],
      authors: [myPubkey],
      limit: 1
    }, (type, event) => {
      if (type === 'EVENT') {
        const pubkeys = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
        window.dataStore.setFollowingList(pubkeys);
        window.profileFetcher.requestMultiple(pubkeys);
      }
    });

    // 2. 自分のふぁぼ取得
    window.relayManager.subscribe('my-likes', {
      kinds: [7],
      authors: [myPubkey]
    }, (type, event) => {
      if (type === 'EVENT') {
        window.dataStore.addEvent(event);
        window.viewState.onEventReceived(event);
      }
    });
  }

  /**
   * 自分の投稿履歴を取得 (mypostsタブ用)
   */
  fetchMyPostsHistory() {
    const myPubkey = window.nostrAuth.pubkey;
    console.log('📥 自分の投稿履歴を取得中...');

    window.relayManager.subscribe('my-posts-history', {
      kinds: [1, 42],
      authors: [myPubkey],
      limit: 100
    }, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.addHistoryEventToTab(event, 'myposts');
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('✅ 自分の投稿履歴取得完了');
        window.viewState.renderNow();
      }
    });
  }

  /**
   * 受け取ったリアクション等を取得 (likesタブ用)
   */
  fetchReceivedLikes() {
    const myPubkey = window.nostrAuth.pubkey;
    console.log('📥 受け取ったリアクションを取得中...');

    window.relayManager.subscribe('received-reactions', {
      kinds: [7],
      '#p': [myPubkey],
      limit: 50
    }, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.addHistoryEventToTab(event, 'likes');
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('✅ リアクション取得完了');
      }
    });

    window.relayManager.subscribe('received-reposts', {
      kinds: [6],
      '#p': [myPubkey],
      limit: 50
    }, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.addHistoryEventToTab(event, 'likes');
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('✅ リポスト取得完了');
      }
    });

    window.relayManager.subscribe('received-mentions', {
      kinds: [1],
      '#p': [myPubkey],
      limit: 50
    }, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.addHistoryEventToTab(event, 'likes');
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('✅ メンション取得完了');
        window.viewState.renderNow();
      }
    });
  }

  // ========================================
  // タブ切り替え
  // ========================================

  /**
   * タブを切り替え
   * @param {string} tab
   */
  switchTab(tab) {
    this.currentTab = tab;
    console.log('🔀 タブ切り替え:', tab);

    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.toggle('active', btn.id === `tab-${tab}`);
    });

    window.viewState.switchTab(tab);

    if (!this.tabDataFetched[tab] && window.nostrAuth.isLoggedIn()) {
      if (tab === 'myposts') {
        this.fetchMyPostsHistory();
        this.tabDataFetched.myposts = true;
      } else if (tab === 'likes') {
        this.fetchReceivedLikes();
        this.tabDataFetched.likes = true;
      }
    }

    if (window.timeline) {
      window.timeline.switchTab(tab);
    }
  }

  // ========================================
  // フィルタ管理
  // ========================================

  /**
   * 投稿者フィルタを適用
   * @param {string[]|null} authors
   */
  applyFilter(authors) {
    this.filterAuthors = authors;
    
    if (window.timeline) {
      window.timeline.setFilter({ authors });
    }
    
    // Stream Phaseを再開
    window.relayManager.unsubscribe('stream-phase');
    this.executeStreamPhase();
  }

  /**
   * flowgazerしぼりこみトグル
   * @param {boolean} enabled
   */
  toggleFlowgazerFilter(enabled) {
    this.flowgazerOnly = enabled;
    
    if (window.timeline) {
      window.timeline.setFilter({ flowgazerOnly: enabled });
    }
  }

  /**
   * kind:42表示切り替え
   * @param {boolean} enabled
   */
  toggleKind42Display(enabled) {
    this.showKind42 = enabled;
    localStorage.setItem('showKind42', enabled.toString());
    console.log(`📺 kind:42表示: ${enabled ? 'ON' : 'OFF'}`);

    if (window.timeline) {
      window.timeline.setFilter({ showKind42: enabled });
    }

    // Stream Phaseを再開
    window.relayManager.unsubscribe('stream-phase');
    this.executeStreamPhase();
  }

  // ========================================
  // もっと見る (LoadMore - 連鎖リクエスト方式)
  // ========================================

  /**
   * もっと見るボタンの処理（連鎖リクエスト方式）
   */
  async loadMore() {
    if (this.isLoadingMore) {
      console.warn('ロード中のため、重複処理をスキップ');
      return;
    }
    this.isLoadingMore = true;

    const tab = this.currentTab;
    const oldestTimestamp = window.viewState.getOldestTimestamp(tab);
    
    console.log(`📥 もっと見る: ${tab}タブ, until=${new Date(oldestTimestamp * 1000).toLocaleString()}`);

    document.getElementById('load-more').classList.add('loading');

    try {
      // Step 1: kind:1を50件取得
      const step1Result = await this.loadMoreStep1(tab, oldestTimestamp);
      
      if (!step1Result.success) {
        alert('これ以上ありません');
        return;
      }

      const oldestKind1 = step1Result.oldestTimestamp;
      console.log(`✅ Step1完了: ${step1Result.count}件取得, oldest=${new Date(oldestKind1 * 1000).toLocaleString()}`);

      // Step 2: その期間のkind:6,42を全件取得
      await this.loadMoreStep2(tab, oldestTimestamp, oldestKind1);
      
      // カーソル更新
      window.viewState.updateTabCursor(tab, oldestKind1);
      
      console.log('✅ もっと見る完了');
      window.viewState.renderNow();
      
    } catch (err) {
      console.error('❌ もっと見る失敗:', err);
      alert('データの取得に失敗しました');
    } finally {
      document.getElementById('load-more').classList.remove('loading');
      this.isLoadingMore = false;
    }
  }

  /**
   * LoadMore Step1: kind:1を50件取得
   * @private
   */
  async loadMoreStep1(tab, untilTimestamp) {
    return new Promise((resolve) => {
      const events = [];
      
      const filter = this._buildLoadMoreStep1Filter(tab, untilTimestamp);
      if (!filter) {
        resolve({ success: false });
        return;
      }

      window.relayManager.subscribe('load-more-step1', filter, (type, event) => {
        if (type === 'EVENT') {
          const added = window.dataStore.addEvent(event);
          if (added) {
            events.push(event);
            window.viewState.addHistoryEventToTab(event, tab);
            window.profileFetcher.request(event.pubkey);
          }
        } else if (type === 'EOSE') {
          window.relayManager.unsubscribe('load-more-step1');
          
          if (events.length === 0) {
            resolve({ success: false });
          } else {
            const oldest = Math.min(...events.map(e => e.created_at));
            resolve({ success: true, count: events.length, oldestTimestamp: oldest });
          }
        }
      });
    });
  }

  /**
   * LoadMore Step2: kind:6,42を期間指定で全件取得
   * @private
   */
  async loadMoreStep2(tab, untilTimestamp, sinceTimestamp) {
    return new Promise((resolve) => {
      const filter = this._buildLoadMoreStep2Filter(tab, untilTimestamp, sinceTimestamp);
      if (!filter) {
        resolve();
        return;
      }

      window.relayManager.subscribe('load-more-step2', filter, (type, event) => {
        if (type === 'EVENT') {
          const added = window.dataStore.addEvent(event);
          if (added) {
            window.viewState.addHistoryEventToTab(event, tab);
            window.profileFetcher.request(event.pubkey);
          }
        } else if (type === 'EOSE') {
          window.relayManager.unsubscribe('load-more-step2');
          console.log('✅ Step2完了');
          resolve();
        }
      });
    });
  }

  /**
   * LoadMore Step1用フィルタ構築 (kind:1のみ)
   * @private
   */
  _buildLoadMoreStep1Filter(tab, untilTimestamp) {
    const myPubkey = window.nostrAuth?.pubkey;
    const filter = {
      kinds: [1],
      until: untilTimestamp - 1,
      limit: 50
    };

    switch (tab) {
      case 'global':
        if (this.filterAuthors && this.filterAuthors.length > 0) {
          filter.authors = this.filterAuthors;
        }
        break;
        
      case 'following':
        if (window.dataStore.followingPubkeys.size === 0) {
          console.warn('フォローリストが空です');
          return null;
        }
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
        if (!myPubkey) return null;
        filter.authors = [myPubkey];
        break;

      case 'likes':
        // likesタブではkind:7を取得
        filter.kinds = [7];
        if (!myPubkey) return null;
        filter['#p'] = [myPubkey];
        break;

      default:
        return null;
    }

    return filter;
  }

  /**
   * LoadMore Step2用フィルタ構築 (kind:6,42)
   * @private
   */
  _buildLoadMoreStep2Filter(tab, untilTimestamp, sinceTimestamp) {
    const myPubkey = window.nostrAuth?.pubkey;
    
    // likesタブではStep2不要
    if (tab === 'likes') {
      return null;
    }

    const filter = {
      kinds: this.showKind42 ? [6, 42] : [6],
      until: untilTimestamp - 1,
      since: sinceTimestamp
    };

    switch (tab) {
      case 'global':
        if (this.filterAuthors && this.filterAuthors.length > 0) {
          filter.authors = this.filterAuthors;
        }
        break;
        
      case 'following':
        if (window.dataStore.followingPubkeys.size === 0) return null;
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
        if (!myPubkey) return null;
        filter.authors = [myPubkey];
        break;

      default:
        return null;
    }

    return filter;
  }

  // ========================================
  // ユーザーアクション
  // ========================================

  /**
   * 投稿を送信
   * @param {string} content
   */
  async sendPost(content, kind = 1, channelId = null) {
    if (!window.nostrAuth.canWrite()) {
      alert('投稿するには秘密鍵でのサインインが必要です。');
      showAuthUI();
      return;
    }

    try {
      const event = {
        kind: kind,
        content: content,
        created_at: Math.floor(Date.now() / 1000),
        tags: []
      };

      // --- Kindごとの処理（kind:42） ---
      if (kind === 42) {
        if (!channelId) {
          alert('投稿先のチャンネルを選んでください！');
          return;
        }

        // eタグ（root）は先に追加
        event.tags.push(['e', channelId, '', 'root']);
      }

      // clientタグは最後に追加
      event.tags.push(['client', 'flowgazer', '31990:a19caaa8404721584746fb0e174cf971a94e0f51baaf4c4e8c6e54fa88985eaf:1755917022711', 'wss://relay.nostr.band/']);

      const signed = await window.nostrAuth.signEvent(event);
      window.relayManager.publish(signed);
      window.dataStore.addEvent(signed);

      alert('送信完了！');
      document.getElementById('new-post-content').value = '';

    } catch (err) {
      console.error('投稿失敗:', err);
      alert('投稿に失敗しました: ' + err.message);
    }
  }

  /**
   * ふぁぼを送信
   * @param {string} targetEventId
   * @param {string} targetPubkey
   */
  async sendLike(targetEventId, targetPubkey) {
    if (!window.nostrAuth.canWrite()) {
      alert('ふぁぼるには秘密鍵でのサインインが必要です。');
      showAuthUI();
      return;
    }

    try {
      const kind7Content = document.getElementById('kind-7-content-input').value.trim() || '+';
      
      const event = {
        kind: 7,
        content: kind7Content,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', targetEventId],
          ['p', targetPubkey]
        ]
      };

      const signed = await window.nostrAuth.signEvent(event);
      window.relayManager.publish(signed);
      window.dataStore.addEvent(signed);
      window.viewState.onEventReceived(signed);
      window.viewState.renderNow();
      
      alert('ふぁぼった!');
      
    } catch (err) {
      console.error('失敗:', err);
      alert('ふぁぼれませんでした: ' + err.message);
    }
  }

  // ========================================
  // 禁止ワード管理
  // ========================================

  /**
   * 禁止ワードリストを取得
   */
  async fetchForbiddenWords() {
    try {
      const response = await fetch('https://ompomz.github.io/flowgazer/nglist.xml');
      const xmlText = await response.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      const terms = xmlDoc.querySelectorAll('term');
      
      this.forbiddenWords = Array.from(terms).map(node => node.textContent);
      console.log('📋 禁止ワードリスト読み込み完了:', this.forbiddenWords.length, '件');
      
    } catch (err) {
      console.error('禁止ワードリスト読み込み失敗:', err);
      this.forbiddenWords = [];
    }
  }

  // ========================================
  // UI更新
  // ========================================

  /**
   * ログインUI更新
   */
  updateLoginUI() {
    const notLoggedInSpan = document.getElementById('not-logged-in');
    const npubLink = document.getElementById('npub-link');

    if (window.nostrAuth.isLoggedIn()) {
      const npub = window.NostrTools.nip19.npubEncode(window.nostrAuth.pubkey);
      npubLink.textContent = npub.substring(0, 12) + '...' + npub.slice(-4);
      npubLink.href = 'https://nostter.app/' + npub;
      npubLink.style.display = 'inline';
      notLoggedInSpan.style.display = 'none';
    } else {
      npubLink.style.display = 'none';
      notLoggedInSpan.style.display = 'inline';
    }
  }
}

/**
 * 自分のチャンネルリストを取得し、各チャンネルの名前を解決する
 */
async function fetchMyChannels() {
  const myPubkey = window.nostrAuth?.pubkey;
  if (!myPubkey) return;

  console.log('📡 チャンネルリスト取得開始...');
  
  const subId = 'my-channels-' + Date.now();
  
  // Step 1: kind:10005 を取得してチャンネルID一覧を得る
  window.relayManager.subscribe(subId, {
    kinds: [10005],
    authors: [myPubkey],
    limit: 1
  }, async (type, event) => {
    if (type === 'EVENT' && event.kind === 10005) {
      console.log('✅ kind:10005 受信:', event.tags);
      
      // eタグからチャンネルID一覧を抽出
      const channelIds = event.tags
        .filter(t => t[0] === 'e' && t[1])
        .map(t => t[1]);
      
      if (channelIds.length === 0) {
        console.warn('⚠️ チャンネルが見つかりませんでした');
        updateChannelDropdown([]);
        window.relayManager.unsubscribe(subId);
        return;
      }
      
      console.log(`📋 ${channelIds.length}個のチャンネルIDを取得`);
      
      // Step 2: 各チャンネルの名前を解決
      await resolveChannelNames(channelIds);
      
      window.relayManager.unsubscribe(subId);
    }
    
    if (type === 'EOSE') {
      window.relayManager.unsubscribe(subId);
    }
  });
}

/**
 * チャンネルID配列から名前を解決してプルダウンを更新
 * 優先順位: kind:41 → kind:40 → デフォルト名
 * @param {string[]} channelIds
 */
async function resolveChannelNames(channelIds) {
  return new Promise((resolve) => {
    const channels = [];
    const resolved = new Set(); // 名前が確定した channelId
    const subId41 = 'channel-meta-41-' + Date.now();

    console.log('🔍 チャンネル名解決開始（kind:41 優先）');

    // --- Step 1: kind:41（metadata update）を取得 ---
    window.relayManager.subscribe(
      subId41,
      {
        kinds: [41],
        '#e': channelIds
      },
      (type, event) => {
        if (type === 'EVENT') {
          const channelId = event.tags.find(t => t[0] === 'e')?.[1];
          if (!channelId || !channelIds.includes(channelId)) return;

          try {
            const metadata = JSON.parse(event.content);
            const name = metadata.name || `Channel ${channelId.substring(0, 8)}`;
            window.channelNameMap.set(channelId, name);

            const existing = channels.find(c => c.id === channelId);
            if (!existing || event.created_at > existing.created_at) {
              if (existing) {
                existing.name = name;
                existing.created_at = event.created_at;
                existing.source = '41';
              } else {
                channels.push({
                  id: channelId,
                  name,
                  created_at: event.created_at,
                  source: '41'
                });
              }
              resolved.add(channelId);
              console.log(`✅ kind:41 から解決: ${name}`);
            }
          } catch (err) {
            console.error('❌ kind:41 パース失敗:', err);
          }
        }

        if (type === 'EOSE') {
          window.relayManager.unsubscribe(subId41);
          fetchKind40Fallback();
        }
      }
    );

    // --- Step 2: kind:40（channel create）で補完 ---
    function fetchKind40Fallback() {
      const unresolvedIds = channelIds.filter(id => !resolved.has(id));

      if (unresolvedIds.length === 0) {
        finish();
        return;
      }

      console.log(`🔁 kind:40 で補完 (${unresolvedIds.length} 件)`);

      const subId40 = 'channel-meta-40-' + Date.now();

      window.relayManager.subscribe(
        subId40,
        {
          kinds: [40],
          ids: unresolvedIds
        },
        (type, event) => {
          if (type === 'EVENT' && unresolvedIds.includes(event.id)) {
            try {
              const metadata = JSON.parse(event.content);
              const name = metadata.name || `Channel ${event.id.substring(0, 8)}`;
              window.channelNameMap.set(event.id, name);

              channels.push({
                id: event.id,
                name,
                created_at: event.created_at,
                source: '40'
              });

              resolved.add(event.id);
              console.log(`✅ kind:40 から解決: ${name}`);
            } catch (err) {
              console.error('❌ kind:40 パース失敗:', err);
            }
          }

          if (type === 'EOSE') {
            window.relayManager.unsubscribe(subId40);
            finish();
          }
        }
      );
    }

    // --- Step 3: それでも未解決ならデフォルト名 ---
    function finish() {
      channelIds.forEach(id => {
        if (!resolved.has(id)) {
          channels.push({
            id,
            name: `Channel ${id.substring(0, 8)}...`,
            created_at: 0,
            source: 'default'
          });
          console.log(`⚠️ デフォルト名使用: ${id.substring(0, 8)}`);
        }
      });

      updateChannelDropdown(channels);
      resolve();
    }

    // 保険のタイムアウト（10秒）
    setTimeout(() => {
      console.log('⏱️ チャンネル名解決タイムアウト');
      finish();
    }, 10000);
  });
}

/**
 * 取得したチャンネル情報をプルダウンに反映する
 * @param {Array} channels - [{id: string, name: string}, ...]
 */
function updateChannelDropdown(channels) {
  const channelSelect = document.getElementById('channel-list-selector');
  if (!channelSelect) return;

  // 現在選択中の値を保持
  const currentValue = channelSelect.value;

  // 初期化
  channelSelect.innerHTML = '<option value="">-- チャンネルを選択 --</option>';

  if (channels.length === 0) {
    const option = document.createElement('option');
    option.value = "";
    option.textContent = "チャンネルが見つかりませんでした";
    option.disabled = true;
    channelSelect.appendChild(option);
    console.log('⚠️ 表示可能なチャンネルがありません');
    return;
  }

  // チャンネル名でソート
  channels.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  // 選択肢に追加
  channels.forEach(channel => {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = channel.name;
    // 前回選択していた値と一致するなら selected にする
    if (channel.id === currentValue) {
      option.selected = true;
    }
    channelSelect.appendChild(option);
  });

  console.log(`✅ プルダウンに ${channels.length} 件のチャンネルをセットしました`);
}

// ========================================
// グローバル初期化
// ========================================

window.channelNameMap = new Map();

window.app = new FlowgazerApp();
console.log('✅ FlowgazerApp初期化完了');

window.sendLikeEvent = (eventId, pubkey) => window.app.sendLike(eventId, pubkey);

window.addEventListener('beforeunload', () => {
  if (window.timeline) {
    window.timeline.destroy();
  }
  if (window.relayManager) {
    window.relayManager.disconnect();
  }
  console.log('🗑️ アプリケーションクリーンアップ完了');
});