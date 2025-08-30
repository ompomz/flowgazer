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

  // 停止中メッセージを表示（divを含める）
 const timeline = document.getElementById("timeline");
if (timeline) {
  const li = document.createElement("li");
  li.className = "auto-stop-message";

  const wrapperDiv = document.createElement("div");
  wrapperDiv.style.width = "600px";         // 左寄せで幅600px
  wrapperDiv.style.marginLeft = "0";        // 左寄せ
  wrapperDiv.style.textAlign = "center";    // 中のテキストを中央寄せ
  wrapperDiv.style.paddingBottom = "0.5rem";
  wrapperDiv.style.color = "#666";

  const p = document.createElement("p");
  p.textContent = "---自動更新を停止中---";
  p.style.margin = "0";

  wrapperDiv.appendChild(p);
  li.appendChild(wrapperDiv);
  timeline.prepend(li);
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
