/**
 * app.js
 * 【責務】: アプリケーション制御、リレー接続、ユーザーアクション処理
 */

class FlowgazerApp {
  constructor() {
    // ===== アプリケーション状態 =====
    this.currentTab = 'global';
    this.isAutoUpdate = true;
    this.filterAuthors = null;
    this.flowgazerOnly = false;
    this.forbiddenWords = [];
    this.showKind42 = false; // デフォルトは非表示
    
    // ===== データ取得済みフラグ =====
    this.tabDataFetched = {
      global: false,
      following: false,
      myposts: false,
      likes: false
    };
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
    const defaultRelay = 'wss://r.kojira.io/';
    const relay = savedRelay || defaultRelay;
    await this.connectRelay(relay);

    // 禁止ワード取得
    await this.fetchForbiddenWords();

    // ログイン済みなら初期データ取得
    if (window.nostrAuth.isLoggedIn()) {
      this.fetchInitialData();
    }

    console.log('✅ flowgazer起動完了');
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
      
      // メインタイムライン購読
      this.subscribeMainTimeline();
      
      // URL保存
      localStorage.setItem('relayUrl', url);
    } catch (err) {
      console.error('❌ リレー接続失敗:', err);
      alert('リレーに接続できませんでした: ' + url);
    }
  }

  /**
   * メインタイムライン購読
   */
  subscribeMainTimeline() {
    const filters = this._buildMainTimelineFilters();

    if (filters.length > 0) {
      window.relayManager.unsubscribe('main-timeline');
      window.relayManager.subscribe('main-timeline', filters, (type, event) => {
        this.handleTimelineEvent(type, event);
      });
    }
  }

  /**
   * メインタイムライン用フィルタ構築
   * @private
   */
  _buildMainTimelineFilters() {
    const filters = [];
    const myPubkey = window.nostrAuth.isLoggedIn() ? window.nostrAuth.pubkey : null;

    // === Global フィルタ ===
    const globalFilter = {
      kinds: this.showKind42 ? [1, 6, 42] : [1, 6], // ← 変更
      limit: 150
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
            // 自分が自分をフォローしているなら除外しない
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
            limit: 150
        });
    }
}

    // === Likes フィルタ (自分宛のリアクション等) ===
    if (myPubkey) {
      // kind:7 (リアクション)
      filters.push({
        kinds: [7],
        '#p': [myPubkey],
        limit: 50
      });

      // kind:6 (リポスト)
      filters.push({
        kinds: [6],
        '#p': [myPubkey],
        limit: 50
      });

      // kind:1 (メンション)
      filters.push({
        kinds: [1],
        '#p': [myPubkey],
        limit: 50
      });

      // 自分の投稿へのリアクション
      const myPostIds = Array.from(window.dataStore.getEventIdsByAuthor(myPubkey));
      if (myPostIds.length > 0) {
        filters.push({
          kinds: [6, 7],
          '#e': myPostIds.slice(0, 100) // 最新100件のみ
        });
      }
    }

    return filters;
  }

  /**
   * タイムラインイベントハンドラー
   * @param {string} type - 'EVENT' or 'EOSE'
   * @param {Object} event
   */
  handleTimelineEvent(type, event) {
    if (type === 'EVENT') {
      // kind:0 (プロフィール) の処理
      if (event.kind === 0) {
        try {
          const profile = JSON.parse(event.content);
          const updated = window.dataStore.addProfile(event.pubkey, {
            ...profile,
            created_at: event.created_at
          });
          
          if (updated && window.timeline) {
            window.timeline.refresh();
          }
        } catch (err) {
          console.error('プロフィールパースエラー:', err);
        }
        return;
      }

      // イベントをDataStoreに保存
      const added = window.dataStore.addEvent(event);
      
      if (added) {
        // ViewStateに通知 (ライブストリーム)
        window.viewState.onEventReceived(event);
        
        // プロフィール取得リクエスト
        window.profileFetcher.request(event.pubkey);
      }
      
    } else if (type === 'EOSE') {
      console.log('📡 EOSE受信');
      
      // プロフィールを一括取得
      window.profileFetcher.flushNow();
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

    // kind:7 (リアクション)
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

    // kind:6 (リポスト)
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

    // kind:1 (メンション)
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

    // タブボタンのアクティブ状態更新
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.toggle('active', btn.id === `tab-${tab}`);
    });

    // ViewStateに通知
    window.viewState.switchTab(tab);

    // 初回データ取得
    if (!this.tabDataFetched[tab] && window.nostrAuth.isLoggedIn()) {
      if (tab === 'myposts') {
        this.fetchMyPostsHistory();
        this.tabDataFetched.myposts = true;
      } else if (tab === 'likes') {
        this.fetchReceivedLikes();
        this.tabDataFetched.likes = true;
      }
    }

    // Timelineに通知
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
    
    // Timelineに通知
    if (window.timeline) {
      window.timeline.setFilter({ authors });
    }
    
    // 購読を再開
    window.relayManager.unsubscribe('main-timeline');
    this.subscribeMainTimeline();
  }

  /**
   * flowgazerしぼりこみトグル
   * @param {boolean} enabled
   */
  toggleFlowgazerFilter(enabled) {
    this.flowgazerOnly = enabled;
    
    // Timelineに通知
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
  
    // localStorageに保存
    localStorage.setItem('showKind42', enabled.toString());
  
    console.log(`📺 kind:42表示: ${enabled ? 'ON' : 'OFF'}`);
  
    // Timelineに通知
    if (window.timeline) {
      window.timeline.setFilter({ showKind42: enabled });
    }
  
    // 購読を再開（kind:42の取得を制御）
    window.relayManager.unsubscribe('main-timeline');
    this.subscribeMainTimeline();
  }

  // ========================================
  // もっと見る (LoadMore)
  // ========================================

  /**
   * もっと見るボタンの処理
   */
  loadMore() {
    if (this.isLoadingMore) {
      console.warn('ロード中のため、重複処理をスキップ');
      return;
    }
    this.isLoadingMore = true;

    const tab = this.currentTab;
    const oldestTimestamp = window.viewState.getOldestTimestamp(tab);
    
    console.log(`📥 もっと見る: ${tab}タブ, until=${new Date(oldestTimestamp * 1000).toLocaleString()}`);

    // ViewStateからフィルタを構築
    const filter = window.viewState.buildLoadMoreFilter(tab, oldestTimestamp);
    
    if (!filter) {
      console.warn('フィルタ構築に失敗しました');
      this.isLoadingMore = false;
      return;
    }

    // ローディング表示
    document.getElementById('load-more').classList.add('loading');

    // 購読
    window.relayManager.subscribe('load-more', filter, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.addHistoryEventToTab(event, tab);
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        window.relayManager.unsubscribe('load-more');
        document.getElementById('load-more').classList.remove('loading');
        console.log(`✅ もっと見る完了 (${tab})`);
        window.viewState.renderNow();
        this.isLoadingMore = false;
      }
    });
  }

  // ========================================
  // ユーザーアクション
  // ========================================

  /**
   * 投稿を送信
   * @param {string} content
   */
  async sendPost(content) {
    if (!window.nostrAuth.canWrite()) {
      alert('投稿するには秘密鍵でのサインインが必要です。');
      showAuthUI();
      return;
    }

    try {
      const event = {
        kind: 1,
        content: content,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['client', 'flowgazer', '31990:a19caaa8404721584746fb0e174cf971a94e0f51baaf4c4e8c6e54fa88985eaf:1755917022711', 'wss://relay.nostr.band/']
        ]
      };

      // 署名
      const signed = await window.nostrAuth.signEvent(event);
      
      // 送信
      window.relayManager.publish(signed);
      
      // DataStoreに追加
      window.dataStore.addEvent(signed);
      
      // ViewStateに通知
      window.viewState.addHistoryEventToTab(signed, 'myposts');
      window.viewState.addHistoryEventToTab(signed, 'global');

      // 自分が自分をフォローしているなら following にも追加
      const myPubkey = window.nostrAuth?.pubkey;
      if (window.dataStore.isFollowing(myPubkey)) {
        window.viewState.addHistoryEventToTab(signed, 'following');
        }
    
      // 即座に再描画
      window.viewState.renderNow();
      
      alert('投稿しました！');
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

      // 署名
      const signed = await window.nostrAuth.signEvent(event);
      
      // 送信
      window.relayManager.publish(signed);
      
      // DataStoreに追加
      window.dataStore.addEvent(signed);
      
      // ViewStateに通知
      window.viewState.onEventReceived(signed);
      
      // 再描画
      window.viewState.renderNow();
      
      alert('ふぁぼった！');
      
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

  /**
  * 指定したユーザーの投稿履歴を取得
  */
async fetchUserPosts(pubkey) {
    const relayUrl = this.url || 'wss://relay.nostr.band/';
    
    try {
        // 1. まずリレーに接続する（これが必要！）
        await window.relayManager.connect(relayUrl);
        
        // 2. 接続できたら取得する
        const posts = await window.relayManager.getEvents(relayUrl, {
            kinds: [1],
            authors: [pubkey],
            limit: 20
        });

        // 取得したイベントをストアに入れておく
        if (posts && posts.length > 0) {
            posts.forEach(ev => window.dataStore.addEvent(ev));
        }
        return posts;
    } catch (error) {
        console.error("fetchUserPosts error:", error);
        return [];
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

// ========================================
// グローバル初期化
// ========================================

window.app = new FlowgazerApp();
console.log('✅ FlowgazerApp初期化完了');

// グローバル関数 (長押しふぁぼ用)
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
