@echo off
rem Doble clic para abrir El Morterito. No cerrar esta ventana mientras se usa.
cd /d "%~dp0"
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.mjs
pause
