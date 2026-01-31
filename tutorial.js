document.addEventListener('DOMContentLoaded', () => {
  const openBtn = document.getElementById('open-tutorial-btn');
  const overlay = document.getElementById('tutorial-overlay');
  const closeBtn = document.getElementById('tutorial-close-button');
  const images = document.querySelectorAll('.tutorial-image');
  const dots = document.querySelectorAll('.dot');
  let currentIndex = 0;

  function closeTutorial() {
    overlay.style.display = 'none';
  }

  function openTutorial() {
    overlay.style.display = 'flex';
  }

  function showImage(index) {
    images.forEach(img => img.classList.remove('active'));
    images[index].classList.add('active');
    
    dots.forEach(dot => dot.classList.remove('active'));
    dots[index].classList.add('active');
    
    currentIndex = index;
  }

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTutorial();
  });

  openBtn.addEventListener('click', () => {
    openTutorial();
    showImage(0);
  });

  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      const dotIndex = parseInt(dot.dataset.index);
      showImage(dotIndex);
    });
  });

  images.forEach((img, index) => {
  img.addEventListener('click', () => {
    const nextIndex = (index + 1) % images.length;
    showImage(nextIndex);
    });
  });
  
  showImage(currentIndex);
});