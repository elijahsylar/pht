-- Drop everything the pre-rebuild PHT stored. IRREVERSIBLE.
--
-- Never run by `migrate`, by a deploy script, or by anything automatic. Run it
-- by hand, once, and only after:
--
--   1. the rebuilt backend and the new page are deployed and working, and
--   2. `ops/pht-pin-legacy-dump.sh` has just exited 0 on a fresh dump.
--
-- If that script printed ABORT, stop: the pinned dump is the only way back.
-- The full procedure is in docs/DEPLOY.md, "Dropping legacy tables".
--
--   ssh "$PHT_REMOTE"
--   mysql -u <DB_USER> -p <DB_NAME> < pht-drop-legacy.sql
--
-- Safe to run twice (IF EXISTS / a DELETE that matches nothing). It does not
-- touch habits, checks, day_notes, or any other settings row.

-- entries first: it holds the foreign key into protocols.
DROP TABLE IF EXISTS entries;
DROP TABLE IF EXISTS protocols;
DROP TABLE IF EXISTS journal_entries;
DROP TABLE IF EXISTS gratitude_entries;
DROP TABLE IF EXISTS coach_conversations;

-- Named one by one rather than LIKE 'coach%', so a future setting that happens
-- to start the same way cannot be swept up.
DELETE FROM settings
 WHERE `key` IN ('coach_system_prompt', 'coach_temperature', 'coach_max_tokens', 'coach_model');
