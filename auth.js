// auth.js
class NostrAuth {
  constructor() {
    this.pubkey = null;
    this.nsec = null;
    this.useNIP07 = false;
    this.readOnly = false;
    this.sessionNsec = null;
    this.sessionPubkey = null;
  }

  // npubまたはNIP-05で認証（閲覧専用）
  async loginWithNpub(input) {
    try {
      if (input.includes('@')) {
        const [name, domain] = input.split('@');
        const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`);
        const data = await response.json();
        if (!data.names || !data.names[name]) {
          throw new Error('NIP-05アドレスが見つかりませんでした');
        }
        this.pubkey = data.names[name];
      } else {
        const decoded = NostrTools.nip19.decode(input);
        if (decoded.type !== 'npub') {
          throw new Error('無効なnpubです');
        }
        this.pubkey = decoded.data;
      }
      
      this.nsec = null;
      this.useNIP07 = false;
      this.readOnly = true;
      this.sessionNsec = null;
      this.sessionPubkey = null;
      
      this.save();
      return this.pubkey;
    } catch (error) {
      throw new Error('無効な形式です: ' + error.message);
    }
  }

  // --- 一時的な書き込み用nsecを検証・セットするメソッド ---
  setSessionNsec(nsec) {
    try {
      const decoded = NostrTools.nip19.decode(nsec);
      if (decoded.type !== 'nsec') throw new Error();
      
      this.sessionNsec = nsec;
      this.sessionPubkey = NostrTools.getPublicKey(decoded.data);
      return this.sessionPubkey; // UI側でnpubを表示するために返す
    } catch (e) {
      throw new Error('無効なnsecです');
    }
  }

  // NIP-07で認証
  async loginWithExtension() {
    if (!window.nostr) {
      throw new Error('NIP-07拡張機能が見つかりません');
    }
    this.pubkey = await window.nostr.getPublicKey();
    this.useNIP07 = true;
    this.readOnly = false;
    this.save();
    return this.pubkey;
  }

  // nsecで認証（永続ログイン）
  loginWithNsec(nsec) {
    const decoded = NostrTools.nip19.decode(nsec);
    if (decoded.type !== 'nsec') {
      throw new Error('無効なnsecです');
    }
    this.nsec = nsec;
    this.pubkey = NostrTools.getPublicKey(decoded.data);
    this.useNIP07 = false;
    this.readOnly = false;
    this.save();
    return this.pubkey;
  }

  // サインアウト
  logout() {
    this.pubkey = null;
    this.nsec = null;
    this.sessionNsec = null;
    this.sessionPubkey = null;
    this.useNIP07 = false;
    this.readOnly = false;
    localStorage.removeItem('nostr_auth');
  }

  // 状態を保存
  save() {
    localStorage.setItem('nostr_auth', JSON.stringify({
      pubkey: this.pubkey,
      nsec: this.nsec,
      useNIP07: this.useNIP07,
      readOnly: this.readOnly || false
    }));
  }

  load() {
    const saved = localStorage.getItem('nostr_auth');
    if (saved) {
      const data = JSON.parse(saved);
      this.pubkey = data.pubkey;
      this.nsec = data.nsec;
      this.useNIP07 = data.useNIP07;
      this.readOnly = data.readOnly || false;
    }
  }

  // 書き込み可能かチェック（セッション鍵がある場合もOKとする）
  canWrite() {
    return (this.isLoggedIn() && !this.readOnly) || this.sessionNsec !== null;
  }

  // イベントに署名（一時的なnsecを最優先にする）
  async signEvent(event, overrideNsec = null) {
    // 1. 今回の投稿で直接渡されたnsec
    // 2. メモリに保持しているセッションnsec
    // 3. ログイン情報として持っているnsec
    const targetNsec = overrideNsec || this.sessionNsec || this.nsec;

    if (targetNsec) {
      const decoded = NostrTools.nip19.decode(targetNsec);
      return NostrTools.finalizeEvent(event, decoded.data);
    } else if (this.useNIP07) {
      return await window.nostr.signEvent(event);
    }
    
    throw new Error('署名に必要な鍵が見つかりません');
  }

  // ---- 追加: NIP-04 / NIP-44 復号 ----
  // counterpartPubkey: 暗号化の相手の公開鍵（自分宛てリストなら自分の pubkey）
  // scheme: 'nip44' | 'nip04'
  async decrypt(counterpartPubkey, ciphertext, scheme = 'nip44') {
    if (!this.pubkey || this.readOnly) {
      throw new Error('復号に必要な鍵がありません');
    }

    // 1. 秘密鍵ログイン
    if (this.nsec && !this.useNIP07) {
      const sk = NostrTools.nip19.decode(this.nsec).data; // Uint8Array

      if (scheme === 'nip44') {
        // nostr-tools のバージョン差（v2 名前空間の有無）を吸収する
        const n44 = NostrTools.nip44;
        const getKey = n44?.getConversationKey || n44?.v2?.utils?.getConversationKey;
        const dec = n44?.decrypt || n44?.v2?.decrypt;
        if (!getKey || !dec) throw new Error('nip44 が利用できません');
        return dec(ciphertext, getKey(sk, counterpartPubkey));
      }

      if (!NostrTools.nip04?.decrypt) throw new Error('nip04 が利用できません');
      return await NostrTools.nip04.decrypt(sk, counterpartPubkey, ciphertext);
    }

    // 2. NIP-07（拡張機能のポップアップ許可が発生する）
    if (this.useNIP07) {
      const api = window.nostr?.[scheme];
      if (!api?.decrypt) {
        throw new Error(`拡張機能が ${scheme} の復号に対応していません`);
      }
      return await api.decrypt(counterpartPubkey, ciphertext);
    }

    throw new Error('復号に使える鍵が見つかりません');
  }

  isLoggedIn() {
    return this.pubkey !== null;
  }
}

window.nostrAuth = new NostrAuth();
window.nostrAuth.load();