// Only browsers too old to run the app load this file.
(function () {
  'use strict';
  window.__appStarted = true;
  var box = document.getElementById('boot');
  if (box) box.textContent = 'This browser is too old to run the app. Update the phone, or open the app in a current version of Safari or Chrome.';
})();
