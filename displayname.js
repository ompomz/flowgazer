/**
 * プロファイル取得中の公開鍵を追跡するSet
 * 重複したリクエストを避けるために使用します。
 */
const pubkeysInProgress = new Set();

/**
 * プロファイル取得に使用するリレーのリスト
 * 優先度の高い順に並べています。
 */
const PROFILE_RELAYS = [
  "wss://relay.nostr.band",
  "wss://relay-jp.nostr.wirednet.jp/",
  "wss://relay.damus.io"
];

/**
 * NostrのKind:0 (Profile) イベントを解析し、プロファイル情報をprofilesオブジェクトに保存します。
 *
 * @param {object} nostrEv - Nostrイベントオブジェクト (Kind:0)
 * @param {object} profiles - プロファイル情報を保持するオブジェクト
 * @returns {void}
 */
export const updateProfile = (nostrEv, profiles) => {
  // Kind:0イベントか確認
  if (nostrEv.kind !== 0) {
    console.error("updateProfile関数はKind:0イベントのみを受け付けます。");
    return;
  }

  try {
    const profileContent = JSON.parse(nostrEv.content);
    profiles[nostrEv.pubkey] = profileContent;
    // console.log(`公開鍵: ${nostrEv.pubkey.substring(0, 8)}... のプロファイルを更新しました。`);
  } catch (error) {
    console.error("プロフィールコンテンツのパースに失敗しました:", error);
  }
};

/**
 * プロファイル情報から表示名を取得します。
 * 存在しない場合は、公開鍵の短縮形を返します。
 *
 * @param {string} pubkey - ユーザーの公開鍵 (hex)
 * @param {object} profiles - プロファイル情報を保持するオブジェクト
 * @returns {string} - 表示名、または公開鍵の短縮形
 */
export const getDisplayName = (pubkey, profiles) => {
  if (profiles[pubkey] && profiles[pubkey].name) {
    return profiles[pubkey].name;
  }
  return pubkey.substring(0, 8);
};

/**
 * 未取得のKind:0プロファイルを複数のリレーから取得します。
 * @param {string[]} pubkeysToFetch - プロファイルをフェッチする公開鍵の配列
 * @param {object} profiles - プロファイル情報を保持するオブジェクト (メインスクリプトと共有)
 * @param {Function} onProfilesFetched - プロファイル取得後に呼び出されるコールバック関数
 */
export const fetchProfilesForPubkeys = (pubkeysToFetch, profiles, onProfilesFetched) => {
  const pubkeys = new Set();
  for (const pubkey of pubkeysToFetch) {
    if (!profiles[pubkey] && !pubkeysInProgress.has(pubkey)) {
      pubkeys.add(pubkey);
      pubkeysInProgress.add(pubkey);
    }
  }

  if (pubkeys.size === 0) {
    // console.log("フェッチ対象のプロファイルはありませんでした。");
    return;
  }

  // 複数のリレーを順に試行する関数
  let relayIndex = 0;
  const tryNextRelay = () => {
    if (relayIndex >= PROFILE_RELAYS.length) {
      console.warn("すべてのプロファイルリレーへの接続に失敗しました。");
      pubkeys.forEach(pubkey => pubkeysInProgress.delete(pubkey));
      return;
    }

    const currentRelayUrl = PROFILE_RELAYS[relayIndex];
    const PROFILE_SUB_ID = "motherfuncking-profile-sub-" + Date.now();
    const profileRelayWS = new WebSocket(currentRelayUrl);
    let timeoutId;

    profileRelayWS.addEventListener("open", () => {
      // console.log(`プロファイルリレーに接続しました: ${currentRelayUrl}`);
      profileRelayWS.send(JSON.stringify(["REQ", PROFILE_SUB_ID, {
        kinds: [0],
        authors: Array.from(pubkeys)
      }]));
      // タイムアウト設定
      timeoutId = setTimeout(() => {
        console.warn(`プロファイルリレー ${currentRelayUrl} からの応答がタイムアウトしました。`);
        profileRelayWS.close();
      }, 5000); // 5秒後にタイムアウト
    });

    profileRelayWS.addEventListener("message", ev => {
      try {
        const r2cMsg = JSON.parse(ev.data);
        if (r2cMsg[0] === "EVENT" && r2cMsg[2].kind === 0) {
          const nostrEv = r2cMsg[2];
          updateProfile(nostrEv, profiles);
          pubkeysInProgress.delete(nostrEv.pubkey);
          if (typeof onProfilesFetched === 'function') {
            onProfilesFetched();
          }
        } else if (r2cMsg[0] === "EOSE" && r2cMsg[1] === PROFILE_SUB_ID) {
          // console.log(`プロファイルリレー ${currentRelayUrl} からEOSEを受信しました。`);
          clearTimeout(timeoutId);
          profileRelayWS.close();
        }
      } catch (err) {
        console.error("プロファイルイベントの処理に失敗しました:", err);
      }
    });

    profileRelayWS.addEventListener("close", () => {
      clearTimeout(timeoutId);
      // console.log(`プロファイルリレー ${currentRelayUrl} との接続が閉じられました。`);
      // 次のリレーを試す
      relayIndex++;
      tryNextRelay();
    });

    profileRelayWS.addEventListener("error", err => {
      console.error(`プロファイルリレー ${currentRelayUrl} でエラーが発生しました。`, err);
      profileRelayWS.close();
    });
  };

  tryNextRelay();
};
