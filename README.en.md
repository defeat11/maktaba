# maktaba

[العربية](README.md)

**In: a drive full of forgotten projects. Out: an index that knows which ones still run today.**

A local Node server scans the drives and builds an index of every project. Every 6 hours it actually runs each project and records whether it worked. The verdict is measured, not guessed.

It indexes 164 projects on one machine today: 132 originals and 32 backup copies. The code is 26,180 lines of JavaScript across 77 files, with 19 unit test files and 95 Git commits.

---

## The problem

Projects pile up over the years. One folder ends up with three copies and nobody knows which one is the original.

Three questions no file explorer answers: does this project still run? Which port does it hold? What starts itself at boot?

Indexing is the easy part. Knowing the truth instead of guessing at it is the hard part.

---

## How it works

| Step | What it does |
|---|---|
| 1. Scan | Walks the drives 6 levels deep, skipping `node_modules` and package directories |
| 2. Dedupe | Fingerprints each project with a SHA1 of its `package.json`, groups the copies, picks the original |
| 3. Profile | Reads entry point, ports, dependencies and code size — read-only, nothing runs |
| 4. Doctor check | Runs each project for up to 20 seconds and judges it from its real output |
| 5. Boot registry | Reads scheduled tasks, `Run` keys and Startup folders, and maps them back to their owners |
| 6. Repair | On request, sends an agent to fix a broken project — after taking a restore point |

The modules are 43 files in `lib/`, 12,229 lines in total.

---

## The key design decision

### 1. No write without a restore point

The agent gets full write access inside the project folder. That is a real risk to unsaved work.

The decision: every path that writes into a user project goes through one function, and that function takes a restore point first.

| Project state | Restore point |
|---|---|
| Clean Git repo | Record `HEAD` — roll back with `git reset --hard` |
| Dirty Git repo | `git stash -u` and record the stash ref |
| Not a repo | zip archive in `backups/` |
| None of the above possible | **Refuse to run** |

The cost: some repairs get refused. The return: zero edits with no way back.

The archive path is not a rare case: 96 of the 164 indexed projects have no `.git` folder at all.

### 2. "I don't know" gets its own exit code

The checker returns four codes: 0 healthy, 1 broken, 2 invocation error, 3 **unknown**.

Code 3 is the core of the design. Before it, a timeout returned 0, so a hung project read as healthy. A failed launch returned 1, so a healthy project was marked broken — and then became the target of an agent that rewrote it.

The success test was a regex looking for a port number. A Node crash trace opens with a line like `loader:1459`, which is a four-digit number. So a crashed project was declared healthy on the strength of its own crash trace.

Today's distribution: 80 healthy, 30 unknown, 54 not checked yet. The third bucket tells the truth instead of inventing a verdict.

### 3. A scan cursor on disk

A full cycle takes hours, and the guardian log shows 37 server restarts. Every restart sent the scan back to zero.

The fix: a cursor file that records what has been checked. Alongside it, a timeout counter: a project that hangs twice in a row is skipped. The rule exists because six cycles in a row died on the same project.

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

So I built a tool that measures instead of guessing, and touches nothing before it can guarantee the way back.
