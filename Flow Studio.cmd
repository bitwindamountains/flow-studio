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
set "FLOW_MCP_HOME=D:\flow-studio\data"
set "FLOW_MCP_OUTPUT=D:\flow-studio\projects"
rem 8787 is often taken by another local service, so the studio uses 8797. claude\mcp.json uses the same port.
set "FLOW_MCP_PORT=8797"
set "FLOW_STUDIO_NO_OPEN=1"
rem Flow runs in Brave (owner's choice) with the studio's own profile under data\, never the everyday Brave profile.
if not defined FLOW_MCP_CHROME if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" set "FLOW_MCP_CHROME=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
start "Flow Studio server" /b node dist\studio.js
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
if exist "%BRAVE%" ( start "" "%BRAVE%" --user-data-dir="D:\flow-studio\data\ui-profile" --no-first-run --app=http://127.0.0.1:%FLOW_MCP_PORT% ) else ( start "" http://127.0.0.1:%FLOW_MCP_PORT% )
rem Keep this window open while the server runs.
pause
