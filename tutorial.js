// tutorial.js

document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('tutorial-overlay');
  const closeBtn = document.getElementById('tutorial-close-button');
  const nextBtn = document.getElementById('next-button');
  const prevBtn = document.getElementById('prev-button');
  const images = document.querySelectorAll('.tutorial-image');
  let currentIndex = 0;

  function openTutorial() {
    overlay.classList.remove('minimized');
  }

  function minimizeTutorial() {
    overlay.classList.add('minimized');
  }

  function showImage(index) {
    images.forEach(img => img.classList.remove('active'));
    images[index].classList.add('active');
  }

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // イベントの伝播を停止
    minimizeTutorial();
  });

  overlay.addEventListener('click', (e) => {
    // 最小化された状態でのみ実行
    if (overlay.classList.contains('minimized')) {
      if (e.target.closest('#tutorial-modal')) {
        openTutorial();
      }
    } else {
      // 最小化されていない状態で背景がクリックされたら閉じる
      if (!e.target.closest('#tutorial-modal')) {
        minimizeTutorial();
      }
    }
  });

  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // イベントの伝播を停止
    currentIndex = (currentIndex + 1) % images.length;
    showImage(currentIndex);
  });

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // イベントの伝播を停止
    currentIndex = (currentIndex - 1 + images.length) % images.length;
    showImage(currentIndex);
  });

  showImage(currentIndex);
});
