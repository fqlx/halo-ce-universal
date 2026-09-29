// A service worker that adds the cross-origin isolation headers to every
// response, for web hosts that cannot send them themselves (GitHub Pages,
// for example). The game's threads need SharedArrayBuffer, which a page has
// only when it is served with
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
// launcher.js registers this worker and reloads the page once when the page
// arrived without them. Hosts that send the headers (tools/web_serve.py,
// Netlify and Cloudflare Pages with _headers) never need it.
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
	const request = event.request;
	// a request the browser only allows from its cache
	if (request.cache === "only-if-cached" && request.mode !== "same-origin")
		return;
	event.respondWith((async () => {
		const response = await fetch(request);
		// opaque responses (other origins) cannot be changed
		if (response.status === 0)
			return response;
		const headers = new Headers(response.headers);
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
		headers.set("Cross-Origin-Embedder-Policy", "require-corp");
		headers.set("Cross-Origin-Resource-Policy", "same-origin");
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	})());
});
