/* Offline copy for the AWS study decks.

   Pages: the network is tried first, so an online visit always shows the newest version and refreshes
   the saved copy. The saved copy is used when the network fails, or has not answered within WAIT_MS.
   Fonts: the saved copy is used first, because the font files never change.

   Nothing here is specific to one deck: any page under this folder is saved the first time it is opened online. */
const CACHE = 'aws-decks-v1';
const PAGES = ['./', 'index.html', 'aws-professional-cards.html'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const WAIT_MS = 4000;

const isFont = url => FONT_HOSTS.includes(url.hostname);
const inScope = url => url.origin === self.location.origin && url.href.startsWith(self.registration.scope);
/* one saved copy per page whatever its query string; fonts keep theirs, since it selects the font */
const keyFor = url => isFont(url) ? url.href : url.origin + url.pathname;
/* fonts are fetched in CORS mode so the saved response is an ordinary one rather than an opaque one */
const fetchFont = url => fetch(url.href, { mode: 'cors', credentials: 'omit' });
const open = () => caches.open(CACHE);
const saved = key => open().then(cache => cache.match(key, { ignoreVary: true }));

self.addEventListener('install', event => {
  event.waitUntil(
    open()
      .then(cache => cache.addAll(PAGES.map(page => new Request(page, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n.startsWith('aws-decks-') && n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (isFont(url)) event.respondWith(font(event, url));
  else if (inScope(url)) event.respondWith(page(event, request, url));
});

function page(event, request, url) {
  const key = keyFor(url);
  const fetched = fetch(request);
  /* registered before anything else reads the response, so the copy is taken while the body is still unread */
  const stored = fetched.then(response => {
    if (!response.ok) return;
    const copy = response.clone();
    return open().then(cache => cache.put(key, copy));
  });
  event.waitUntil(stored.catch(() => {}));   // a slow answer still refreshes the saved copy

  const slow = new Promise(resolve => setTimeout(resolve, WAIT_MS))
    .then(() => saved(key))
    .then(hit => hit || fetched);
  return Promise.race([fetched, slow])
    .catch(() => saved(key).then(hit => hit || Response.error()));
}

async function font(event, url) {
  const key = keyFor(url);
  const refresh = () => fetchFont(url).then(response => {
    if (!response.ok) return response;
    const copy = response.clone();
    return open().then(cache => cache.put(key, copy)).then(() => response);
  });
  const hit = await saved(key);
  if (!hit) return refresh();
  /* the stylesheet can change, so refresh it quietly; the font files themselves are permanent */
  if (url.hostname === 'fonts.googleapis.com') event.waitUntil(refresh().catch(() => {}));
  return hit;
}

/* A page tells the worker what it has already loaded, so that the very first visit is saved too:
   on that visit the page and its fonts were fetched before this worker was in control. */
self.addEventListener('message', event => {
  const list = event.data && event.data.save;
  if (!Array.isArray(list)) return;
  event.waitUntil(open().then(cache => Promise.all(list.map(async href => {
    let url;
    try { url = new URL(href); } catch (error) { return; }
    if (!isFont(url) && !inScope(url)) return;
    const key = keyFor(url);
    if (await cache.match(key, { ignoreVary: true })) return;
    try {
      const response = await (isFont(url) ? fetchFont(url) : fetch(key));
      if (response.ok) await cache.put(key, response);
    } catch (error) { /* offline or blocked: nothing to save this time */ }
  }))));
});
