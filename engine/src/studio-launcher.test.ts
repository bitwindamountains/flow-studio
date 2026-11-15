import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const preflight = fileURLToPath(new URL("../../scripts/studio-preflight.ps1", import.meta.url));
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

test("launcher refuses silent server reuse and restarts only a confirmed Studio process", { skip: process.platform !== "win32" }, () => {
  // All OS operations are replaced before the helper runs. No live server/profile is used.
  const dir = mkdtempSync(join(tmpdir(), "studio-launcher-"));
  try {
    const harness = join(dir, "test.ps1");
    writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
. ${quote(preflight)}
$script:listening = $false
$script:stopped = 0
$script:asked = 0
$script:consent = $true
$script:command = 'node dist\\studio.js'
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) if ($script:listening) { [pscustomobject]@{ LocalPort = 8797; OwningProcess = 123 } } }
function Get-CimInstance { param($ClassName, $Filter) [pscustomobject]@{ Name = 'node.exe'; CommandLine = $script:command } }
function Confirm-StudioRestart { $script:asked++; return $script:consent }
function Stop-Process { param($Id, $ErrorAction) if ($Id -ne 123) { throw 'wrong PID' }; $script:stopped++; $script:listening = $false }
function Check($condition, $message) { if (!$condition) { throw $message } }
Ensure-StudioPortFree -Port 8797 -StudioScript 'D:\\flow-studio\\engine\\dist\\studio.js'
Check ($script:stopped -eq 0 -and $script:asked -eq 0) 'fresh launch must not stop or ask'
$script:listening = $true
Ensure-StudioPortFree -Port 8797 -StudioScript 'D:\\flow-studio\\engine\\dist\\studio.js'
Check ($script:stopped -eq 1 -and $script:asked -eq 1 -and !$script:listening) 'confirmed restart must release the port'
$script:listening = $true; $script:consent = $false
$refused = $false
try { Ensure-StudioPortFree -Port 8797 -StudioScript 'D:\\flow-studio\\engine\\dist\\studio.js' } catch { $refused = $true }
Check ($refused -and $script:stopped -eq 1) 'declining must preserve the running server'
$script:command = 'node unrelated.js'; $script:consent = $true
$refused = $false
try { Ensure-StudioPortFree -Port 8797 -StudioScript 'D:\\flow-studio\\engine\\dist\\studio.js' } catch { $refused = $true }
Check ($refused -and $script:stopped -eq 1 -and $script:asked -eq 2) 'unrelated listener must never be stopped'
$script:command = 'node "D:\\flow-studio\\engine\\dist\\studio.js"'
Ensure-StudioPortFree -Port 8797 -StudioScript 'D:\\flow-studio\\engine\\dist\\studio.js'
Check ($script:stopped -eq 2) 'absolute Studio command must be recognized'
$script:listening = $true; $script:command = 'node dist\\index.js'
$refused = $false
try { Ensure-StudioPortFree -Port 8797 -StudioScript 'D:\\flow-studio\\engine\\dist\\studio.js' } catch { $refused = $true }
Check ($refused -and $script:stopped -eq 2) 'an MCP server must not be killed or silently reused'
$script:command = 'node dist\\studio.js'
$script:reads = 0
function Get-CimInstance { param($ClassName, $Filter) $script:reads++; [pscustomobject]@{ Name = 'node.exe'; CommandLine = $script:command; CreationDate = $script:reads } }
$refused = $false
try { Ensure-StudioPortFree -Port 8797 -StudioScript 'D:\\flow-studio\\engine\\dist\\studio.js' } catch { $refused = $true }
Check ($refused -and $script:stopped -eq 2) 'a replacement process must not be stopped'
function Get-NetTCPConnection { param($State, $ErrorAction) throw 'access denied' }
$refused = $false
try { Ensure-StudioPortFree -Port 8797 -StudioScript 'D:\\flow-studio\\engine\\dist\\studio.js' } catch { $refused = $true }
Check ($refused -and $script:stopped -eq 2) 'an inspection failure must stop startup'
Write-Output 'passed'
`);
    assert.match(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], { encoding: "utf8", timeout: 20000 }), /passed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launcher checks the port before starting its server", () => {
  const cmd = readFileSync(new URL("../../Flow Studio.cmd", import.meta.url), "utf8");
  const guard = cmd.indexOf("studio-preflight.ps1");
  assert.ok(guard >= 0 && guard < cmd.indexOf('start "Flow Studio server"'), "preflight must run before server startup");
  assert.match(cmd.slice(guard, cmd.indexOf('start "Flow Studio server"')), /if errorlevel 1/);
});
