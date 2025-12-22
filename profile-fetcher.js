/**
 * profile-fetcher.js
 * 単一リレー向け：kind:0 プロファイルをバッチで効率よく取得
 */

class ProfileFetcher {
  constructor() {
    this.queue = new Set();          // 取得待ち pubkey
    this.inProgress = new Set();     // 取得中 pubkey
    this.timer = null;
    this.batchDelay = 500;           // バッチ遅延
    this.maxBatchSize = 100;         // 一度に問い合わせる最大数
  }

  /**
   * プロファイル取得をリクエスト
   */
  request(pubkey) {
    if (window.dataStore.profiles.has(pubkey)) return;
    if (this.inProgress.has(pubkey)) return;

    this.queue.add(pubkey);
    this.scheduleFlush();
  }

  /**
   * 複数 pubkey のリクエスト
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
   * 実際にバッチ取得を行う
   */
  async flush() {
    if (this.queue.size === 0) return;

    // バッチ分だけ取り出す
    const pubkeys = Array.from(this.queue).slice(0, this.maxBatchSize);
    pubkeys.forEach(pk => this.queue.delete(pk));

    // 取得中マーク
    pubkeys.forEach(pk => this.inProgress.add(pk));

    console.log(`👤 プロファイルをバッチ取得: ${pubkeys.length}件`);

    // リレー未接続なら接続
    if (!window.relayManager.isConnected()) {
      try {
        await window.relayManager.connect(window.appConfig.mainRelay);
      } catch (err) {
        console.error("❌ リレー接続失敗:", err);
        pubkeys.forEach(pk => this.inProgress.delete(pk));
        return;
      }
    }

    const subId = "profiles-" + Date.now();

    const handler = (type, event) => {
      // EVENT（kind:0）
      if (type === "EVENT" && event?.kind === 0) {
        try {
          const profile = JSON.parse(event.content);
          window.dataStore.addProfile(event.pubkey, {
            ...profile,
            created_at: event.created_at
          });

          this.inProgress.delete(event.pubkey);

        } catch (err) {
          console.error("❌ プロファイルパースエラー:", err);
        }
      }

      // EOSE（購読終了）
      if (type === "EOSE") {
        window.relayManager.unsubscribe(subId);

        // EVENT が来なかった pubkey も完了扱い
        pubkeys.forEach(pk => this.inProgress.delete(pk));

        console.log(`✅ プロファイル取得完了: ${window.dataStore.profiles.size}件`);

        if (window.timeline) {
          window.timeline.refresh();
        }
      }
    };

    // 購読開始
    window.relayManager.subscribe(subId, {
      kinds: [0],
      authors: pubkeys
    }, handler);
  }

  /**
   * 即時フラッシュ
   */
  flushNow() {
    clearTimeout(this.timer);
    this.flush();
  }
}

window.profileFetcher = new ProfileFetcher();