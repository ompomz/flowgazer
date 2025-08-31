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

  closeBtn.addEventListener('click', () => {
    minimizeTutorial();
  });

  overlay.addEventListener('click', (e) => {
    if (overlay.classList.contains('minimized') && e.target.closest('#tutorial-modal')) {
      openTutorial();
    }
  });

  nextBtn.addEventListener('click', () => {
    currentIndex = (currentIndex + 1) % images.length;
    showImage(currentIndex);
  });

  prevBtn.addEventListener('click', () => {
    currentIndex = (currentIndex - 1 + images.length) % images.length;
    showImage(currentIndex);
  });

  showImage(currentIndex);
});
