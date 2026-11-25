@echo off
setlocal
rem SDK and AVD are stored under D:\???????, accessed via ASCII junction D:\horun-android.
set "SDK=D:\horun-android\android-sdk"
set "AVD_HOME=D:\horun-android\.android\avd"
set "ANDROID_SDK_ROOT=%SDK%"
set "ANDROID_HOME=%SDK%"
set "ANDROID_AVD_HOME=%AVD_HOME%"
set "TEMP=D:\horun-android\.tmp\temp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"

if "%~1"=="" (set "AVD=HorunEmu") else (set "AVD=%~1")
start "" "%SDK%\emulator\emulator.exe" -avd "%AVD%" -gpu auto -no-snapshot-load -netdelay none -netspeed full -no-boot-anim
endlocal
