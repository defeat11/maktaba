' Starts the Maktaba server at logon, with no console window.
'
' Registered as the Maktaba-Autostart scheduled task. Deliberately does NOT
' check whether the port is free first: server.js refuses to start when 4500 is
' already taken, exits 1 and says so, which is the correct behaviour and avoids
' two launchers racing to decide who owns the port.
'
' The repository root is derived from this script's own location, so the file
' works from any checkout path.
Option Explicit
Dim fso, sh, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "cmd /c node server.js >> logs\boot.log 2>&1", 0, False
