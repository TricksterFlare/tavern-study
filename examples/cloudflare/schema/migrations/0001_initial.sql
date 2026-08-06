PRAGMA foreign_keys = ON;

CREATE TABLE schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_versions(version) VALUES (1);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK(category IN ('world','plot','outline','session')),
  title TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  chapter TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  lore_keys TEXT NOT NULL DEFAULT '[]',
  lore_position TEXT NOT NULL DEFAULT 'before',
  is_char INTEGER NOT NULL DEFAULT 0 CHECK(is_char IN (0,1)),
  lore_constant INTEGER NOT NULL DEFAULT 0 CHECK(lore_constant IN (0,1)),
  trigger_mode TEXT NOT NULL DEFAULT 'scan' CHECK(trigger_mode IN ('scan','presence')),
  lore_enabled INTEGER NOT NULL DEFAULT 1 CHECK(lore_enabled IN (0,1)),
  lore_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX memories_project_category ON memories(project, category, updated_at DESC);

CREATE TABLE oc_chapters (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  chapter_no TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX chapters_published ON oc_chapters(project, status, chapter_no, id);

CREATE TABLE oc_comments (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES oc_chapters(id) ON DELETE CASCADE,
  reply_to TEXT REFERENCES oc_comments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('owner','ai')),
  display_name TEXT NOT NULL,
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX comments_chapter_cursor ON oc_comments(chapter_id, created_at, id);

CREATE TABLE comment_rate_buckets (
  dimension TEXT NOT NULL CHECK(dimension IN ('actor','ip')),
  subject TEXT NOT NULL,
  minute_bucket TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(dimension, subject, minute_bucket)
);
CREATE TRIGGER comment_rate_limit_guard
BEFORE UPDATE OF request_count ON comment_rate_buckets
WHEN NEW.request_count > 5
BEGIN
  SELECT RAISE(ABORT, 'comment_rate_limited');
END;

CREATE TRIGGER comments_reply_same_chapter_insert
BEFORE INSERT ON oc_comments
WHEN NEW.reply_to IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM oc_comments parent WHERE parent.id = NEW.reply_to AND parent.chapter_id = NEW.chapter_id
)
BEGIN
  SELECT RAISE(ABORT, 'reply_must_belong_to_same_chapter');
END;

CREATE TRIGGER comments_reply_same_chapter_update
BEFORE UPDATE OF chapter_id, reply_to ON oc_comments
WHEN NEW.reply_to IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM oc_comments parent WHERE parent.id = NEW.reply_to AND parent.chapter_id = NEW.chapter_id
)
BEGIN
  SELECT RAISE(ABORT, 'reply_must_belong_to_same_chapter');
END;

CREATE TABLE oc_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE usage_log (id TEXT PRIMARY KEY, channel TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE desk_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', block_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE desk_blocks (id TEXT PRIMARY KEY, preset_id TEXT NOT NULL, identifier TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'system', content TEXT NOT NULL DEFAULT '', marker INTEGER NOT NULL DEFAULT 0, injection TEXT NOT NULL DEFAULT '{}', in_queue INTEGER NOT NULL DEFAULT 0, queue_pos INTEGER, enabled_default INTEGER NOT NULL DEFAULT 0, UNIQUE(preset_id, identifier));
CREATE TABLE desk_recipes (id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, preset_id TEXT NOT NULL, weight TEXT NOT NULL DEFAULT 'heavy' CHECK(weight IN ('light','heavy')), overrides TEXT NOT NULL DEFAULT '{}', regex_ids TEXT NOT NULL DEFAULT '[]', params TEXT NOT NULL DEFAULT '{}', light_system TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT);
CREATE TABLE desk_regex (id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('preset','global')), preset_id TEXT, name TEXT NOT NULL DEFAULT '', find TEXT NOT NULL, replace TEXT NOT NULL DEFAULT '', flags TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL CHECK(direction IN ('up','down','both')), enabled INTEGER NOT NULL DEFAULT 1, meta TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE desk_windows (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', recipe_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', note_depth INTEGER NOT NULL DEFAULT 3, state_board TEXT NOT NULL DEFAULT '{}', timeline_state TEXT NOT NULL DEFAULT '{}', vars TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT);
CREATE TABLE desk_floors (id TEXT PRIMARY KEY, window_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL DEFAULT '', variants TEXT NOT NULL DEFAULT '[]', active_variant INTEGER NOT NULL DEFAULT 0, thinking TEXT, report TEXT, created_at TEXT NOT NULL);
CREATE INDEX desk_blocks_preset ON desk_blocks(preset_id);
CREATE INDEX desk_recipes_project ON desk_recipes(project);
CREATE INDEX desk_windows_project ON desk_windows(project);
CREATE INDEX desk_floors_window_created ON desk_floors(window_id, created_at);
