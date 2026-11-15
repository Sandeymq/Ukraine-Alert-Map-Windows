'use strict';
// Запуск інтерфейсу: малюємо віджет і підключаємо дані з головного процесу.
(function () {
  var el = document.getElementById('w');
  el.innerHTML = UAW.render();
  var app = UAW.createApp(el);
  var host = window.uawHost;
  if (host) {
    host.onOutput(function (text) { app.onOutput(text); });
    host.onStream(function (msg) { app.onStream(msg); });
    if (host.onMaterial) host.onMaterial(function (m) { app.setMaterial(m.material); });
    host.ready();
  }
  window.__uaw = app;
})();
