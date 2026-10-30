@echo off
rem Double-click to start Flow Studio. Close this window to stop it. Claude starts only when the window connects.
cd /d "%~dp0engine"
if not exist dist call npm run build
set "FLOW_MCP_HOME=D:\flow-studio\data"
set "FLOW_MCP_OUTPUT=D:\flow-studio\projects"
set "FLOW_STUDIO_NO_OPEN=1"
rem FLOW_MCP_CHROME is left as the caller set it (unset = engine default).
start "Flow Studio server" /b node dist\studio.js
rem The first page load receives the one-shot UI token, so open the window right away, before anything else can.
set /a TRIES=0
:wait
curl -s http://127.0.0.1:8787/api/health | find "flow-mcp" >nul && goto up
set /a TRIES+=1
if %TRIES% geq 40 goto up
timeout /t 1 /nobreak >nul
goto wait
:up
set "BRAVE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if exist "%BRAVE%" ( start "" "%BRAVE%" --app=http://127.0.0.1:8787 ) else ( start "" http://127.0.0.1:8787 )
rem Keep this window open while the server runs.
pause
