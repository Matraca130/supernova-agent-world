@echo off
cd /d C:\Users\petri\numero1_sseki_2325_55
echo Verificando Ollama...
ollama list 2>nul | findstr mxbai >nul
if errorlevel 1 (
    echo [ERROR] Ollama no esta corriendo o mxbai-embed-large no esta instalado.
    pause
    exit /b 1
)
echo Ollama OK. Iniciando v4 (parallel + curator)...
echo.
node multi-agent-chat\orchestrator-v4.cjs --quality high --rounds 3 "Como mejorar la integracion de IA en Axon"
echo.
echo Generando reporte...
node multi-agent-chat\report.cjs
pause
