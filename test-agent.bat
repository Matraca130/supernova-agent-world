@echo off
cd /d C:\Users\petri\numero1_sseki_2325_55
echo Probando claude CLI...
echo hola | claude -p --tools ""
echo.
echo Exit code: %ERRORLEVEL%
pause
