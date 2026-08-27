import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseFlowchart, importFlowchart } from '../importers/flowchart.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(__dirname, 'fixtures', 'flowchart');

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

// --- Valid imports -------------------------------------------------------

test('valid simple flowchart imports into typed architecture IR', () => {
  const result = parseFlowchart(readFixture('valid-simple.mmd'));
  assert.ok(result.ok, `Expected ok, got diagnostics: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(result.ir.schema_version, 1);
  assert.equal(result.ir.diagram_type, 'architecture');
  assert.equal(result.ir.components.length, 4);
  assert.equal(result.ir.connections.length, 3);
  const labels = result.ir.components.map((c) => c.label);
  assert.ok(labels.includes('API Server'));
  assert.ok(labels.includes('PostgreSQL'));
  assert.ok(labels.includes('Redis Cache'));
  assert.ok(labels.includes('Analytics Worker'));
});

test('valid subgraph flowchart maps subgraphs to boundaries', () => {
  const result = parseFlowchart(readFixture('valid-subgraph.mmd'));
  assert.ok(result.ok);
  assert.equal(result.ir.components.length, 4);
  assert.equal(result.ir.connections.length, 3);
  assert.ok(result.ir.boundaries, 'Expected boundaries from subgraphs');
  assert.equal(result.ir.boundaries.length, 2);
  const boundaryLabels = result.ir.boundaries.map((b) => b.label);
  assert.ok(boundaryLabels.includes('Frontend'));
  assert.ok(boundaryLabels.includes('Backend'));
  const frontend = result.ir.boundaries.find((b) => b.label === 'Frontend');
  assert.ok(frontend.wraps.includes('A'));
  assert.ok(frontend.wraps.includes('B'));
  const backend = result.ir.boundaries.find((b) => b.label === 'Backend');
  assert.ok(backend.wraps.includes('C'));
  assert.ok(backend.wraps.includes('D'));
});

test('valid labeled edges preserve labels in connections', () => {
  const result = parseFlowchart(readFixture('valid-labeled-edges.mmd'));
  assert.ok(result.ok);
  assert.equal(result.ir.connections.length, 4);
  const labeledConn = result.ir.connections.find((c) => c.label === 'HTTPS request');
  assert.ok(labeledConn, 'Expected a connection labeled "HTTPS request"');
  const sqlConn = result.ir.connections.find((c) => c.label === 'SQL query');
  assert.ok(sqlConn, 'Expected a connection labeled "SQL query"');
  const cacheConn = result.ir.connections.find((c) => c.label === 'cache miss');
  assert.ok(cacheConn, 'Expected a connection labeled "cache miss"');
  assert.equal(cacheConn.variant, 'dashed');
});

test('valid chained edges create multiple connections from one line', () => {
  const result = parseFlowchart(readFixture('valid-chained.mmd'));
  assert.ok(result.ok);
  assert.equal(result.ir.components.length, 4);
  assert.equal(result.ir.connections.length, 3);
  assert.equal(result.ir.connections[0].from, 'A');
  assert.equal(result.ir.connections[0].to, 'B');
  assert.equal(result.ir.connections[1].from, 'B');
  assert.equal(result.ir.connections[1].to, 'C');
  assert.equal(result.ir.connections[2].from, 'C');
  assert.equal(result.ir.connections[2].to, 'D');
});

test('all component types are valid Archify componentType values', () => {
  const result = parseFlowchart(readFixture('valid-subgraph.mmd'));
  assert.ok(result.ok);
  const validTypes = ['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external'];
  for (const comp of result.ir.components) {
    assert.ok(validTypes.includes(comp.type), `Component ${comp.id} has invalid type "${comp.type}"`);
  }
});

test('all component ids match the Archify id pattern', () => {
  const result = parseFlowchart(readFixture('valid-simple.mmd'));
  assert.ok(result.ok);
  const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  for (const comp of result.ir.components) {
    assert.match(comp.id, idPattern, `Component id "${comp.id}" does not match pattern`);
  }
});

// --- Malformed sources ---------------------------------------------------

test('unclosed subgraph exits non-zero with a stable diagnostic', () => {
  const result = parseFlowchart(readFixture('malformed-unclosed-subgraph.mmd'));
  assert.ok(!result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === 'import/flowchart-unclosed-subgraph'));
});

test('unclosed node shape exits non-zero with a stable diagnostic', () => {
  const result = parseFlowchart(readFixture('malformed-unclosed-shape.mmd'));
  assert.ok(!result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === 'import/flowchart-unclosed-node-shape'));
});

test('missing diagram declaration exits non-zero with a stable diagnostic', () => {
  const result = parseFlowchart(readFixture('malformed-no-declaration.mmd'));
  assert.ok(!result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === 'import/flowchart-missing-declaration'));
});

test('unbalanced end exits non-zero with a stable diagnostic', () => {
  const result = parseFlowchart(readFixture('malformed-unbalanced-end.mmd'));
  assert.ok(!result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === 'import/flowchart-unbalanced-end'));
});

// --- Unsupported sources --------------------------------------------------

test('classDef directive exits non-zero with a stable named diagnostic', () => {
  const result = parseFlowchart(readFixture('unsupported-classDef.mmd'));
  assert.ok(!result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === 'import/unsupported-keyword-classdef'));
});

test('style directive exits non-zero with a stable named diagnostic', () => {
  const result = parseFlowchart(readFixture('unsupported-style.mmd'));
  assert.ok(!result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === 'import/unsupported-keyword-style'));
});

// --- Adversarial sources -------------------------------------------------

test('adversarial HTML injection in node labels is preserved as text, not interpreted', () => {
  const result = parseFlowchart(readFixture('adversarial-injection.mmd'));
  assert.ok(result.ok);
  const labels = result.ir.components.map((c) => c.label);
  // The label should contain the raw text including the script tag, not interpret it.
  assert.ok(labels.some((l) => l.includes('<script>')), 'Label should preserve raw text');
  assert.ok(labels.some((l) => l.includes('malicious')), 'Label should preserve raw text');
});

// --- CLI integration -----------------------------------------------------

test('CLI import command produces valid JSON IR from a flowchart file', () => {
  const cli = path.join(skillRoot, 'bin', 'archify.mjs');
  const fixture = path.join(fixturesDir, 'valid-simple.mmd');
  const tmpOut = path.join(os.tmpdir(), `archify-import-${Date.now()}.json`);
  const result = spawnSync(process.execPath, [cli, 'import', 'flowchart', fixture, tmpOut, '--json'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.ok, true);
  assert.equal(receipt.command, 'import');
  assert.equal(receipt.source, 'mermaid-flowchart');
  assert.equal(receipt.components, 4);
  assert.equal(receipt.connections, 3);
  // Verify the IR file was written and is valid.
  const ir = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
  assert.equal(ir.schema_version, 1);
  assert.equal(ir.diagram_type, 'architecture');
  assert.equal(ir.components.length, 4);
  fs.unlinkSync(tmpOut);
});

test('CLI import command exits non-zero for malformed input', () => {
  const cli = path.join(skillRoot, 'bin', 'archify.mjs');
  const fixture = path.join(fixturesDir, 'malformed-unclosed-subgraph.mmd');
  const result = spawnSync(process.execPath, [cli, 'import', 'flowchart', fixture, '--json'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.notEqual(result.status, 0, 'Expected non-zero exit for malformed input');
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.ok, false);
  assert.ok(receipt.diagnostics.length > 0);
  assert.ok(receipt.diagnostics[0].code.startsWith('import/'));
});

test('CLI import command exits non-zero for unsupported syntax', () => {
  const cli = path.join(skillRoot, 'bin', 'archify.mjs');
  const fixture = path.join(fixturesDir, 'unsupported-classDef.mmd');
  const result = spawnSync(process.execPath, [cli, 'import', 'flowchart', fixture, '--json'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.notEqual(result.status, 0, 'Expected non-zero exit for unsupported syntax');
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.ok, false);
  assert.ok(receipt.diagnostics.some((d) => d.code.startsWith('import/unsupported')));
});

// --- Existing behavior unchanged ----------------------------------------

test('importFlowchart receipt has stable schemaVersion and command fields', () => {
  const result = importFlowchart(readFixture('valid-simple.mmd'));
  assert.ok(result.ok);
  assert.equal(result.receipt.schemaVersion, 1);
  assert.equal(result.receipt.command, 'import');
  assert.equal(result.receipt.source, 'mermaid-flowchart');
});
