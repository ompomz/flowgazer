/**
 * view-state.js
 * タイムライン表示のための状態管理層
 * データ取得と描画の間に挟まり、表示タイミングを制御
 */

class ViewState {
  constructor() {
    // タブごとの表示対象イベントID
    this.visibleEventIds = {
      global: new Set(),
      following: new Set(),
      myposts: new Set(),
      likes: new Set()
    };

    // 描画待機キュー（プロファイル未取得のイベント）
    this.pendingEventIds = new Set();
    
    // 描画タイマー
    this.renderTimer = null;
    this.renderDelay = 300; // 300ms後に描画
  }

  /**
   * イベントを追加（タブに応じて振り分け）
   */
  addEvent(event, currentTab) {
    const myPubkey = window.nostrAuth?.pubkey;

    // どのタブに表示すべきか判定
    const targetTabs = this.determineTargetTabs(event, myPubkey);

    // 各タブに追加
    targetTabs.forEach(tab => {
      this.visibleEventIds[tab].add(event.id);
    });

    // プロファイルが未取得なら待機キューに追加
    if (!window.dataStore.profiles.has(event.pubkey)) {
      this.pendingEventIds.add(event.id);
      window.profileFetcher.request(event.pubkey);
    }

    // 現在のタブなら描画をスケジュール
    if (targetTabs.includes(currentTab)) {
      this.scheduleRender();
    }
  }

  /**
   * イベントがどのタブに表示されるべきか判定
   */
  determineTargetTabs(event, myPubkey) {
    const tabs = [];

    // kind:1, 6 → global
    if (event.kind === 1 || event.kind === 6) {
      tabs.push('global');
    }

    // フォロー中 → following
    if ((event.kind === 1 || event.kind === 6) && 
        window.dataStore.followingPubkeys.has(event.pubkey)) {
      tabs.push('following');
    }

    // 自分の投稿 → myposts
    if (event.kind === 1 && event.pubkey === myPubkey) {
      tabs.push('myposts');
    }

    // 自分が受け取ったkind:7 → likes
    if (event.kind === 7) {
      const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
      if (targetPubkey === myPubkey) {
        tabs.push('likes');
      }
    }

    return tabs;
  }

  /**
   * プロファイル取得完了時の処理
   */
  onProfileFetched(pubkey) {
    // 待機中のイベントから該当するものを削除
    const eventsToRemove = [];
    this.pendingEventIds.forEach(eventId => {
      const event = window.dataStore.events.get(eventId);
      if (event?.pubkey === pubkey) {
        eventsToRemove.push(eventId);
      }
    });

    eventsToRemove.forEach(id => this.pendingEventIds.delete(id));

    // 描画をスケジュール
    if (eventsToRemove.length > 0) {
      this.scheduleRender();
    }
  }

  /**
   * 描画をスケジュール
   */
  scheduleRender() {
    // 自動更新がOFFなら何もしない
    if (!window.app?.isAutoUpdate) {
      console.log('⏸️ 自動更新OFF: 描画スキップ');
      return;
    }

    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      if (window.timeline) {
        window.timeline.refresh();
      }
    }, this.renderDelay);
  }

  /**
   * 即座に描画
   */
  renderNow() {
    clearTimeout(this.renderTimer);
    if (window.timeline) {
      window.timeline.refresh();
    }
  }

  /**
   * タブ切り替え時の処理
   * 注: イベントIDは残したまま、描画だけ切り替える
   */
  switchTab(newTab) {
    console.log(`📑 ViewState: タブ切り替え → ${newTab}`);
    // 即座に描画
    this.renderNow();
  }

  /**
   * 表示対象のイベントを取得
   */
  getVisibleEvents(tab, filterOptions = {}) {
    const eventIds = Array.from(this.visibleEventIds[tab]);
    
    let events = eventIds
      .map(id => window.dataStore.events.get(id))
      .filter(Boolean);

    // 禁止ワードフィルター
    if ((tab === 'global' || tab === 'following') && window.app?.forbiddenWords?.length > 0) {
      events = events.filter(ev => {
        if (ev.kind !== 1) return true; // kind:1以外はスルー
        const content = ev.content.toLowerCase(); // 大文字小文字を無視
        return !window.app.forbiddenWords.some(word => 
          content.includes(word.toLowerCase())
        );
      });
    }

    // globalとfollowingタブでkind:1の字数制限
    if (tab === 'global' || tab === 'following') {
      events = events.filter(ev => {
        if (ev.kind !== 1) return true; // kind:1以外はスルー
        return ev.content.length <= 190; // 例：190字まで
      });
    }

      // flowgazerしぼりこみ
    if (filterOptions.flowgazerOnly && tab !== 'likes') {
      events = events.filter(ev => 
        ev.kind === 1 && 
        ev.tags.some(tag => tag[0] === 'client' && tag[1] === 'flowgazer')
      );
    }

    // 投稿者フィルター
    if (filterOptions.authors?.length > 0) {
      const authorSet = new Set(filterOptions.authors);
      events = events.filter(ev => authorSet.has(ev.pubkey));
    }

    // プロファイル未取得のものは除外
    events = events.filter(ev => window.dataStore.profiles.has(ev.pubkey));

    // ソート
    return events.sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * 統計情報
   */
  getStats() {
    return {
      global: this.visibleEventIds.global.size,
      following: this.visibleEventIds.following.size,
      myposts: this.visibleEventIds.myposts.size,
      likes: this.visibleEventIds.likes.size,
      pending: this.pendingEventIds.size
    };
  }

  /**
   * デバッグ情報
   */
  debug() {
    console.log('📊 ViewState統計:', this.getStats());
    console.log('⏳ 待機中のイベント:', Array.from(this.pendingEventIds));
  }
}

// グローバルインスタンス
window.viewState = new ViewState();
console.log('✅ ViewState初期化完了');