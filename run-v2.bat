@echo off
cd /d C:\Users\petri\numero1_sseki_2325_55
echo Verificando Ollama...
ollama list 2>nul | findstr mxbai >nul
if errorlevel 1 (
    echo [ERROR] Ollama no esta corriendo o mxbai-embed-large no esta instalado.
    pause
    exit /b 1
)
echo Ollama OK. Iniciando debate...
echo.
node multi-agent-chat\orchestrator-v2.cjs --quality high --rounds 3 --context "multi-agent-chat\contexto-sistema.md" "Como mejorar este sistema de multi-agent chat? Tienen acceso al codigo y arquitectura completa en el contexto. Propongan mejoras concretas al orchestrator, vector store, prompts, y experiencia. Al final generen prompts de accion para implementar las mejoras."
pause
