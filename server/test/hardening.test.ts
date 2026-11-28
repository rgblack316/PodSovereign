import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { plain } from '../src/auphonic/auphonic.js';
import { newPassword } from '../src/cli/reset-password.js';
import { Router } from '../src/http/router.js';
import { sniffImage } from '../src/site/settings.js';

describe('text from HTML', () => {
  test('tags go, entities are decoded once, and "&amp;lt;" stays text', () => {
    assert.equal(plain('<p>Fish &amp; chips</p><p>a &lt; b</p>'), 'Fish & chips\na < b');
    assert.equal(plain('x &amp;lt;b&amp;gt; y'), 'x &lt;b&gt; y');
    assert.equal(plain('<<b>script>alert(1)</b>'), 'alert(1)');
  });
});

describe('SVG detection', () => {
  const svg = (s: string) => sniffImage(Buffer.from(s));
  test('an SVG may start with a declaration, comments and a DOCTYPE', () => {
    assert.equal(svg('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
    assert.equal(svg('<?xml version="1.0"?>\n<!-- one -->\n<!-- two -->\n<!DOCTYPE svg PUBLIC "x" "y">\n<svg width="1"/>'), 'image/svg+xml');
    assert.equal(svg('<html><svg/></html>'), null);
    assert.equal(svg('<?xml version="1.0"?>'), null);
  });
  test('a long run of comments is read quickly', () => {
    const t = Date.now();
    assert.equal(svg('<!--' + ' x'.repeat(200) + '<!--'.repeat(50)), null);
    assert.ok(Date.now() - t < 200);
  });
});

describe('routes', () => {
  test('characters that mean something in a regular expression are matched as themselves', async () => {
    const r = new Router();
    let hit = '';
    r.get('/a+b/:id', async (ctx) => { hit = ctx.params.id!; });
    const route = (r as any).routes[0];
    assert.ok(route.re.test('/a+b/42'));
    assert.ok(!route.re.test('/aab/42'));
    assert.equal(hit, '');
  });
});

describe('generated passwords', () => {
  test('four groups of five from the readable alphabet', () => {
    for (let i = 0; i < 50; i++) assert.match(newPassword(), /^([a-hj-km-zA-HJ-NP-Z2-9]{5}-){3}[a-hj-km-zA-HJ-NP-Z2-9]{5}$/);
    assert.notEqual(newPassword(), newPassword());
  });
});
