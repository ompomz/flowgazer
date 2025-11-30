// auth.js - 新規作成
class NostrAuth {
  constructor() {
    this.pubkey = null;
    this.nsec = null;
    this.useNIP07 = false;
  }

// npubまたはNIP-05で認証（閲覧専用）
async loginWithNpub(input) {
  try {
    // NIP-05形式かチェック（xxx@domain.com）
    if (input.includes('@')) {
      console.log('NIP-05アドレスを解決中...');
      const [name, domain] = input.split('@');
      
      const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`);
      const data = await response.json();
      
      if (!data.names || !data.names[name]) {
        throw new Error('NIP-05アドレスが見つかりませんでした');
      }
      
      this.pubkey = data.names[name];
      console.log('NIP-05解決成功:', this.pubkey);
    } else {
      // npub形式
      const decoded = NostrTools.nip19.decode(input);
      if (decoded.type !== 'npub') {
        throw new Error('無効なnpubです');
      }
      this.pubkey = decoded.data;
    }
    
    this.nsec = null;
    this.useNIP07 = false;
    this.readOnly = true;
    this.save();
    return this.pubkey;
  } catch (error) {
    throw new Error('無効な形式です: ' + error.message);
  }
}
  
  // NIP-07で認証
  async loginWithExtension() {
    if (!window.nostr) {
      throw new Error('NIP-07拡張機能が見つかりません');
    }
    this.pubkey = await window.nostr.getPublicKey();
    this.useNIP07 = true;
    this.readOnly = false; // ← 追加
    this.save();
    return this.pubkey;
  }

  // nsecで認証
  loginWithNsec(nsec) {
    const decoded = NostrTools.nip19.decode(nsec);
    if (decoded.type !== 'nsec') {
      throw new Error('無効なnsecです');
    }
    this.nsec = nsec;
    this.pubkey = NostrTools.getPublicKey(decoded.data);
    this.useNIP07 = false;
    this.readOnly = false; // ← 追加
    this.save();
    return this.pubkey;
  }

  // サインアウト
  logout() {
    this.pubkey = null;
    this.nsec = null;
    this.useNIP07 = false;
    localStorage.removeItem('nostr_auth');
  }

  // 状態を保存
  save() {
    localStorage.setItem('nostr_auth', JSON.stringify({
      pubkey: this.pubkey,
      nsec: this.nsec,
      useNIP07: this.useNIP07,
      readOnly: this.readOnly || false // ← 追加
    }));
  }

  // 状態を復元
load() {
  const saved = localStorage.getItem('nostr_auth');
  if (saved) {
    const data = JSON.parse(saved);
    this.pubkey = data.pubkey;
    this.nsec = data.nsec;
    this.useNIP07 = data.useNIP07;
    this.readOnly = data.readOnly || false; // ← 追加
  }
}

  // 書き込み可能かチェックするメソッド
canWrite() {
  return this.isLoggedIn() && !this.readOnly;
}

  // イベントに署名
  async signEvent(event) {
    if (this.useNIP07) {
      return await window.nostr.signEvent(event);
    } else if (this.nsec) {
      const decoded = NostrTools.nip19.decode(this.nsec);
      return NostrTools.finalizeEvent(event, decoded.data);
    }
    throw new Error('署名できませんでした');
  }

  // 認証状態確認
  isLoggedIn() {
    return this.pubkey !== null;
  }
}

// グローバルインスタンス
window.nostrAuth = new NostrAuth();
window.nostrAuth.load();