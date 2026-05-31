-- mysql -h127.0.0.1 -P3306 -uroot -p < schema/init.sql

CREATE DATABASE IF NOT EXISTS discord_collector
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE discord_collector;

CREATE TABLE IF NOT EXISTS frames (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  received_at DATETIME(3) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  opcode INT NULL,
  request_id VARCHAR(255) NULL,
  raw_payload LONGTEXT NULL,
  parsed_json JSON NULL,
  parse_error TEXT NULL,
  UNIQUE KEY uk_payload_hash (payload_hash),
  KEY idx_frames_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_guilds (
  guild_id VARCHAR(32) NOT NULL PRIMARY KEY,
  name VARCHAR(256) NOT NULL DEFAULT '',
  icon_hash VARCHAR(128) NULL,
  icon_url VARCHAR(512) NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_discord_guilds_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_channels (
  channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL DEFAULT '',
  name VARCHAR(256) NOT NULL DEFAULT '',
  channel_type INT NOT NULL DEFAULT 0,
  last_message_preview VARCHAR(512) NULL,
  last_message_at_ms BIGINT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_discord_channels_guild (guild_id),
  KEY idx_discord_channels_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(32) NOT NULL COMMENT 'Discord snowflake id',
  guild_id VARCHAR(32) NOT NULL DEFAULT '',
  guild_name VARCHAR(256) NULL,
  channel_id VARCHAR(32) NOT NULL DEFAULT '',
  channel_name VARCHAR(256) NULL,
  author_id VARCHAR(32) NOT NULL DEFAULT '',
  created_at_ms BIGINT NOT NULL DEFAULT 0,
  content TEXT NULL,
  author_username VARCHAR(128) NULL,
  author_global_name VARCHAR(128) NULL,
  author_avatar VARCHAR(512) NULL,
  event_type VARCHAR(32) NOT NULL DEFAULT 'MESSAGE_CREATE',
  source VARCHAR(32) NOT NULL DEFAULT 'gateway_ws' COMMENT 'gateway_ws|rest_api',
  raw_json JSON NULL,
  received_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_discord_message_id (message_id),
  KEY idx_discord_guild (guild_id),
  KEY idx_discord_channel_time (channel_id, created_at_ms),
  KEY idx_discord_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_signal_cards (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(64) NOT NULL,
  channel_id VARCHAR(32) NOT NULL,
  guild_id VARCHAR(32) NOT NULL DEFAULT '',
  source_text_hash CHAR(64) NOT NULL,
  raw_content TEXT NOT NULL,
  parsed_json JSON NULL,
  cards_by_style JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  expires_at DATETIME(3) NULL,
  telegram_sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_signal_message_id (message_id),
  KEY idx_signal_channel_status (channel_id, status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_channel_text_cache (
  channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
  recent_texts JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_channel_message_dedup (
  channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
  recent_keys JSON NOT NULL COMMENT '最近 3 条消息去重指纹',
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_guilds (
  guild_id VARCHAR(32) NOT NULL PRIMARY KEY,
  name VARCHAR(256) NOT NULL DEFAULT '',
  icon_hash VARCHAR(128) NULL,
  icon_url VARCHAR(512) NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_discord_guilds_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_channels (
  channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL DEFAULT '',
  name VARCHAR(256) NOT NULL DEFAULT '',
  channel_type INT NOT NULL DEFAULT 0,
  last_message_preview VARCHAR(512) NULL,
  last_message_at_ms BIGINT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_discord_channels_guild (guild_id),
  KEY idx_discord_channels_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
