-- 在连接前执行一次（示例）：
-- mysql -h127.0.0.1 -P3306 -uroot -p < schema/init.sql

CREATE DATABASE IF NOT EXISTS stream_collector
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
