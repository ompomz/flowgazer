// tutorial.js

document.addEventListener('DOMContentLoaded', () => {
    
    const openBtn = document.getElementById('open-tutorial-btn');
    const overlay = document.getElementById('tutorial-overlay');
    const closeBtn = document.getElementById('tutorial-close-button');
    const nextBtn = document.getElementById('next-button');
    const prevBtn = document.getElementById('prev-button');
    const images = document.querySelectorAll('.tutorial-image');
    let currentIndex = 0;

    // チュートリアルを完全に非表示にする関数
    function closeTutorial() {
        overlay.style.display = 'none';
    }

    // チュートリアルを表示する関数
    function openTutorial() {
        overlay.style.display = 'flex';
    }

    // 画像を切り替える関数
    function showImage(index) {
        images.forEach(img => img.classList.remove('active'));
        images[index].classList.add('active');
    }

    // チュートリアルを開くボタンのクリックイベント
    openBtn.addEventListener('click', () => {
        openTutorial();
    });

    // 「閉じる」ボタンでチュートリアルを閉じる
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTutorial();
    });

    // 次へボタン
    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentIndex = (currentIndex + 1) % images.length;
        showImage(currentIndex);
    });

    // 前へボタン
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentIndex = (currentIndex - 1 + images.length) % images.length;
        showImage(currentIndex);
    });

    // 初期状態はチュートリアルを非表示にしておく
    closeTutorial();
    showImage(currentIndex);
});
