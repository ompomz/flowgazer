/**
 * relay-manager.js
 * リレー接続を一元管理するモジュール
 */

class RelayManager {
  constructor() {
    this.ws = null;
    this.url = null;
    this.subscriptions = new Map(); // subId -> handler
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.isConnecting = false;
  }

  /**
   * リレーに接続
   */
  async connect(url) {
    if (this.ws?.readyState === WebSocket.OPEN && this.url === url) {
      console.log('✅ すでに接続済み:', url);
      return Promise.resolve();
    }

    // 既存接続をクリーンアップ
    if (this.ws) {
      this.disconnect();
    }

    this.url = url;
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          console.log('✅ リレー接続成功:', url);
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          
          // 既存の購読を再開
          this.resubscribeAll();
          resolve();
        };

        this.ws.onmessage = (ev) => {
          this.handleMessage(ev.data);
        };

        this.ws.onerror = (err) => {
          console.error('❌ リレー接続エラー:', url, err);
          this.isConnecting = false;
          reject(err);
        };

        this.ws.onclose = () => {
          console.warn('⚠️ リレー接続切断:', url);
          this.isConnecting = false;
          this.attemptReconnect();
        };

        // 接続タイムアウト（5秒）
        setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.ws?.close();
            reject(new Error('接続タイムアウト'));
          }
        }, 5000);

      } catch (err) {
        console.error('❌ WebSocket作成エラー:', err);
        this.isConnecting = false;
        reject(err);
      }
    });
  }

  /**
   * メッセージハンドラー
   */
  handleMessage(data) {
    try {
      const [type, subId, event] = JSON.parse(data);
      const handler = this.subscriptions.get(subId);

      if (handler) {
        handler(type, event, subId);
      }

    } catch (err) {
      console.error('❌ メッセージ処理エラー:', err);
    }
  }

  /**
   * イベントを購読
   */
  subscribe(subId, filters, handler) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ リレー未接続のため購読できません');
      return false;
    }

    // フィルターの正規化（配列化）
    const filterArray = Array.isArray(filters) ? filters : [filters];

    // ハンドラーを登録
    this.subscriptions.set(subId, handler);

    // REQメッセージを送信
    const reqMsg = ['REQ', subId, ...filterArray];
    this.ws.send(JSON.stringify(reqMsg));

    console.log('📡 購読開始:', subId, filterArray);
    return true;
  }

  /**
   * 購読を解除
   */
  unsubscribe(subId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.subscriptions.delete(subId);
      return;
    }

    this.ws.send(JSON.stringify(['CLOSE', subId]));
    this.subscriptions.delete(subId);
    console.log('📡 購読解除:', subId);
  }

  /**
   * すべての購読を解除
   */
  unsubscribeAll() {
    const subIds = Array.from(this.subscriptions.keys());
    subIds.forEach(subId => this.unsubscribe(subId));
  }

  /**
   * すべての購読を再開（再接続時用）
   */
  resubscribeAll() {
    console.log('🔄 購読を再開します...');
    // 一旦保存
    const subs = new Map(this.subscriptions);
    this.subscriptions.clear();

    // 再購読（実際のフィルターは保持していないので、
    // 呼び出し側で再度subscribeを呼ぶ必要がある）
    // ここでは登録だけ戻す
    subs.forEach((handler, subId) => {
      this.subscriptions.set(subId, handler);
    });
  }

  /**
   * 再接続を試みる
   */
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ 再接続の上限に達しました');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);

    console.log(`🔄 ${delay}ms後に再接続を試みます... (試行 ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (this.url) {
        this.connect(this.url).catch(err => {
          console.error('再接続失敗:', err);
        });
      }
    }, delay);
  }

  /**
   * 切断
   */
  disconnect() {
    if (this.ws) {
      this.unsubscribeAll();
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.url = null;
    console.log('🔌 リレーから切断しました');
  }

  /**
   * 接続状態を取得
   */
  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * イベントを送信（投稿・ふぁぼなど）
   */
  publish(event) {
    if (!this.isConnected()) {
      throw new Error('リレーに接続されていません');
    }

    this.ws.send(JSON.stringify(['EVENT', event]));
    console.log('📤 イベント送信:', event.kind);
  }
  
  /**
   * 指定したリレーから単一のイベントを取得する (Promise版)
   */
  async getEvent(url, filters) {
    // 1. 指定されたリレーに接続
    await this.connect(url);

    return new Promise((resolve) => {
      const subId = 'single-fetch-' + Math.random().toString(36).substring(7);
      let foundEvent = null;

      // タイムアウト設定 (3秒待っても来なければ諦める)
      const timer = setTimeout(() => {
        this.unsubscribe(subId);
        resolve(null);
      }, 3000);

      const handler = (type, event) => {
        if (type === 'EVENT') {
          foundEvent = event;
          clearTimeout(timer);
          this.unsubscribe(subId);
          resolve(event);
        } else if (type === 'EOSE') {
          clearTimeout(timer);
          this.unsubscribe(subId);
          resolve(foundEvent); // EVENTが来ていればそれを、無ければnullを返す
        }
      };

      this.subscribe(subId, filters, handler);
    });
  }
// 複数のイベントをまとめて取得する機能を追加
async getEvents(relayUrl, filter, timeout = 5000) {
    return new Promise((resolve) => {
        const events = [];
        // ランダムな購読IDを作成
        const subId = 'list-' + Math.random().toString(36).substring(7);
        
        // タイムアウトを設定（リレーが反応しない時のため）
        const timer = setTimeout(() => {
            this.unsubscribe(subId);
            resolve(events); 
        }, timeout);

        this.subscribe(subId, filter, (type, event) => {
            if (type === 'EVENT') {
                events.push(event);
            } else if (type === 'EOSE') {
                // リレーが「出し切ったよ」と言ったら終了
                clearTimeout(timer);
                this.unsubscribe(subId);
                resolve(events);
            }
        }, relayUrl);
    });
}
}

// グローバルインスタンス
window.relayManager = new RelayManager();
console.log('✅ RelayManager初期化完了');
