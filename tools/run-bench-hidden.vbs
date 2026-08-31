' Re-measures the free models weekly with no console window.
'
' Same wrapper as the daily audit, and for the same reason: a scheduled task
' would otherwise flash a black window once a week. This job only asks models
' questions and writes scores — it never touches a project.
'
' The repository root is derived from this script's own location, so the file
' works from any checkout path.
Option Explicit
Dim fso, sh, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "cmd /c node tools\bench-models.js >> logs\model-bench.log 2>&1", 0, False
