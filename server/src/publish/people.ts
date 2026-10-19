/**
 * <podcast:person>: the people in a show (channel) or an episode (item).
 *
 * Per the Podcast Namespace, people listed on an episode wholly replace the
 * show's people for that episode, so an episode with a guest lists the hosts
 * too. role and group come from the Podcast Taxonomy (case-insensitive);
 * a missing role means "host", a missing group means "cast".
 */
import type { Config } from '../config.js';
import type { Queryable } from '../db/db.js';
import type { XmlNode } from '../feed/types.js';
import { fileRef, httpUrl, node, PublishError, text } from './fields.js';

/** podcasttaxonomy.com, as published in the Podcast Namespace repository (taxonomy.json). */
export const PERSON_TAXONOMY: Record<string, string[]> = {
  Cast: ['Host', 'Co-Host', 'Guest Host', 'Guest', 'Voice Actor', 'Narrator', 'Announcer', 'Reporter'],
  'Creative Direction': ['Director', 'Assistant Director', 'Executive Producer', 'Senior Producer', 'Producer', 'Associate Producer', 'Development Producer', 'Creative Director'],
  Writing: ['Author', 'Editorial Director', 'Co-Writer', 'Writer', 'Songwriter', 'Guest Writer', 'Story Editor', 'Managing Editor', 'Script Editor', 'Script Coordinator', 'Researcher', 'Editor', 'Fact Checker', 'Translator', 'Transcriber', 'Logger'],
  'Audio Production': ['Studio Coordinator', 'Technical Director', 'Technical Manager', 'Audio Engineer', 'Remote Recording Engineer', 'Post Production Engineer'],
  'Audio Post-Production': ['Audio Editor', 'Sound Designer', 'Foley Artist', 'Composer', 'Theme Music', 'Music Production', 'Music Contributor'],
  Administration: ['Production Coordinator', 'Booking Coordinator', 'Production Assistant', 'Content Manager', 'Marketing Manager', 'Sales Representative', 'Sales Manager'],
  Visuals: ['Graphic Designer', 'Cover Art Designer'],
  Community: ['Social Media Manager'],
  'Misc.': ['Consultant', 'Intern'],
  'Video Production': ['Camera Operator', 'Lighting Designer', 'Camera Grip', 'Assistant Camera'],
  'Video Post-Production': ['Editor', 'Assistant Editor'],
};

export interface Person {
  name: string;
  role: string | null;
  group: string | null;
  img: string | null;
  href: string | null;
}

const MAX_PEOPLE = 50;

export function peopleFromTags(tags: XmlNode[]): Person[] {
  return tags
    .filter((t) => t.name === 'podcast:person')
    .map((t) => ({
      name: t.text,
      role: t.attrs.role ?? null,
      group: t.attrs.group ?? null,
      img: t.attrs.img ?? null,
      href: t.attrs.href ?? null,
    }));
}

/** Validate the editor's list and turn it into <podcast:person> tags. */
export async function peopleToTags(q: Queryable, config: Config, podcastId: string, v: unknown): Promise<XmlNode[]> {
  const list = v === null ? [] : v;
  if (!Array.isArray(list)) throw new PublishError('People must be a list');
  if (list.length > MAX_PEOPLE) throw new PublishError(`At most ${MAX_PEOPLE} people`);
  const out: XmlNode[] = [];
  for (const [i, p] of list.entries()) {
    const o = (p ?? {}) as { name?: unknown; role?: unknown; group?: unknown; img?: unknown; href?: unknown };
    const label = `Person ${i + 1}`;
    const name = text(o.name, `${label} name`, { required: true, max: 128 })!;
    const attrs: Record<string, string> = {};
    const role = text(o.role, `${label} role`, { max: 100 });
    const group = text(o.group, `${label} group`, { max: 100 });
    if (role) attrs.role = role;
    if (group) attrs.group = group;
    const img = await fileRef(q, config, podcastId, o.img, `${label} photo`, ['image']);
    if (img) attrs.img = img.url;
    const href = httpUrl(o.href, `${label} link`);
    if (href) attrs.href = href;
    out.push(node('podcast:person', attrs, name));
  }
  return out;
}
