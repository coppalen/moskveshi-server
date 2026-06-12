@echo off
echo Starting moskveshi server...
if not exist .env (
  echo.
  echo ERROR: File .env not found.
  echo Copy .env.example to .env and set ADMIN_PASSWORD.
  echo.
  pause
  exit /b
)
npm install
npm start
pause
