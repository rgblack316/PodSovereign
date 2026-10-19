import sax from 'sax';
import { canonicalPrefix } from './namespaces.js';
import type { XmlNode } from './types.js';

export interface ParsedXml {
  root: XmlNode;
  /** Non-canonical namespaces declared in the document (prefix → URI). */
  namespaces: Record<string, string>;
  warnings: string[];
}

const MAX_WARNINGS = 50;

/**
 * Parse XML into a simple tree. Element/attribute names are normalised to
 * canonical prefixes (itunes:, podcast:, …) based on namespace URI, so feeds
 * using unusual prefixes still map correctly. Lenient: recoverable errors are
 * recorded as warnings and parsing continues.
 */
export function parseXml(xml: string): ParsedXml {
  const parser = sax.parser(true, { xmlns: true, trim: false, normalize: false });
  const stack: XmlNode[] = [];
  const namespaces: Record<string, string> = {};
  const warnings: string[] = [];
  let root: XmlNode | undefined;

  const qualify = (uri: string, prefix: string, local: string): string => {
    const canon = canonicalPrefix(uri);
    if (canon) return `${canon}:${local}`;
    if (prefix) {
      if (uri) namespaces[prefix] = uri;
      return `${prefix}:${local}`;
    }
    return local;
  };

  parser.onopentag = (tag) => {
    const t = tag as sax.QualifiedTag;
    const attrs: Record<string, string> = {};
    for (const a of Object.values(t.attributes)) {
      if (a.name === 'xmlns' || a.prefix === 'xmlns') continue;
      attrs[a.prefix ? qualify(a.uri, a.prefix, a.local) : a.local] = a.value;
    }
    const node: XmlNode = { name: qualify(t.uri, t.prefix, t.local), attrs, text: '', cdata: false, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    stack.push(node);
  };

  parser.ontext = (text) => {
    const top = stack[stack.length - 1];
    if (top) top.text += text;
  };

  parser.oncdata = (text) => {
    const top = stack[stack.length - 1];
    if (top) {
      top.text += text;
      top.cdata = true;
    }
  };

  parser.onclosetag = () => {
    const node = stack.pop();
    if (!node) return;
    node.text = node.text.trim();
  };

  parser.onerror = (err) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(err.message.split('\n')[0] ?? String(err));
    parser.error = null as unknown as Error;
    parser.resume();
  };

  parser.write(xml).close();

  if (!root) throw new Error('Not an XML document');
  // Only keep namespaces that aren't built in (built-ins are always re-declared canonically).
  for (const [prefix, uri] of Object.entries(namespaces)) if (canonicalPrefix(uri)) delete namespaces[prefix];
  return { root, namespaces, warnings };
}

// ───────────── Serialisation ─────────────

export function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escAttr(s: string): string {
  return escText(s).replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;');
}

export function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** Strip characters that are illegal in XML 1.0 (common in pasted show notes). */
export function cleanXmlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

export function attrString(attrs: Record<string, string | number | boolean | null | undefined>): string {
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    out += ` ${k}="${escAttr(cleanXmlChars(String(v)))}"`;
  }
  return out;
}

/**
 * Element with text content. `html` mode wraps the text in CDATA when it
 * contains markup (show notes); plain mode escapes it.
 */
export function el(
  name: string,
  text: string | number | null | undefined,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  html = false,
): string {
  if (text === null || text === undefined) return '';
  const s = cleanXmlChars(String(text));
  const body = html && /[<>&]/.test(s) ? cdata(s) : escText(s);
  return `<${name}${attrString(attrs)}>${body}</${name}>`;
}

/** Serialise a raw node (used for `extra` tags) with indentation. */
export function serializeNode(node: XmlNode, indent: string, step = '  '): string {
  const open = `<${node.name}${attrString(node.attrs)}`;
  const text = node.text ? (node.cdata ? cdata(cleanXmlChars(node.text)) : escText(cleanXmlChars(node.text))) : '';
  if (!node.children.length) {
    return text ? `${indent}${open}>${text}</${node.name}>` : `${indent}${open}/>`;
  }
  const inner = node.children.map((c) => serializeNode(c, indent + step, step)).join('\n');
  const textLine = text ? `${indent}${step}${text}\n` : '';
  return `${indent}${open}>\n${textLine}${inner}\n${indent}</${node.name}>`;
}
