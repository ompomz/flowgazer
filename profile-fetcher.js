/**
 * profile-fetcher.js
 * プロファイル（kind:0）を効率的にバッチ取得
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
    // 既にデータがある
    if (window.dataStore.profiles.has(pubkey)) {
      return;
    }

    // 取得中
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
    this.queue.clear();

    // 取得中マークを付ける
    pubkeys.forEach(pk => this.inProgress.add(pk));

    console.log(`👤 プロファイルをバッチ取得: ${pubkeys.length}件`);

    // 購読ID
    const subId = 'profiles-' + Date.now();

    // ハンドラー
    const handler = (type, event) => {
      if (type === 'EVENT' && event.kind === 0) {
        try {
          const profile = JSON.parse(event.content);
          window.dataStore.addProfile(event.pubkey, {
            ...profile,
            created_at: event.created_at
          });

          // 取得完了マーク
          this.inProgress.delete(event.pubkey);

        } catch (err) {
          console.error('❌ プロファイルパースエラー:', err);
        }

} else if (type === 'EOSE') {
    window.relayManager.unsubscribe(subId);
    pubkeys.forEach(pk => this.inProgress.delete(pk));

    console.log(`✅ プロファイル取得完了: ${window.dataStore.profiles.size}件`);

    // A. 既存ツール用の処理（あれば実行、なければ無視）
    if (window.timeline && typeof window.timeline.refresh === 'function') {
        window.timeline.refresh();
    }

    // B. 今回のツール用の処理（イベントを飛ばす方式にすると安全！）
    // 「プロフィールが更新されたよ！」という合図をブラウザ全体に出す
    document.dispatchEvent(new CustomEvent('profiles_updated'));
}
    };

    // 購読
    window.relayManager.subscribe(subId, {
      kinds: [0],
      authors: pubkeys
    }, handler);
  }

  /**
   * 即座にフラッシュ
   */
  flushNow() {
    clearTimeout(this.timer);
    this.flush();
  }
}

// グローバルインスタンス
window.profileFetcher = new ProfileFetcher();
