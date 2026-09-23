# Railway Universal Starter

یک استارتر سبک و مرتب برای اجرای سایت، API، بات و Worker روی Railway.

> Railway VPS کامل نیست؛ یک کانتینر لینوکسی است. این قالب ابزارهای رایج را دارد، اما systemd، دسترسی privileged به Docker، IP ثابت و دسکتاپ گرافیکی ندارد.

## راه‌اندازی

1. این پوشه را داخل یک ریپازیتوری GitHub آپلود کن.
2. در Railway گزینه‌ی **New Project → Deploy from GitHub Repo** را بزن.
3. ریپازیتوری را انتخاب کن. Railway فایل `railway.json` و `Dockerfile` را می‌خواند.
4. بدون هیچ متغیری Deploy کن؛ صفحه‌ی پیش‌فرض و مسیر `/health` باید بلافاصله بالا بیاید.
5. اگر فایل یا SQLite لازم داری، از تنظیمات سرویس Railway یک Volume بساز و آن را روی مسیر `/data` Mount کن.

## اجرای پروژه‌ی خودت

در Variables این موارد را تنظیم کن:

- `START_CMD`: دستور اجرا؛ مثل `node bot.js` یا `python3 bot.py`
- `MODE`: برای سایت/API مقدار `web` و برای بات مقدار `worker`
- `SERVICE_NAME`: اختیاری؛ نام سرویس صفحه‌ی پیش‌فرض

برای سایت حتماً برنامه روی `0.0.0.0` و پورت متغیر `PORT` گوش بدهد.

نمونه‌ی سایت Node:

```text
START_CMD=node examples/node-web/server.js
MODE=web
```

نمونه‌ی سایت Python:

```text
START_CMD=python3 examples/python-web/main.py
MODE=web
```

نمونه‌ی بات Python:

```text
START_CMD=python3 bot.py
MODE=worker
```

## نکات مهم

- توکن و رمز را داخل GitHub نگذار؛ از Railway Variables استفاده کن.
- فایل‌سیستم کانتینر موقتی است؛ برای ماندگاری فایل‌ها Volume روی `/data` لازم است.
- این سرویس برای پروژه‌های سبک ساخته شده؛ پردازش ویدیویی سنگین و دیتابیس بزرگ مناسبش نیست.
- هر سرویس بهتر است یک پردازش اصلی داشته باشد؛ Railway خودش Restart را مدیریت می‌کند.
