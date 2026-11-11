// A plain script that runs before the app. If the app has not started after a while (a file
// failed to load, for example), it replaces "Opening…" with something the user can act on.
(function () {
  'use strict';
  setTimeout(function () {
    if (window.__appStarted) return;
    var box = document.getElementById('boot');
    if (!box) return;
    box.textContent = 'The app did not start. Check that you have signal, then reload the page. Poles already saved on this phone are not affected.';
  }, 12000);
})();
