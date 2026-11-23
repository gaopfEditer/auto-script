import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSignalIngestSource, signalIngestSourceFromEnv } from "./signal-ingest-source.js";

describe("signal-ingest-source", () => {
  it("defaults to kolvip", () => {
    assert.equal(parseSignalIngestSource(undefined), "kolvip");
    assert.equal(signalIngestSourceFromEnv({}), "kolvip");
  });

  it("parses discord aliases", () => {
    assert.equal(parseSignalIngestSource("discord"), "discord");
    assert.equal(parseSignalIngestSource("DC"), "discord");
    assert.equal(signalIngestSourceFromEnv({ SIGNAL_INGEST_SOURCE: "discord" }), "discord");
  });
});