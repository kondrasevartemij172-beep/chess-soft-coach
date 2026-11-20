@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Chess Soft Coach
echo   Открываю: http://chess-soft-coach.localhost:8080
echo   (любое имя вида *.localhost браузер сам направляет на 127.0.0.1)
echo.
echo   Закрой это окно, чтобы остановить сервер.
echo.
start "" "http://chess-soft-coach.localhost:8080/"
py -3 -m http.server 8080 2>nul || python -m http.server 8080
pause
