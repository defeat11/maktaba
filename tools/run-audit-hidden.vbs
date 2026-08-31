' Runs the daily fleet audit with no console window.
'
' Task Scheduler would otherwise flash a black window across the screen once a
' day; the guardian uses the same wrapper for the same reason. The audit only
' reads — it never starts, stops or changes a program.
'
' The repository root is derived from this script's own location, so the file
' works from any checkout path.
Option Explicit
Dim fso, sh, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "cmd /c node tools\fleet-audit.js >> logs\fleet-audit.log 2>&1", 0, False
