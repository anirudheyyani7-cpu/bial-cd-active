/**
 * db/schema.ts — this app's database schema, in Drizzle.
 *
 * Starts EMPTY on purpose — there is no demonstration data model to work around or delete. Add
 * the tables your app actually needs; nothing here is required by the platform, the platform
 * owns the database's lifecycle, the app owns everything inside it.
 *
 * After ANY edit to this file, call `apply_schema_change(what_changed="…")`. It generates the
 * migration and applies it in ONE step. Make ONE kind of schema change per call: mixing a rename
 * into the same diff as an add is what wakes drizzle-kit's rename resolver, and keeping the diff
 * away from that resolver is the only thing that PREVENTS the failure described below.
 *
 * Never use drizzle-kit's `push`: it mutates the database with no migration file, so the next
 * restore brings back code that expects tables the database does not have.
 *
 * WHY THIS EXISTS — why one call, and not the two commands it replaced.
 *
 * Nothing refuses a hand-run of `npx drizzle-kit generate` or `npm run db:migrate`. No guard
 * blocks them and no error stops you, and that is exactly the problem: measured against the
 * `drizzle-kit@0.31.10` this template pins, BOTH halves of that sequence can fail and still exit
 * 0, so anyone reading exit codes believes a schema change happened that did not.
 *
 *   - `--name` buys a readable filename, nothing more. Without it an unambiguous diff generates
 *     fine and exits 0 — it just lands under a random name like
 *     `drizzle/0001_special_fantastic_four.sql`.
 *   - What actually stops the command is the rename resolver — "is `label` new, or renamed from
 *     `title`?" — an interactive select that no CLI flag answers, `--name` included. Given a
 *     terminal it does not fail at all, it waits (one recorded attempt sat at the prompt for
 *     4 minutes 9 seconds). Here there is no terminal and stdin is closed, where it is worse: it
 *     prints "Interactive prompts require a TTY terminal", writes NO migration file, and exits 0.
 *   - The apply half is non-fatal BY DESIGN: `scripts/db-migrate.mjs` catches every error and
 *     exits 0, so that a failed migration can never stop the dev server from booting.
 *
 * `apply_schema_change` is the only thing that reads what those commands PRINTED rather than what
 * they returned. It reports the failure the exit code hides, and names which step failed and what
 * state that left the database in.
 */

export {};
