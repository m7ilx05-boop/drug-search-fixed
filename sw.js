// خدمة بسيطة: بتخلي الموقع قابل للتثبيت كتطبيق، ومبتخزّنش أي بيانات (كل حاجة بتتحمّل من النت زي الأول).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
