@echo off
rem Double-click to start Flow Studio. Close this window to stop it. Claude starts only when the window connects.
cd /d "%~dp0engine"
rem Always rebuild: tsc is quick, and a stale dist would silently run old code.
call npm run build
if errorlevel 1 (
  echo.
  echo Flow Studio could not be built - see the errors above.
  pause
  exit /b 1
)
rem Paths follow this folder, wherever the repo was cloned. configure-paths points the agents' MCP configs here too.
set "FLOW_MCP_HOME=%~dp0data"
set "FLOW_MCP_OUTPUT=%~dp0projects"
node "%~dp0scripts\configure-paths.mjs"
if errorlevel 1 (
  echo.
  echo Could not point claude\mcp.json and .codex\config.toml at this folder - see the error above.
  pause
  exit /b 1
)
rem 8787 is often taken by another local service, so the studio uses 8797. claude\mcp.json uses the same port.
set "FLOW_MCP_PORT=8797"
set "FLOW_STUDIO_NO_OPEN=1"
rem Never silently attach to a server whose one-time owner session may already be gone.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\studio-preflight.ps1" -Port %FLOW_MCP_PORT%
if errorlevel 1 (
  pause
  exit /b 1
)
rem ffmpeg (continue-from-last-frame) installed by winget may not be on this window's PATH yet.
if not defined FLOW_MCP_FFMPEG for /d %%P in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do for /d %%V in ("%%P\*") do if exist "%%V\bin\ffmpeg.exe" set "FLOW_MCP_FFMPEG=%%V\bin\ffmpeg.exe"
rem Flow runs in Brave (owner's choice) with the studio's own profile under data\, never the everyday Brave profile.
if not defined FLOW_MCP_CHROME if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" set "FLOW_MCP_CHROME=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
start "Flow Studio server" /b node "%~dp0engine\dist\studio.js"
rem The first page load receives the one-shot UI token, so open the window right away, before anything else can.
set /a TRIES=0
:wait
curl -s http://127.0.0.1:%FLOW_MCP_PORT%/api/health | findstr /c:"\"name\":\"flow-mcp\"" >nul && goto up
set /a TRIES+=1
if %TRIES% geq 40 goto fail
timeout /t 1 /nobreak >nul
goto wait
:fail
echo.
echo Flow Studio did not start: nothing on port %FLOW_MCP_PORT% answered as flow-mcp within 40 seconds.
echo Another program may be using that port, or the server stopped - see the messages above.
echo No browser window was opened.
pause
exit /b 1
:up
set "BRAVE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"
rem The window gets its own profile outside the studio folder, never an everyday browser profile (the owner cookie must not land there).
set "UIPROFILE=%LOCALAPPDATA%\FlowStudioUI"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BRAVE%" set "BRAVE=%EDGE%"
if not exist "%BRAVE%" (
  echo.
  echo Neither Brave nor Edge was found, so the studio window cannot open in its own profile.
  echo Install Brave, then start Flow Studio again.
  pause
  exit /b 1
)
start "" "%BRAVE%" --user-data-dir="%UIPROFILE%" --no-first-run --app=http://127.0.0.1:%FLOW_MCP_PORT%
rem Keep this window open while the server runs.
pause
