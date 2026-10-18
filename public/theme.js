/* theme: Paris is the default for everyone (legacy classic/lounge cookies are ignored). External file so the CSP needs no 'unsafe-inline' scripts. */
(function(){var q=(new URLSearchParams(location.search).get('theme')||'').toLowerCase();
if(['paris','lounge'].indexOf(q)>=0){document.cookie='theme='+q+';path=/;max-age=31536000;samesite=lax';}else if(['classic','default','none'].indexOf(q)>=0){document.cookie='theme=;path=/;max-age=0';}
document.documentElement.setAttribute('data-theme','paris');})();
