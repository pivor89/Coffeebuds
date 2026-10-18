/* CoffeeBuds PWA: service worker registration, tasteful install hint, and a permanent install API (window.cbInstall). */
(function () {
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {}); });
  var KEY = 'cb_install_dismissed';
  var SHARE_SVG = '<svg class="ih-share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ADD_SVG = '<svg class="ih-share" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var MENU_SVG = '<svg class="ih-share" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>';
  function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  var ua = navigator.userAgent, isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isSafari = isIOS && !/crios|fxios|edgios|opios/i.test(ua);
  var dismissed = false; try { dismissed = localStorage.getItem(KEY) === '1'; } catch (e) {}
  var deferred = null, listeners = [];
  function changed() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }

  function removeHint() { var h = document.getElementById('installHint'); if (h) h.remove(); }
  function show(html, onInstall, opts) {
    opts = opts || {}; removeHint();
    var el = document.createElement('div'); el.id = 'installHint'; el.className = 'install-hint' + (opts.sheet ? ' sheet' : ''); el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Install CoffeeBuds');
    el.innerHTML = '<img src="/icons/icon-192.png" alt="" width="40" height="40"><div class="ih-text"><strong>Install CoffeeBuds</strong><span>' + html + '</span></div>' +
      (onInstall ? '<button class="btn caramel ih-install" type="button">Install</button>' : '') + '<button class="ih-close" type="button" aria-label="Dismiss">×</button>';
    document.body.appendChild(el);
    // Only the automatic hint remembers dismissal; sheets opened from the button don't.
    el.querySelector('.ih-close').onclick = function () { if (!opts.sheet) { try { localStorage.setItem(KEY, '1'); } catch (e) {} } el.remove(); };
    if (onInstall) el.querySelector('.ih-install').onclick = onInstall;
  }
  function prompt() {
    var d = deferred; if (!d) return Promise.resolve('unavailable');
    d.prompt();
    return d.userChoice.then(function (c) { return (c && c.outcome) || 'dismissed'; }).finally(function () { deferred = null; removeHint(); changed(); });
  }
  // Always capture the prompt (even if the floating hint was dismissed) so the permanent button can use it.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e; changed();
    if (!dismissed && !isStandalone()) show('Add it to your home screen for quick coffee plans.', prompt);
  });
  window.addEventListener('appinstalled', function () { removeHint(); deferred = null; try { localStorage.setItem(KEY, '1'); } catch (e) {} changed(); });
  if (isSafari && !dismissed && !isStandalone()) setTimeout(function () { show('Tap Share ' + SHARE_SVG + ', then Add to Home Screen'); }, 1500);

  window.cbInstall = {
    // 'installed' | 'prompt' (native prompt available) | 'ios' | 'manual'
    state: function () { return isStandalone() ? 'installed' : deferred ? 'prompt' : isSafari ? 'ios' : 'manual'; },
    onChange: function (f) { listeners.push(f); },
    install: function () {
      var s = this.state();
      if (s === 'prompt') return prompt();
      if (s === 'ios') show('Tap Share ' + SHARE_SVG + ' in Safari\'s toolbar, then <b>Add to Home Screen</b> ' + ADD_SVG + '.', null, { sheet: true });
      else if (s === 'manual') show('Open your browser menu ' + MENU_SVG + ' and choose <b>Install app</b> / <b>Add to Home screen</b>.', null, { sheet: true });
      return Promise.resolve(s);
    },
  };
})();
