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
  else if (m.done) lights.push({ cls: 'on', text: `Media copied (${fmtBytes(m.bytes)})` });
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

  if (!p.podping.serverEnabled) lights.push({ cls: '', text: 'Podping not set up' });
  else lights.push(p.podping.enabled ? { cls: 'on', text: 'Podping on' } : { cls: '', text: 'Podping off' });

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

  const [section, a, b] = route();
  let view;
  try {
    if (section === 'import' && a) view = await viewImportJob(a);
    else if (section === 'import') view = await viewImport();
    else if (section === 'show' && a) view = await viewShow(a, b ?? 'overview');
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
    h('a', { class: 'btn primary import', href: '#/import' }, 'Import a show'),
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
      h('h1', { style: 'font-size:var(--t-xl);margin-bottom:12px' }, 'Bring your first show over'),
      h('p', { class: 'muted' }, 'Paste the RSS feed address from your current host. Every episode, image, transcript and chapter file is copied to this server, and the show gets a new feed address.'),
      h('a', { class: 'btn primary', href: '#/import' }, 'Import a show')));
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
  const slug = h('input', { type: 'text', name: 'slug', pattern: '[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?', placeholder: 'my-show' });
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
  ['episodes', 'Episodes'],
  ['prefixes', 'Stats prefixes'],
  ['podping', 'Podping'],
  ['live', 'Live'],
  ['settings', 'Settings'],
];

async function viewShow(id, tab) {
  const { podcast: p } = await api('GET', `/api/podcasts/${id}`);
  const canEdit = p.role !== 'viewer';
  const body = h('div');
  const reload = () => render();

  const views = { overview: tabOverview, episodes: tabEpisodes, prefixes: tabPrefixes, podping: tabPodping, live: tabLive, settings: tabSettings };
  body.append(await (views[tab] ?? tabOverview)(p, canEdit, reload));

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
      TABS.filter(([k]) => k !== 'settings' || p.role === 'owner').map(([k, label]) =>
        h('a', { href: `#/show/${id}/${k}`, 'aria-current': k === tab ? 'page' : null }, label))),
    body);
}

// Overview: the move checklist + facts
async function tabOverview(p, canEdit, reload) {
  const parts = [];
  if (p.sourceFeedUrl) {
    const m = p.media;
    const mediaDone = p.status === 'active' && !m.pending;
    const redirectOk = p.redirect?.status === 'ok';
    const podpingOn = p.podping.enabled && p.podping.serverEnabled;

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
            h('p', { class: 'muted' }, p.podping.serverEnabled
              ? 'Once the redirect is in place, Podping tells apps the moment you publish.'
              : 'Podping isn’t set up on this server yet. The administrator needs to add a Podping key.'),
            h('a', { class: 'btn', href: `#/show/${p.id}/podping` }, 'Podping settings'))))));
  }

  parts.push(h('section', { class: 'panel' },
    h('h2', null, 'About this show'),
    h('dl', { class: 'facts', style: 'margin-top:12px' },
      h('dt', null, 'Episodes'), h('dd', null, p.episodeCount),
      p.sourceFeedUrl ? [h('dt', null, 'Imported from'), h('dd', null, p.sourceFeedUrl)] : null,
      p.importedAt ? [h('dt', null, 'Imported'), h('dd', null, fmtDate(p.importedAt, true))] : null,
      h('dt', null, 'Podcast GUID'), h('dd', null, p.podcastGuid ?? '—'),
      p.language ? [h('dt', null, 'Language'), h('dd', null, p.language)] : null,
      h('dt', null, 'Your access'), h('dd', null, { owner: 'Owner', editor: 'Editor', viewer: 'Viewer (read only)' }[p.role]))));

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

async function tabEpisodes(p) {
  const { episodes } = await api('GET', `/api/podcasts/${p.id}/episodes`);
  if (!episodes.length) return h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'This show has no episodes yet.'));
  return h('div', { class: 'panel', style: 'padding:0' }, h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null,
      h('th', null, 'Episode'), h('th', null, 'Published'), h('th', { class: 'num' }, 'Length'),
      h('th', { class: 'num' }, 'Size'), h('th', null, ''))),
    h('tbody', null, episodes.map((e) => h('tr', null,
      h('td', null,
        h('div', { class: 'ep-title' }, e.title),
        h('div', { class: 'hint' }, [
          e.itunes_season ? `Season ${e.itunes_season}` : null,
          e.itunes_episode ? `Episode ${e.itunes_episode}` : null,
          e.itunes_episode_type && e.itunes_episode_type !== 'full' ? e.itunes_episode_type[0].toUpperCase() + e.itunes_episode_type.slice(1) : null,
        ].filter(Boolean).join(', '))),
      h('td', { class: 'nowrap' }, fmtDate(e.pub_date)),
      h('td', { class: 'num' }, fmtDuration(e.itunes_duration)),
      h('td', { class: 'num nowrap' }, e.enclosure_length ? fmtBytes(e.enclosure_length) : '—'),
      h('td', null, e.status !== 'published' ? h('span', { class: `pill ${e.status}` }, e.status === 'draft' ? 'Draft' : 'Scheduled') : null)))))));
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
    disabled: !canEdit || !st.serverEnabled,
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
      h('p', { class: 'muted' }, 'Podping tells podcast apps and Podcast Index the moment your feed changes, so new episodes show up in seconds instead of hours.'),
      !st.serverEnabled ? h('p', { class: 'error' }, 'Podping isn’t set up on this server. The administrator needs to add a Podping key (PODPING_TOKEN).') : null,
      h('label', { class: 'switch' }, toggle, st.enabled ? 'Podping is on for this show' : 'Podping is off for this show'),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'Imported shows start with Podping off. Turn it on after your old host redirects to this feed; turning it on announces the feed once.')),
    st.pings.length ? h('section', { class: 'panel', style: 'padding:0' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Ping'), h('th', null, 'Result'), h('th', null, 'When'))),
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
      h('p', { class: 'muted' }, p.podping.enabled && p.podping.serverEnabled
        ? 'Going live and ending a show update the feed and send a Podping, so listeners’ apps react right away.'
        : 'Going live and ending a show update the feed. Turn on Podping to alert apps instantly.'),
      items.length ? list : h('p', { class: 'muted' }, 'No live shows scheduled.'),
      canEdit ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => openForm(null) }, 'Schedule a live show')) : null),
    formSlot);
  return wrap;
}

async function tabSettings(p) {
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
    h('section', { class: 'panel' },
      h('h2', null, 'Feed address'),
      h('p', { class: 'muted' }, 'The address can’t be changed once a show is live, because podcast apps and directories keep it.'),
      h('dl', { class: 'facts' }, h('dt', null, 'Feed'), h('dd', null, p.feedUrl), h('dt', null, 'Media'), h('dd', null, `${state.setup.publicBaseUrl}/${p.slug}/media/`))),
    h('section', { class: 'panel' },
      h('h2', null, 'Delete this show'),
      h('p', { class: 'muted' }, 'Removes the feed, every episode and all copied media from this server. Subscribers following this feed will stop getting episodes. This can’t be undone.'),
      field(`Type ${p.slug} to confirm`, confirmInput),
      err,
      h('div', { class: 'actions' }, del)));
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
  h('p', { class: 'muted' }, 'They sign in with this email and the starting password, then can change it under Account. They only see their own shows.'),
  h('div', { class: 'row' }, field('Email', email), field('Name (optional)', name)),
  field('Starting password', pw, 'At least 10 characters. Share it with them privately.'),
  h('div', { class: 'field' }, h('label', { class: 'check' }, admin, h('span', null, 'Make them an administrator too'))),
  err,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Create account')));

  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'People')),
    h('section', { class: 'panel', style: 'padding:0' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Email'), h('th', { class: 'num' }, 'Shows'), h('th', null, 'Joined'))),
      h('tbody', null, users.map((u) => h('tr', null,
        h('td', null, u.displayName || '—', u.isAdmin ? h('span', { class: 'hint' }, ' (admin)') : null),
        h('td', null, u.email),
        h('td', { class: 'num' }, u.podcasts),
        h('td', { class: 'nowrap' }, fmtDate(u.createdAt)))))))),
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

  // Podping key
  const keyErr = formError();
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: s.podpingKeySet ? 'A key is saved. Enter a new one to replace it.' : 'Paste your podping.cloud key' });
  const keyForm = h('form', {
    class: 'panel',
    onsubmit: (ev) => {
      ev.preventDefault();
      keyErr.hidden = true;
      if (!key.value.trim()) return showError(keyErr, 'Paste the key first.');
      busy(keyForm, async () => {
        try {
          await api('PUT', '/api/admin/site', { podpingKey: key.value });
          toast('Podping key saved');
          render();
        } catch (e) {
          showError(keyErr, e);
        }
      });
    },
  },
  h('h2', null, 'Podping key'),
  h('p', { class: 'muted' }, 'Podping needs a key for podping.cloud from Podcast Index (podcastindex.org). Each show then has its own Podping switch.'),
  h('p', null, h('span', { class: `light ${s.podpingKeySet ? 'on' : ''}` },
    s.podpingKeySet ? (s.podpingKeyFromEnv ? 'Key set on the server (PODPING_TOKEN)' : 'Key saved') : 'No key yet')),
  field('Key', key),
  keyErr,
  h('div', { class: 'actions' },
    h('button', { class: 'primary', type: 'submit' }, 'Save Podping key'),
    s.podpingKeySet && !s.podpingKeyFromEnv ? h('button', {
      type: 'button',
      class: 'quiet',
      onclick: async () => {
        if (!confirm('Remove the Podping key? Pings stop for every show.')) return;
        await api('PUT', '/api/admin/site', { podpingKey: null });
        toast('Podping key removed');
        render();
      },
    }, 'Remove key') : null));

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
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'When off, only admins can add podcasters (under People).')),
    keyForm);
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
      h('span', null, h('b', null, p.name, p.id === cur.provider ? h('span', { class: 'hint' }, ' (current)') : null), h('span', { class: 'hint' }, p.blurb)));
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
