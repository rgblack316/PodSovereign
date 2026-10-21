// FeedHost dashboard. Plain ES modules, no build step.
// All data is inserted as text (never innerHTML), so feed content can't inject markup.

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const state = { setup: null, me: null, podcasts: [], services: null };
let cleanup = []; // timers etc. cleared on every navigation

// ───────────── helpers ─────────────

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by the CSP (inline style attributes are not)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2400);
}

async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    window.prompt('Copy this:', text);
  }
}

const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

const fmtDate = (v, withTime = false) => {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleString(undefined, withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' });
};

const fmtBytes = (n) => {
  if (!n) return '0 MB';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

const fmtDuration = (s) => {
  if (!s && s !== 0) return '—';
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};

/** ISO string with the browser's own UTC offset, e.g. 2026-11-03T20:00:00-05:00 */
function localIso(value) {
  if (!value) return null;
  const d = new Date(value);
  const off = -d.getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
    `${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

/** ISO → value for <input type=datetime-local> */
function toInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function artImg(url, title, size = '') {
  const initials = (title || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const placeholder = () => h('div', { class: `art placeholder ${size}`, 'aria-hidden': 'true' }, initials);
  if (!url) return placeholder();
  // Fall back to initials if the image can't load (e.g. art still on an old http:// host).
  const img = h('img', { class: `art ${size}`, src: url, alt: '', loading: 'lazy', onerror: () => img.replaceWith(placeholder()) });
  return img;
}

function formError() {
  return h('p', { class: 'error', role: 'alert', hidden: true });
}
function showError(el, err) {
  el.textContent = err instanceof Error ? err.message : String(err);
  el.hidden = false;
}

/** Disable a form's buttons while a request runs. */
async function busy(form, fn) {
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    return await fn();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function field(labelText, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, labelText), input, hint ? h('p', { class: 'hint' }, hint) : null);
}

// ───────────── branding ─────────────

const siteName = () => state.setup?.siteName || 'FeedHost';
const brandMark = () => h('img', { class: 'logo', src: `/site/logo?v=${state.setup?.siteVersion ?? 0}`, alt: '' });

function applyBranding() {
  let link = document.querySelector('link[rel=icon]');
  if (!link) document.head.append((link = h('link', { rel: 'icon' })));
  link.href = `/site/favicon?v=${state.setup?.siteVersion ?? 0}`;
}

// ───────────── signal lights ─────────────

/** The lights shown on a show's channel strip, from the podcast detail. */
function showLights(p) {
  const lights = [];
  lights.push(p.status === 'active'
    ? { cls: 'on', text: 'Feed live' }
    : { cls: 'warn', text: 'Importing' });

  const m = p.media ?? { done: 0, failed: 0, pending: 0 };
  if (p.status === 'importing') lights.push({ cls: 'warn', text: `Copying media (${m.done} done)` });
  else if (m.failed) lights.push({ cls: 'warn', text: `${m.failed} file${m.failed === 1 ? '' : 's'} not copied` });
  else if (m.done) lights.push({ cls: 'on', text: `${p.sourceFeedUrl ? 'Media copied' : 'Media stored'} (${fmtBytes(m.bytes)})` });
  else lights.push({ cls: '', text: 'No media' });

  if (p.sourceFeedUrl) {
    const r = p.redirect?.status;
    lights.push(
      r === 'ok' ? { cls: 'on', text: 'Old feed redirects here' }
        : r === 'temporary' ? { cls: 'warn', text: 'Redirect is temporary' }
          : r === 'elsewhere' || r === 'unreachable' ? { cls: 'bad', text: r === 'elsewhere' ? 'Redirect goes elsewhere' : 'Old feed unreachable' }
            : r === 'none' ? { cls: '', text: 'No redirect yet' }
              : { cls: '', text: 'Redirect not checked' },
    );
  }

  lights.push(p.podping.enabled ? { cls: 'on', text: 'Podping on' } : { cls: '', text: 'Podping off' });

  if (p.live.now) lights.push({ cls: 'live', text: 'On air' });
  else if (p.live.upcoming) lights.push({ cls: 'warn', text: `${p.live.upcoming} live show${p.live.upcoming === 1 ? '' : 's'} scheduled` });
  return lights;
}

/** Tiny dots for the sidebar, from the list endpoint. */
function miniLights(p) {
  const dots = [
    p.status === 'active' ? 'on' : 'warn',
    p.mediaFailed ? 'warn' : 'on',
  ];
  if (p.imported) dots.push(p.redirectStatus === 'ok' ? 'on' : p.redirectStatus === 'temporary' ? 'warn' : ['elsewhere', 'unreachable'].includes(p.redirectStatus) ? 'bad' : '');
  dots.push(p.podpingEnabled ? 'on' : '');
  if (p.liveNow) dots.push('live');
  const summary = [
    p.status === 'active' ? 'feed live' : 'importing',
    p.mediaFailed ? `${p.mediaFailed} files not copied` : null,
    p.imported ? (p.redirectStatus === 'ok' ? 'redirect in place' : 'no redirect confirmed') : null,
    p.podpingEnabled ? 'Podping on' : 'Podping off',
    p.liveNow ? 'on air' : null,
  ].filter(Boolean).join(', ');
  return [h('span', { class: 'mini', 'aria-hidden': 'true', title: summary }, dots.map((c) => h('span', { class: c }))), h('span', { class: 'sr-only' }, summary)];
}

// ───────────── boot & routing ─────────────

async function refreshPodcasts() {
  state.podcasts = (await api('GET', '/api/podcasts')).podcasts;
}

async function boot() {
  state.setup = await api('GET', '/api/setup');
  applyBranding();
  try {
    state.me = (await api('GET', '/api/me')).user;
    await refreshPodcasts();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) throw e;
    state.me = null;
  }
  window.addEventListener('hashchange', render);
  render();
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return parts;
}

let lastHash = null;
async function render() {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  const navigated = location.hash !== lastHash;
  lastHash = location.hash;
  if (!state.me) return renderAuth();

  const [section, a, b, c] = route();
  let view;
  try {
    if (section === 'import' && a) view = await viewImportJob(a);
    else if (section === 'import') view = await viewImport();
    else if (section === 'new') view = await viewNewShow();
    else if (section === 'show' && a) view = await viewShow(a, b, c);
    else if (section === 'account') view = await viewAccount();
    else if (section === 'people' && state.me.isAdmin) view = await viewPeople();
    else if (section === 'site' && state.me.isAdmin) view = await viewSite();
    else view = await viewHome();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      state.me = null;
      return renderAuth();
    }
    view = h('div', { class: 'page' },
      h('div', { class: 'empty' }, h('h2', null, e instanceof ApiError && e.status === 404 ? 'Not found' : 'Something went wrong'),
        h('p', { class: 'muted' }, e.message), h('a', { href: '#/' }, 'Back to your shows')));
  }
  $app.replaceChildren(frame(view));
  if (navigated) window.scrollTo(0, 0);
  const h1 = $app.querySelector('main h1');
  document.title = h1 ? `${h1.textContent} · ${siteName()}` : siteName();
}

// ───────────── sign in ─────────────

function renderAuth(mode) {
  document.title = `Sign in · ${siteName()}`;
  const first = state.setup.needsFirstAccount;
  mode = first ? 'first' : mode ?? 'signin';
  const err = formError();
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: mode === 'signin' ? 'current-password' : 'new-password', required: true, minlength: mode === 'signin' ? null : 10 });
  const name = h('input', { type: 'text', name: 'name', autocomplete: 'name' });

  const form = h('form', {
    onsubmit: (ev) => {
      ev.preventDefault();
      err.hidden = true;
      busy(form, async () => {
        try {
          const path = mode === 'signin' ? '/api/auth/login' : '/api/auth/register';
          const body = { email: email.value, password: password.value, displayName: name.value || undefined };
          state.me = (await api('POST', path, body)).user;
          state.setup.needsFirstAccount = false;
          await refreshPodcasts();
          go('#/');
        } catch (e) {
          showError(err, e);
        }
      });
    },
  },
  mode !== 'signin' ? field('Your name', name) : null,
  field('Email', email),
  field('Password', password, mode === 'signin' ? null : 'At least 10 characters.'),
  err,
  h('button', { class: 'primary', type: 'submit' }, mode === 'signin' ? 'Sign in' : 'Create account'));

  const heading = mode === 'first' ? 'Set up your podcast host' : mode === 'register' ? 'Create an account' : 'Sign in';
  const lead = mode === 'first'
    ? 'Create the first account. It becomes the administrator: you can then name the site, add your logo and set its web address under Site settings.'
    : mode === 'register' ? 'Host your podcast feed and media on this server.' : 'Manage your shows, stats prefixes and live broadcasts.';

  $app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-box' },
    h('div', { class: 'brand' }, brandMark(), siteName()),
    h('h1', null, heading),
    h('p', { class: 'muted' }, lead),
    form,
    !first && state.setup.registrationOpen ? h('p', { class: 'hint', style: 'margin-top:16px' },
      mode === 'signin' ? 'New here? ' : 'Have an account? ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth(mode === 'signin' ? 'register' : 'signin'); } },
        mode === 'signin' ? 'Create an account' : 'Sign in')) : null,
  )));
  (mode === 'signin' ? email : name).focus();
}

// ───────────── frame ─────────────

function frame(view) {
  const [section, a] = route();
  const current = section === 'show' ? a : null;
  const rail = h('aside', { class: 'rail' },
    h('a', { class: 'brand', href: '#/' }, brandMark(), siteName()),
    h('nav', { 'aria-label': 'Shows' },
      h('h2', null, 'Shows'),
      state.podcasts.length
        ? h('ul', { class: 'channels' }, state.podcasts.map((p) => h('li', null,
          h('a', { href: `#/show/${p.id}`, 'aria-current': p.id === current ? 'page' : null },
            artImg(p.imageUrl, p.title),
            h('span', { class: 'name' }, p.title),
            miniLights(p)))))
        : h('p', { class: 'hint', style: 'margin:0 8px' }, 'No shows yet.')),
    h('div', { class: 'rail-actions' },
      h('a', { class: 'btn primary import', href: '#/import', 'aria-current': section === 'import' ? 'page' : null }, 'Import a show'),
      h('a', { class: 'btn import', href: '#/new', 'aria-current': section === 'new' ? 'page' : null }, 'Start a new show')),
    h('div', { class: 'rail-foot' },
      h('div', { class: 'who' }, state.me.displayName || state.me.email),
      h('a', { href: '#/account' }, 'Account'),
      state.me.isAdmin ? h('a', { href: '#/people' }, 'People') : null,
      state.me.isAdmin ? h('a', { href: '#/site' }, 'Site settings') : null,
      h('button', {
        type: 'button',
        onclick: async () => {
          await api('POST', '/api/auth/logout');
          state.me = null;
          state.podcasts = [];
          location.hash = '';
          renderAuth();
        },
      }, 'Sign out')));
  return h('div', { class: 'frame' }, rail, h('main', { id: 'main' }, view));
}

// ───────────── home ─────────────

async function viewHome() {
  if (!state.podcasts.length) {
    return h('div', { class: 'page' }, h('div', { class: 'empty' },
      h('h1', { style: 'font-size:var(--t-xl);margin-bottom:12px' }, 'Add your first show'),
      h('p', { class: 'muted' }, 'Moving from another host? Paste your current feed address and every episode, image, transcript and chapter file is copied here. Starting fresh? Create the show and publish your first episode.'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn primary', href: '#/import' }, 'Import a show'),
        h('a', { class: 'btn', href: '#/new' }, 'Start a new show'))));
  }
  if (state.podcasts.length === 1) {
    location.replace(`#/show/${state.podcasts[0].id}`);
    return h('div');
  }
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Your shows')),
    h('div', { class: 'panel', style: 'padding:0' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Show'), h('th', { class: 'num' }, 'Episodes'), h('th', null, 'Feed address'))),
      h('tbody', null, state.podcasts.map((p) => h('tr', null,
        h('td', null, h('a', { href: `#/show/${p.id}`, class: 'ep-title' }, p.title), p.role !== 'owner' ? h('span', { class: 'hint' }, ` (${p.role})`) : null),
        h('td', { class: 'num' }, p.episodeCount),
        h('td', null, h('span', { class: 'hint' }, p.feedUrl)))))))));
}

// ───────────── import ─────────────

async function viewImport() {
  const err = formError();
  const url = h('input', { type: 'url', name: 'url', required: true, placeholder: 'https://feeds.example.com/my-show.xml' });
  const slug = h('input', { type: 'text', name: 'slug', pattern: '[a-z0-9](?:[a-z0-9\\-]{0,58}[a-z0-9])?', placeholder: 'my-show' });
  const previewText = h('span');
  const updatePreview = () => {
    previewText.textContent = `${state.setup.publicBaseUrl}/${slug.value || '<from the show title>'}/feed.xml`;
  };
  slug.addEventListener('input', () => {
    slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    updatePreview();
  });
  updatePreview();

  const form = h('form', {
    class: 'panel',
    onsubmit: (ev) => {
      ev.preventDefault();
      err.hidden = true;
      busy(form, async () => {
        try {
          const { job } = await api('POST', '/api/imports', { url: url.value, slug: slug.value || undefined });
          go(`#/import/${job.id}`);
        } catch (e) {
          showError(err, e);
        }
      });
    },
  },
  h('h2', null, 'Import a show'),
  h('p', { class: 'muted' }, 'Paste the feed address from your current host. Nothing changes there: your old feed keeps working until you set up a redirect.'),
  field('Current feed address', url),
  field('New feed address (optional)', slug, 'Lowercase letters, numbers and dashes. Leave blank to use the show’s title.'),
  h('p', { class: 'preview' }, h('b', null, 'Your new feed'), previewText),
  err,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Start import')));

  const { jobs } = await api('GET', '/api/imports');
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Import a show')),
    form,
    jobs.length ? h('div', { class: 'panel' }, h('h2', null, 'Recent imports'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Feed'), h('th', null, 'Status'), h('th', null, 'Started'))),
        h('tbody', null, jobs.map((j) => h('tr', null,
          h('td', null, h('a', { href: `#/import/${j.id}` }, j.sourceUrl)),
          h('td', null, h('span', { class: `pill ${j.status === 'failed' ? 'ended' : j.status === 'done' ? '' : 'pending'}` }, jobStatusText(j.status))),
          h('td', { class: 'nowrap' }, fmtDate(j.createdAt, true)))))))) : null);
}

const jobStatusText = (s) => ({ queued: 'Waiting', running: 'Importing', verifying: 'Needs verification', done: 'Finished', failed: 'Failed' })[s] ?? s;

async function viewImportJob(jobId) {
  const page = h('div', { class: 'page' });
  const draw = async () => {
    const { job } = await api('GET', `/api/imports/${jobId}`);
    if (job.status === 'verifying') {
      page.replaceChildren(verificationView(job));
      return job;
    }
    const p = job.progress ?? {};
    const stages = [
      ['fetching', 'Read the feed'],
      ['saving', `Save ${p.episodes ?? ''} episodes`.replace('  ', ' ')],
      ['media', p.mediaTotal ? `Copy files (${p.mediaDone ?? 0} of ${p.mediaTotal}${p.mediaBytes ? `, ${fmtBytes(p.mediaBytes)}` : ''})` : 'Copy files'],
      ['finishing', 'Point the feed at the copies'],
    ];
    const order = ['fetching', 'saving', 'media', 'finishing', 'done'];
    const at = job.status === 'done' ? 4 : order.indexOf(p.stage ?? 'fetching');
    const pct = job.status === 'done' ? 100 : p.mediaTotal ? Math.round(30 + 65 * ((p.mediaDone ?? 0) / p.mediaTotal)) : [5, 15, 30, 95][Math.max(0, at)] ?? 5;

    const failedHere = job.status === 'failed';
    page.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', null, job.status === 'done' ? 'Import finished' : failedHere ? 'Import stopped' : 'Importing…'),
        h('p', { class: 'muted', style: 'overflow-wrap:anywhere' }, job.sourceUrl)),
      h('div', { class: 'panel' },
        failedHere
          ? h('div', null, h('p', { class: 'error', role: 'alert' }, job.error), h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/import' }, 'Try another feed')))
          : h('div', null,
            h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Import progress' }, h('span', { style: `width:${pct}%` })),
            h('ul', { class: 'stages' }, stages.map(([key, text], i) =>
              h('li', null, h('span', { class: `light ${i < at ? 'on' : i === at && job.status !== 'done' ? 'warn' : ''}` }, text)))),
            job.status === 'done' && job.podcastId
              ? h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: `#/show/${job.podcastId}` }, 'Open the show'))
              : h('p', { class: 'hint', style: 'margin-top:16px' }, 'You can leave this page; the import keeps going.')),
        job.warnings?.length
          ? h('details', { style: 'margin-top:20px', open: job.status === 'done' && job.warnings.length < 6 },
            h('summary', null, `${job.warnings.length} note${job.warnings.length === 1 ? '' : 's'} from the import`),
            h('ul', { class: 'warnings' }, job.warnings.map((w) => h('li', null, w))))
          : null));
    return job;
  };

  const job = await draw();
  if (job.status === 'queued' || job.status === 'running') {
    const t = setInterval(async () => {
      try {
        const j = await draw();
        if (j.status === 'done' || j.status === 'failed' || j.status === 'verifying') {
          clearInterval(t);
          await refreshPodcasts();
          if (j.status !== 'failed') render();
        }
      } catch { /* keep polling */ }
    }, 1500);
    cleanup.push(() => clearInterval(t));
  }
  return page;
}

/** Step 2 of an import: prove you own the show (feed tag or emailed code). */
function verificationView(job) {
  const v = job.verification;
  const pv = job.preview ?? {};
  const reload = () => render();

  // Option A: tag in the feed
  const feedMsg = h('p', { class: 'hint', role: 'status' });
  const checkBtn = h('button', {
    type: 'button',
    class: 'primary',
    onclick: async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking…';
      feedMsg.className = 'hint';
      feedMsg.textContent = '';
      try {
        const r = await api('POST', `/api/imports/${job.id}/check-feed`);
        if (r.verified) {
          toast('Ownership confirmed. Importing now.');
          return reload();
        }
        feedMsg.className = 'error';
        feedMsg.textContent = r.message;
      } catch (e) {
        feedMsg.className = 'error';
        feedMsg.textContent = e.message;
      }
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check my feed now';
    },
  }, 'Check my feed now');

  const feedOption = h('section', { class: 'panel verify-option' },
    h('h2', null, 'Add a tag to your feed'),
    h('p', { class: 'muted' }, 'At your current host, add this to the show’s feed. Look for “custom RSS tags” or “channel tags” in the show settings.'),
    h('div', { class: 'codebox' }, h('code', null, v.tag),
      h('button', { type: 'button', onclick: () => copy(v.tag, 'Tag copied') }, 'Copy tag')),
    h('p', { class: 'hint' }, 'Host doesn’t allow custom tags? Paste just the code into the show’s description instead: ',
      h('code', { class: 'inline' }, v.token), ' ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); copy(v.token, 'Code copied'); } }, 'Copy code')),
    h('div', { class: 'actions' }, checkBtn),
    feedMsg,
    h('p', { class: 'hint' }, 'You can remove the tag or code once the import has finished.'));

  // Option B: emailed code
  const mailMsg = h('p', { class: 'hint', role: 'status' });
  const codeInput = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 9, placeholder: '123456', 'aria-label': 'Code from the email' });
  const codeForm = h('form', {
    class: 'row',
    hidden: !v.codeSent,
    onsubmit: (ev) => {
      ev.preventDefault();
      busy(codeForm, async () => {
        try {
          await api('POST', `/api/imports/${job.id}/verify-code`, { code: codeInput.value });
          toast('Ownership confirmed. Importing now.');
          reload();
        } catch (e) {
          mailMsg.className = 'error';
          mailMsg.textContent = e.message;
        }
      });
    },
  }, h('div', { style: 'flex:0 1 180px' }, codeInput), h('button', { class: 'primary', type: 'submit' }, 'Confirm code'));
  const sendBtn = h('button', {
    type: 'button',
    onclick: async () => {
      sendBtn.disabled = true;
      mailMsg.className = 'hint';
      mailMsg.textContent = 'Sending…';
      try {
        const r = await api('POST', `/api/imports/${job.id}/send-code`);
        mailMsg.textContent = `Code sent to ${r.sentTo}. It works for 30 minutes.`;
        codeForm.hidden = false;
        sendBtn.textContent = 'Send a new code';
        codeInput.focus();
      } catch (e) {
        mailMsg.className = 'error';
        mailMsg.textContent = e.message;
      }
      sendBtn.disabled = false;
    },
  }, v.codeSent ? 'Send a new code' : 'Email me a code');

  const emailOption = h('section', { class: 'panel verify-option' },
    h('h2', null, 'Get a code by email'),
    v.canEmail
      ? [
          h('p', { class: 'muted' }, `We’ll email a code to the owner address listed in the feed: ${pv.ownerEmail}.`),
          h('div', { class: 'actions' }, sendBtn),
          mailMsg,
          codeForm,
        ]
      : h('p', { class: 'muted' }, v.emailReason === 'no_owner_email'
        ? 'The feed doesn’t list an owner email (<itunes:owner>), so use the feed tag instead.'
        : 'Email isn’t set up on this site yet, so use the feed tag instead.'));

  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'Confirm you own this show'),
      h('p', { class: 'muted' }, 'Nothing has been copied yet. Prove the show is yours in one of these two ways, and the import continues by itself.')),
    h('div', { class: 'verify-preview' },
      artImg(pv.imageUrl, pv.title),
      h('div', null,
        h('h2', null, pv.title),
        h('p', { class: 'muted' }, [pv.author, `${pv.episodes} episode${pv.episodes === 1 ? '' : 's'}`].filter(Boolean).join(', ')),
        h('p', { class: 'hint', style: 'overflow-wrap:anywhere' }, job.sourceUrl))),
    h('div', { class: 'verify-options' }, feedOption, emailOption),
    h('div', { class: 'actions' },
      state.me.isAdmin ? h('button', {
        type: 'button',
        onclick: async () => {
          if (!confirm(`Skip verification for “${pv.title}”?\n\nOnly do this for shows you manage or have permission to move.`)) return;
          await api('POST', `/api/imports/${job.id}/skip-verification`);
          toast('Verification skipped. Importing now.');
          reload();
        },
      }, 'Skip: I manage this show') : null,
      h('button', {
        type: 'button',
        class: 'quiet',
        onclick: async () => {
          if (!confirm('Cancel this import?')) return;
          await api('POST', `/api/imports/${job.id}/cancel`);
          toast('Import cancelled');
          go('#/import');
        },
      }, 'Cancel import')),
    h('p', { class: 'hint' }, `This request stays open for ${v.expiresInDays} days. You can leave and come back from Import a show.`));
}

// ───────────── show page ─────────────

const TABS = [
  ['overview', 'Overview'],
  ['details', 'Show details'],
  ['episodes', 'Episodes'],
  ['settings', 'Settings'],
];
/** Old tab addresses → where that content lives now. */
const MOVED_TABS = { podping: ['settings', 'podping'], prefixes: ['settings', 'prefixes'], team: ['settings', 'team'], live: ['episodes', 'live'] };

async function viewShow(id, tab, sub) {
  const { podcast: p } = await api('GET', `/api/podcasts/${id}`);
  const canEdit = p.role !== 'viewer';
  const body = h('div');
  const reload = () => render();
  const showOverview = !p.setup?.overviewHidden;
  let jumpTo = null;
  if (MOVED_TABS[tab]) [tab, jumpTo] = MOVED_TABS[tab];
  if (!tab) tab = showOverview ? 'overview' : 'episodes';

  const views = { overview: tabOverview, episodes: tabEpisodes, details: tabDetails, settings: tabSettings };
  if (tab === 'episodes' && sub) body.append(await viewEpisode(p, canEdit, sub));
  else body.append(await (views[tab] ?? tabOverview)(p, canEdit, reload));
  if (jumpTo) requestAnimationFrame(() => document.getElementById(`section-${jumpTo}`)?.scrollIntoView({ block: 'start' }));

  return h('div', { class: 'page' },
    h('header', { class: 'strip' },
      artImg(p.imageUrl, p.title),
      h('div', null,
        h('h1', null, p.title),
        p.author ? h('p', { class: 'by' }, p.author) : h('div', { style: 'height:12px' }),
        h('div', { class: 'feedline' },
          h('code', null, p.feedUrl),
          h('button', { type: 'button', onclick: () => copy(p.feedUrl, 'Feed address copied') }, 'Copy feed address')))),
    h('div', { class: 'lights', role: 'list', 'aria-label': 'Show status' },
      showLights(p).map((l) => h('span', { class: `light ${l.cls}`, role: 'listitem' }, l.text))),
    h('nav', { class: 'tabs', 'aria-label': 'Show sections' },
      TABS.filter(([k]) => k !== 'overview' || showOverview || tab === 'overview').map(([k, label]) =>
        h('a', { href: `#/show/${id}/${k}`, 'aria-current': k === tab ? 'page' : null }, label))),
    body);
}

// Overview: the move checklist + facts
async function tabOverview(p, canEdit, reload) {
  const parts = [];
  if (p.setup?.done && p.setup.overviewHidesAt) {
    const hides = new Date(p.setup.overviewHidesAt);
    parts.push(h('section', { class: 'panel setup-done' },
      h('h2', null, 'Setup is complete'),
      p.setup.overviewHidden
        ? h('p', { class: 'muted' }, 'This tab is hidden now that setup is done. Show facts are under Settings.')
        : h('p', { class: 'muted' }, `This tab hides on ${fmtDate(hides)}, 7 days after the last step was finished. Show facts and the feed address are always under Settings.`)));
  }
  if (p.sourceFeedUrl) {
    const m = p.media;
    const mediaDone = p.status === 'active' && !m.pending;
    const redirectOk = p.redirect?.status === 'ok';
    const podpingOn = p.podping.enabled;

    const checkErr = formError();
    const checkBtn = h('button', {
      type: 'button',
      disabled: !canEdit,
      onclick: async () => {
        checkErr.hidden = true;
        checkBtn.disabled = true;
        checkBtn.textContent = 'Checking…';
        try {
          await api('POST', `/api/podcasts/${p.id}/redirect-check`);
          await refreshPodcasts();
          reload();
        } catch (e) {
          showError(checkErr, e);
          checkBtn.disabled = false;
          checkBtn.textContent = 'Check the redirect';
        }
      },
    }, 'Check the redirect');

    parts.push(h('section', { class: 'panel' },
      h('h2', null, redirectOk && podpingOn ? 'This show has moved' : 'Finish moving this show'),
      h('p', { class: 'muted' }, redirectOk && podpingOn
        ? 'Apps that follow the old feed are being sent here, and new episodes are announced through Podping.'
        : 'Your old feed keeps working until you redirect it. Work through these in order.'),
      h('ol', { class: 'steps' },
        h('li', { class: mediaDone && !m.failed ? 'done' : 'attention' },
          h('div', null,
            h('h3', null, 'Copy the media'),
            h('p', { class: 'muted' },
              p.status === 'importing' ? 'Files are still being copied.'
                : `${m.done} files copied (${fmtBytes(m.bytes)}).` +
                (m.failed ? ` ${m.failed} couldn’t be copied and still load from the old host; the import notes list them.` : '')))),
        h('li', { class: redirectOk ? 'done' : p.redirect?.status ? 'attention' : '' },
          h('div', null,
            h('h3', null, 'Redirect the old feed here'),
            h('p', { class: 'muted' }, 'At your old host, set a permanent (301) redirect from your old feed to the new one. Apple Podcasts and other apps then move your subscribers automatically.'),
            h('dl', { class: 'facts', style: 'margin:12px 0' },
              h('dt', null, 'From'), h('dd', null, p.sourceFeedUrl),
              h('dt', null, 'To'), h('dd', null, p.feedUrl)),
            p.redirect?.detail ? h('p', { class: redirectOk ? 'muted' : 'error' }, p.redirect.detail,
              p.redirect.checkedAt ? h('span', { class: 'hint' }, ` Checked ${fmtDate(p.redirect.checkedAt, true)}.`) : null) : null,
            checkErr,
            h('div', { class: 'actions', style: 'margin-top:8px' },
              h('button', { type: 'button', onclick: () => copy(p.feedUrl, 'New feed address copied') }, 'Copy new address'),
              checkBtn))),
        h('li', { class: podpingOn ? 'done' : '' },
          h('div', null,
            h('h3', null, 'Turn on Podping'),
            h('p', { class: 'muted' }, 'Once the redirect is in place, Podping tells apps the moment you publish.'),
            h('a', { class: 'btn', href: `#/show/${p.id}/podping` }, 'Podping settings'))))));
  }

  if (!p.sourceFeedUrl && canEdit) {
    const { checklist } = await api('GET', `/api/podcasts/${p.id}/details`);
    if (checklist.length) {
      parts.push(checklistPanel(checklist, h('div', { class: 'actions' },
        h('a', { class: 'btn primary', href: `#/show/${p.id}/details` }, 'Edit show details'),
        h('a', { class: 'btn', href: `#/show/${p.id}/episodes/new` }, 'New episode'))));
    }
  }

  // Import notes for this show
  const { jobs } = await api('GET', '/api/imports');
  const job = jobs.find((j) => j.podcastId === p.id && j.status === 'done');
  if (job?.warnings?.length) {
    parts.push(h('section', { class: 'panel' },
      h('details', null, h('summary', null, `${job.warnings.length} note${job.warnings.length === 1 ? '' : 's'} from the import`),
        h('ul', { class: 'warnings' }, job.warnings.map((w) => h('li', null, w))))));
  }
  return h('div', null, parts);
}

// ───────────── uploads ─────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Name to show for a stored file: the last part of its address, without our 8-character prefix. */
function fileLabel(url, name) {
  if (name) return name.replace(/^[0-9a-f]{8,10}-/, '');
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url).replace(/^[0-9a-f]{8,10}-/, '');
  } catch {
    return url;
  }
}

/**
 * Upload a file in chunks of a few MB. Cloudflare Tunnel limits a single request to 100 MB,
 * and chunks let a dropped connection pick up where it stopped. Returns the stored file.
 */
async function uploadFile(podcastId, file, kind, { onProgress, signal } = {}) {
  const { upload } = await api('POST', `/api/podcasts/${podcastId}/uploads`, { filename: file.name, size: file.size, kind });
  const base = `/api/podcasts/${podcastId}/uploads/${upload.id}`;
  let offset = upload.received;
  try {
    while (offset < file.size) {
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      const end = Math.min(file.size, offset + upload.chunkSize);
      for (let attempt = 1; ; attempt++) {
        let res = null;
        let data = null;
        try {
          res = await fetch(`${base}?offset=${offset}`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file.slice(offset, end),
            signal,
          });
          data = await res.json().catch(() => null);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
        }
        if (res?.ok || (res?.status === 409 && typeof data?.received === 'number')) {
          offset = data.received;
          break;
        }
        if (res && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw new ApiError(res.status, data?.error ?? `Upload failed (${res.status})`);
        }
        if (attempt >= 6) throw new Error('The connection keeps dropping. Check your internet connection, then try again.');
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
      onProgress?.(offset / file.size);
    }
    return (await api('POST', `${base}/complete`)).media;
  } catch (e) {
    if (e.name === 'AbortError') api('DELETE', base).catch(() => {});
    throw e;
  }
}

/**
 * "Choose file" button with progress and cancel. `dropTarget` (optional) also accepts a dragged file.
 * Calls onDone(media) when the file is stored.
 */
function uploader({ podcastId, kind, accept, label, onDone, onStart, dropTarget, primary = false }) {
  const input = h('input', { type: 'file', accept, hidden: true });
  const pick = h('button', { type: 'button', class: primary ? 'primary' : '', onclick: () => input.click() }, label);
  const bar = h('span');
  const meter = h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Upload progress' }, bar);
  const what = h('span', { class: 'hint' });
  const cancel = h('button', { type: 'button', class: 'quiet' }, 'Cancel');
  const progress = h('div', { class: 'upload-progress', hidden: true }, meter, h('div', { class: 'upload-line' }, what, cancel));
  const err = formError();
  let ctrl = null;

  async function start(file) {
    if (!file || ctrl) return;
    err.hidden = true;
    ctrl = new AbortController();
    pick.disabled = true;
    progress.hidden = false;
    const set = (f) => {
      const pct = Math.floor(f * 100);
      bar.style.width = `${pct}%`;
      meter.setAttribute('aria-valuenow', pct);
      what.textContent = f < 1 ? `Uploading ${file.name}: ${pct}% of ${fmtBytes(file.size)}` : `Checking ${file.name}…`;
    };
    set(0);
    onStart?.();
    try {
      const media = await uploadFile(podcastId, file, kind, { onProgress: set, signal: ctrl.signal });
      onDone(media);
    } catch (e) {
      if (e.name !== 'AbortError') showError(err, e);
    } finally {
      ctrl = null;
      pick.disabled = false;
      progress.hidden = true;
      input.value = '';
    }
  }
  input.addEventListener('change', () => start(input.files[0]));
  cancel.addEventListener('click', () => ctrl?.abort());
  if (dropTarget) {
    dropTarget.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      dropTarget.classList.add('over');
    });
    dropTarget.addEventListener('dragleave', () => dropTarget.classList.remove('over'));
    dropTarget.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dropTarget.classList.remove('over');
      start(ev.dataTransfer.files[0]);
    });
  }
  return { button: pick, el: h('div', { class: 'uploader' }, input, progress, err), busy: () => !!ctrl };
}

// ───────────── episodes list ─────────────

function episodeState(e) {
  if (e.status === 'draft') return h('span', { class: 'pill draft' }, 'Draft');
  if (!e.inFeed) return h('span', { class: 'pill scheduled' }, `Scheduled ${fmtDate(e.pub_date ?? e.pubDate, true)}`);
  return null;
}

const PAGE_SIZES = [10, 25, 50, 0]; // 0 = all
const pageMemory = {}; // podcastId → page, so returning from the editor lands on the same page

function savedPageSize() {
  try {
    const v = localStorage.getItem('fh.episodesPerPage');
    if (v !== null && PAGE_SIZES.includes(Number(v))) return Number(v);
  } catch { /* storage unavailable: use the default */ }
  return 10;
}
function savePageSize(n) {
  try { localStorage.setItem('fh.episodesPerPage', String(n)); } catch { /* ignore */ }
}

/** Page numbers to show: first, last, and two either side of the current one, with gaps as null. */
function pageList(current, total) {
  const keep = new Set([1, total, current - 2, current - 1, current, current + 1, current + 2].filter((n) => n >= 1 && n <= total));
  const out = [];
  let last = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - last > 1) out.push(null);
    out.push(n);
    last = n;
  }
  return out;
}

function episodeRow(p, e) {
  return h('tr', null,
    h('td', null,
      h('a', { class: 'ep-title', href: `#/show/${p.id}/episodes/${e.id}` }, e.title || 'Untitled'),
      ' ', episodeState(e),
      h('div', { class: 'hint' }, [
        e.itunes_season ? `Season ${e.itunes_season}` : null,
        e.itunes_episode ? `Episode ${e.itunes_episode}` : null,
        e.itunes_episode_type && e.itunes_episode_type !== 'full' ? e.itunes_episode_type[0].toUpperCase() + e.itunes_episode_type.slice(1) : null,
        e.hasTranscript ? 'Transcript' : null,
        e.hasChapters ? 'Chapters' : null,
        !e.enclosure_url ? 'No audio yet' : null,
      ].filter(Boolean).join(' · '))),
    h('td', { class: 'nowrap' }, e.status === 'draft' ? '—' : fmtDate(e.pub_date)),
    h('td', { class: 'num' }, fmtDuration(e.itunes_duration)),
    h('td', { class: 'num nowrap' }, e.enclosure_length ? fmtBytes(Number(e.enclosure_length)) : '—'));
}

async function tabEpisodes(p, canEdit) {
  const { episodes } = await api('GET', `/api/podcasts/${p.id}/episodes`);
  const newBtn = canEdit ? h('a', { class: 'btn primary', href: `#/show/${p.id}/episodes/new` }, 'New episode') : null;
  const live = h('div', { id: 'section-live', class: 'settings-section' }, await tabLive(p, canEdit, () => render()));
  // Something on air or coming up goes first, so Go live / End is right there.
  const liveFirst = p.live.now || p.live.upcoming;
  if (!episodes.length) {
    return h('div', null,
      liveFirst ? live : null,
      h('div', { class: 'section-head' }, h('p', { class: 'muted' }, 'No episodes yet.'), newBtn),
      h('div', { class: 'panel' },
        h('h2', null, 'Publish your first episode'),
        h('p', { class: 'muted' }, 'Upload the audio, give it a title and description, and publish it now or schedule it for later.'),
        canEdit ? h('a', { class: 'btn primary', href: `#/show/${p.id}/episodes/new` }, 'New episode') : null),
      liveFirst ? null : live);
  }

  let size = savedPageSize();
  let page = pageMemory[p.id] ?? 1;
  const tbody = h('tbody');
  const count = h('p', { class: 'muted', 'aria-live': 'polite' });
  const sizes = h('div', { class: 'page-sizes', role: 'group', 'aria-label': 'Episodes per page' });
  const pager = h('nav', { class: 'pager', 'aria-label': 'Episode pages' });
  const table = h('table', { class: 'episodes' },
    h('thead', null, h('tr', null,
      h('th', null, 'Episode'), h('th', null, 'Published'), h('th', { class: 'num' }, 'Length'), h('th', { class: 'num' }, 'Size'))),
    tbody);

  function draw(scroll) {
    const pages = size ? Math.max(1, Math.ceil(episodes.length / size)) : 1;
    page = Math.min(Math.max(1, page), pages);
    pageMemory[p.id] = page;
    const from = size ? (page - 1) * size : 0;
    const shown = size ? episodes.slice(from, from + size) : episodes;
    tbody.replaceChildren(...shown.map((e) => episodeRow(p, e)));

    const n = episodes.length;
    count.textContent = (size && n > size ? `Showing ${from + 1}–${from + shown.length} of ${n} episodes.` : `${n} episode${n === 1 ? '' : 's'}.`) +
      ' Drafts and scheduled episodes aren’t in the feed yet.';

    sizes.replaceChildren(h('span', { class: 'hint' }, 'Per page'), ...PAGE_SIZES.map((sz) => h('button', {
      type: 'button',
      'aria-pressed': String(sz === size),
      onclick: () => {
        // Keep the first episode on screen in view when the page size changes.
        size = sz;
        page = sz ? Math.floor(from / sz) + 1 : 1;
        savePageSize(sz);
        draw();
      },
    }, sz ? String(sz) : 'All')));

    const goTo = (n2) => {
      page = n2;
      draw(true);
    };
    pager.hidden = pages <= 1;
    pager.replaceChildren(
      h('button', { type: 'button', disabled: page === 1, onclick: () => goTo(page - 1) }, '‹ Previous'),
      h('div', { class: 'pages' }, pageList(page, pages).map((n2) => n2 === null
        ? h('span', { class: 'gap', 'aria-hidden': 'true' }, '…')
        : h('button', { type: 'button', 'aria-current': n2 === page ? 'page' : null, 'aria-label': `Page ${n2}`, onclick: () => goTo(n2) }, String(n2)))),
      h('button', { type: 'button', disabled: page === pages, onclick: () => goTo(page + 1) }, 'Next ›'));
    if (scroll) table.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  draw();

  return h('div', null,
    liveFirst ? live : null,
    h('div', { class: 'section-head' }, count, newBtn),
    h('div', { class: 'list-tools' }, sizes),
    h('div', { class: 'panel', style: 'padding:0' }, h('div', { class: 'table-wrap' }, table)),
    pager,
    liveFirst ? null : live);
}

// ───────────── people (<podcast:person>) ─────────────

const roleKey = (group, role) => `${group.toLowerCase()}|${role.toLowerCase()}`;

/** Role picker grouped by the Podcast Taxonomy. Picking a role sets its group too. */
function roleSelect(taxonomy, person) {
  const sel = h('select', { 'aria-label': 'Role' });
  for (const [group, roles] of Object.entries(taxonomy)) {
    sel.append(h('optgroup', { label: group }, roles.map((r) => h('option', { value: roleKey(group, r) }, r))));
  }
  // A missing role means host; a missing group means cast (or wherever the role lives).
  const role = (person.role ?? 'host').toLowerCase();
  let group = person.group?.toLowerCase();
  if (!group) group = Object.entries(taxonomy).find(([, rs]) => rs.some((r) => r.toLowerCase() === role))?.[0].toLowerCase() ?? 'cast';
  const key = `${group}|${role}`;
  if (![...sel.options].some((o) => o.value === key)) {
    sel.prepend(h('option', { value: key }, `${person.role ?? 'host'} (${person.group ?? 'cast'})`));
  }
  sel.value = key;
  return sel;
}

/**
 * Editable list of people: name, role, photo, link; reorder and remove.
 * `list` is changed in place; onChange is called after every edit.
 */
function peopleEditor({ podcastId, taxonomy, list, onChange, onUpload }) {
  const wrap = h('div', { class: 'people' });
  const rows = h('div', { class: 'people-list' });
  const changed = () => onChange?.();

  function draw() {
    rows.replaceChildren(...list.map((person, i) => {
      const name = h('input', { type: 'text', value: person.name, placeholder: 'Name', 'aria-label': 'Name', maxlength: 128, required: true });
      name.addEventListener('input', () => { person.name = name.value; changed(); });
      const role = roleSelect(taxonomy, person);
      role.addEventListener('change', () => {
        const [g, r] = role.value.split('|');
        person.group = g;
        person.role = r;
        changed();
      });
      const href = h('input', { type: 'url', value: person.href ?? '', placeholder: 'Link (website or profile)', 'aria-label': 'Link' });
      href.addEventListener('input', () => { person.href = href.value || null; changed(); });

      const photo = uploader({
        podcastId,
        kind: 'image',
        accept: '.jpg,.jpeg,.png,.webp,image/*',
        label: person.img ? 'Change photo' : 'Add photo',
        onDone: (m) => {
          person.img = m.url;
          person.imgRef = { mediaId: m.id };
          onUpload?.(m);
          changed();
          draw();
        },
      });
      const move = (d) => {
        list.splice(i + d, 0, list.splice(i, 1)[0]);
        changed();
        draw();
      };
      return h('div', { class: 'person' },
        artImg(person.img, person.name || '?', 'avatar'),
        h('div', { class: 'person-fields' }, name, role, href),
        h('div', { class: 'person-actions' },
          photo.button,
          person.img ? h('button', { type: 'button', class: 'quiet', onclick: () => { person.img = null; person.imgRef = null; changed(); draw(); } }, 'Remove photo') : null,
          h('button', { type: 'button', class: 'quiet', 'aria-label': `Move ${person.name || 'person'} up`, disabled: i === 0, onclick: () => move(-1) }, '↑'),
          h('button', { type: 'button', class: 'quiet', 'aria-label': `Move ${person.name || 'person'} down`, disabled: i === list.length - 1, onclick: () => move(1) }, '↓'),
          h('button', { type: 'button', class: 'quiet danger', onclick: () => { list.splice(i, 1); changed(); draw(); } }, 'Remove')),
        photo.el);
    }));
    if (!list.length) rows.append(h('p', { class: 'hint' }, 'No one listed yet.'));
  }
  draw();
  const add = h('button', {
    type: 'button',
    onclick: () => {
      list.push({ name: '', role: 'host', group: 'cast', img: null, imgRef: null, href: null });
      changed();
      draw();
      rows.querySelector('.person:last-child input')?.focus();
    },
  }, 'Add person');
  wrap.append(rows, h('div', { class: 'actions', style: 'margin-top:8px' }, add));
  return { el: wrap, redraw: draw };
}

/** People as the editor holds them → what the API takes. Existing photos are sent by address. */
const peoplePayload = (list) => list.map((p) => ({
  name: p.name, role: p.role, group: p.group, href: p.href || null, img: p.imgRef ?? (p.img ? { url: p.img } : null),
}));
const editablePeople = (people) => people.map((p) => ({ ...p, imgRef: null }));

function peopleSummary(people) {
  if (!people.length) return h('p', { class: 'hint' }, 'The show has no people listed. Add them on the Show details tab.');
  return h('ul', { class: 'people-chips' }, people.map((p) =>
    h('li', null, artImg(p.img, p.name, 'avatar'), h('span', null, h('b', null, p.name), h('small', null, p.role ?? 'host')))));
}

// ───────────── locations (<podcast:location>) ─────────────

const REL_TEXT = { subject: 'What it’s about', creator: 'Where it was made' };

/**
 * Locations list with an OpenStreetMap lookup that fills in coordinates, the OSM ID and country.
 * `list` is changed in place.
 */
function locationsEditor({ list, onChange, defaultRel }) {
  const changed = () => onChange?.();
  const rows = h('div', { class: 'locations-list' });
  const q = h('input', { type: 'search', placeholder: 'Search for a place, e.g. Johns Creek, GA', 'aria-label': 'Search for a place' });
  const find = h('button', { type: 'button' }, 'Look up');
  const results = h('ul', { class: 'place-results', hidden: true });
  const err = formError();

  async function search() {
    if (!q.value.trim()) return q.focus();
    err.hidden = true;
    find.disabled = true;
    find.textContent = 'Looking…';
    try {
      const { places } = await api('GET', `/api/places?q=${encodeURIComponent(q.value)}`);
      results.replaceChildren(...(places.length ? places.map((pl) => h('li', null, h('button', {
        type: 'button',
        class: 'quiet',
        onclick: () => {
          list.push({ name: pl.name, rel: defaultRel, geo: pl.geo, osm: pl.osm, country: pl.country });
          results.hidden = true;
          q.value = '';
          changed();
          draw();
        },
      }, h('b', null, pl.name), h('span', { class: 'hint' }, pl.label)))) : [h('li', { class: 'hint' }, 'Nothing found. Try adding the city or country.')]));
      results.hidden = false;
    } catch (e) {
      showError(err, e);
    } finally {
      find.disabled = false;
      find.textContent = 'Look up';
    }
  }
  find.addEventListener('click', search);
  q.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault(); // don't submit the whole form
      search();
    }
  });

  function draw() {
    rows.replaceChildren(...list.map((loc, i) => {
      const input = (key, attrs) => {
        const el = h('input', { type: 'text', value: loc[key] ?? '', ...attrs });
        el.addEventListener('input', () => { loc[key] = el.value.trim() || null; if (key === 'name') loc.name = el.value; changed(); });
        return el;
      };
      const rel = h('select', { 'aria-label': 'Type' }, Object.entries(REL_TEXT).map(([v, t]) => h('option', { value: v }, t)));
      rel.value = loc.rel ?? 'subject';
      rel.addEventListener('change', () => { loc.rel = rel.value; changed(); });
      const [lat, lon] = /^geo:(-?[\d.]+),(-?[\d.]+)/i.exec(loc.geo ?? '')?.slice(1) ?? [];
      return h('div', { class: 'location' },
        h('div', { class: 'location-main' },
          input('name', { placeholder: 'Place name, as listeners should see it', 'aria-label': 'Place name', maxlength: 128 }),
          rel,
          h('button', { type: 'button', class: 'quiet danger', onclick: () => { list.splice(i, 1); changed(); draw(); } }, 'Remove')),
        h('div', { class: 'location-codes' },
          h('label', null, 'Coordinates', input('geo', { placeholder: 'geo:34.0289,-84.1986' })),
          h('label', null, 'OpenStreetMap ID', input('osm', { placeholder: 'R119557' })),
          h('label', null, 'Country', input('country', { placeholder: 'US', maxlength: 2 })),
          lat ? h('a', { href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}`, target: '_blank', rel: 'noopener' }, 'View map') : null));
    }));
    if (!list.length) rows.append(h('p', { class: 'hint' }, 'No locations.'));
  }
  draw();
  const add = h('button', { type: 'button', class: 'quiet', onclick: () => { list.push({ name: '', rel: defaultRel, geo: null, osm: null, country: null }); changed(); draw(); rows.querySelector('.location:last-child input')?.focus(); } }, 'Add one by hand');
  return h('div', { class: 'locations' },
    h('div', { class: 'place-search' }, q, find),
    err, results, rows,
    h('div', { class: 'actions', style: 'margin-top:4px' }, add));
}

const locationsPayload = (list) => {
  if (list.some((l) => !l.name?.trim())) throw new Error('Every location needs a name.');
  return list.map((l) => ({ name: l.name, rel: l.rel, geo: l.geo, osm: l.osm, country: l.country }));
};

// ───────────── Podcasting 2.0 tag forms ─────────────

/** A small list editor: rows built by makeRow(item, index, redraw); add() returns a new item. */
function rowList({ list, makeRow, addLabel, add, empty, onChange }) {
  const rows = h('div', { class: 'tag-rows' });
  const changed = () => onChange?.();
  function draw() {
    rows.replaceChildren(...list.map((item, i) => {
      const remove = h('button', { type: 'button', class: 'quiet danger', onclick: () => { list.splice(i, 1); changed(); draw(); } }, 'Remove');
      return h('div', { class: 'tag-row' }, makeRow(item, i, changed, draw), h('div', { class: 'tag-row-end' }, remove));
    }));
    if (!list.length && empty) rows.append(h('p', { class: 'hint' }, empty));
  }
  draw();
  const addBtn = add ? h('button', { type: 'button', onclick: () => { list.push(add()); changed(); draw(); rows.querySelector('.tag-row:last-child input')?.focus(); } }, addLabel) : null;
  return { el: h('div', null, rows, addBtn ? h('div', { class: 'actions', style: 'margin-top:8px' }, addBtn) : null), redraw: draw };
}

const bound = (obj, key, attrs = {}) => {
  const el = h('input', { type: 'text', value: obj[key] ?? '', ...attrs });
  el.addEventListener('input', () => { obj[key] = el.value; el.dispatchEvent(new CustomEvent('fieldchange', { bubbles: true })); });
  return el;
};

// ── Value for value (podcast:value) ──

const sats = (btc) => {
  const n = Number(btc);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e8) : null;
};

function valueEditor({ blocks, onChange }) {
  const wrap = h('div', { class: 'value-editor' });
  const changed = () => onChange?.();
  wrap.addEventListener('fieldchange', changed);

  function draw() {
    wrap.replaceChildren(...blocks.map((b, bi) => {
      const method = h('select', { 'aria-label': 'Payment method' },
        h('option', { value: 'keysend' }, 'Keysend (node and Lightning addresses)'),
        h('option', { value: 'lnaddress' }, 'Lightning address'));
      if (![...method.options].some((o) => o.value === b.method)) method.prepend(h('option', { value: b.method }, b.method));
      method.value = b.method;
      method.addEventListener('change', () => { b.method = method.value; changed(); });
      const suggested = bound(b, 'suggested', { inputmode: 'decimal', placeholder: '0.00000005000', 'aria-label': 'Suggested amount' });
      const satsNote = h('p', { class: 'hint' });
      const noteSats = () => { const s = sats(b.suggested); satsNote.textContent = s ? `About ${s.toLocaleString()} sats per payment.` : 'Optional. In bitcoin: 0.00000005 is 5 sats.'; };
      suggested.addEventListener('input', noteSats);
      noteSats();

      const total = h('p', { class: 'hint value-total' });
      const pctCells = [];
      const updatePct = () => {
        const sum = b.recipients.reduce((t, r) => t + (Number(r.split) || 0), 0);
        b.recipients.forEach((r, i) => { if (pctCells[i]) pctCells[i].textContent = sum ? `${Math.round(((Number(r.split) || 0) / sum) * 1000) / 10}%` : '—'; });
        total.textContent = `Splits are shares: each recipient gets their split ÷ ${sum || 0} of every payment.`;
      };
      const recipients = rowList({
        list: b.recipients,
        addLabel: 'Add recipient',
        add: () => ({ name: '', type: 'lnaddress', address: '', split: 0, fee: false, customKey: null, customValue: null }),
        onChange: () => { changed(); updatePct(); },
        empty: 'No recipients yet. Add the people who should receive payments.',
        makeRow: (r, i, rowChanged, redraw) => {
          const type = h('select', { 'aria-label': 'Address type' }, h('option', { value: 'lnaddress' }, 'Lightning address'), h('option', { value: 'node' }, 'Node pubkey'));
          if (![...type.options].some((o) => o.value === r.type)) type.prepend(h('option', { value: r.type }, r.type));
          type.value = r.type;
          const address = bound(r, 'address', { placeholder: r.type === 'node' ? '03ae9f91a0cb8ff43840e3c322c4c61f…' : 'name@getalby.com', 'aria-label': 'Address' });
          type.addEventListener('change', () => { r.type = type.value; address.placeholder = r.type === 'node' ? '03ae9f91a0cb8ff43840e3c322c4c61f…' : 'name@getalby.com'; rowChanged(); });
          const split = h('input', { type: 'text', inputmode: 'numeric', value: r.split ?? '', 'aria-label': 'Split (shares)', class: 'short' });
          split.addEventListener('input', () => { r.split = split.value === '' ? '' : Number(split.value); rowChanged(); });
          const pct = h('span', { class: 'pct' });
          pctCells[i] = pct;
          const fee = h('input', { type: 'checkbox', checked: r.fee });
          fee.addEventListener('change', () => { r.fee = fee.checked; rowChanged(); });
          const more = h('details', { class: 'more', open: r.customKey || r.customValue ? true : null }, h('summary', null, 'Custom record'),
            h('div', { class: 'row' },
              h('div', { class: 'field' }, h('label', null, 'Custom key'), bound(r, 'customKey', { placeholder: '696969' })),
              h('div', { class: 'field' }, h('label', null, 'Custom value'), bound(r, 'customValue', { placeholder: 'Optional' }))),
            h('p', { class: 'hint' }, 'Only if the recipient’s wallet asks for one (some node and Lightning address setups do).'));
          return h('div', { class: 'recipient' },
            h('div', { class: 'recipient-main' }, bound(r, 'name', { placeholder: 'Name', 'aria-label': 'Name' }), type, address,
              h('label', { class: 'split' }, split, pct), h('label', { class: 'check small' }, fee, 'Fee')),
            more);
        },
      });
      updatePct();

      const other = h('textarea', { class: 'code', rows: 3, spellcheck: 'false' }, b.other ?? '');
      other.addEventListener('input', () => { b.other = other.value; changed(); });
      return h('div', { class: 'value-block' },
        blocks.length > 1 ? h('h3', { class: 'sub' }, `Value block ${bi + 1}`) : null,
        h('div', { class: 'row' }, field('Method', method), h('div', { class: 'field' }, h('label', null, 'Suggested amount (BTC)'), suggested, satsNote)),
        h('h3', { class: 'sub' }, 'Recipients'),
        recipients.el,
        total,
        h('details', { class: 'more', open: b.other ? true : null }, h('summary', null, 'Time splits and other tags in this block'),
          h('div', { class: 'field', style: 'margin-top:8px' }, other,
            h('p', { class: 'hint' }, 'Advanced, as XML. For example a ', h('code', { class: 'inline' }, '<podcast:valueTimeSplit>'), ' that sends part of the payments to a song or guest during part of the episode.'))),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'quiet danger', onclick: () => { if (!confirm('Remove this value block and all its recipients?')) return; blocks.splice(bi, 1); changed(); draw(); } }, 'Remove value block')));
    }));
    if (!blocks.length) {
      wrap.append(h('p', { class: 'hint' }, 'Not set up. Listeners using Podcasting 2.0 apps can stream sats to you while they listen.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => { blocks.push(blankValue()); changed(); draw(); } }, 'Set up value for value')));
    }
  }
  draw();
  return { el: wrap, redraw: draw };
}

const blankValue = () => ({ type: 'lightning', method: 'keysend', suggested: '0.00000005000', recipients: [{ name: '', type: 'lnaddress', address: '', split: 100, fee: false, customKey: null, customValue: null }], other: '' });
const copyValue = (blocks) => JSON.parse(JSON.stringify(blocks));
const valuePayload = (blocks) => blocks.map((b) => ({
  type: b.type, method: b.method, suggested: b.suggested || null, other: b.other || '',
  recipients: b.recipients.map((r) => ({ name: r.name || null, type: r.type, address: (r.address || '').trim(), split: r.split === '' ? null : Number(r.split), fee: !!r.fee, customKey: r.customKey || null, customValue: r.customValue || null })),
}));

function valueSummary(blocks) {
  if (!blocks.length) return h('p', { class: 'hint' }, 'The show has no value split set up. Add one on the Show details tab.');
  return h('ul', { class: 'plain-list' }, blocks.flatMap((b) => b.recipients.map((r) => {
    const sum = b.recipients.reduce((t, x) => t + (Number(x.split) || 0), 0);
    return h('li', null, h('b', null, r.name || r.address), h('span', { class: 'hint' }, ` · ${sum ? Math.round((r.split / sum) * 1000) / 10 : 0}%${r.fee ? ' (fee)' : ''}`));
  })));
}

// ── Funding ──

function fundingEditor({ list, onChange }) {
  return rowList({
    list, onChange, addLabel: 'Add a support link', empty: 'No support links.',
    add: () => ({ url: '', label: '' }),
    makeRow: (f, i, changed) => {
      const label = bound(f, 'label', { placeholder: 'Support the show', maxlength: 128, 'aria-label': 'Link text' });
      const url = bound(f, 'url', { type: 'url', placeholder: 'https://…', 'aria-label': 'Link address' });
      [label, url].forEach((el) => el.addEventListener('input', changed));
      return h('div', { class: 'pair' }, label, url);
    },
  });
}

// ── Recommended shows (podcast:podroll) ──

function podrollEditor({ list, onChange }) {
  const changed = () => onChange?.();
  const url = h('input', { type: 'url', placeholder: 'Paste a show’s feed address', 'aria-label': 'Feed address of a show to recommend' });
  const find = h('button', { type: 'button' }, 'Add show');
  const err = formError();
  const rows = rowList({
    list, onChange, empty: 'No recommended shows.',
    makeRow: (r) => h('div', { class: 'remote' },
      h('b', null, r.title || r.feedUrl || `Show ${r.feedGuid}`),
      h('div', { class: 'hint' }, [r.title && r.feedUrl ? r.feedUrl : null, r.title || r.feedUrl ? `GUID ${r.feedGuid}` : 'No feed address saved, so its name can’t be shown'].filter(Boolean).join(' · '))),
  });
  // Show names for saved entries that have a feed address (titles aren't stored in the feed).
  (async () => {
    let found = false;
    for (const r of list.filter((x) => x.feedUrl && !x.title).slice(0, 20)) {
      try {
        r.title = (await api('GET', `/api/feed-lookup?url=${encodeURIComponent(r.feedUrl)}`)).show.title;
        found = true;
      } catch { /* leave the address showing */ }
    }
    if (found) rows.redraw();
  })();
  async function add() {
    if (!url.value.trim()) return url.focus();
    err.hidden = true;
    find.disabled = true;
    find.textContent = 'Looking…';
    try {
      const { show } = await api('GET', `/api/feed-lookup?url=${encodeURIComponent(url.value.trim())}`);
      if (list.some((x) => x.feedGuid === show.feedGuid)) throw new Error(`${show.title ?? 'That show'} is already on the list.`);
      list.push({ feedGuid: show.feedGuid, feedUrl: show.feedUrl, title: show.title, medium: null });
      url.value = '';
      changed();
      rows.redraw();
      toast(`Added ${show.title ?? 'the show'}`);
    } catch (e) {
      showError(err, e);
    } finally {
      find.disabled = false;
      find.textContent = 'Add show';
    }
  }
  find.addEventListener('click', add);
  url.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
  const guid = h('input', { type: 'text', placeholder: 'Podcast GUID', 'aria-label': 'Podcast GUID' });
  const manual = h('details', { class: 'more' }, h('summary', null, 'Add by GUID instead'),
    h('div', { class: 'place-search', style: 'margin-top:8px' }, guid, h('button', {
      type: 'button',
      onclick: () => { if (!guid.value.trim()) return guid.focus(); list.push({ feedGuid: guid.value.trim(), feedUrl: null, title: null, medium: null }); guid.value = ''; changed(); rows.redraw(); },
    }, 'Add')));
  return { el: h('div', null, h('div', { class: 'place-search' }, url, find), err, h('div', { style: 'margin-top:12px' }, rows.el), manual) };
}
const podrollPayload = (list) => list.map((r) => ({ feedGuid: r.feedGuid, feedUrl: r.feedUrl || null, medium: r.medium || null }));

// ── Publishing schedule (podcast:updateFrequency) ──

const SCHEDULES = [
  ['', 'Not set'], ['FREQ=DAILY', 'Daily'], ['FREQ=WEEKLY', 'Weekly'], ['FREQ=WEEKLY;INTERVAL=2', 'Every two weeks'],
  ['FREQ=MONTHLY', 'Monthly'], ['FREQ=MONTHLY;INTERVAL=2', 'Every two months'], ['custom', 'Custom rule'],
];

function scheduleEditor({ value, onChange }) {
  const v = value ? { ...value } : { label: '', rrule: null, dtstart: null, complete: false };
  const changed = () => onChange?.();
  const preset = h('select', { 'aria-label': 'How often new episodes come out' }, SCHEDULES.map(([r, t]) => h('option', { value: r }, t)));
  preset.value = !v.rrule ? '' : SCHEDULES.some(([r]) => r === v.rrule) ? v.rrule : 'custom';
  const label = bound(v, 'label', { placeholder: 'Shown in some apps, e.g. Every other Monday', maxlength: 128 });
  const rule = bound(v, 'rrule', { placeholder: 'FREQ=WEEKLY;BYDAY=MO', class: 'code-input' });
  const start = h('input', { type: 'date', value: v.dtstart ? String(v.dtstart).slice(0, 10) : '' });
  const complete = h('input', { type: 'checkbox', checked: v.complete });
  const ruleField = field('Rule (iCalendar RRULE)', rule, 'For example FREQ=WEEKLY;BYDAY=MO,TH for Mondays and Thursdays.');
  const sync = () => { ruleField.hidden = preset.value !== 'custom'; };
  preset.addEventListener('change', () => {
    if (preset.value !== 'custom') {
      v.rrule = preset.value || null;
      const name = SCHEDULES.find(([r]) => r === preset.value)?.[1];
      if (preset.value && (!v.label || SCHEDULES.some(([, t]) => t === v.label))) { v.label = name; label.value = name; }
    }
    sync();
    changed();
  });
  [label, rule].forEach((el) => el.addEventListener('input', changed));
  start.addEventListener('change', () => { v.dtstart = start.value || null; changed(); });
  complete.addEventListener('change', () => { v.complete = complete.checked; changed(); });
  sync();
  return {
    el: h('div', null,
      h('div', { class: 'row' }, field('How often', preset), field('Description', label)),
      ruleField,
      h('div', { class: 'row' }, field('Starting (optional)', start, 'For a show returning from a break, or a limited series.'),
        h('div', { class: 'field' }, h('label', { class: 'check' }, complete, 'No more episodes are planned')))),
    get: () => (!v.rrule && !v.label && !v.complete ? null : { label: v.label || null, rrule: preset.value === 'custom' ? v.rrule : (preset.value || null), dtstart: v.dtstart, complete: !!v.complete }),
  };
}

// ── License ──

const LICENSES = [
  ['', 'Not set'],
  ['cc-by-4.0', 'CC BY 4.0: credit me'],
  ['cc-by-sa-4.0', 'CC BY-SA 4.0: credit me, share alike'],
  ['cc-by-nd-4.0', 'CC BY-ND 4.0: credit me, no changes'],
  ['cc-by-nc-4.0', 'CC BY-NC 4.0: credit me, non-commercial'],
  ['cc-by-nc-sa-4.0', 'CC BY-NC-SA 4.0: credit me, non-commercial, share alike'],
  ['cc-by-nc-nd-4.0', 'CC BY-NC-ND 4.0: credit me, non-commercial, no changes'],
  ['cc0-1.0', 'CC0 1.0: public domain'],
  ['custom', 'Another license'],
];

function licenseEditor({ value, onChange, inherit }) {
  const v = value ? { ...value } : { identifier: '', url: null };
  const select = h('select', { 'aria-label': 'License' }, LICENSES.map(([id, t]) => h('option', { value: id }, id === '' && inherit ? 'Same as the show' : t)));
  const known = LICENSES.find(([id]) => id && id !== 'custom' && id === (v.identifier || '').toLowerCase());
  select.value = !v.identifier ? '' : known ? known[0] : 'custom';
  const name = bound(v, 'identifier', { placeholder: 'my-podcast-license-v1', maxlength: 128 });
  const url = bound(v, 'url', { type: 'url', placeholder: 'https://example.com/license.pdf' });
  const custom = h('div', { class: 'row' }, field('License name', name), field('Link to the license', url, 'Required for a license that isn’t on the list.'));
  const sync = () => { custom.hidden = select.value !== 'custom'; };
  select.addEventListener('change', () => {
    if (select.value !== 'custom') { v.identifier = select.value; v.url = null; }
    else if (known) { v.identifier = ''; name.value = ''; }
    sync();
    onChange?.();
  });
  [name, url].forEach((el) => el.addEventListener('input', () => onChange?.()));
  sync();
  return {
    el: h('div', null, field('License', select, 'How others may reuse your episodes.'), custom),
    get: () => {
      if (!select.value) return null;
      if (select.value === 'custom') return v.identifier ? { identifier: v.identifier, url: v.url || null } : null;
      // Unchanged: keep exactly what was stored (e.g. its original capitalisation and link).
      if (value && (value.identifier || '').toLowerCase() === select.value) return { identifier: value.identifier, url: value.url };
      return { identifier: select.value, url: null };
    },
  };
}

// ── Text records (podcast:txt) ──

function txtEditor({ list, onChange }) {
  return rowList({
    list, onChange, addLabel: 'Add text record', empty: 'None.',
    add: () => ({ purpose: '', value: '' }),
    makeRow: (t, i, changed) => {
      const purpose = bound(t, 'purpose', { placeholder: 'Purpose, e.g. verify', maxlength: 128, 'aria-label': 'Purpose', class: 'short-wide' });
      const value = bound(t, 'value', { placeholder: 'Value', maxlength: 4000, 'aria-label': 'Value' });
      [purpose, value].forEach((el) => el.addEventListener('input', changed));
      return h('div', { class: 'pair' }, purpose, value);
    },
  });
}
const txtPayload = (list) => list.map((t) => ({ purpose: t.purpose || null, value: t.value }));

// ───────────── episode editor ─────────────

const TRANSCRIPT_TYPES = [
  ['text/vtt', 'WebVTT (.vtt)'], ['application/x-subrip', 'SubRip (.srt)'], ['text/html', 'HTML'],
  ['application/json', 'JSON'], ['text/plain', 'Plain text'],
];

async function viewEpisode(p, canEdit, episodeId) {
  const isNew = episodeId === 'new';
  const ep = isNew
    ? { status: 'draft', inFeed: false, title: '', description: '', link: null, enclosure: null, duration: null, season: null, episode: null,
        episodeType: 'full', explicit: null, imageUrl: null, block: false, transcripts: [], chapters: null, people: [], locations: [],
        value: [], funding: [], license: null, txt: [], otherTags: '', itunesTitle: null }
    : (await api('GET', `/api/podcasts/${p.id}/episodes/${episodeId}`)).episode;
  const showInfo = await api('GET', `/api/podcasts/${p.id}/details`);

  const unsaved = new Set(); // uploads not yet saved into the episode
  let dirty = false;
  const markDirty = () => (dirty = true);
  const onUnload = (ev) => {
    if (!dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  };
  window.addEventListener('beforeunload', onUnload);
  cleanup.push(() => {
    window.removeEventListener('beforeunload', onUnload);
    for (const id of unsaved) api('DELETE', `/api/podcasts/${p.id}/media/${id}`).catch(() => {});
  });

  // ── Audio ──
  let enclosure = null; // what to send: undefined = unchanged
  let enclosureChanged = false;
  const audioSlot = h('div');
  const duration = h('input', { type: 'text', inputmode: 'numeric', value: ep.duration != null ? fmtDuration(ep.duration) : '', placeholder: '45:30', pattern: '[0-9:.]*' });
  const linkUrl = h('input', { type: 'url', placeholder: 'https://cdn.example.com/episode-12.mp3' });
  const linkType = h('select', null, [['audio/mpeg', 'MP3'], ['audio/x-m4a', 'M4A / AAC'], ['video/mp4', 'MP4 video']].map(([v, t]) => h('option', { value: v }, t)));
  const linkLength = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Size in bytes (optional)' });
  let current = ep.enclosure ? { url: ep.enclosure.url, name: ep.enclosure.name, bytes: ep.enclosure.length, type: ep.enclosure.type, duration: ep.duration } : null;

  const drop = h('div', { class: 'dropzone' });
  const up = uploader({
    podcastId: p.id,
    kind: undefined,
    accept: '.mp3,.m4a,.aac,.mp4,.m4v,.mov,.ogg,.opus,.wav,.flac,audio/*,video/*',
    label: current ? 'Replace audio' : 'Choose audio file',
    primary: !current,
    dropTarget: drop,
    onStart: markDirty,
    onDone: (m) => {
      if (m.kind !== 'audio' && m.kind !== 'video') return toast('That isn’t an audio or video file');
      unsaved.add(m.id);
      enclosure = { mediaId: m.id };
      enclosureChanged = true;
      current = { url: m.url, name: m.name, bytes: m.bytes, type: m.mimeType, duration: m.duration };
      if (m.duration) duration.value = fmtDuration(m.duration);
      drawAudio();
      toast('Audio uploaded');
    },
  });
  const useLink = h('details', { class: 'use-link' }, h('summary', null, 'Use a file hosted somewhere else'),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('div', { class: 'field', style: 'flex:3 1 280px' }, h('label', null, 'Address of the audio file'), linkUrl),
      field('Type', linkType), field('Size', linkLength)),
    h('div', { class: 'actions', style: 'margin-top:0' }, h('button', {
      type: 'button',
      onclick: () => {
        if (!linkUrl.value) return linkUrl.focus();
        enclosure = { url: linkUrl.value, type: linkType.value, length: linkLength.value ? Number(linkLength.value) : null };
        enclosureChanged = true;
        current = { url: linkUrl.value, name: null, bytes: enclosure.length, type: linkType.value, duration: null };
        markDirty();
        drawAudio();
      },
    }, 'Use this address')));

  function drawAudio() {
    up.button.textContent = current ? 'Replace audio' : 'Choose audio file';
    up.button.className = current ? '' : 'primary';
    if (current) {
      const player = /^https?:/.test(current.url) ? h('audio', { controls: true, preload: 'none', src: current.url }) : null;
      drop.replaceChildren(h('div', { class: 'file-row' },
        h('div', { class: 'file-icon', 'aria-hidden': 'true' }, (current.type ?? 'audio/').startsWith('video/') ? 'VID' : 'AUD'),
        h('div', null,
          h('b', null, fileLabel(current.url, current.name)),
          h('div', { class: 'hint' }, [current.bytes ? fmtBytes(current.bytes) : null, current.duration ? fmtDuration(current.duration) : null, current.type].filter(Boolean).join(' · ')))),
      player, h('div', { class: 'actions' }, up.button, h('span', { class: 'hint' }, 'or drop a new file here')));
    } else {
      drop.replaceChildren(h('p', { class: 'drop-text' }, 'Drop the episode’s audio here'),
        h('p', { class: 'hint' }, 'MP3 or M4A recommended. Large files are fine: uploads continue if the connection drops.'),
        h('div', { class: 'actions', style: 'justify-content:center' }, up.button));
    }
  }
  drawAudio();
  audioSlot.append(drop, up.el, useLink);

  // ── Details ──
  const title = h('input', { type: 'text', required: true, value: ep.title, maxlength: 1000 });
  const desc = h('textarea', { rows: 10 }, ep.description ?? '');
  const season = h('input', { type: 'text', inputmode: 'numeric', value: ep.season ?? '', pattern: '[0-9]*' });
  const number = h('input', { type: 'text', inputmode: 'numeric', value: ep.episode ?? '', pattern: '[0-9]*' });
  const etype = h('select', null, [['full', 'Full episode'], ['trailer', 'Trailer'], ['bonus', 'Bonus']].map(([v, t]) => h('option', { value: v }, t)));
  etype.value = ep.episodeType ?? 'full';
  const explicit = h('select', null, [['', 'Same as the show'], ['true', 'Explicit'], ['false', 'Clean']].map(([v, t]) => h('option', { value: v }, t)));
  explicit.value = ep.explicit === null || ep.explicit === undefined ? '' : String(ep.explicit);
  const link = h('input', { type: 'url', value: ep.link ?? '', placeholder: 'https://example.com/episodes/12' });
  const itunesTitle = h('input', { type: 'text', value: ep.itunesTitle ?? '', placeholder: 'Leave blank to use the title' });

  // Episode art
  let image; // undefined = unchanged
  let imageUrl = ep.imageUrl;
  const artSlot = h('div', { class: 'art-pick' });
  const artUp = uploader({
    podcastId: p.id,
    kind: 'image',
    accept: '.jpg,.jpeg,.png,image/jpeg,image/png',
    label: 'Upload image',
    onStart: markDirty,
    onDone: (m) => {
      unsaved.add(m.id);
      image = { mediaId: m.id };
      imageUrl = m.url;
      drawArt(m);
    },
  });
  function drawArt(m) {
    artSlot.replaceChildren(
      artImg(imageUrl, ep.title || '—'),
      h('div', null,
        h('p', { class: 'hint' }, imageUrl
          ? (m?.width ? `${m.width} × ${m.height} pixels. ` : '') + 'Shown instead of the show artwork in apps that support it.'
          : 'Optional. Square JPEG or PNG, 1400–3000 pixels. Without one, apps show the show artwork.'),
        h('div', { class: 'actions', style: 'margin-top:8px' }, artUp.button, imageUrl ? h('button', {
          type: 'button',
          class: 'quiet',
          onclick: () => {
            image = null;
            imageUrl = null;
            markDirty();
            drawArt();
          },
        }, 'Remove') : null),
        artUp.el));
  }
  drawArt();

  // ── Transcripts & chapters ──
  const transcripts = ep.transcripts.map((t) => ({ ...t, ref: { url: t.url } }));
  let chapters = ep.chapters ? { ref: { url: ep.chapters.url }, url: ep.chapters.url } : null;
  let chaptersChanged = false;
  let transcriptsChanged = false;
  const tList = h('div', { class: 'file-list' });
  const tUp = uploader({
    podcastId: p.id,
    kind: 'transcript',
    accept: '.vtt,.srt,.html,.htm,.json,.txt',
    label: 'Add transcript',
    onStart: markDirty,
    onDone: (m) => {
      unsaved.add(m.id);
      transcripts.push({ url: m.url, name: m.name, type: m.mimeType, language: ep.language ?? p.language ?? '', rel: /vtt|subrip/.test(m.mimeType) ? 'captions' : null, ref: { mediaId: m.id } });
      transcriptsChanged = true;
      drawTranscripts();
    },
  });
  function drawTranscripts() {
    tList.replaceChildren(...transcripts.map((t, i) => {
      const lang = h('input', { type: 'text', value: t.language ?? '', placeholder: 'en', 'aria-label': 'Language', class: 'short' });
      lang.addEventListener('input', () => { t.language = lang.value; transcriptsChanged = true; markDirty(); });
      const cap = h('input', { type: 'checkbox', checked: t.rel === 'captions' });
      cap.addEventListener('change', () => { t.rel = cap.checked ? 'captions' : null; transcriptsChanged = true; markDirty(); });
      const type = TRANSCRIPT_TYPES.find(([v]) => v === t.type)?.[1] ?? t.type;
      return h('div', { class: 'file-row' },
        h('div', { class: 'file-icon', 'aria-hidden': 'true' }, 'TXT'),
        h('div', null, h('b', null, fileLabel(t.url, t.name)), h('div', { class: 'hint' }, type)),
        h('div', { class: 'file-opts' },
          lang,
          /vtt|subrip|srt/.test(t.type) ? h('label', { class: 'check small' }, cap, 'Captions') : null,
          h('button', { type: 'button', class: 'quiet', onclick: () => { transcripts.splice(i, 1); transcriptsChanged = true; markDirty(); drawTranscripts(); } }, 'Remove')));
    }));
    if (!transcripts.length) tList.append(h('p', { class: 'hint' }, 'No transcript. Apple Podcasts and other apps can show one as the episode plays.'));
  }
  drawTranscripts();

  const cSlot = h('div', { class: 'file-list' });
  const cUp = uploader({
    podcastId: p.id,
    kind: 'chapters',
    accept: '.json,application/json',
    label: 'Upload chapters file',
    onStart: markDirty,
    onDone: (m) => {
      unsaved.add(m.id);
      chapters = { url: m.url, name: m.name, ref: { mediaId: m.id } };
      chaptersChanged = true;
      drawChapters();
    },
  });
  function drawChapters() {
    cUp.button.textContent = chapters ? 'Replace chapters' : 'Upload chapters file';
    cSlot.replaceChildren(chapters
      ? h('div', { class: 'file-row' },
        h('div', { class: 'file-icon', 'aria-hidden': 'true' }, 'CH'),
        h('div', null, h('b', null, fileLabel(chapters.url, chapters.name)), h('div', { class: 'hint' }, 'JSON chapters')),
        h('div', { class: 'file-opts' }, h('button', { type: 'button', class: 'quiet', onclick: () => { chapters = null; chaptersChanged = true; markDirty(); drawChapters(); } }, 'Remove')))
      : h('p', { class: 'hint' }, 'No chapters. Use a Podcast Namespace JSON chapters file (many editors export one).'));
  }
  drawChapters();

  // ── People ──
  const people = editablePeople(ep.people ?? []);
  let peopleChanged = false;
  let ownPeople = people.length > 0;
  const peopleSlot = h('div');
  const noHost = h('p', { class: 'warn-note', hidden: true }, 'No host in this list, so apps won’t show your hosts on this episode. Use “Copy in the show’s people” to add them.');
  const checkHost = () => {
    noHost.hidden = !ownPeople || !people.length || people.some((x) => /^(co-|guest )?host$/i.test(x.role ?? 'host'));
  };
  const pEditor = peopleEditor({
    podcastId: p.id,
    taxonomy: showInfo.roles,
    list: people,
    onChange: () => { peopleChanged = true; markDirty(); checkHost(); },
    onUpload: (m) => unsaved.add(m.id),
  });
  const copyShow = () => {
    const have = new Set(people.map((x) => x.name.trim().toLowerCase()));
    for (const sp of showInfo.show.people) if (!have.has(sp.name.trim().toLowerCase())) people.push({ ...sp, imgRef: null });
    peopleChanged = true;
    markDirty();
    pEditor.redraw();
    checkHost();
  };
  const peopleRadio = (own, labelText, small) => {
    const r = h('input', { type: 'radio', name: 'people-mode', checked: ownPeople === own });
    r.addEventListener('change', () => {
      ownPeople = own;
      peopleChanged = true;
      markDirty();
      if (own && !people.length) copyShow();
      drawPeople();
    });
    return h('label', { class: 'choice' }, r, h('span', null, labelText, h('small', null, small)));
  };
  function drawPeople() {
    peopleSlot.replaceChildren(
      h('div', { class: 'choices two' },
        peopleRadio(false, 'Same as the show', 'Apps show the show’s people for this episode'),
        peopleRadio(true, 'People for this episode', 'Add guests and anyone else on this episode')),
      ownPeople
        ? h('div', { style: 'margin-top:16px' },
          h('p', { class: 'hint' }, 'Apps show this list instead of the show’s people for this episode, so keep your hosts in it.'),
          noHost,
          pEditor.el,
          showInfo.show.people.length ? h('button', { type: 'button', class: 'quiet', style: 'margin-top:4px', onclick: copyShow }, 'Copy in the show’s people') : null)
        : h('div', { style: 'margin-top:16px' }, peopleSummary(showInfo.show.people)));
    checkHost();
  }
  drawPeople();

  // ── Locations ──
  const locations = (ep.locations ?? []).map((l) => ({ ...l }));
  let locationsChanged = false;
  const locEditor = locationsEditor({ list: locations, defaultRel: 'subject', onChange: () => { locationsChanged = true; markDirty(); } });

  // ── Value for value, support links, license, text records ──
  const changes = {};
  const mark = (k) => () => { changes[k] = true; markDirty(); };
  const valueBlocks = copyValue(ep.value ?? []);
  let ownValue = valueBlocks.length > 0;
  const vEditor = valueEditor({ blocks: valueBlocks, onChange: mark('value') });
  const valueSlot = h('div');
  const valueRadio = (own, labelText, small) => {
    const r = h('input', { type: 'radio', name: 'value-mode', checked: ownValue === own });
    r.addEventListener('change', () => {
      ownValue = own;
      changes.value = true;
      markDirty();
      if (own && !valueBlocks.length) valueBlocks.push(...copyValue(showInfo.show.value?.length ? showInfo.show.value : [blankValue()]));
      vEditor.redraw();
      drawValue();
    });
    return h('label', { class: 'choice' }, r, h('span', null, labelText, h('small', null, small)));
  };
  function drawValue() {
    valueSlot.replaceChildren(
      h('div', { class: 'choices two' },
        valueRadio(false, 'Same as the show', 'Payments follow the show’s split'),
        valueRadio(true, 'Split for this episode', 'For example, give a guest a share')),
      h('div', { style: 'margin-top:16px' }, ownValue
        ? [h('p', { class: 'hint' }, 'Apps use this split instead of the show’s for this episode, so include yourself.'), vEditor.el]
        : valueSummary(showInfo.show.value ?? [])));
  }
  drawValue();
  const funding = (ep.funding ?? []).map((f) => ({ ...f }));
  const fEditor = fundingEditor({ list: funding, onChange: mark('funding') });
  const lic = licenseEditor({ value: ep.license, onChange: mark('license'), inherit: true });
  const txt = (ep.txt ?? []).map((t) => ({ ...t }));
  const txtEd = txtEditor({ list: txt, onChange: mark('txt') });

  // ── Advanced ──
  const other = h('textarea', { class: 'code', rows: Math.min(16, Math.max(4, (ep.otherTags.match(/\n/g)?.length ?? 0) + 2)), spellcheck: 'false' }, ep.otherTags);
  const block = h('input', { type: 'checkbox', checked: ep.block });

  // ── Publishing ──
  const mode = { value: ep.status === 'draft' ? 'draft' : ep.inFeed ? 'live' : 'schedule' };
  const when = h('input', { type: 'datetime-local', value: toInputValue(ep.status === 'scheduled' && ep.pubDate ? ep.pubDate : new Date(Date.now() + 86400_000).toISOString()) });
  const liveDate = h('input', { type: 'datetime-local', value: toInputValue(ep.pubDate) });
  const save = h('button', { type: 'submit', class: 'primary' });
  const radio = (value, labelText, extra) => {
    const r = h('input', { type: 'radio', name: 'when', value, checked: mode.value === value });
    r.addEventListener('change', () => { mode.value = value; markDirty(); drawMode(); });
    return h('label', { class: 'choice' }, r, h('span', null, labelText, extra));
  };
  const modes = h('div', { class: 'choices' });
  function drawMode() {
    const published = !isNew && ep.status !== 'draft' && ep.inFeed;
    modes.replaceChildren(
      radio('draft', 'Draft', h('small', null, 'Not in the feed')),
      radio('live', published ? 'In the feed' : 'Publish now', published ? h('small', null, 'Publish date ', liveDate) : h('small', null, 'Appears in apps within minutes')),
      radio('schedule', 'Schedule', h('small', null, when)));
    liveDate.disabled = mode.value !== 'live';
    when.disabled = mode.value !== 'schedule';
    save.textContent = mode.value === 'draft' ? (isNew || ep.status === 'draft' ? 'Save draft' : 'Move to drafts')
      : mode.value === 'schedule' ? (ep.status === 'scheduled' ? 'Save changes' : 'Schedule')
        : published ? 'Save changes' : 'Publish now';
  }
  drawMode();

  const err = formError();
  const stateLine = isNew ? 'New episode'
    : ep.status === 'draft' ? 'Draft'
      : ep.inFeed ? `In the feed since ${fmtDate(ep.pubDate, true)}` : `Scheduled for ${fmtDate(ep.pubDate, true)}`;
  const pingNote = p.podping.enabled
    ? 'Podping tells apps as soon as it’s in the feed.'
    : 'Apps pick it up the next time they check the feed.';

  const body = () => {
    const b = {
      title: title.value,
      description: desc.value,
      link: link.value || null,
      season: season.value || null,
      episode: number.value || null,
      episodeType: etype.value,
      explicit: explicit.value === '' ? null : explicit.value === 'true',
      itunesTitle: itunesTitle.value || null,
      duration: duration.value || null,
      otherTags: other.value,
      block: block.checked,
    };
    if (enclosureChanged) b.enclosure = enclosure;
    if (image !== undefined) b.image = image;
    if (peopleChanged) {
      if (ownPeople && people.some((x) => !x.name.trim())) throw new Error('Every person needs a name.');
      b.people = ownPeople ? peoplePayload(people) : [];
    }
    if (locationsChanged) b.locations = locationsPayload(locations);
    if (changes.value) b.value = ownValue ? valuePayload(valueBlocks) : [];
    if (changes.funding) b.funding = funding;
    if (changes.license) b.license = lic.get();
    if (changes.txt) b.txt = txtPayload(txt);
    if (transcriptsChanged) b.transcripts = transcripts.map((t) => ({ ...t.ref, type: t.type, language: t.language || null, rel: t.rel }));
    if (chaptersChanged) b.chapters = chapters ? chapters.ref : null;
    if (mode.value === 'draft') b.status = 'draft';
    else if (mode.value === 'schedule') {
      if (!when.value) throw new Error('Choose when to publish');
      if (new Date(when.value).getTime() <= Date.now()) throw new Error('The scheduled time has passed. Choose a later time, or publish now.');
      b.status = 'published';
      b.pubDate = localIso(when.value);
    } else {
      b.status = 'published';
      b.pubDate = liveDate.value && !isNew && ep.status !== 'draft' && ep.inFeed ? localIso(liveDate.value) : null;
    }
    return b;
  };

  const form = h('form', {
    class: 'editor',
    novalidate: true,
    oninput: markDirty,
    onsubmit: (ev) => {
      ev.preventDefault();
      err.hidden = true;
      if (up.busy() || artUp.busy() || tUp.busy() || cUp.busy()) return showError(err, 'Wait for the upload to finish.');
      busy(form, async () => {
        try {
          const b = body();
          const r = isNew
            ? await api('POST', `/api/podcasts/${p.id}/episodes`, b)
            : await api('PATCH', `/api/podcasts/${p.id}/episodes/${ep.id}`, b);
          unsaved.clear();
          dirty = false;
          const e = r.episode;
          toast(e.status === 'draft' ? 'Draft saved' : !e.inFeed ? `Scheduled for ${fmtDate(e.pubDate, true)}` : ep.inFeed ? 'Saved' : 'Published');
          await refreshPodcasts();
          go(`#/show/${p.id}/episodes/${e.id}`);
        } catch (e) {
          showError(err, e);
          err.scrollIntoView({ block: 'nearest' });
        }
      });
    },
  },
  h('fieldset', { class: 'plain', disabled: !canEdit },
    h('div', { class: 'editor-main' },
      h('section', { class: 'panel' }, h('h2', null, 'Audio'), audioSlot,
        h('div', { class: 'row', style: 'margin-top:16px' }, field('Length', duration, 'Filled in from the file. hh:mm:ss'))),
      h('section', { class: 'panel' }, h('h2', null, 'Details'),
        field('Title', title),
        field('Description', desc, 'Show notes. Basic HTML works: <p>, <a href>, <b>, <i>, <ul>, <li>.'),
        h('div', { class: 'row' }, field('Season', season), field('Episode number', number), field('Type', etype), field('Content', explicit)),
        h('div', { class: 'field' }, h('label', null, 'Episode art'), artSlot),
        field('Episode web page', link, 'Optional. A page about this episode on your website.')),
      h('section', { class: 'panel' }, h('h2', null, 'People'), peopleSlot),
      h('section', { class: 'panel' }, h('h2', null, 'Locations'),
        h('p', { class: 'muted' }, 'Places this episode is about, or where it was recorded. Apps can show them on a map.'),
        locEditor),
      h('section', { class: 'panel' }, h('h2', null, 'Value for value'), valueSlot),
      h('section', { class: 'panel' }, h('h2', null, 'Support links'),
        h('p', { class: 'muted' }, 'Links just for this episode, such as a guest’s book or a cause you mention.'),
        fEditor.el),
      h('section', { class: 'panel' }, h('h2', null, 'Transcripts and chapters'),
        h('h3', { class: 'sub' }, 'Transcripts'), tList, tUp.el, h('div', { class: 'actions', style: 'margin-top:8px' }, tUp.button),
        h('h3', { class: 'sub' }, 'Chapters'), cSlot, cUp.el, h('div', { class: 'actions', style: 'margin-top:8px' }, cUp.button)),
      h('section', { class: 'panel' }, h('details', { open: ep.otherTags || ep.license || ep.txt?.length ? true : null },
        h('summary', null, 'More tags and options'),
        h('div', { style: 'margin-top:16px' },
          field('Title for Apple Podcasts', itunesTitle, 'Only if it should differ from the title, e.g. without the episode number.'),
          lic.el,
          h('div', { class: 'field' }, h('label', null, 'Text records'), txtEd.el),
          h('div', { class: 'field' },
            h('label', { for: 'other-tags' }, 'Other tags'),
            (other.id = 'other-tags', other),
            h('p', { class: 'hint' }, 'Any other iTunes or Podcasting 2.0 tags for this episode, as XML: soundbites, alternate enclosures, social interaction and so on. For example ',
              h('code', { class: 'inline' }, '<podcast:soundbite startTime="73.0" duration="60.0">Best bit</podcast:soundbite>'))),
          h('label', { class: 'check' }, block, 'Hide this episode from Apple Podcasts'),
          ep.guid ? h('p', { class: 'hint', style: 'margin-top:12px' }, `GUID: ${ep.guid}`) : null)))),
    h('aside', { class: 'editor-side' },
      h('section', { class: 'panel publish' },
        h('h2', null, 'Publishing'),
        h('p', { class: 'state' }, stateLine),
        modes,
        err,
        canEdit ? h('div', { class: 'actions' }, save) : null,
        h('p', { class: 'hint', style: 'margin-top:12px' }, pingNote),
        !isNew && canEdit ? h('button', {
          type: 'button',
          class: 'quiet danger delete',
          onclick: async () => {
            if (!confirm(`Delete “${ep.title}”? It disappears from the feed and its files are removed. This can’t be undone.`)) return;
            try {
              await api('DELETE', `/api/podcasts/${p.id}/episodes/${ep.id}`);
              dirty = false;
              toast('Episode deleted');
              await refreshPodcasts();
              go(`#/show/${p.id}/episodes`);
            } catch (e) {
              showError(err, e);
            }
          },
        }, 'Delete episode') : null))));

  return h('div', null,
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: `#/show/${p.id}/episodes` }, 'Episodes'), h('span', { 'aria-hidden': 'true' }, ' / '),
      h('span', null, isNew ? 'New episode' : ep.title)),
    form);
}

// ───────────── show details ─────────────

const LANGUAGES = [
  ['en', 'English'], ['en-us', 'English (US)'], ['en-gb', 'English (UK)'], ['es', 'Spanish'], ['es-mx', 'Spanish (Mexico)'],
  ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['pt-br', 'Portuguese (Brazil)'], ['nl', 'Dutch'],
  ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'], ['fi', 'Finnish'], ['pl', 'Polish'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh', 'Chinese'], ['hi', 'Hindi'], ['ar', 'Arabic'],
];

function languageInput(value) {
  const id = `langs-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', { type: 'text', list: id, value: value ?? '', placeholder: 'en', maxlength: 35 });
  return [input, h('datalist', { id }, LANGUAGES.map(([v, t]) => h('option', { value: v }, t)))];
}

/** A select of "Category" and "Category › Subcategory". Keeps a category the list doesn't have (from an import). */
function categorySelect(all, current, optional) {
  const sel = h('select', null, h('option', { value: '' }, optional ? 'None' : 'Choose a category'));
  const key = (c) => (c ? (c.sub?.[0] ? `${c.text}|${c.sub[0]}` : c.text) : '');
  const known = new Set();
  for (const [top, subs] of Object.entries(all)) {
    known.add(top);
    subs.forEach((s) => known.add(`${top}|${s}`));
    sel.append(h('optgroup', { label: top }, h('option', { value: top }, top), subs.map((s) => h('option', { value: `${top}|${s}` }, `${top} › ${s}`))));
  }
  if (current && !known.has(key(current))) sel.prepend(h('option', { value: key(current) }, `${[current.text, ...current.sub].join(' › ')} (not an Apple category)`));
  sel.value = key(current);
  const initial = sel.value;
  return {
    el: sel,
    get: () => {
      if (!sel.value) return null;
      if (sel.value === initial && current) return current; // unchanged: keep it exactly
      const [text, sub] = sel.value.split('|');
      return { text, sub: sub ? [sub] : [] };
    },
  };
}

async function tabDetails(p, canEdit, reload) {
  const d = await api('GET', `/api/podcasts/${p.id}/details`);
  const s = d.show;
  const err = formError();

  // Artwork
  let image; // undefined = unchanged
  let art = { url: s.imageUrl, size: s.imageSize };
  const artSlot = h('div', { class: 'art-pick big' });
  const artUp = uploader({
    podcastId: p.id,
    kind: 'image',
    accept: '.jpg,.jpeg,.png,image/jpeg,image/png',
    label: s.imageUrl ? 'Replace artwork' : 'Upload artwork',
    onDone: (m) => {
      image = { mediaId: m.id };
      art = { url: m.url, size: { width: m.width, height: m.height } };
      drawArt();
    },
  });
  function drawArt() {
    const sz = art.size;
    const ok = sz && sz.width === sz.height && sz.width >= 1400 && sz.width <= 3000;
    artSlot.replaceChildren(artImg(art.url, s.title),
      h('div', null,
        h('p', { class: sz && !ok ? 'error' : 'hint' }, sz
          ? `${sz.width} × ${sz.height} pixels. ${ok ? 'Good for Apple Podcasts.' : 'Apple needs a square image 1400 to 3000 pixels wide.'}`
          : 'A square JPEG or PNG, 1400 to 3000 pixels wide. This is what listeners see in every app.'),
        h('div', { class: 'actions', style: 'margin-top:8px' }, artUp.button),
        artUp.el));
  }
  drawArt();

  const title = h('input', { type: 'text', required: true, value: s.title });
  const desc = h('textarea', { rows: 6 }, s.description ?? '');
  const author = h('input', { type: 'text', value: s.author ?? '', placeholder: 'The name listeners see under the title' });
  const [lang, langList] = languageInput(s.language);
  const cats = [0, 1, 2].map((i) => categorySelect(d.categories, s.categories[i], i > 0));
  const ownerName = h('input', { type: 'text', value: s.ownerName ?? '' });
  const ownerEmail = h('input', { type: 'email', value: s.ownerEmail ?? '' });
  const link = h('input', { type: 'url', value: s.link ?? '', placeholder: 'https://example.com' });
  const copyright = h('input', { type: 'text', value: s.copyright ?? '', placeholder: `© ${new Date().getFullYear()} ${s.author ?? ''}`.trim() });
  const type = h('select', null, h('option', { value: 'episodic' }, 'Episodic: newest first'), h('option', { value: 'serial' }, 'Serial: in order, start at episode 1'));
  type.value = s.type ?? 'episodic';
  const explicit = h('input', { type: 'checkbox', checked: s.explicit });
  const medium = h('select', null, h('option', { value: '' }, 'Not set (podcast)'), d.mediums.map((m) => h('option', { value: m }, m[0].toUpperCase() + m.slice(1))));
  medium.value = s.medium ?? '';
  const locked = h('select', null, h('option', { value: '' }, 'Not set'), h('option', { value: 'true' }, 'Locked: other hosts may not import this feed'), h('option', { value: 'false' }, 'Unlocked'));
  locked.value = s.locked === null ? '' : String(s.locked);
  const lockedOwner = h('input', { type: 'email', value: s.lockedOwner ?? '', placeholder: 'Defaults to the owner email' });
  const complete = h('input', { type: 'checkbox', checked: s.complete });
  const block = h('input', { type: 'checkbox', checked: s.block });
  const newFeed = h('input', { type: 'url', value: s.newFeedUrl ?? '', placeholder: 'Only when moving this show to another host' });
  const people = editablePeople(s.people);
  let peopleChanged = false;
  const pEditor = peopleEditor({ podcastId: p.id, taxonomy: d.roles, list: people, onChange: () => (peopleChanged = true) });
  const locations = s.locations.map((l) => ({ ...l }));
  let locationsChanged = false;
  const locEditor = locationsEditor({ list: locations, defaultRel: 'creator', onChange: () => (locationsChanged = true) });
  const valueBlocks = copyValue(s.value ?? []);
  const changes = {};
  const mark = (k) => () => (changes[k] = true);
  const vEditor = valueEditor({ blocks: valueBlocks, onChange: mark('value') });
  const funding = (s.funding ?? []).map((f) => ({ ...f }));
  const fEditor = fundingEditor({ list: funding, onChange: mark('funding') });
  const podroll = (s.podroll ?? []).map((r) => ({ ...r }));
  const prEditor = podrollEditor({ list: podroll, onChange: mark('podroll') });
  const sched = scheduleEditor({ value: s.updateFrequency, onChange: mark('updateFrequency') });
  const lic = licenseEditor({ value: s.license, onChange: mark('license') });
  const txt = (s.txt ?? []).map((t) => ({ ...t }));
  const txtEd = txtEditor({ list: txt, onChange: mark('txt') });
  const other = h('textarea', { class: 'code', id: 'show-other-tags', rows: Math.min(16, Math.max(4, (s.otherTags.match(/\n/g)?.length ?? 0) + 2)), spellcheck: 'false' }, s.otherTags);

  const form = h('form', {
    novalidate: true,
    onsubmit: (ev) => {
      ev.preventDefault();
      err.hidden = true;
      if (artUp.busy()) return showError(err, 'Wait for the upload to finish.');
      if (newFeed.value && newFeed.value !== (s.newFeedUrl ?? '') &&
        !confirm('A new feed address tells Apple and other apps to move every subscriber to that address. Only do this when you’re leaving this host. Continue?')) return;
      busy(form, async () => {
        try {
          const body = {
            title: title.value, description: desc.value, author: author.value, language: lang.value,
            categories: cats.map((c) => c.get()).filter(Boolean),
            ownerName: ownerName.value, ownerEmail: ownerEmail.value, link: link.value || null, copyright: copyright.value,
            type: type.value, explicit: explicit.checked, medium: medium.value || null,
            locked: locked.value === '' ? null : locked.value === 'true', lockedOwner: lockedOwner.value || null,
            complete: complete.checked, block: block.checked, newFeedUrl: newFeed.value || null, otherTags: other.value,
          };
          if (image !== undefined) body.image = image;
          if (peopleChanged) {
            if (people.some((x) => !x.name.trim())) throw new Error('Every person needs a name.');
            body.people = peoplePayload(people);
          }
          if (locationsChanged) body.locations = locationsPayload(locations);
          if (changes.value) body.value = valuePayload(valueBlocks);
          if (changes.funding) body.funding = funding;
          if (changes.podroll) body.podroll = podrollPayload(podroll);
          if (changes.updateFrequency) body.updateFrequency = sched.get();
          if (changes.license) body.license = lic.get();
          if (changes.txt) body.txt = txtPayload(txt);
          await api('PUT', `/api/podcasts/${p.id}/details`, body);
          toast('Show details saved');
          await refreshPodcasts();
          reload();
        } catch (e) {
          showError(err, e);
        }
      });
    },
  },
  h('fieldset', { class: 'plain', disabled: !canEdit },
    h('section', { class: 'panel' },
      h('h2', null, 'Artwork'), artSlot),
    h('section', { class: 'panel' },
      h('h2', null, 'About the show'),
      field('Title', title),
      field('Description', desc, 'What the show is about. Directories show this on the show page.'),
      h('div', { class: 'row' }, field('Author', author), h('div', { class: 'field' }, h('label', { for: (lang.id = 'show-lang') }, 'Language'), lang, langList)),
      h('div', { class: 'row' }, field('Category', cats[0].el), field('Second category', cats[1].el), field('Third category', cats[2].el)),
      h('div', { class: 'row' }, field('Owner name', ownerName), field('Owner email', ownerEmail)),
      h('div', { class: 'row' }, field('Website', link), field('Copyright', copyright)),
      h('div', { class: 'row' }, field('Show type', type), h('div', { class: 'field' }, h('label', { class: 'check' }, explicit, 'Explicit content')))),
    h('section', { class: 'panel' },
      h('h2', null, 'People'),
      h('p', { class: 'muted' }, 'Hosts and regular crew. Podcasting 2.0 apps show them with every episode, unless an episode lists its own people.'),
      pEditor.el),
    h('section', { class: 'panel' },
      h('h2', null, 'Locations'),
      h('p', { class: 'muted' }, 'Where the show is made, or the places it covers. Episodes can list their own.'),
      locEditor),
    h('section', { class: 'panel' },
      h('h2', null, 'Value for value'),
      h('p', { class: 'muted' }, 'Lightning payments (sats) that listeners can stream or boost from Podcasting 2.0 apps such as Fountain, Podverse and Castamatic. Episodes can have their own split.'),
      vEditor.el),
    h('section', { class: 'panel' },
      h('h2', null, 'Support links'),
      h('p', { class: 'muted' }, 'Where listeners can support the show: Patreon, a tip jar, merch and so on. Apps show these as buttons.'),
      fEditor.el),
    h('section', { class: 'panel' },
      h('h2', null, 'Recommended shows'),
      h('p', { class: 'muted' }, 'Other podcasts you recommend (a podroll). Apps that support it list them on your show page.'),
      prEditor.el),
    h('section', { class: 'panel' },
      h('h2', null, 'Schedule and license'),
      sched.el,
      lic.el),
    h('section', { class: 'panel' }, h('details', { open: s.otherTags ? true : null },
      h('summary', null, 'More tags and options'),
      h('div', { style: 'margin-top:16px' },
        h('div', { class: 'row' }, field('Medium', medium), field('Locked', locked), field('Lock owner email', lockedOwner)),
        h('label', { class: 'check' }, complete, 'This show is finished: no more episodes'),
        h('label', { class: 'check', style: 'margin-top:8px' }, block, 'Hide this show from Apple Podcasts'),
        h('div', { class: 'field', style: 'margin-top:16px' },
          h('label', null, 'Text records'), txtEd.el,
          h('p', { class: 'hint' }, 'Short values that services read from your feed, such as ownership verification codes. Old ones can be removed once they’ve done their job.')),
        h('div', { class: 'field', style: 'margin-top:16px' },
          h('label', { for: 'show-other-tags' }, 'Other tags'), other,
          h('p', { class: 'hint' }, 'Any other iTunes or Podcasting 2.0 channel tags, as XML: trailers, images, chat, social interaction and so on. Live shows are on the Episodes tab.')),
        field('New feed address', newFeed, 'Sets <itunes:new-feed-url>. Leave blank unless you’re moving this show away from here.'),
        s.podcastGuid ? h('p', { class: 'hint' }, `Podcast GUID: ${s.podcastGuid}`) : null))),
    err,
    canEdit ? h('div', { class: 'actions', style: 'margin-bottom:24px' }, h('button', { class: 'primary', type: 'submit' }, 'Save show details')) : null));

  return h('div', null, d.checklist.length ? checklistPanel(d.checklist) : null, form);
}

function checklistPanel(items, extra) {
  return h('section', { class: 'panel checklist' },
    h('h2', null, 'Before you submit to Apple Podcasts and Spotify'),
    h('ul', null, items.map((t) => h('li', null, t))),
    extra ?? null);
}

// ───────────── new show ─────────────

async function viewNewShow() {
  const err = formError();
  const title = h('input', { type: 'text', required: true, placeholder: 'Garden Talk' });
  const slug = h('input', { type: 'text', pattern: '[a-z0-9](?:[a-z0-9\\-]{0,58}[a-z0-9])?', placeholder: 'garden-talk' });
  const desc = h('textarea', { rows: 4 });
  const author = h('input', { type: 'text', value: state.me.displayName ?? '' });
  const [lang, langList] = languageInput('en');
  const { categories } = await api('GET', '/api/categories');
  const cat = categorySelect(categories, null, false);
  const ownerEmail = h('input', { type: 'email', value: state.me.email });
  const explicit = h('input', { type: 'checkbox' });
  const preview = h('span');
  let slugEdited = false;
  const auto = () => title.value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const update = () => {
    if (!slugEdited) slug.value = auto();
    preview.textContent = `${state.setup.publicBaseUrl}/${slug.value || 'your-show'}/feed.xml`;
  };
  title.addEventListener('input', update);
  slug.addEventListener('input', () => {
    slugEdited = true;
    slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    update();
  });
  update();

  const form = h('form', {
    class: 'panel',
    onsubmit: (ev) => {
      ev.preventDefault();
      err.hidden = true;
      busy(form, async () => {
        try {
          const { podcast } = await api('POST', '/api/podcasts', {
            title: title.value, slug: slug.value || undefined, description: desc.value, author: author.value,
            language: lang.value, categories: cat.get() ? [cat.get()] : [], ownerEmail: ownerEmail.value, ownerName: author.value,
            explicit: explicit.checked,
          });
          await refreshPodcasts();
          toast('Show created. Add the artwork next.');
          go(`#/show/${podcast.id}/details`);
        } catch (e) {
          showError(err, e);
        }
      });
    },
  },
  h('h2', null, 'Start a new show'),
  h('p', { class: 'muted' }, 'You can change everything except the feed address later.'),
  field('Title', title),
  field('Feed address', slug, 'Lowercase letters, numbers and dashes. This can’t change once the show is listed.'),
  h('p', { class: 'preview', style: 'margin-top:-8px;margin-bottom:16px' }, h('b', null, 'Your feed'), preview),
  field('Description', desc),
  h('div', { class: 'row' }, field('Author', author), h('div', { class: 'field' }, h('label', { for: (lang.id = 'new-lang') }, 'Language'), lang, langList)),
  h('div', { class: 'row' }, field('Category', cat.el), field('Owner email', ownerEmail, 'Not shown to listeners in most apps.')),
  h('label', { class: 'check' }, explicit, 'Explicit content'),
  err,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Create show')));

  return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Start a new show')), form);
}

// Stats prefixes: one checkbox per service, ID fields where needed, order for the chain
async function tabPrefixes(p, canEdit, reload) {
  const [cfg, eps] = await Promise.all([
    api('GET', `/api/podcasts/${p.id}/prefixes`),
    api('GET', `/api/podcasts/${p.id}/episodes`),
  ]);
  const sample = eps.episodes.find((e) => e.enclosure_url)?.enclosure_url ?? `${state.setup.publicBaseUrl}/${p.slug}/media/audio/episode.mp3`;

  // Working copy: every service appears once (custom may appear several times).
  let rows = cfg.services.filter((s) => s.key !== 'custom').map((s) => {
    const saved = cfg.settings.find((x) => x.serviceKey === s.key);
    return { serviceKey: s.key, enabled: !!saved?.enabled, paramValue: saved?.paramValue ?? '', position: saved?.position ?? 100 + cfg.services.indexOf(s) };
  });
  rows.push(...cfg.settings.filter((x) => x.serviceKey === 'custom').map((x) => ({ ...x, paramValue: x.paramValue ?? '' })));
  rows.sort((a, b) => a.position - b.position);
  // Ticked services first, in chain order; the rest below.
  const settle = () => { rows = [...rows.filter((r) => r.enabled), ...rows.filter((r) => !r.enabled)]; };
  settle();
  let altEnclosures = cfg.prefixAlternateEnclosures;

  const svc = (k) => cfg.services.find((s) => s.key === k);
  const list = h('ul', { class: 'prefixes' });
  const preview = h('div', { class: 'preview' });
  const err = formError();

  const chain = () => rows.filter((r) => r.enabled).map((r) => {
    const s = svc(r.serviceKey);
    if (s.key === 'custom') return r.paramValue ? (r.paramValue.endsWith('/') ? r.paramValue : r.paramValue + '/') : 'https://…/';
    return s.template.replace('{param}', r.paramValue || `{${s.paramLabel}}`);
  });
  const strip = (u) => u.replace(/^https?:\/\//i, '');
  const drawPreview = () => {
    const c = chain();
    let out = sample;
    for (let i = c.length - 1; i >= 0; i--) out = c[i] + strip(out);
    preview.replaceChildren(h('b', null, c.length ? 'Episode links will look like this' : 'Episode links (no prefixes)'), out);
  };

  const draw = () => {
    const onCount = rows.filter((r) => r.enabled).length;
    const items = rows.map((r, i) => {
      const s = svc(r.serviceKey);
      const box = h('input', {
        type: 'checkbox',
        checked: r.enabled,
        disabled: !canEdit,
        onchange: () => {
          r.enabled = box.checked;
          // Newly ticked services join the end of the chain.
          rows.splice(i, 1);
          rows.splice(box.checked ? onCount : onCount - 1, 0, r);
          settle();
          draw();
        },
      });
      const param = s.paramLabel ? h('input', {
        type: s.key === 'custom' ? 'url' : 'text',
        value: r.paramValue,
        placeholder: s.key === 'custom' ? 'https://tracking.example.com/prefix/' : '',
        disabled: !canEdit,
        'aria-label': `${s.name} ${s.paramLabel}`,
        oninput: (e) => { r.paramValue = e.target.value; drawPreview(); },
      }) : null;
      return h('li', null,
        h('div', null,
          h('label', { class: 'check' }, box, h('span', null, s.name)),
          param && (r.enabled || s.key === 'custom') ? h('div', { class: 'param' }, h('label', { class: 'hint' }, s.paramLabel), param) : null),
        canEdit ? h('div', { class: 'order' },
          s.key === 'custom' ? h('button', { type: 'button', class: 'quiet', 'aria-label': 'Remove custom prefix', onclick: () => { rows.splice(i, 1); draw(); } }, 'Remove') : null,
          r.enabled && onCount > 1 ? [
            h('button', { type: 'button', class: 'quiet', disabled: i === 0, 'aria-label': `Move ${s.name} earlier`, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } }, '↑'),
            h('button', { type: 'button', class: 'quiet', disabled: i === onCount - 1, 'aria-label': `Move ${s.name} later`, onclick: () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); } }, '↓'),
          ] : null) : null);
    });
    if (onCount && onCount < rows.length) items.splice(onCount, 0, h('li', { class: 'divider' }, 'Not in use'));
    list.replaceChildren(...items);
    drawPreview();
  };
  draw();

  const alt = h('input', { type: 'checkbox', checked: altEnclosures, disabled: !canEdit, onchange: () => { altEnclosures = alt.checked; } });
  const save = h('button', {
    class: 'primary',
    type: 'button',
    disabled: !canEdit,
    onclick: async () => {
      err.hidden = true;
      save.disabled = true;
      try {
        await api('PUT', `/api/podcasts/${p.id}/prefixes`, {
          settings: rows.map((r, i) => ({ ...r, position: i })),
          prefixAlternateEnclosures: altEnclosures,
        });
        toast('Stats prefixes saved');
        reload();
      } catch (e) {
        showError(err, e);
        save.disabled = false;
      }
    },
  }, 'Save stats prefixes');

  return h('div', { class: 'panel' },
    h('h2', null, 'Stats prefixes'),
    h('p', { class: 'muted' }, 'Measurement services count downloads by sitting in front of each episode’s link. Tick the ones you have an account with. Ticked services run in the order shown; use the arrows to change it.'),
    list,
    canEdit ? h('div', { class: 'actions', style: 'margin-top:4px' },
      h('button', { type: 'button', class: 'quiet', onclick: () => { rows.push({ serviceKey: 'custom', enabled: true, paramValue: '', position: rows.length }); settle(); draw(); } }, 'Add a custom prefix')) : null,
    preview,
    h('div', { class: 'field', style: 'margin-top:16px' },
      h('label', { class: 'check' }, alt, h('span', null, 'Also add prefixes to alternate versions (such as video editions)'))),
    err,
    canEdit ? h('div', { class: 'actions' }, save) : h('p', { class: 'hint' }, 'You have read-only access to this show.'));
}

async function tabPodping(p, canEdit, reload) {
  const st = await api('GET', `/api/podcasts/${p.id}/podping`);
  const toggle = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: st.enabled,
    disabled: !canEdit,
    onchange: async () => {
      toggle.disabled = true;
      try {
        await api('PUT', `/api/podcasts/${p.id}/podping`, { enabled: toggle.checked });
        toast(toggle.checked ? 'Podping turned on' : 'Podping turned off');
        await refreshPodcasts();
        reload();
      } catch (e) {
        toast(e.message);
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
      }
    },
  });
  const reasons = { update: 'Feed updated', live: 'Went live', liveEnd: 'Live show ended' };
  return h('div', null,
    h('section', { class: 'panel' },
      h('h2', null, 'Podping'),
      h('p', { class: 'muted' }, 'Podping tells podcast apps the moment your feed changes, so new episodes show up in minutes instead of hours. It goes through Podcast Index; there’s nothing to set up.'),
      h('label', { class: 'switch' }, toggle, st.enabled ? 'Podping is on for this show' : 'Podping is off for this show'),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'Imported shows start with Podping off. Turn it on after your old host redirects to this feed; turning it on announces the feed once.')),
    st.pings.length ? h('section', { class: 'panel', style: 'padding:0' },
      h('h3', { class: 'table-title' }, 'Recent notifications'), h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Change'), h('th', null, 'Result'), h('th', null, 'When'))),
      h('tbody', null, st.pings.map((x) => h('tr', null,
        h('td', null, reasons[x.reason] ?? x.reason),
        h('td', null, x.status === 'sent' ? h('span', { class: 'light on' }, 'Sent')
          : x.status === 'pending' ? h('span', { class: 'light warn' }, x.attempts ? `Retrying (${x.lastError})` : 'Waiting to send')
            : h('span', { class: 'light bad' }, `Gave up: ${x.lastError}`)),
        h('td', { class: 'nowrap' }, fmtDate(x.sentAt ?? x.createdAt, true)))))))) : null);
}

// Live items
async function tabLive(p, canEdit, reload) {
  const { liveItems } = await api('GET', `/api/podcasts/${p.id}/live`);
  const wrap = h('div');
  const statusText = { pending: 'Scheduled', live: 'On air', ended: 'Ended' };

  const setStatus = async (li, status, btn) => {
    if (status === 'ended' && !confirm(`End “${li.title}”? Apps will show it as over.`)) return;
    btn.disabled = true;
    try {
      await api('POST', `/api/podcasts/${p.id}/live/${li.id}/status`, { status });
      toast(status === 'live' ? 'You’re live' : status === 'ended' ? 'Live show ended' : 'Moved back to scheduled');
      await refreshPodcasts();
      reload();
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  };

  // On air first, then upcoming (soonest first), then past (most recent first).
  const rank = { live: 0, pending: 1, ended: 2 };
  const t = (li) => (li.start ? Date.parse(li.start) : 0);
  const items = liveItems.slice().sort((a, b) =>
    rank[a.status] - rank[b.status] || (a.status === 'ended' ? t(b) - t(a) : t(a) - t(b)));
  const list = h('ul', { class: 'live-list' }, items.map((li) => {
    const btns = [];
    if (canEdit) {
      if (li.status === 'pending') {
        const b = h('button', { type: 'button', class: 'golive', onclick: () => setStatus(li, 'live', b) }, 'Go live');
        btns.push(b);
      }
      if (li.status === 'live') {
        const b = h('button', { type: 'button', class: 'danger solid', onclick: () => setStatus(li, 'ended', b) }, 'End live show');
        btns.push(b);
      }
      if (li.status === 'ended') {
        const b = h('button', { type: 'button', onclick: () => setStatus(li, 'pending', b) }, 'Schedule again');
        btns.push(b);
      }
      btns.push(h('button', { type: 'button', class: 'quiet', onclick: () => openForm(li) }, 'Edit'));
      if (li.status !== 'live') {
        btns.push(h('button', {
          type: 'button',
          class: 'quiet',
          onclick: async () => {
            if (!confirm(`Remove “${li.title}” from the feed?`)) return;
            await api('DELETE', `/api/podcasts/${p.id}/live/${li.id}`);
            toast('Live show removed');
            await refreshPodcasts();
            reload();
          },
        }, 'Remove'));
      }
    }
    return h('li', { class: li.status === 'live' ? 'is-live' : '' },
      h('div', null,
        h('h3', null, li.title, h('span', { class: `pill ${li.status}` }, statusText[li.status])),
        h('p', { class: 'when' }, li.start ? fmtDate(li.start, true) : 'No start time', li.end ? ` until ${fmtDate(li.end, true)}` : ''),
        li.streamUrl ? h('p', { class: 'stream' }, li.streamUrl) : null,
        li.contentLinks.length ? h('p', { class: 'hint' }, li.contentLinks.map((l, i) => [i ? ', ' : '', h('a', { href: l.href, target: '_blank', rel: 'noopener' }, l.text)])) : null),
      h('div', { class: 'btns' }, btns));
  }));

  const formSlot = h('div');
  function openForm(li) {
    const err = formError();
    const title = h('input', { type: 'text', required: true, value: li?.title ?? '' });
    const start = h('input', { type: 'datetime-local', required: true, value: toInputValue(li?.start) });
    const end = h('input', { type: 'datetime-local', value: toInputValue(li?.end) });
    const stream = h('input', { type: 'url', required: true, value: li?.streamUrl ?? '', placeholder: 'https://stream.example.com/live.mp3' });
    const type = h('select', null, [
      ['audio/mpeg', 'MP3 audio'], ['audio/aac', 'AAC audio'], ['audio/ogg', 'Ogg / Opus audio'],
      ['application/x-mpegURL', 'HLS stream (.m3u8)'], ['video/mp4', 'MP4 video'],
    ].map(([v, t]) => h('option', { value: v }, t)));
    type.value = li?.streamType ?? 'audio/mpeg';
    const image = h('input', { type: 'url', value: li?.imageUrl ?? '', placeholder: 'Optional' });
    const desc = h('textarea', null, li?.description ?? '');
    const links = (li?.contentLinks ?? []).concat([{ href: '', text: '' }, { href: '', text: '' }]).slice(0, Math.max(2, (li?.contentLinks?.length ?? 0) + 1));
    const linkRows = links.map((l) => ({
      href: h('input', { type: 'url', value: l.href, placeholder: 'https://youtube.com/live/…', 'aria-label': 'Link address' }),
      text: h('input', { type: 'text', value: l.text, placeholder: 'Watch on YouTube', 'aria-label': 'Link text' }),
    }));

    const form = h('form', {
      class: 'panel',
      onsubmit: (ev) => {
        ev.preventDefault();
        err.hidden = true;
        busy(form, async () => {
          const body = {
            title: title.value,
            start: localIso(start.value),
            end: end.value ? localIso(end.value) : null,
            streamUrl: stream.value,
            streamType: type.value,
            imageUrl: image.value || null,
            description: desc.value,
            contentLinks: linkRows.filter((r) => r.href.value).map((r) => ({ href: r.href.value, text: r.text.value })),
          };
          try {
            if (li) await api('PATCH', `/api/podcasts/${p.id}/live/${li.id}`, body);
            else await api('POST', `/api/podcasts/${p.id}/live`, body);
            toast(li ? 'Live show updated' : 'Live show scheduled');
            await refreshPodcasts();
            reload();
          } catch (e) {
            showError(err, e);
          }
        });
      },
    },
    h('h2', null, li ? `Edit “${li.title}”` : 'Schedule a live show'),
    h('p', { class: 'muted' }, 'This adds the broadcast to your feed so apps can show it as coming up. This site doesn’t stream: use the address of your own stream (Icecast, YouTube and so on).'),
    field('Title', title),
    h('div', { class: 'row' }, field('Starts', start), field('Ends (optional)', end)),
    h('div', { class: 'row' }, field('Stream address', stream), field('Stream type', type)),
    field('Description (optional)', desc),
    field('Image address (optional)', image),
    h('div', { class: 'field' }, h('label', null, 'Links to watch or listen (optional)'),
      linkRows.map((r) => h('div', { class: 'row', style: 'margin-bottom:8px' }, h('div', { style: 'flex:2 1 260px' }, r.href), h('div', { style: 'flex:1 1 160px' }, r.text)))),
    li?.otherTags?.length ? h('p', { class: 'hint' }, `Also kept from the original feed: ${li.otherTags.join(', ')}.`) : null,
    err,
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'submit' }, li ? 'Save changes' : 'Schedule live show'),
      h('button', { type: 'button', onclick: () => formSlot.replaceChildren() }, 'Cancel')));
    formSlot.replaceChildren(form);
    title.focus();
    form.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  wrap.append(
    h('section', { class: 'panel' },
      h('h2', null, 'Live shows'),
      h('p', { class: 'muted' }, p.podping.enabled
        ? 'Going live and ending a show update the feed and send a Podping, so listeners’ apps react right away.'
        : 'Going live and ending a show update the feed. Turn on Podping to alert apps instantly.'),
      items.length ? list : h('p', { class: 'muted' }, 'No live shows scheduled.'),
      canEdit ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => openForm(null) }, 'Schedule a live show')) : null),
    formSlot);
  return wrap;
}

// ───────────── team ─────────────

const ROLE_HELP = [
  ['Owner', 'Everything, including the team, the feed address and deleting the show. One per show.'],
  ['Editor', 'Episodes, show details, stats prefixes, Podping and live shows.'],
  ['Viewer', 'Can look at everything, can’t change anything.'],
];

async function tabTeam(p, canEdit, reload) {
  const { team, me } = await api('GET', `/api/podcasts/${p.id}/team`);
  const isOwner = p.role === 'owner';
  const err = formError();
  const act = async (fn, msg) => {
    err.hidden = true;
    try {
      await fn();
      if (msg) toast(msg);
      await refreshPodcasts();
      reload();
    } catch (e) {
      showError(err, e);
    }
  };

  const rows = team.map((m) => {
    const who = h('div', null, h('b', null, m.displayName || m.email), m.userId === me ? h('span', { class: 'hint' }, ' (you)') : null,
      m.displayName ? h('div', { class: 'hint' }, m.email) : null);
    let roleCell;
    const actions = [];
    if (m.role === 'owner') roleCell = h('span', { class: 'pill' }, 'Owner');
    else if (isOwner) {
      const sel = h('select', { 'aria-label': `Role for ${m.email}` }, h('option', { value: 'editor' }, 'Editor'), h('option', { value: 'viewer' }, 'Viewer'));
      sel.value = m.role;
      sel.addEventListener('change', () => act(() => api('PATCH', `/api/podcasts/${p.id}/team/${m.userId}`, { role: sel.value }), 'Role changed'));
      roleCell = sel;
      actions.push(h('button', {
        type: 'button',
        class: 'quiet',
        onclick: () => {
          if (!confirm(`Make ${m.displayName || m.email} the owner of “${p.title}”? You’ll stay on the team as an editor.`)) return;
          act(() => api('PATCH', `/api/podcasts/${p.id}/team/${m.userId}`, { role: 'owner' }), 'Ownership handed over');
        },
      }, 'Make owner'));
      actions.push(h('button', {
        type: 'button',
        class: 'quiet danger',
        onclick: () => confirm(`Remove ${m.displayName || m.email} from “${p.title}”?`) &&
          act(() => api('DELETE', `/api/podcasts/${p.id}/team/${m.userId}`), 'Removed from the team'),
      }, 'Remove'));
    } else {
      roleCell = h('span', { class: 'pill' }, m.role === 'editor' ? 'Editor' : 'Viewer');
      if (m.userId === me) {
        actions.push(h('button', {
          type: 'button',
          class: 'quiet danger',
          onclick: async () => {
            if (!confirm(`Leave “${p.title}”? You’ll lose access until the owner adds you again.`)) return;
            try {
              await api('DELETE', `/api/podcasts/${p.id}/team/${me}`);
              await refreshPodcasts();
              toast('You left the show');
              go('#/');
            } catch (e) {
              showError(err, e);
            }
          },
        }, 'Leave this show'));
      }
    }
    return h('tr', null, h('td', null, who), h('td', null, roleCell), h('td', { class: 'team-actions' }, actions));
  });

  const parts = [h('section', { class: 'panel' },
    h('h2', null, 'Team'),
    h('p', { class: 'muted' }, isOwner ? 'Everyone here can open this show in their own dashboard.' : 'Everyone who can open this show. Only the owner can change the team.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'team' },
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Role'), h('th', null, ''))),
      h('tbody', null, rows))),
    err)];

  if (isOwner) {
    const addErr = formError();
    const email = h('input', { type: 'email', required: true, placeholder: 'name@example.com' });
    const role = h('select', null, h('option', { value: 'editor' }, 'Editor'), h('option', { value: 'viewer' }, 'Viewer'));
    const form = h('form', {
      class: 'panel',
      onsubmit: (ev) => {
        ev.preventDefault();
        addErr.hidden = true;
        busy(form, async () => {
          try {
            await api('POST', `/api/podcasts/${p.id}/team`, { email: email.value, role: role.value });
            toast('Added to the team');
            reload();
          } catch (e) {
            showError(addErr, e);
          }
        });
      },
    },
    h('h2', null, 'Add someone'),
    h('p', { class: 'muted' }, state.me.isAdmin
      ? 'They need an account on this site. Create one on the People page if they don’t have one yet.'
      : 'They need an account on this site. If they don’t have one, ask the site administrator to create it.'),
    h('div', { class: 'row' }, h('div', { class: 'field', style: 'flex:3 1 260px' }, h('label', { for: 'team-email' }, 'Their email'), (email.id = 'team-email', email)), field('Role', role),
      h('div', { class: 'field', style: 'flex:0 0 auto' }, h('button', { class: 'primary', type: 'submit' }, 'Add'))),
    addErr);
    parts.push(form);
  }

  parts.push(h('section', { class: 'panel' }, h('h2', null, 'What each role can do'),
    h('dl', { class: 'facts', style: 'margin-top:12px' }, ROLE_HELP.map(([r, d]) => [h('dt', null, r), h('dd', null, d)]))));
  return h('div', null, parts);
}

async function feedAndDelete(p) {
  const err = formError();
  const confirmInput = h('input', { type: 'text', autocomplete: 'off', 'aria-label': `Type ${p.slug} to confirm` });
  const del = h('button', {
    class: 'danger solid',
    type: 'button',
    onclick: async () => {
      err.hidden = true;
      if (confirmInput.value !== p.slug) return showError(err, `Type ${p.slug} to confirm.`);
      del.disabled = true;
      try {
        await api('DELETE', `/api/podcasts/${p.id}`);
        await refreshPodcasts();
        toast('Show deleted');
        go('#/');
      } catch (e) {
        showError(err, e);
        del.disabled = false;
      }
    },
  }, 'Delete this show');
  return h('div', null,
    h('section', { class: 'panel', id: 'section-feed' },
      h('h2', null, 'Feed and show facts'),
      h('p', { class: 'muted' }, 'The feed address can’t be changed once a show is listed, because podcast apps and directories keep it.'),
      h('dl', { class: 'facts' },
        h('dt', null, 'Feed'), h('dd', null, p.feedUrl),
        h('dt', null, 'Media'), h('dd', null, `${state.setup.publicBaseUrl}/${p.slug}/media/`),
        h('dt', null, 'Podcast GUID'), h('dd', null, p.podcastGuid ?? '—'),
        h('dt', null, 'Episodes'), h('dd', null, p.episodeCount),
        p.sourceFeedUrl ? [h('dt', null, 'Imported from'), h('dd', null, p.sourceFeedUrl)] : null,
        p.importedAt ? [h('dt', null, 'Imported'), h('dd', null, fmtDate(p.importedAt, true))] : null,
        h('dt', null, 'Your access'), h('dd', null, { owner: 'Owner', editor: 'Editor', viewer: 'Viewer (read only)' }[p.role]))),
    p.role !== 'owner' ? null : h('section', { class: 'panel', id: 'section-delete' },
      h('h2', null, 'Delete this show'),
      h('p', { class: 'muted' }, 'Removes the feed, every episode and all copied media from this server. Subscribers following this feed will stop getting episodes. This can’t be undone.'),
      field(`Type ${p.slug} to confirm`, confirmInput),
      err,
      h('div', { class: 'actions' }, del)));
}

/** Settings: Podping, stats prefixes, the team, feed facts and (owners) deleting the show. */
async function tabSettings(p, canEdit, reload) {
  const parts = [
    ['podping', 'Podping', await tabPodping(p, canEdit, reload)],
    ['prefixes', 'Stats prefixes', await tabPrefixes(p, canEdit, reload)],
    ['team', 'Team', await tabTeam(p, canEdit, reload)],
    ['feed', 'Feed', null],
  ];
  const rest = await feedAndDelete(p);
  if (p.role === 'owner') parts.push(['delete', 'Delete show', null]);
  return h('div', null,
    h('nav', { class: 'jump', 'aria-label': 'Settings sections' }, parts.map(([k, label]) => h('button', {
      type: 'button',
      class: 'quiet',
      onclick: () => document.getElementById(`section-${k}`)?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }),
    }, label))),
    parts.filter(([, , el]) => el).map(([k, , el]) => h('div', { id: `section-${k}`, class: 'settings-section' }, el)),
    rest);
}

// ───────────── account & people ─────────────

async function viewAccount() {
  const err = formError();
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const form = h('form', {
    class: 'panel',
    onsubmit: (ev) => {
      ev.preventDefault();
      err.hidden = true;
      busy(form, async () => {
        try {
          await api('POST', '/api/me/password', { currentPassword: cur.value, newPassword: next.value });
          form.reset();
          toast('Password changed. Other devices were signed out.');
        } catch (e) {
          showError(err, e);
        }
      });
    },
  },
  h('h2', null, 'Change password'),
  h('p', { class: 'muted' }, 'Changing your password signs you out on every other device.'),
  field('Current password', cur),
  field('New password', next, 'At least 10 characters.'),
  err,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Change password')));
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Account'), h('p', { class: 'muted' }, state.me.email)),
    form);
}

async function viewPeople() {
  const { users } = await api('GET', '/api/admin/users');
  const err = formError();
  const email = h('input', { type: 'email', required: true });
  const name = h('input', { type: 'text' });
  const pw = h('input', { type: 'text', required: true, minlength: 10, autocomplete: 'off' });
  const admin = h('input', { type: 'checkbox' });
  const form = h('form', {
    class: 'panel',
    onsubmit: (ev) => {
      ev.preventDefault();
      err.hidden = true;
      busy(form, async () => {
        try {
          await api('POST', '/api/admin/users', { email: email.value, displayName: name.value, password: pw.value, isAdmin: admin.checked });
          toast('Account created');
          render();
        } catch (e) {
          showError(err, e);
        }
      });
    },
  },
  h('h2', null, 'Add a podcaster'),
  h('p', { class: 'muted' }, 'They sign in with this email and the starting password, then can change it under Account. They see their own shows and any show they’re added to.'),
  h('div', { class: 'row' }, field('Email', email), field('Name (optional)', name)),
  field('Starting password', pw, 'At least 10 characters. Share it with them privately.'),
  h('div', { class: 'field' }, h('label', { class: 'check' }, admin, h('span', null, 'Make them an administrator too'))),
  err,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Create account')));

  const deleteSlot = h('div');
  function openDelete(u) {
    const owned = u.shows.filter((x) => x.role === 'owner');
    const others = users.filter((x) => x.id !== u.id);
    const dErr = formError();
    let mode = owned.length ? 'transfer' : 'none';
    const to = h('select', null, others.map((x) => h('option', { value: x.id }, x.displayName ? `${x.displayName} (${x.email})` : x.email)));
    to.value = state.me.id;
    const confirmBox = h('input', { type: 'text', autocomplete: 'off', placeholder: 'delete' });
    const choice = (value, labelText, extra) => {
      const r = h('input', { type: 'radio', name: 'del-mode', checked: mode === value });
      r.addEventListener('change', () => { mode = value; });
      return h('label', { class: 'choice' }, r, h('span', null, labelText, extra));
    };
    const del = h('button', { type: 'button', class: 'danger solid' }, `Delete ${u.displayName || u.email}`);
    del.addEventListener('click', async () => {
      dErr.hidden = true;
      if (mode === 'delete' && confirmBox.value.trim().toLowerCase() !== 'delete') return showError(dErr, 'Type delete to confirm deleting their shows.');
      del.disabled = true;
      try {
        const body = mode === 'transfer' ? { shows: 'transfer', transferTo: to.value } : mode === 'delete' ? { shows: 'delete' } : {};
        const r = await api('DELETE', `/api/admin/users/${u.id}`, body);
        toast(r.transferred ? `Account deleted; ${r.transferred} show${r.transferred === 1 ? '' : 's'} handed over` : r.deletedShows ? 'Account and shows deleted' : 'Account deleted');
        await refreshPodcasts();
        render();
      } catch (e) {
        showError(dErr, e);
        del.disabled = false;
      }
    });
    deleteSlot.replaceChildren(h('section', { class: 'panel danger-panel' },
      h('h2', null, `Delete ${u.displayName || u.email}?`),
      h('p', { class: 'muted' }, 'They won’t be able to sign in, and they’re removed from every show’s team. This can’t be undone.'),
      owned.length ? [
        h('p', null, `They own ${owned.length === 1 ? 'one show' : `${owned.length} shows`}: ${owned.map((x) => x.title).join(', ')}.`),
        h('div', { class: 'choices' },
          choice('transfer', 'Give their shows to someone else', h('small', null, 'Episodes, media and feed addresses stay exactly as they are. ', to)),
          choice('delete', 'Delete their shows too', h('small', null, 'Removes the feeds, every episode and all media. Type delete to confirm: ', confirmBox))),
      ] : null,
      dErr,
      h('div', { class: 'actions' }, del, h('button', { type: 'button', onclick: () => deleteSlot.replaceChildren() }, 'Cancel'))));
    deleteSlot.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  const roleLabel = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'People')),
    h('section', { class: 'panel', style: 'padding:0' }, h('div', { class: 'table-wrap' }, h('table', { class: 'people-table' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Shows'), h('th', null, 'Joined'), h('th', null, ''))),
      h('tbody', null, users.map((u) => {
        const self = u.id === state.me.id;
        const adminBtn = h('button', {
          type: 'button',
          class: 'quiet',
          disabled: self && u.isAdmin,
          title: self ? 'You can’t remove your own administrator access' : null,
          onclick: async () => {
            if (u.isAdmin && !confirm(`Remove administrator access from ${u.displayName || u.email}?`)) return;
            try {
              await api('PATCH', `/api/admin/users/${u.id}`, { isAdmin: !u.isAdmin });
              toast(u.isAdmin ? 'No longer an administrator' : 'Now an administrator');
              render();
            } catch (e) {
              toast(e.message);
            }
          },
        }, u.isAdmin ? 'Remove admin' : 'Make admin');
        return h('tr', null,
          h('td', null, h('b', null, u.displayName || u.email), u.isAdmin ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'Admin') : null,
            self ? h('span', { class: 'hint' }, ' (you)') : null, u.displayName ? h('div', { class: 'hint' }, u.email) : null),
          h('td', null, u.shows.length
            ? h('ul', { class: 'show-roles' }, u.shows.map((x) => h('li', null, x.title, h('span', { class: 'hint' }, ` · ${roleLabel[x.role]}`))))
            : h('span', { class: 'hint' }, 'None')),
          h('td', { class: 'nowrap' }, fmtDate(u.createdAt)),
          h('td', { class: 'team-actions' }, adminBtn,
            self ? null : h('button', { type: 'button', class: 'quiet danger', onclick: () => openDelete(u) }, 'Delete')));
      }))))),
    deleteSlot,
    h('p', { class: 'hint', style: 'margin:-8px 0 24px' }, 'To let someone work on a show, add them on that show’s Team tab.'),
    form);
}

// ───────────── site settings (admin) ─────────────

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('That file could not be read'));
  r.readAsDataURL(file);
});

async function refreshSetup() {
  state.setup = await api('GET', '/api/setup');
  applyBranding();
}

async function viewSite() {
  const [{ settings: s }, storage] = await Promise.all([api('GET', '/api/admin/site'), api('GET', '/api/admin/storage')]);
  const remoteStorage = storage.current.provider !== 'local';

  // Branding: name + logo + favicon
  const nameErr = formError();
  const name = h('input', { type: 'text', value: s.siteName, maxlength: 60, required: true });

  const assetBlock = (kind, label, hint, accept, has) => {
    const err = formError();
    const preview = h('img', { class: `asset-preview ${kind}`, src: `/site/${kind}?v=${state.setup.siteVersion}`, alt: `Current ${label.toLowerCase()}` });
    const file = h('input', {
      type: 'file',
      accept,
      class: 'sr-only',
      onchange: async () => {
        err.hidden = true;
        const f = file.files[0];
        if (!f) return;
        try {
          await api('POST', `/api/admin/site/${kind}`, { dataUrl: await readAsDataUrl(f) });
          await refreshSetup();
          toast(`${label} updated`);
          render();
        } catch (e) {
          showError(err, e);
        }
      },
    });
    const id = `upload-${kind}`;
    file.id = id;
    return h('div', { class: 'asset' },
      preview,
      h('div', null,
        h('h3', null, label),
        h('p', { class: 'hint' }, hint),
        err,
        h('div', { class: 'actions', style: 'margin-top:8px' },
          file,
          h('label', { for: id, class: 'btn', tabindex: 0, role: 'button', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } },
            has ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`),
          has ? h('button', {
            type: 'button',
            class: 'quiet',
            onclick: async () => {
              await api('DELETE', `/api/admin/site/${kind}`);
              await refreshSetup();
              toast(`${label} removed`);
              render();
            },
          }, 'Use the default') : null)));
  };

  const brandForm = h('form', {
    class: 'panel',
    onsubmit: (ev) => {
      ev.preventDefault();
      nameErr.hidden = true;
      busy(brandForm, async () => {
        try {
          await api('PUT', '/api/admin/site', { siteName: name.value });
          await refreshSetup();
          toast('Site name saved');
          render();
        } catch (e) {
          showError(nameErr, e);
        }
      });
    },
  },
  h('h2', null, 'Name and logo'),
  h('p', { class: 'muted' }, 'Shown on the sign-in page, in the sidebar and in browser tabs.'),
  field('Site name', name),
  nameErr,
  h('div', { class: 'actions', style: 'margin:0 0 24px' }, h('button', { class: 'primary', type: 'submit' }, 'Save site name')),
  assetBlock('logo', 'Logo', 'PNG, JPEG, WebP or SVG, up to 1 MB. A square mark works best; it’s shown small next to the site name.', 'image/png,image/jpeg,image/webp,image/svg+xml', s.hasLogo),
  assetBlock('favicon', 'Favicon', 'The browser-tab icon. PNG, SVG or ICO, up to 1 MB; 64×64 or larger.', 'image/png,image/svg+xml,image/x-icon,.ico', s.hasFavicon));

  // Address
  const addrErr = formError();
  const base = h('input', { type: 'url', value: s.publicBaseUrl, required: true, placeholder: 'https://podcasts.example.com' });
  const media = h('input', { type: 'url', value: s.mediaBaseUrl, placeholder: 'Same as the site address' });
  const here = location.origin;
  const useHere = here !== s.publicBaseUrl
    ? h('p', { class: 'hint' }, `You’re viewing this page at ${here}. `,
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); base.value = here; } }, 'Use this address'))
    : null;
  const addrForm = h('form', {
    class: 'panel',
    onsubmit: (ev) => {
      ev.preventDefault();
      addrErr.hidden = true;
      const newBase = base.value.trim().replace(/\/+$/, '');
      try {
        const u = new URL(newBase);
        if (u.pathname !== '/' && u.pathname !== '') return showError(addrErr, `The site address can’t include a path. Use just the address, like ${u.origin}`);
      } catch {
        return showError(addrErr, 'Enter the full address, like https://podcasts.example.com');
      }
      const changing = newBase !== s.publicBaseUrl || media.value.trim().replace(/\/+$/, '') !== s.mediaBaseUrl;
      if (!changing) return toast('No changes to save');
      if (s.showCount && !confirm(
        `Change the address for ${s.showCount} show${s.showCount === 1 ? '' : 's'}?\n\n` +
        'Every feed and media link moves to the new address. Apps already subscribed keep using the old address, ' +
        'so keep the old address pointed at this server: requests that arrive there are redirected to the new one.')) return;
      busy(addrForm, async () => {
        try {
          const { result } = await api('PUT', '/api/admin/site', { publicBaseUrl: newBase, mediaBaseUrl: media.value.trim() || null });
          await refreshSetup();
          toast(result.addressChanged ? `Address saved. ${result.rewrittenShows} show${result.rewrittenShows === 1 ? '' : 's'} updated.` : 'Saved');
          if (new URL(state.setup.publicBaseUrl).origin !== location.origin) {
            alert(`Saved. This site’s address is now ${state.setup.publicBaseUrl}.\n\nMake sure that address reaches this server (DNS or your Cloudflare Tunnel) before sharing feeds.`);
          }
          render();
        } catch (e) {
          showError(addrErr, e);
        }
      });
    },
  },
  h('h2', null, 'Web address'),
  h('p', { class: 'muted' }, 'The address listeners and podcast apps use. Every show’s feed lives at this address followed by /show-name/feed.xml.'),
  field('Site address', base, 'Just the address, without a path, for example https://podcasts.example.com.'),
  useHere,
  remoteStorage
    ? h('p', { class: 'hint' }, `Episode files are served from ${storage.current.publicBase} (see Media storage below).`)
    : field('Media address (optional)', media, 'Leave blank to serve episode files from the site address. Set it to a pull-through CDN address that fetches from this server.'),
  s.previousHosts.length ? h('p', { class: 'hint' }, `Requests that reach this server at ${s.previousHosts.join(', ')} are redirected to the current address.`) : null,
  s.showCount ? h('p', { class: 'warn-note' }, 'Changing this after shows are live moves every feed. Subscribers only follow along if the old address still reaches this server.') : null,
  addrErr,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Save web address')));

  // Sign-ups
  const reg = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: s.allowRegistration,
    onchange: async () => {
      reg.disabled = true;
      try {
        await api('PUT', '/api/admin/site', { allowRegistration: reg.checked });
        await refreshSetup();
        toast(reg.checked ? 'Anyone can now create an account' : 'Only admins can add accounts now');
      } catch (e) {
        toast(e.message);
        reg.checked = !reg.checked;
      }
      reg.disabled = false;
    },
  });

  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Site settings'),
      h('p', { class: 'muted' }, 'These apply to the whole site and every podcaster on it.')),
    brandForm,
    addrForm,
    storagePanel(storage),
    verifyPanel(s),
    h('section', { class: 'panel' },
      h('h2', null, 'Sign-ups'),
      h('label', { class: 'switch', style: 'margin-top:12px' }, reg, 'Anyone can create an account'),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'When off, only admins can add podcasters (under People).')));
}

// ───────────── ownership verification + email ─────────────

function verifyPanel(s) {
  const req = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: s.requireVerification,
    onchange: async () => {
      req.disabled = true;
      try {
        await api('PUT', '/api/admin/site', { requireVerification: req.checked });
        toast(req.checked ? 'Imports now need ownership verification' : 'Verification turned off');
      } catch (e) {
        toast(e.message);
        req.checked = !req.checked;
      }
      req.disabled = false;
    },
  });

  const m = s.smtp;
  const mail = s.mail;
  let provider = mail.provider;
  const err = formError();
  const from = h('input', { type: 'text', value: mail.from, placeholder: `${siteName()} <podcasts@example.com>` });

  // Resend
  const resendKey = h('input', { type: 'password', autocomplete: 'off', placeholder: mail.resendKeySet ? 'Saved. Leave blank to keep it.' : 're_…' });
  const resendBox = h('div', null,
    h('p', { class: 'hint' }, 'Create an API key with Sending access at ',
      h('a', { href: 'https://resend.com/api-keys', target: '_blank', rel: 'noopener' }, 'resend.com/api-keys'),
      ', and verify your domain at ',
      h('a', { href: 'https://resend.com/domains', target: '_blank', rel: 'noopener' }, 'resend.com/domains'),
      '. The From address must be on that domain.'),
    h('div', { class: 'fields-grid' }, field('Resend API key', resendKey)));

  // SMTP
  const hostIn = h('input', { type: 'text', value: m.host, placeholder: 'smtp.example.com', autocomplete: 'off' });
  const sec = h('select', null, h('option', { value: 'starttls' }, 'STARTTLS (usually port 587)'), h('option', { value: 'tls' }, 'TLS (usually port 465)'), h('option', { value: 'none' }, 'None (not recommended)'));
  sec.value = m.security;
  const port = h('input', { type: 'text', inputmode: 'numeric', value: m.port ?? '', placeholder: sec.value === 'tls' ? '465' : '587' });
  sec.addEventListener('change', () => { port.placeholder = sec.value === 'tls' ? '465' : '587'; });
  const user = h('input', { type: 'text', value: m.user, autocomplete: 'off' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: m.passwordSet ? 'Saved. Leave blank to keep it.' : '' });
  const smtpBox = h('div', { class: 'fields-grid' },
    field('Mail server', hostIn), field('Security', sec), field('Port', port), field('Username', user), field('Password', pass));

  const boxes = h('div');
  const drawBox = () => boxes.replaceChildren(provider === 'resend' ? resendBox : smtpBox);
  const choice = (value, label, blurb) => {
    const r = h('input', { type: 'radio', name: 'mail-provider', value, checked: provider === value, onchange: () => { provider = value; err.hidden = true; drawBox(); } });
    return h('label', { class: `provider ${provider === value ? 'chosen' : ''}` }, r, h('span', null, h('b', null, label), h('span', { class: 'hint' }, blurb)));
  };
  const choices = h('div', { class: 'providers', role: 'radiogroup', 'aria-label': 'How email is sent' },
    choice('resend', 'Resend', 'Send through Resend’s API with an API key.'),
    choice('smtp', 'SMTP server', 'Your email provider’s SMTP server (Postmark, SES, Gmail, your host…).'));
  choices.addEventListener('change', () => choices.querySelectorAll('.provider').forEach((el) => el.classList.toggle('chosen', el.querySelector('input').checked)));
  drawBox();

  const form = h('form', {
    onsubmit: (ev) => {
      ev.preventDefault();
      err.hidden = true;
      busy(form, async () => {
        try {
          await api('PUT', '/api/admin/site', provider === 'resend'
            ? { resend: { apiKey: resendKey.value || undefined, from: from.value } }
            : { smtp: { host: hostIn.value, port: port.value, security: sec.value, user: user.value, password: pass.value || undefined, from: from.value } });
          toast('Email settings saved');
          render();
        } catch (e) {
          showError(err, e);
        }
      });
    },
  },
  choices,
  boxes,
  h('div', { class: 'fields-grid' }, field('From', from, 'The sender shown to podcasters, e.g. Studio Name <podcasts@example.com>.')),
  err,
  h('div', { class: 'actions' },
    h('button', { class: 'primary', type: 'submit' }, 'Save email settings'),
    mail.configured ? h('button', {
      type: 'button',
      class: 'quiet',
      onclick: async () => {
        if (!confirm('Remove the email settings? Podcasters will only be able to verify with the feed tag.')) return;
        await api('PUT', '/api/admin/site', { resend: null, smtp: null });
        toast('Email settings removed');
        render();
      },
    }, 'Remove') : null));

  const testTo = h('input', { type: 'email', placeholder: state.me.email, 'aria-label': 'Send the test to' });
  const testMsg = h('p', { class: 'hint', role: 'status' });
  const testBtn = h('button', {
    type: 'button',
    disabled: !mail.configured,
    onclick: async () => {
      testBtn.disabled = true;
      testMsg.className = 'hint';
      testMsg.textContent = 'Sending…';
      try {
        const r = await api('POST', '/api/admin/site/test-email', { to: testTo.value || undefined });
        testMsg.textContent = `Sent to ${r.sentTo}. Check that inbox (and its spam folder).`;
      } catch (e) {
        testMsg.className = 'error';
        testMsg.textContent = e.message;
      }
      testBtn.disabled = false;
    },
  }, 'Send test email');

  return h('section', { class: 'panel' },
    h('h2', null, 'Ownership verification'),
    h('p', { class: 'muted' }, 'Before a show is imported, the person importing it proves they own it: by adding a tag to the feed at their current host, or with a code emailed to the owner address in the feed. Admins can skip it for shows they manage.'),
    h('label', { class: 'switch', style: 'margin:12px 0 20px' }, req, 'Require verification for every import'),
    h('h3', null, 'Email for verification codes'),
    h('p', { class: 'hint', style: 'margin-bottom:12px' }, mail.configured
      ? h('span', { class: 'light on' }, `Email is set up (${mail.provider === 'resend' ? 'Resend' : 'SMTP'})`)
      : 'Optional. Without it, podcasters verify with the feed tag.'),
    form,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('div', { style: 'flex:0 1 280px' }, testTo), testBtn),
    testMsg);
}

// ───────────── media storage ─────────────

function storagePanel(storage) {
  const panel = h('section', { class: 'panel' });
  const providers = [{ id: 'local', name: 'This server', blurb: 'Files are stored on this server’s disk and served from the site address.', fields: [] }, ...storage.providers];
  const cur = storage.current;
  let chosen = cur.provider;
  const values = { ...cur.settings };
  let secretValue = '';
  const err = formError();
  const results = h('div');

  const move = storage.move;
  const moving = move && (move.status === 'queued' || move.status === 'running');
  const nameOf = (id) => providers.find((p) => p.id === id)?.name ?? id;

  const status = h('div', { class: 'storage-now' },
    h('span', { class: `light ${cur.provider === 'local' ? '' : 'on'}` },
      cur.provider === 'local' ? 'Stored on this server' : `Stored with ${nameOf(cur.provider)}`),
    h('span', { class: 'hint' }, `${storage.media.files} files, ${fmtBytes(storage.media.bytes)}. Served from ${cur.publicBase}`));

  const moveBox = h('div');
  const drawMove = (m) => {
    if (!m) return moveBox.replaceChildren();
    if (m.status === 'queued' || m.status === 'running') {
      const pct = m.total ? Math.round((100 * (m.moved + m.failed)) / m.total) : 2;
      moveBox.replaceChildren(h('div', { class: 'move' },
        h('p', null, h('span', { class: 'light warn' }, `Moving media to ${nameOf(m.to)}: ${m.moved} of ${m.total || '…'} files (${fmtBytes(m.bytes)})`)),
        h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Move progress' }, h('span', { style: `width:${pct}%` })),
        h('p', { class: 'hint' }, 'Shows keep working from the current storage until every file has moved. Imports are paused meanwhile.')));
    } else if (m.status === 'failed') {
      moveBox.replaceChildren(h('p', { class: 'warn-note' }, `The last move to ${nameOf(m.to)} stopped: ${m.error} Your shows are still served from the current storage; fix the problem and save again to retry.`));
    } else moveBox.replaceChildren();
  };
  drawMove(move);
  if (moving) {
    const t = setInterval(async () => {
      try {
        const s2 = await api('GET', '/api/admin/storage');
        drawMove(s2.move);
        if (s2.move && !['queued', 'running'].includes(s2.move.status)) {
          clearInterval(t);
          await refreshSetup();
          toast(s2.move.status === 'done' ? `Media moved to ${nameOf(s2.move.to)}` : 'The move stopped');
          render();
        }
      } catch { /* keep polling */ }
    }, 2000);
    cleanup.push(() => clearInterval(t));
  }

  const picker = h('div', { class: 'providers', role: 'radiogroup', 'aria-label': 'Where media is stored' });
  const fieldsBox = h('div');

  const drawPicker = () => picker.replaceChildren(...providers.map((p) => {
    const input = h('input', {
      type: 'radio', name: 'provider', value: p.id, checked: p.id === chosen, disabled: moving,
      onchange: () => {
        chosen = p.id;
        if (chosen !== cur.provider) { for (const k of Object.keys(values)) delete values[k]; } else Object.assign(values, cur.settings);
        secretValue = '';
        results.replaceChildren();
        err.hidden = true;
        drawPicker();
        drawFields();
      },
    });
    return h('label', { class: `provider ${p.id === chosen ? 'chosen' : ''}` }, input,
      h('span', null, h('b', null, p.name, p.id === cur.provider ? h('span', { class: 'hint' }, ' (current)') : null,
        p.id !== 'local' && p.tested === false ? h('span', { class: 'pill untested', title: 'Built to the provider’s documentation but not yet tried with a real account. Report problems on GitHub.' }, 'Not yet tested') : null),
      h('span', { class: 'hint' }, p.blurb)));
  }));

  const drawFields = () => {
    const p = providers.find((x) => x.id === chosen);
    if (!p || p.id === 'local') {
      fieldsBox.replaceChildren(h('p', { class: 'hint' }, 'To put a pull-through CDN in front of this server, set the media address under Web address.'));
      return;
    }
    const inputs = p.fields.map((f) => {
      if (f.type === 'checkbox') {
        const cb = h('input', { type: 'checkbox', checked: values[f.key] ?? f.default ?? false, onchange: () => { values[f.key] = cb.checked; } });
        return h('div', { class: 'field wide' }, h('label', { class: 'check' }, cb, h('span', null, f.label)), f.hint ? h('p', { class: 'hint' }, f.hint) : null);
      }
      if (f.type === 'secret') {
        const saved = cur.provider === p.id && cur.secretSet;
        const inp = h('input', { type: 'password', autocomplete: 'off', placeholder: saved ? 'Saved. Leave blank to keep it.' : '', oninput: (e) => { secretValue = e.target.value; } });
        return field(f.label, inp, f.hint);
      }
      if (f.type === 'select') {
        const v = values[f.key] ?? f.default ?? '';
        const known = f.options.some((o) => o.value === v);
        const other = h('input', { type: 'text', value: known ? '' : v, placeholder: 'Type the hostname', hidden: known || !f.allowOther, 'aria-label': `${f.label} (other)`, oninput: (e) => { values[f.key] = e.target.value; } });
        const sel = h('select', {
          onchange: () => {
            if (sel.value === '__other') { other.hidden = false; values[f.key] = other.value; other.focus(); } else { other.hidden = true; values[f.key] = sel.value; }
          },
        }, f.options.map((o) => h('option', { value: o.value }, o.label)), f.allowOther ? h('option', { value: '__other' }, 'Other…') : null);
        sel.value = known ? v : f.allowOther ? '__other' : f.options[0].value;
        if (!values[f.key]) values[f.key] = sel.value === '__other' ? '' : sel.value;
        const wrap = field(f.label, sel, f.hint);
        wrap.append(other);
        return wrap;
      }
      if (values[f.key] === undefined && typeof f.default === 'string') values[f.key] = f.default;
      const inp = h('input', { type: 'text', value: values[f.key] ?? '', placeholder: f.placeholder ?? '', autocomplete: 'off', oninput: (e) => { values[f.key] = e.target.value; } });
      return field(f.label, inp, f.hint);
    });
    const pub = h('input', { type: 'url', value: values.publicUrl ?? '', placeholder: p.publicUrlPlaceholder, oninput: (e) => { values.publicUrl = e.target.value; } });
    fieldsBox.replaceChildren(
      h('p', { class: 'hint' }, h('a', { href: p.docsUrl, target: '_blank', rel: 'noopener' }, `${p.name} setup guide`)),
      h('div', { class: 'fields-grid' }, inputs),
      field('Public address', pub, p.publicUrlHint));
  };

  const body = () => ({ provider: chosen, settings: values, secret: secretValue || undefined });
  const showSteps = (test) => {
    results.replaceChildren(h('ul', { class: 'test-steps' }, test.steps.map((st) =>
      h('li', null, h('span', { class: `light ${st.ok ? 'on' : 'bad'}` }, st.step), h('p', { class: 'hint' }, st.detail)))));
  };

  const testBtn = h('button', {
    type: 'button',
    disabled: moving,
    onclick: async () => {
      err.hidden = true;
      testBtn.disabled = true;
      testBtn.textContent = 'Testing…';
      results.replaceChildren(h('p', { class: 'hint' }, 'Uploading a small test file…'));
      try {
        const test = await api('POST', '/api/admin/storage/test', body());
        showSteps(test);
        toast(test.ok ? 'Connection works' : 'Connection test failed');
      } catch (e) {
        results.replaceChildren();
        showError(err, e);
      }
      testBtn.disabled = false;
      testBtn.textContent = 'Test connection';
    },
  }, 'Test connection');

  const saveBtn = h('button', {
    type: 'button',
    class: 'primary',
    disabled: moving,
    onclick: async () => {
      err.hidden = true;
      const changingPlace = chosen !== cur.provider;
      if (changingPlace && storage.media.files &&
        !confirm(`Move ${storage.media.files} files (${fmtBytes(storage.media.bytes)}) to ${nameOf(chosen)}?\n\n` +
          'Shows keep working from the current storage during the move, and switch over once every file has been copied. Imports pause until it finishes.' +
          (cur.provider === 'local' ? '\n\nCopies on this server are deleted after the move succeeds.' : ''))) return;
      saveBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/storage', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
        const data = await res.json();
        if (!res.ok) {
          if (data.test) showSteps(data.test);
          throw new Error(data.error);
        }
        await refreshSetup();
        toast(data.move ? `Moving media to ${nameOf(chosen)}` : 'Storage settings saved');
        render();
      } catch (e) {
        showError(err, e);
        saveBtn.disabled = false;
      }
    },
  }, 'Save storage settings');

  drawPicker();
  drawFields();
  panel.append(
    h('h2', null, 'Media storage'),
    h('p', { class: 'muted' }, 'Where episode audio, video, artwork, transcripts and chapter files are kept. A storage provider serves downloads from its own network instead of this server’s connection.'),
    status,
    moveBox,
    picker,
    fieldsBox,
    results,
    err,
    h('div', { class: 'actions' }, testBtn, saveBtn),
    h('p', { class: 'hint', style: 'margin-top:12px' }, 'Saving runs the same test first and changes nothing if it fails.'));
  return panel;
}

boot().catch((e) => {
  $app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-box' },
    h('h1', null, 'The dashboard can’t start'), h('p', { class: 'muted' }, e.message))));
});
