// Theme initialisation — runs before React hydration to prevent flash-of-wrong-theme.
// Referenced by app/layout.js via next/script strategy="beforeInteractive".
(function () {
  try {
    var saved = localStorage.getItem('ws-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = saved ? saved === 'dark' : prefersDark;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
