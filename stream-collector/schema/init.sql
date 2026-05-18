-- 在连接前执行一次（示例）：
-- mysql -h127.0.0.1 -P3306 -uroot -p < schema/init.sql

CREATE DATABASE IF NOT EXISTS stream_collector
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE stream_collector;

-- CDP 原始 WebSocket 帧（payload_hash 去重）
CREATE TABLE IF NOT EXISTS frames (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  received_at DATETIME(3) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  opcode INT NULL,
  request_id VARCHAR(255) NULL,
  raw_payload LONGTEXT NULL COMMENT 'WS 帧体明文（JSON 或 hex/utf8，便于直接查看维护）',
  parsed_json JSON NULL,
  parse_error TEXT NULL,
  UNIQUE KEY uk_payload_hash (payload_hash),
  KEY idx_frames_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kook 频道消息（message_id 去重；Show 页 REST + WS 桌面通知等）
CREATE TABLE IF NOT EXISTS kook_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(128) NOT NULL COMMENT 'Kook 消息 id（全局唯一）',
  guild_id VARCHAR(32) NOT NULL DEFAULT '' COMMENT '服务器/群组 id',
  channel_id VARCHAR(32) NOT NULL DEFAULT '' COMMENT '频道 id',
  author_id VARCHAR(32) NOT NULL DEFAULT '' COMMENT '发送者用户 id',
  create_at_ms BIGINT NOT NULL DEFAULT 0 COMMENT 'Kook create_at（毫秒时间戳）',
  content TEXT NULL COMMENT '正文',
  msg_type INT NULL COMMENT 'Kook 消息 type',
  author_username VARCHAR(128) NULL,
  author_nickname VARCHAR(128) NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'rest' COMMENT 'rest|ws_desktop|frontend 等',
  raw_json JSON NULL COMMENT '原始片段（可选）',
  received_at DATETIME(3) NOT NULL COMMENT '本系统首次入库时间',
  UNIQUE KEY uk_kook_message_id (message_id),
  KEY idx_kook_guild (guild_id),
  KEY idx_kook_channel_time (channel_id, create_at_ms),
  KEY idx_kook_author (author_id),
  KEY idx_kook_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 有效信号（发车）标记
CREATE TABLE IF NOT EXISTS kook_signal_marks (
  message_id VARCHAR(128) NOT NULL PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL DEFAULT '',
  channel_id VARCHAR(32) NOT NULL DEFAULT '',
  note TEXT NULL,
  marked_at DATETIME(3) NOT NULL,
  KEY idx_signal_mark_guild_time (guild_id, marked_at),
  KEY idx_signal_mark_channel (channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 信号结果核验（每条信号一条，UPSERT）
CREATE TABLE IF NOT EXISTS kook_signal_reviews (
  message_id VARCHAR(128) NOT NULL PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL DEFAULT '',
  channel_id VARCHAR(32) NOT NULL DEFAULT '',
  hit_take_profit TINYINT NULL COMMENT '1=止盈 0=未止盈 NULL=未评',
  hit_stop_loss TINYINT NULL COMMENT '1=止损 0=未止损 NULL=未评',
  entry_type VARCHAR(32) NULL COMMENT 'precise|near_miss|near_stop_loss|bad_entry_no_sl|none',
  entry_offset DECIMAL(20,8) NULL COMMENT '差一点入场插值/偏差',
  review_note TEXT NULL,
  reviewed_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_signal_review_guild_time (guild_id, reviewed_at),
  KEY idx_signal_review_channel (channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
