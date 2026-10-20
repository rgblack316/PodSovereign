/**
 * Who can work on a show. One owner, plus any number of editors and viewers:
 *
 *   owner   everything, including the team, the feed's Settings and deleting the show
 *   editor  episodes, show details, stats prefixes, Podping, live shows
 *   viewer  can look, can't change anything
 *
 * People are added by the email of an existing account (admins create accounts
 * on the People page). Ownership can be handed to a team member; the previous
 * owner stays on as an editor.
 */
import type { Config } from '../config.js';
import { maybeOne, type Queryable } from './db.js';
import { invalidateFeedCache, isUuid } from './podcasts.js';

export class TeamError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type TeamRole = 'owner' | 'editor' | 'viewer';

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: TeamRole;
}

export async function listTeam(q: Queryable, podcastId: string): Promise<TeamMember[]> {
  const { rows } = await q.query<{ id: string; email: string; display_name: string | null; role: TeamRole }>(
    `SELECT u.id, u.email, u.display_name, 'owner' AS role, 0 AS rank FROM podcasts p JOIN users u ON u.id = p.owner_id WHERE p.id = $1
     UNION ALL
     SELECT u.id, u.email, u.display_name, m.role, CASE m.role WHEN 'editor' THEN 1 ELSE 2 END
       FROM podcast_members m JOIN users u ON u.id = m.user_id WHERE m.podcast_id = $1
     ORDER BY rank, email`,
    [podcastId],
  );
  return rows.map((r) => ({ userId: r.id, email: r.email, displayName: r.display_name, role: r.role }));
}

/** Each account can only own one copy of a podcast (same podcast:guid). */
async function assertCanOwn(q: Queryable, podcastId: string, userId: string) {
  const clash = await maybeOne<{ title: string }>(
    q,
    `SELECT o.title FROM podcasts o JOIN podcasts p ON p.id = $1
      WHERE o.owner_id = $2 AND o.id <> p.id AND o.podcast_guid IS NOT NULL AND o.podcast_guid = p.podcast_guid`,
    [podcastId, userId],
  );
  if (clash) throw new TeamError(`They already own a copy of this podcast (“${clash.title}”), so they can’t own this one too.`, 409);
}

const memberRole = (v: unknown): 'editor' | 'viewer' => {
  if (v !== 'editor' && v !== 'viewer') throw new TeamError('Role must be editor or viewer');
  return v;
};

export async function addMember(q: Queryable, podcastId: string, email: unknown, role: unknown): Promise<void> {
  const r = memberRole(role);
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!e) throw new TeamError('Enter their email address');
  const user = await maybeOne<{ id: string }>(q, `SELECT id FROM users WHERE email = $1`, [e]);
  if (!user) throw new TeamError('There’s no account with that email. Ask the site administrator to create one on the People page, then add them here.', 404);
  const owner = await maybeOne(q, `SELECT 1 FROM podcasts WHERE id = $1 AND owner_id = $2`, [podcastId, user.id]);
  if (owner) throw new TeamError('That’s the owner of this show');
  const exists = await maybeOne(q, `SELECT 1 FROM podcast_members WHERE podcast_id = $1 AND user_id = $2`, [podcastId, user.id]);
  if (exists) throw new TeamError('They’re already on the team. Change their role instead.', 409);
  await q.query(`INSERT INTO podcast_members (podcast_id, user_id, role) VALUES ($1, $2, $3)`, [podcastId, user.id, r]);
}

async function requireMember(q: Queryable, podcastId: string, userId: string) {
  const m = isUuid(userId)
    ? await maybeOne<{ role: string }>(q, `SELECT role FROM podcast_members WHERE podcast_id = $1 AND user_id = $2`, [podcastId, userId])
    : null;
  if (!m) throw new TeamError('That person isn’t on this show’s team', 404);
  return m;
}

/** Change a member's role. role "owner" hands the show over; the old owner becomes an editor. */
export async function setRole(q: Queryable, podcastId: string, userId: string, role: unknown): Promise<void> {
  await requireMember(q, podcastId, userId);
  if (role === 'owner') {
    await assertCanOwn(q, podcastId, userId);
    const p = (await maybeOne<{ owner_id: string }>(q, `SELECT owner_id FROM podcasts WHERE id = $1 FOR UPDATE`, [podcastId]))!;
    await q.query(`DELETE FROM podcast_members WHERE podcast_id = $1 AND user_id = $2`, [podcastId, userId]);
    await q.query(`UPDATE podcasts SET owner_id = $2, updated_at = now() WHERE id = $1`, [podcastId, userId]);
    await q.query(`INSERT INTO podcast_members (podcast_id, user_id, role) VALUES ($1, $2, 'editor')`, [podcastId, p.owner_id]);
    await invalidateFeedCache(q, podcastId);
    return;
  }
  await q.query(`UPDATE podcast_members SET role = $3 WHERE podcast_id = $1 AND user_id = $2`, [podcastId, userId, memberRole(role)]);
}

export async function removeMember(q: Queryable, podcastId: string, userId: string): Promise<void> {
  await requireMember(q, podcastId, userId);
  await q.query(`DELETE FROM podcast_members WHERE podcast_id = $1 AND user_id = $2`, [podcastId, userId]);
}

// ───────────── deleting accounts (admins) ─────────────

export interface DeleteUserInput {
  /** What to do with shows the user owns: hand them to another account, or delete them. */
  shows?: unknown;
  transferTo?: unknown;
}

/**
 * Delete an account. Refuses to delete yourself or the last admin. Shows the
 * account owns must be handed to someone else or deleted (the caller removes
 * deleted shows' media after commit, using the returned ids and slugs).
 */
export async function deleteUser(
  q: Queryable,
  _config: Config,
  actorId: string,
  userId: string,
  input: DeleteUserInput,
): Promise<{ deletedShows: { id: string; slug: string }[]; transferred: number }> {
  if (!isUuid(userId)) throw new TeamError('Account not found', 404);
  if (userId === actorId) throw new TeamError('You can’t delete your own account. Ask another administrator.');
  const user = await maybeOne<{ is_admin: boolean }>(q, `SELECT is_admin FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (!user) throw new TeamError('Account not found', 404);
  if (user.is_admin) {
    const admins = (await maybeOne<{ n: number }>(q, `SELECT count(*)::int AS n FROM users WHERE is_admin`))!;
    if (admins.n <= 1) throw new TeamError('This is the only administrator. Make someone else an administrator first.');
  }

  const { rows: owned } = await q.query<{ id: string; slug: string; title: string }>(
    `SELECT id, slug, title FROM podcasts WHERE owner_id = $1 ORDER BY title`,
    [userId],
  );
  let deletedShows: { id: string; slug: string }[] = [];
  let transferred = 0;
  if (owned.length) {
    if (input.shows === 'transfer') {
      const to = typeof input.transferTo === 'string' && isUuid(input.transferTo)
        ? await maybeOne<{ id: string }>(q, `SELECT id FROM users WHERE id = $1`, [input.transferTo])
        : null;
      if (!to || to.id === userId) throw new TeamError('Choose who should own their shows');
      for (const p of owned) await assertCanOwn(q, p.id, to.id);
      for (const p of owned) {
        await q.query(`DELETE FROM podcast_members WHERE podcast_id = $1 AND user_id = $2`, [p.id, to.id]);
        await q.query(`UPDATE podcasts SET owner_id = $2, updated_at = now() WHERE id = $1`, [p.id, to.id]);
      }
      transferred = owned.length;
    } else if (input.shows === 'delete') {
      await q.query(`DELETE FROM podcasts WHERE owner_id = $1`, [userId]);
      deletedShows = owned.map(({ id, slug }) => ({ id, slug }));
    } else {
      throw new TeamError(
        `This account owns ${owned.length === 1 ? 'a show' : `${owned.length} shows`} (${owned.map((p) => p.title).join(', ')}). Choose whether to give ${owned.length === 1 ? 'it' : 'them'} to someone else or delete ${owned.length === 1 ? 'it' : 'them'}.`,
        409,
      );
    }
  }
  await q.query(`DELETE FROM users WHERE id = $1`, [userId]);
  return { deletedShows, transferred };
}

/** Make an account an administrator, or not. There must always be at least one. */
export async function setAdmin(q: Queryable, actorId: string, userId: string, isAdmin: unknown): Promise<void> {
  if (typeof isAdmin !== 'boolean') throw new TeamError('isAdmin must be true or false');
  if (!isUuid(userId) || !(await maybeOne(q, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]))) throw new TeamError('Account not found', 404);
  if (!isAdmin) {
    if (userId === actorId) throw new TeamError('You can’t remove your own administrator access. Ask another administrator.');
    const admins = (await maybeOne<{ n: number }>(q, `SELECT count(*)::int AS n FROM users WHERE is_admin AND id <> $1`, [userId]))!;
    if (admins.n < 1) throw new TeamError('There must be at least one administrator.');
  }
  await q.query(`UPDATE users SET is_admin = $2 WHERE id = $1`, [userId, isAdmin]);
}
