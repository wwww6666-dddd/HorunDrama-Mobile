@echo off
setlocal
rem ASCII junction keeps adb usable even though the project folder name has Chinese.
"D:\horun-android\android-sdk\platform-tools\adb.exe" %*
endlocal
