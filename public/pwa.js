/* CoffeeBuds PWA: service worker registration + tasteful install prompt */
(function () {
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {}); });
  var KEY = 'cb_install_dismissed';
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var dismissed = false; try { dismissed = localStorage.getItem(KEY) === '1'; } catch (e) {}
  if (standalone || dismissed) return;
  var ua = navigator.userAgent, isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isSafari = isIOS && !/crios|fxios|edgios|opios/i.test(ua);
  var deferred = null;
  function show(html, onInstall) {
    if (document.getElementById('installHint')) return;
    var el = document.createElement('div'); el.id = 'installHint'; el.className = 'install-hint'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Install CoffeeBuds');
    el.innerHTML = '<img src="/icons/icon-192.png" alt="" width="40" height="40"><div class="ih-text"><strong>Install CoffeeBuds</strong><span>' + html + '</span></div>' +
      (onInstall ? '<button class="btn caramel ih-install" type="button">Install</button>' : '') + '<button class="ih-close" type="button" aria-label="Dismiss">×</button>';
    document.body.appendChild(el);
    el.querySelector('.ih-close').onclick = function () { try { localStorage.setItem(KEY, '1'); } catch (e) {} el.remove(); };
    if (onInstall) el.querySelector('.ih-install').onclick = onInstall;
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    show('Add it to your home screen for quick coffee plans.', function () {
      deferred.prompt(); deferred.userChoice.finally(function () { deferred = null; var h = document.getElementById('installHint'); if (h) h.remove(); });
    });
  });
  window.addEventListener('appinstalled', function () { var h = document.getElementById('installHint'); if (h) h.remove(); try { localStorage.setItem(KEY, '1'); } catch (e) {} });
  if (isSafari) setTimeout(function () { show('Tap Share <svg class="ih-share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>, then Add to Home Screen'); }, 1500);
})();
