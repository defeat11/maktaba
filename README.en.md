# maktaba

[العربية](README.md)

**In: a drive full of forgotten projects. Out: an index that knows which ones still run today.**

A local Node server scans the drives. It builds an index of every project. Every 6 hours it runs each project and records if it worked. So the verdict is measured, not guessed.

Today it indexes 164 projects on one machine: 132 originals and 32 backup copies. The code is 26,180 lines of JavaScript in 77 files. There are also 19 unit test files and 95 Git commits.

---

## The problem

Projects pile up over the years. One folder gets three copies. Nobody knows which one is the original.

Three questions no file explorer answers: does this project still run? Which port does it hold? What starts itself at boot?

Indexing is the easy part. The hard part is knowing the truth, not guessing it.

---

## How it works

| Step | What it does |
|---|---|
| 1. Scan | Walks the drives 6 levels deep. Skips `node_modules` and package directories |
| 2. Dedupe | Fingerprints each project with a SHA1 of its `package.json`, groups the copies, picks the original |
| 3. Profile | Reads entry point, ports, dependencies and code size. Read-only, nothing runs |
| 4. Doctor check | Runs each project for up to 20 seconds and judges it from its real output |
| 5. Boot registry | Reads scheduled tasks, `Run` keys and Startup folders. Maps them back to their owners |
| 6. Repair | On request, sends an agent to fix a broken project. It takes a restore point first |

The modules are 43 files in `lib/`, 12,229 lines in total.

---

## The key design decision

### 1. No write without a restore point

The agent gets full write access inside the project folder. That is a real risk to unsaved work.

The decision: every write into a user project goes through one function. That function takes a restore point first.

| Project state | Restore point |
|---|---|
| Clean Git repo | Record `HEAD` — roll back with `git reset --hard` |
| Dirty Git repo | `git stash -u` and record the stash ref |
| Not a repo | zip archive in `backups/` |
| None of the above possible | **Refuse to run** |

The cost: some repairs get refused. The return: zero edits with no way back.

The archive path is not a rare case. 96 of the 164 indexed projects have no `.git` folder.

### 2. "I don't know" gets its own exit code

The checker returns four codes: 0 healthy, 1 broken, 2 invocation error, 3 **unknown**.

Code 3 is the core of the design. Before it, a timeout returned 0. So a hung project read as healthy. A failed launch returned 1. So the tool marked a healthy project as broken. Then an agent came and rewrote it.

The success test was a regex that looks for a port number. A Node crash trace starts with a line like `loader:1459`. That is a four-digit number. So the tool read the crash trace and called the project healthy.

Today's distribution: 80 healthy, 30 unknown, 54 not checked yet. The third bucket tells the truth. It does not invent a verdict.

### 3. A scan cursor on disk

A full cycle takes hours, and the guardian log shows 37 server restarts. Every restart sent the scan back to zero.

The fix: a cursor file that records what was checked. Next to it, a timeout counter. The server skips a project that hangs twice in a row. This rule exists because six cycles in a row died on the same project.

---

## Running it

```bash
npm install
cp config.example.json config.json   # optional - sensible defaults apply without it
npm start          # UI on port 4500
npm run truth      # self-check, read-only, exits non-zero on failure
npm run audit      # audit the whole fleet
```

Real output from `npm run truth` on this machine:

```
فحص حقيقة مكتبة — 2026-08-31 08:35
========================================================================
  [  ok  ] تطابق المرآة مع sqlite: 164 صفاً، صفر انحراف
  [  ok  ] تغطية الفحص: 110 من 164 مفحوصة (67%)
  [ warn ] أقدم حكم صحة: 43 يوماً
           ← أعد الفحص — حكم بهذا العمر لا يصف المشروع كما هو الآن
  [  ok  ] توزيع الصحة: 30 unknown، 80 ok، 54 never
  [  ok  ] عدد الحرّاس: super-guardian فقط
  [  ok  ] سجل الإصلاحات: 6 محاولة، 3 منها مُتحقَّق منها
  [  ok  ] نقاط الاسترجاع: 4 محاولة تحمل نقطة استرجاع
  ... (13 فحصاً آخر، مختصرة هنا)
========================================================================
النتيجة: 19 سليم · 1 تحذير · 0 فشل
```

---

## Why I built it

I had 164 projects on my machine and no idea which ones still ran.

So I built a tool that measures instead of guessing. It changes nothing before it has a way back.
