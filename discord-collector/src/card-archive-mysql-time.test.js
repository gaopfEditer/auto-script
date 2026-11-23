import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSignalCardArchiveRangeSql,
  msToMysqlDatetimeShanghai,
  mysqlDatetimeToArchiveIso,
  shanghaiCalendarDayStartIso,
  shanghaiCalendarDayStartMs,
} from "./card-archive-mysql-time.js";

test("shanghaiCalendarDayStartMs aligns to +08:00 midnight", () => {
  const anchor = Date.parse("2026-11-23T10:30:00+08:00");
  const fromMs = shanghaiCalendarDayStartMs(anchor);
  assert.equal(fromMs, Date.parse("2026-11-23T00:00:00+08:00"));
  assert.equal(shanghaiCalendarDayStartIso(anchor), "2026-11-22T16:00:00.000Z");
});

test("msToMysqlDatetimeShanghai uses wall clock not UTC", () => {
  const ms = Date.parse("2026-11-23T03:54:00+08:00");
  assert.equal(msToMysqlDatetimeShanghai(ms), "2026-11-23 03:54:00.000");
  const fromMs = Date.parse("2026-11-23T00:00:00+08:00");
  assert.equal(msToMysqlDatetimeShanghai(fromMs), "2026-11-23 00:00:00.000");
});

test("buildSignalCardArchiveRangeSql does not reference discord_messages", () => {
  const fromMs = Date.parse("2026-11-23T00:00:00+08:00");
  const toMs = Date.parse("2026-11-23T12:00:00+08:00");
  const { sql, params } = buildSignalCardArchiveRangeSql(fromMs, toMs);
  assert.doesNotMatch(sql, /dm\./);
  assert.equal(params.length, 4);
  assert.equal(params[0], "2026-11-23 00:00:00.000");
  assert.equal(params[1], "2026-11-23 12:00:00.000");
});

test("mysqlDatetimeToArchiveIso tags naive CST with +08:00", () => {
  assert.equal(
    mysqlDatetimeToArchiveIso("2026-11-23 03:54:00"),
    "2026-11-23T03:54:00.000+08:00"
  );
  const d = new Date(Date.UTC(2026, 10, 23, 3, 59, 42, 765));
  assert.equal(mysqlDatetimeToArchiveIso(d), "2026-11-23T03:59:42.765+08:00");
});