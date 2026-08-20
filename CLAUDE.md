# מוקד מובמנט — הערות עבודה

אפליקציית CRM חד-קובצית (`index.html`, וניל JS + Supabase) למוקד שירות לקוחות של movement.

## מבנה הריפו והדמה

- `origin` = https://github.com/adir2112-blip/files.git — **האתר החי**, ענף `main`.
  מתפרסם אוטומטית ב-GitHub Pages: https://adir2112-blip.github.io/files/
- `staging` = https://github.com/adir2112-blip/files-staging.git — **סביבת דמה**, ענף `main`.
  מתפרסם ב-https://adir2112-blip.github.io/files-staging/
- ענפים מקומיים: `main` (= מראה מדויקת של הפרודקשן) ו-`staging` (= `main` + "overlay" אחד עם
  הבדלים שקיימים *רק* בדמה, ראה למטה).

## תהליך עבודה על שינויים

1. עובדים על `main` (או ענף feature שמתמזג ל-main).
2. לפני עלייה לחי: מריבייסים את `staging` על גבי `main` המעודכן (`git rebase main` מתוך `staging`),
   ודוחפים ל-`staging main` (`git push staging staging:main`). זה מעלה לאתר הדמה.
3. אחרי בדיקה ואישור אישי של המשתמש — עוברים ל-`main`, ומוודאים שהוא מכיל את השינויים
   (לרוב `main` כבר הוא הבסיס), ודוחפים ל-`origin main` (`git push origin main:main`).
   **לא לדחוף ל-origin/main בלי אישור מפורש מהמשתמש אחרי בדיקה בדמה.**

## מה שונה בענף/אתר הדמה (overlay, לא לדחוף ל-production)

בתחילת ה-`<script>` יש בלוק `IS_STAGING`:
- חוסם בפועל קריאות `fetch` לכל URL שמכיל `/functions/v1/` (Edge Functions של Supabase —
  מיילים, גיבויים) או `whatsapp-bot-production` (בוט הוואטסאפ) — כדי שבדיקות לא ישלחו
  הודעות/מיילים אמיתיים ללקוחות/מנהלים אמיתיים. שאר הקריאות (Supabase REST, בדיקת גרסה)
  עובדות רגיל.
- באנר קבוע צהוב-שחור בראש העמוד "🧪 סביבת דמה" + `<title>` עם קידומת `[דמה]`.
- `VERSION_URL` מצביע על `version.txt` של ריפו הדמה עצמו (לא של הפרודקשן), כדי שבדיקת
  עדכון גרסה לא תתבלבל בין הסביבות.

**חשוב**: הדמה משתמשת **באותו מסד Supabase** של הפרודקשן (לא מסד נפרד) — כך הוחלט ב-2026-07-25.
המשתמע: כל ארגון/קובץ/רשומה שנוצרים לצורך בדיקה נגישים גם לנציגים/מנהלים אמיתיים באתר החי,
ולהפך. יש ליצור ארגון ייעודי ומסומן בבירור לבדיקות (למשל "🧪 בדיקות בלבד") ולא להזין בו
נתוני אמת. זו נקודת תורפה מוכרת בגישה הזו — אם בעתיד המשתמש ירצה בידוד מלא, יידרש מסד
Supabase שני.

## נקודות שחזור יציבות (git tags)

כשהמשתמש מבקש "לגבות" את המערכת כגרסה יציבה — יוצרים git tag על `main` בשם
`stable-<VERSION>` (למשל `stable-1.0.53`), עם הודעה שכוללת תאריך ואת הפקודות
לשחזור, ודוחפים אותו ל-`origin` (`git push origin stable-<VERSION>`). ה-tag
נשאר בריפו לצמיתות ונגיש מכל שיחה עתידית דרך `git tag -l -n99` או `git log --all --oneline --decorate`.

**לשחזור נקודת שחזור בעתיד**:
```
git fetch origin --tags
git checkout stable-<VERSION> -- index.html version.txt
```
ואז ממשיכים בתהליך הרגיל (commit על main, בדיקה בדמה, ורק אחרי אישור — עלייה ל-production).

## גישה טכנית

- אין build step — קובץ HTML יחיד, בלי תלות ב-node/npm.
- ה-anon key של Supabase חשוף בקוד הלקוח (כרגיל באפליקציות כאלה) — אבטחה מתבססת על
  RLS בצד השרת, לא על הסתרת המפתח.
- יש credential מאוחסן ב-Windows Credential Manager עבור git:https://github.com
  (משתמש `adir2112-blip`) — מאפשר push ישיר משני הריפואים בלי פרומפט אינטראקטיבי.
