import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const fixture = readFileSync(new URL("../../docs/phase5-acceptance-fixture.md", import.meta.url), "utf8");

const jobName = workflow.match(/^  checks:\r?\n    name: (.+)$/m)?.[1];
const requiredCheckName = fixture.match(/^The required check name for Switchyard is `([^`]+)`\.$/m)?.[1];

assert.ok(jobName, "Expected the CI workflow to define a name for the checks job");
assert.equal(requiredCheckName, jobName, "The fixture must use the CI job name as the required check name");
