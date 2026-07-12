@echo off
chcp 65001 >nul
echo.
echo ========================================
echo   建築ブースト 無料トライアル セットアップ
echo ========================================
echo.
echo  データベースを初期化しています...
echo  （AIクレジット50回分 + 材料マスタ36品目）
echo.

cd /d "%~dp0"

:: Node.jsチェック
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [エラー] Node.js がインストールされていません。
    echo   https://nodejs.org/ からインストールしてください。
    pause
    exit /b 1
)

:: sql.jsが必要
if not exist node_modules\sql.js (
    echo  sql.js をインストール中...
    npm install sql.js --no-save >nul 2>&1
)

node setup-trial.js

echo.
echo  セットアップ完了後、「建築ブースト.exe」を起動してください。
echo.
pause
