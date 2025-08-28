// stop.js

function stopAutoLoading() {
  isAutoLoading = false;

  // 自動更新タイマーが存在すれば停止
  if (typeof autoLoadTimer !== 'undefined' && autoLoadTimer) {
    clearInterval(autoLoadTimer);
    autoLoadTimer = null;
  }

  // kind:0,1,6 の購読を解除（MAIN_SUB_IDとPROFILE_SUB_ID）
  if (typeof relayWS !== 'undefined' && relayWS.readyState === WebSocket.OPEN) {
    [MAIN_SUB_ID, PROFILE_SUB_ID].forEach(subId => {
      relayWS.send(JSON.stringify(["CLOSE", subId]));
    });
  }

  // タイムラインを再描画（eventsは保持されている前提）
  if (typeof refreshTimeline === 'function') {
    refreshTimeline();
  }

  // 停止中メッセージを表示
  const timeline = document.getElementById("timeline");
  if (timeline) {
    const msg = document.createElement("li");
    msg.textContent = "---自動更新を停止中---";
    msg.classList.add("auto-stop-message");
    timeline.prepend(msg);
  }

  // 「もっと見る」ボタンのローディング状態を解除
  const loadMoreButton = document.getElementById("load-more");
  if (loadMoreButton) {
    loadMoreButton.classList.remove("loading");
  }

  // 「あきらめる」ボタンを非表示に
  const cancelButton = document.getElementById("cancel-loading");
  if (cancelButton) {
    cancelButton.style.display = "none";
  }

  console.log("stop.js: 自動更新を停止しました");
}
