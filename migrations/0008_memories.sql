-- 长期记忆跟随账号同步。只存记忆本身，不存对话，也不存记忆引用的用户原话（那部分只留在本机）。
-- WITHOUT ROWID：主键就是表，少一份索引，D1 按写入的行数（含索引）计费。
CREATE TABLE memories (
  user_id INTEGER NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,                              -- 客户端生成，同一条记忆在各设备上相同
  type TEXT NOT NULL CHECK (type IN ('semantic', 'episodic', 'procedural')),
  text TEXT NOT NULL,
  concepts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(concepts)),
  problem_key TEXT,
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  attempt_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attempt_ids)),
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
  valid_from INTEGER NOT NULL,                   -- 下面三个时间都是 Unix 毫秒
  invalid_at INTEGER,
  created_at INTEGER NOT NULL,
  superseded_by TEXT,
  updated_at INTEGER NOT NULL,                   -- 服务器写入时间，同步游标
  deleted INTEGER NOT NULL DEFAULT 0,            -- 删除后内容清空，留一行告诉其他设备
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;
CREATE INDEX idx_memories_user_updated ON memories(user_id, updated_at, id);
