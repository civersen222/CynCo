@echo off
rem Rotate one log if it is over a cap: scripts\rotate-log.cmd "<log>" [max bytes, default 52428800].
rem Called by each scripts\run-*.cmd before its ">>" line (F242). Always exits 0: a launcher must
rem never fail on its log. Pure cmd: no bun, so it cannot stop a service from starting.
rem
rem WHAT IT CAN TOUCH, and nothing else: the one file named, when it is a regular *.log file over
rem the cap, is renamed to <log>.1 in the SAME folder, and the <log>.1 that was there before (the
rem one previous generation of THAT name) is replaced. Exactly one previous file is kept. It never
rem lists, enters or deletes a folder, never acts on a wildcard, and never renames through a link:
rem it refuses, with one "[rotate-log] not rotated" line on stderr and nothing changed, a path that
rem is empty, relative, not below a drive letter (a share, or rooted on the current drive), holds
rem * or ?, does not end .log, lies in a volume root, lies in the home folder (USERPROFILE) or in a
rem folder that contains it, or names a folder; and a log, a <log>.1, a log's folder or any folder
rem above it that is a link or a junction. A missing log is no work and says nothing.
rem A launcher passes the path through "call", which doubles a ^ even inside quotes: a path that
rem holds ^ then names no file, and its log is never rotated (nothing else happens).
rem The cap must stay below 2147483647: cmd compares 32-bit numbers and saturates there (measured:
rem "if 25990666616 GTR 52428800" is true, "if 25990666616 GTR 3000000000" is false). A cap that is
rem not a plain decimal number below that, or starts with 0, is refused the same way.
rem No parenthesised blocks below: a path holding ")" or "&" would break one, so the flow is goto.
setlocal DisableDelayedExpansion
set "LOG=%~1"
set "MAX=%~2"
if "%MAX%"=="" set "MAX=52428800"
if "%LOG%"=="" goto no_log
if not "%LOG:**=%"=="%LOG%" goto wildcard
if not "%LOG:?=%"=="%LOG%" goto wildcard
if not "%LOG:~1,2%"==":\" if not "%LOG:~1,2%"==":/" goto not_full
if /i not "%~x1"==".log" goto not_log
for /f "delims=0123456789" %%X in ("%MAX%") do goto bad_max
if "%MAX:~0,1%"=="0" goto bad_max
if %MAX% GEQ 2147483647 goto bad_max
for %%F in ("%LOG%") do set "LOG=%%~fF"
for %%F in ("%LOG%") do set "DIR=%%~dpF"
if "%DIR:~3%"=="" goto in_root
set "DIR=%DIR:~0,-1%"
if "%USERPROFILE%"=="" goto no_home
for %%H in ("%USERPROFILE%\.") do set "CUR=%%~fH"
:home_up
if /i "%DIR%"=="%CUR%" goto in_home
for %%P in ("%CUR%\..") do set "NEXT=%%~fP"
if /i "%NEXT%"=="%CUR%" goto home_ok
set "CUR=%NEXT%"
goto home_up
:home_ok
if not exist "%LOG%" exit /b 0
for %%D in ("%DIR%\.") do set "ATTR=%%~aD---------"
if "%ATTR:~8,1%"=="l" goto dir_link
rem Every folder above it as well: the rename would follow a junction further up.
for %%P in ("%DIR%\..") do set "CUR=%%~fP"
:link_up
for %%D in ("%CUR%\.") do set "ATTR=%%~aD---------"
if "%ATTR:~8,1%"=="l" goto up_link
for %%P in ("%CUR%\..") do set "NEXT=%%~fP"
if /i "%NEXT%"=="%CUR%" goto links_ok
set "CUR=%NEXT%"
goto link_up
:links_ok
for %%F in ("%LOG%") do set "ATTR=%%~aF"
if "%ATTR:~0,1%"=="d" goto is_folder
if "%ATTR:~8,1%"=="l" goto log_link
for %%F in ("%LOG%") do set "SIZE=%%~zF"
if "%SIZE%"=="" exit /b 0
if not %SIZE% GTR %MAX% exit /b 0
if not exist "%LOG%.1" goto rotate
for %%F in ("%LOG%.1") do set "ATTR=%%~aF"
if "%ATTR:~0,1%"=="d" goto old_not_file
if "%ATTR:~8,1%"=="l" goto old_not_file
:rotate
move /y "%LOG%" "%LOG%.1" >nul 2>&1 || goto failed
exit /b 0

:failed
echo [rotate-log] could not rotate "%LOG%" (it may be held open); the service starts anyway 1>&2
exit /b 0
:no_log
echo [rotate-log] not rotated: no log was named 1>&2
exit /b 0
:wildcard
echo [rotate-log] not rotated "%LOG%": the path holds a wildcard 1>&2
exit /b 0
:not_full
echo [rotate-log] not rotated "%LOG%": it is not a full path below a drive letter 1>&2
exit /b 0
:not_log
echo [rotate-log] not rotated "%LOG%": its name does not end .log 1>&2
exit /b 0
:bad_max
echo [rotate-log] not rotated "%LOG%": the cap "%MAX%" is not a decimal number from 1 to 2147483646 1>&2
exit /b 0
:in_root
echo [rotate-log] not rotated "%LOG%": it lies in a volume root 1>&2
exit /b 0
:no_home
echo [rotate-log] not rotated "%LOG%": USERPROFILE is not set, so the home folder cannot be ruled out 1>&2
exit /b 0
:in_home
echo [rotate-log] not rotated "%LOG%": its folder is the home folder or contains it 1>&2
exit /b 0
:dir_link
echo [rotate-log] not rotated "%LOG%": its folder is a link or a junction 1>&2
exit /b 0
:up_link
echo [rotate-log] not rotated "%LOG%": a folder above it is a link or a junction 1>&2
exit /b 0
:is_folder
echo [rotate-log] not rotated "%LOG%": it is a folder 1>&2
exit /b 0
:log_link
echo [rotate-log] not rotated "%LOG%": it is a link 1>&2
exit /b 0
:old_not_file
echo [rotate-log] not rotated "%LOG%": "%LOG%.1" is a folder or a link 1>&2
exit /b 0
