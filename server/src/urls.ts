/**
 * Public URL layout — the one place it's defined.
 *
 *   Feed:   <PUBLIC_BASE_URL>/<slug>/feed.xml
 *   Media:  <MEDIA_BASE_URL>/<slug>/media/<type>/<file>
 *
 * Changing this after podcasts are live breaks every subscriber's URLs, so
 * treat it as fixed once real shows are imported.
 */

export const feedPath = (slug: string) => `/${slug}/feed.xml`;

export const mediaPath = (slug: string, typeDir: string, file: string) => `/${slug}/media/${typeDir}/${file}`;

/** URL prefix under which all of a show's media lives (used to recognise our own copies). */
export const mediaPrefix = (slug: string) => `/${slug}/media/`;

/**
 * Show addresses that would collide with app routes (media sits at /<slug>/…),
 * or that we may want for future pages.
 */
export const RESERVED_SLUGS = new Set([
  'api', 'feed', 'feeds', 'media', 'healthz', 'admin', 'app', 'assets', 'static', 'login', 'logout',
  'register', 'signup', 'settings', 'site', 'dashboard', 'account', 'help', 'docs', 'about', 'www', 'robots-txt',
]);
