/**
 * profile-fetcher.js
 * プロファイル（kind:0）を効率的にバッチ取得
 * * 変更点: 
 * - 新規データ取得時のみ profiles_updated イベントを発火するように最適化
 * - 既存の window.timeline.refresh への互換性を維持
 */

class ProfileFetcher {
  constructor() {
    this.queue = new Set();          // 取得待ちpubkey
    this.inProgress = new Set();     // 取得中pubkey
    this.timer = null;
    this.batchDelay = 500;           // バッチ処理の遅延（ms）
    this.maxBatchSize = 100;         // 一度に取得する最大数
  }

  /**
   * プロファイル取得をリクエスト
   */
  request(pubkey) {
    // 既にデータがある場合はスキップ
    if (window.dataStore && window.dataStore.profiles && window.dataStore.profiles.has(pubkey)) {
      return;
    }

    // 取得中ならスキップ
    if (this.inProgress.has(pubkey)) {
      return;
    }

    // キューに追加
    this.queue.add(pubkey);
    this.scheduleFlush();
  }

  /**
   * 複数のpubkeyをまとめてリクエスト
   */
  requestMultiple(pubkeys) {
    pubkeys.forEach(pk => this.request(pk));
  }

  /**
   * フラッシュをスケジュール
   */
  scheduleFlush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.batchDelay);
  }

  /**
   * キューをフラッシュして実際に取得
   */
  async flush() {
    if (this.queue.size === 0) return;

    // キューから取得対象を取り出し
    const pubkeys = Array.from(this.queue).slice(0, this.maxBatchSize);
    pubkeys.forEach(pk => this.queue.delete(pk));

    // 取得中マークを付ける
    pubkeys.forEach(pk => this.inProgress.add(pk));

    console.log(`👤 プロファイルをバッチ取得開始: ${pubkeys.length}件`);

    // 購読ID
    const subId = 'profiles-' + Date.now();

    // ハンドラー
    const handler = (type, event) => {
      if (type === 'EVENT' && event.kind === 0) {
        try {
          const profile = JSON.parse(event.content);
          if (window.dataStore && typeof window.dataStore.addProfile === 'function') {
            window.dataStore.addProfile(event.pubkey, {
              ...profile,
              created_at: event.created_at
            });
          }

          // 取得完了マーク（inProgressから削除）
          this.inProgress.delete(event.pubkey);

        } catch (err) {
          console.error('❌ プロファイルパースエラー:', err);
        }

      } else if (type === 'EOSE') {
        // 購読解除
        window.relayManager.unsubscribe(subId);
        
        // EOSEが来た時点で、まだinProgressに残っている（＝データが返ってこなかった）pubkeyをクリア
        pubkeys.forEach(pk => this.inProgress.delete(pk));

        // 今回リクエストしたpubkeysのうち、実際にdataStoreに格納されたものがあるか判定
        const hasNewData = pubkeys.some(pk => 
          window.dataStore && window.dataStore.profiles && window.dataStore.profiles.has(pk)
        );

        if (hasNewData) {
          console.log(`✅ 新規プロファイルを取得したため、更新通知を送ります`);
          // 汎用的なカスタムイベントを発火
          document.dispatchEvent(new CustomEvent('profiles_updated'));
          
          // 既存ツール用の直接的なリフレッシュ呼び出し（互換性維持）
          if (window.timeline && typeof window.timeline.refresh === 'function') {
            window.timeline.refresh();
          }
        } else {
          console.log(`ℹ️ 今回のバッチでは新規プロファイルは見つかりませんでした`);
        }
      }
    };

    // 購読開始
    if (window.relayManager && typeof window.relayManager.subscribe === 'function') {
      window.relayManager.subscribe(subId, {
        kinds: [0],
        authors: pubkeys
      }, handler);
    }
  }

  /**
   * 即座にフラッシュ
   */
  flushNow() {
    clearTimeout(this.timer);
    this.flush();
  }
}

// グローバルインスタンスの生成
window.profileFetcher = new ProfileFetcher();
