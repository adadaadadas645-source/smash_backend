# KingdomBackend

**Kingdom Smash: Cannon Blast** (`com.puzzle.blockescape`) oyununun sunucusu. Üç işi var:

1. **Oyuncu kimliği.** Girişsiz çalışır: her kurulum kendi gizli anahtarını üretir, karşılığında oyuncu kimliği ve token alır.
2. **Satın alma doğrulama.** Her satın almayı Google'a doğrulatır ve ödülün **yalnızca bir kez** verilmesini sağlar.
3. **Dünya sıralaması.** Yalnızca bölüm (level) bilgisi tutar, ayrı bir koleksiyonda.

Bunlara ek olarak her isteği ve önemli olayı hem Render loguna hem Firestore'a yazar, böylece bir sorunu
sonradan baştan sona izleyebilirsiniz.

Yapı Avenia sunucusuyla (`Desktop/avenia-react-native/server`) aynıdır: Express + TypeScript,
`firebase-admin` (aynı `FIREBASE_SERVICE_ACCOUNT_KEY` değişkeni), pino loglama, Render. Avenia'ya hiç
dokunulmadı. Bu klasör tamamen ayrıdır.

---

## İçindekiler

1. [Uç noktalar](#1-uç-noktalar)
2. [Veritabanı (Firestore)](#2-veritabanı-firestore)
3. [Yerelde çalıştırma ve test](#3-yerelde-çalıştırma-ve-test)
4. [Render'a kurulum](#4-rendera-kurulum)
5. [Firebase: hangi proje, indeksler, TTL](#5-firebase-hangi-proje-indeksler-ttl)
6. [Google Play doğrulaması](#6-google-play-doğrulaması)
7. [Loglama: yarın bir sorun çıkınca](#7-loglama-yarın-bir-sorun-çıkınca)
8. [Güvenlik](#8-güvenlik)
9. [Darboğaz olmasın diye](#9-darboğaz-olmasın-diye)
10. [Oyun tarafı](#10-oyun-tarafı)
11. [Bilinen sınırlar](#11-bilinen-sınırlar)

---

## 1. Uç noktalar

Hepsi `https://<render-adresi>/api/v1` altındadır. Gövdeler JSON'dur. Her yanıtta `X-Request-ID` başlığı
bulunur; oyun kendi kimliğini gönderirse aynısı geri döner.

| Yöntem | Yol | Kimlik | Ne yapar |
|---|---|---|---|
| POST | `/auth/register` | — | `{ deviceSecret, name?, avatar?, frame?, locale? }` → `{ playerId, token, expiresAt, player }` |
| POST | `/auth/token` | — | `{ playerId, deviceSecret }` → yeni token (süresi dolunca) |
| GET | `/players/me` | Bearer | Oyuncu bilgisi. `noAdsForever` yeniden kurulumda reklamsızlığı geri getirir |
| PATCH | `/players/me` | Bearer | `{ name?, avatar?, frame?, locale? }` |
| POST | `/leaderboard/level` | Bearer | `{ level, name?, avatar?, frame? }` → `{ level, accepted, clamped }` |
| GET | `/leaderboard/world` | Bearer | `{ top: [{rank,name,avatar,frame,level,me?}], me: {rank,level}, total }` |
| POST | `/purchases/verify` | Bearer | `{ productId, receipt }` → `{ status, grant, tokenHash, contents, … }` |
| POST | `/logs/client` | Bearer | `{ events: [{ name, level, at, data }] }`: cihazda ters giden şeyler |
| GET | `/admin/players/:id` | `x-admin-key` | Oyuncu kartı: kayıt, sıralama, satın almalar, son 100 log |
| GET | `/admin/purchases?orderId=GPA.…` | `x-admin-key` | Google sipariş numarasıyla satın alma |
| GET | `/admin/logs?playerId=&requestId=&kind=&name=` | `x-admin-key` | Log satırları, yeniden eskiye |
| POST | `/admin/players/:id/ban` | `x-admin-key` | `{ banned, reason }`: yasaklar ve sıralamadan çıkarır |
| GET | `/health`, `/health/deep` | — | Ayakta mı / Firestore'a ulaşıyor mu |

`/purchases/verify` için `status` değerleri:

| `status` | Oyun ne yapar |
|---|---|
| `granted` | Ödülü verir, satın almayı mağazada kapatır |
| `already_granted` | Bu cihaz daha önce vermediyse verir (çökme, yeniden kurulum), sonra kapatır |
| `rejected` | Ödül vermeden kapatır (sahte, iptal edilmiş ya da başka oyuncuya ait) |
| `pending` ya da 5xx / yanıt yok | Açık bırakır. Her dakika ve bir sonraki açılışta yeniden sorar. Google satın almayı tutar, hiçbir şey kaybolmaz |

Hata yanıtları her zaman `{ success:false, error:"<kod>", requestId }` biçimindedir. Örnek kodlar:
`token_expired`, `invalid_token`, `player_banned`, `rate_limited`, `invalid_request`,
`verification_unavailable`.

---

## 2. Veritabanı (Firestore)

Tüm koleksiyonlar `COLLECTION_PREFIX` (varsayılan `kingdom_`) ile başlar. Böylece aynı Firebase
projesindeki başka uygulamaların verisiyle karışmaz.

| Koleksiyon | Belge kimliği | İçerik |
|---|---|---|
| `kingdom_players` | `p_…` | `deviceSecretHash` (HMAC; gizli anahtarın kendisi saklanmaz), `name`, `avatar`, `frame`, `level`, `noAdsForever`, `purchaseCount`, `banned`, `lastSeenAt`, `appVersion`, `deviceModel`, `platform`, `installId`, `lastIp` |
| `kingdom_leaderboard` | oyuncu kimliği | **Yalnızca sıralama:** `level`, `levelReachedAt`, `name`, `avatar`, `frame`, `updatedAt`, `suspectCount` |
| `kingdom_purchases` | `sha256(purchaseToken)` | `playerId`, `owners[]`, `productId`, `orderId` (GPA.…), `status` (granted/rejected), `reason`, `environment` (production/test/promo), `verifiedBy` (google_api/signature), `google` (Google'ın yanıtı), `grant`, `purchaseTime`, `requestId` |
| `kingdom_logs` | otomatik | `at`, `kind` (request/event/security/error/client), `name`, `level`, `requestId`, `playerId`, `method`, `path`, `status`, `durationMs`, `ip`, `appVersion`, `deviceModel`, `data`, `expireAt` |

Satın alma belgesinin kimliği token'ın hash'i olduğu için aynı satın alma **iki kez verilemez**. Hangi
cihazdan, hangi oyuncudan ya da aynı anda iki kez gelse de sonuç değişmez; transaction içindeki
`create()` bunu garanti eder.

---

## 3. Yerelde çalıştırma ve test

```bash
npm install
cp .env.example .env        # JWT_SECRET ve DEVICE_SECRET_PEPPER için: openssl rand -hex 32
npm run dev
```

Gerçek Firestore yerine emülatörle denemek için:

```bash
firebase emulators:start --only firestore --project demo-kingdom
```

Başka bir terminalde:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_PROJECT_ID=demo-kingdom npm run dev
```

Testler:

```bash
npm test          # birim testleri (sıralama kuralı, makbuz/imza, token, maskeleme, önbellek)
npm run test:e2e  # emülatör açıkken: kayıt → bölüm → sıralama → satın alma (gerçek/tekrar/sahte/taşıma) → admin → loglar
```

`test:e2e` kendi sunucusunu ayrı bir portta başlatır, oyunun yaptığı her şeyi sırayla dener ve log
satırlarının Firestore'a düştüğünü de kontrol eder.

---

## 4. Render'a kurulum

1. Bu klasörü bir GitHub reposuna koyun (`.env` repoya girmez; `.gitignore` bunu engeller).
2. Render → **New → Blueprint** → repoyu seçin. `render.yaml` servisi kurar. `JWT_SECRET`,
   `DEVICE_SECRET_PEPPER` ve `ADMIN_API_KEY` otomatik üretilir.
3. Panelde **elle** girilecek değerler:
   - `FIREBASE_SERVICE_ACCOUNT_KEY`: Avenia'nın Render servisindeki değerin aynısı (bkz. §5).
   - `GOOGLE_PLAY_LICENSE_KEY`: bkz. §6.
   - (isteğe bağlı) `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY`
4. Deploy bitince `https://<servis>.onrender.com/health/deep` adresi `{"ok":true,...}` dönmeli.
5. Oyundaki adresi güncelleyin: `Assets/Scripts/UI/Data/Backend.cs` → `BaseUrl`. Varsayılan değer
   `https://kingdom-backend.onrender.com`; Render başka bir ad verdiyse onu yazın.

> **Plan:** Render'ın ücretsiz planı 15 dakika istek gelmezse uyur ve ilk istek ~30 saniye sürer.
> `render.yaml` bu yüzden `starter` planını kullanıyor. Oyun uyku durumunu da kaldırır: yanıt
> gelmeyen satın alma açık kalır ve daha sonra yeniden sorulur.

---

## 5. Firebase: hangi proje, indeksler, TTL

### Veritabanı: Avenia'nın Firebase'i (`aveniaapp`)

Bu sunucu Avenia'nın Firestore'unu kullanır. Yeni bir proje ya da veritabanı açmanız gerekmez.

- `FIREBASE_PROJECT_ID=aveniaapp` (`render.yaml` içinde hazır).
- `FIREBASE_SERVICE_ACCOUNT_KEY`: Avenia'nın Render servisindeki değerin **aynısı**. Render →
  Avenia servisi → Environment → değeri kopyalayın → bu servise yapıştırın.
- Bu oyunun verisi aynı veritabanında ama ayrı koleksiyonlarda durur: `kingdom_players`,
  `kingdom_leaderboard`, `kingdom_purchases`, `kingdom_logs`. Avenia'nın koleksiyonlarına
  (`users`, `subsc`, `premiumusers`…) hiç dokunulmaz.

> ⚠️ **Avenia'nın Firestore kuralları.** `avenia-react-native/firestore.rules` dosyasında
> `match /{document=**} { allow read, write: if true; }` var. Yayındaki kural bu ise, `kingdom_*`
> koleksiyonları da API anahtarını bilen herkese açıktır. Bu sunucu Admin SDK kullandığı için
> kurallardan etkilenmez. Firebase Console → Firestore → **Kurallar** sekmesinden yayındaki kuralı
> kontrol edin. Açıksa, Avenia'yı etkilemeden şu blok eklenebilir. `{document=**}` kuralı
> `if true` olduğu sürece bu blok tek başına kapatmaz; o geniş kural daraltılınca işe yarar:
>
> ```
> match /kingdom_players/{id}     { allow read, write: if false; }
> match /kingdom_leaderboard/{id} { allow read, write: if false; }
> match /kingdom_purchases/{id}   { allow read, write: if false; }
> match /kingdom_logs/{id}        { allow read, write: if false; }
> ```

### İndeksler (bir kez)

Sıralama sorgusu ve log aramaları birleşik indeks ister. Avenia projesinde `firebase deploy`
**kullanmayın**: o projenin kendi indekslerini silmeyi önerebilir. Aşağıdaki komutlar yalnızca
**ekleme** yapar:

```bash
P=aveniaapp

gcloud firestore indexes composite create --project=$P --collection-group=kingdom_leaderboard \
  --field-config=field-path=level,order=descending --field-config=field-path=levelReachedAt,order=ascending
gcloud firestore indexes composite create --project=$P --collection-group=kingdom_leaderboard \
  --field-config=field-path=level,order=ascending --field-config=field-path=levelReachedAt,order=ascending
for f in playerId requestId kind name; do
  gcloud firestore indexes composite create --project=$P --collection-group=kingdom_logs \
    --field-config=field-path=$f,order=ascending --field-config=field-path=at,order=descending
done
```

Unutulan bir indeks olursa Render logunda `FAILED_PRECONDITION … create it here: https://console.firebase.google.com/…`
satırı çıkar. O bağlantıya tıklamak da indeksi kurar.

### Logların kendiliğinden silinmesi (TTL)

```bash
gcloud firestore fields ttls update expireAt --collection-group=kingdom_logs --enable-ttl --project=$P
```

Log satırları `LOG_RETENTION_DAYS` (varsayılan 30) gün sonra kendiliğinden silinir.

---

## 6. Google Play doğrulaması

Sunucu, satın almayı iki yoldan biriyle doğrular. Güçlü olan önce denenir:

| Yol | Ne kanıtlar | Kurulum |
|---|---|---|
| **Google Play Developer API** | Token Google'da gerçekten var mı, bu ürün için mi, ödenmiş mi (iptal/beklemede değil), test satın alması mı | 15 dk (aşağıda) |
| **İmza** (`GOOGLE_PLAY_LICENSE_KEY`) | Makbuz Google'ın imzası taşıyor mu, yani sahte değil mi | 2 dk |

İkisi de yoksa `/purchases/verify` 503 döner ve oyun satın almayı açık tutar. **En az imza anahtarını
mutlaka girin.**

**İmza anahtarı:** Play Console → uygulama → **Para kazanma ayarları** (Monetization setup) →
**Lisanslama** → "Base64 ile kodlanmış RSA ortak anahtarı". Tek satır olarak `GOOGLE_PLAY_LICENSE_KEY`
değişkenine yazın.

**Developer API:**

1. Servis hesabının bağlı olduğu Google Cloud projesinde **Google Play Android Developer API**'yi
   açın (APIs & Services → Library).
2. Play Console → **Kullanıcılar ve izinler** → **Yeni kullanıcı davet et** → servis hesabının
   e-postası (`…@….iam.gserviceaccount.com`). Uygulama izinleri olarak bu uygulamayı seçin:
   **Finansal verileri görüntüleme** ve **Siparişleri ve abonelikleri yönetme**.
3. Yetkinin etkinleşmesi bazen 24 saate kadar sürer. O süre içinde sunucu kendiliğinden imzaya
   düşer; logda `googlePlay: check failed … status 401/403` görürsünüz.

Kapalı testte lisans test hesaplarının satın almaları `environment: "test"` olarak kaydedilir ve
`ALLOW_TEST_PURCHASES=true` iken ödül verilir.

---

## 7. Loglama: yarın bir sorun çıkınca

Her şey iki yere yazılır:

- **Render → Logs:** Her satır JSON'dur ve şu alanları içerir: `requestId`, `playerId`, `method`,
  `path`, `status`, `durationMs`. Gelen gövde ve giden yanıt da loglanır. Gizli alanlar
  (`deviceSecret`, `token`, `signature`, `authorization`) `[REDACTED]` olarak yazılır;
  `purchaseToken` ve `receipt` kısaltılır.
- **Firestore → `kingdom_logs`:** Her API isteği bir satırdır (gövde, yanıt, süre, cihaz modeli, uygulama
  sürümü, IP). Ayrıca her iş olayı (`player_registered`, `level_reached`, `purchase_granted`,
  `purchase_rejected`, `purchase_transferred`, `player_banned`…), her güvenlik olayı
  (`leaderboard_suspect`, `purchase_token_reused`, `sign_in_rejected`, `rate_limited`…) ve oyunun
  kendi gönderdikleri (`purchase_failed`, `request_failed`, `session_reset`…) de birer satırdır.

Oyun her isteğe `X-Request-ID` koyar (`u-…`) ve aynı kimliği cihaz loguna yazar
(`BACKEND → POST /purchases/verify [u-3f2a…]`). Böylece tek bir kimlikle iki tarafı da bulursunuz.

**Sık senaryolar** (`$K` = `ADMIN_API_KEY`, `$U` = Render adresi):

```bash
# "Altın almıştım, gelmedi" — oyuncu e-postasındaki sipariş numarasını yolladı:
curl -s -H "x-admin-key: $K" "$U/api/v1/admin/purchases?orderId=GPA.3311-1234-5678-90123" | jq

# O oyuncunun her şeyi: kayıt, sıralama, satın almalar, son 100 olay/istek
curl -s -H "x-admin-key: $K" "$U/api/v1/admin/players/p_XXXXXXXX" | jq

# Bir isteğin izi (cihaz logundaki u-… kimliği)
curl -s -H "x-admin-key: $K" "$U/api/v1/admin/logs?requestId=u-3f2a9c…" | jq

# Son reddedilen satın almalar / hile şüpheleri
curl -s -H "x-admin-key: $K" "$U/api/v1/admin/logs?name=purchase_rejected&limit=50" | jq
curl -s -H "x-admin-key: $K" "$U/api/v1/admin/logs?name=leaderboard_suspect&limit=50" | jq

# Hileci: yasakla ve sıralamadan çıkar
curl -s -X POST -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"banned":true,"reason":"level hack"}' "$U/api/v1/admin/players/p_XXXXXXXX/ban"
```

Firestore Console'da da `kingdom_logs`'u `playerId == …` filtresi ve `at` azalan sıralamasıyla
açabilirsiniz.

---

## 8. Güvenlik

- **Kimlik:** Cihaz gizli anahtarı (32 bayt, güvenli rastgele) yalnızca HMAC-SHA256 + pepper ile
  saklanır ve sabit zamanlı karşılaştırılır. Token HS256 JWT'dir (`iss`/`aud`/`exp` kontrollü,
  30 gün).
- **Kimlik yoklaması yok:** "Böyle bir oyuncu yok" ile "yanlış anahtar" aynı 401'i döner.
- **Ödülün kaynağı sunucu:** Ödül içeriği sunucudaki katalogdan gelir, oyunun söylediğine
  bakılmaz. Ürün ve token, Google'ın imzaladığı JSON'dan okunur.
- **Tek seferlik ödül:** Belge kimliği token hash'idir ve transaction içinde `create()` ile yazılır.
  Tekrar gönderim, yarış durumu ya da başka oyuncunun aynı token'ı kullanması sonucu değiştirmez.
  Bu durumlar `purchase_token_reused` olarak loglanır.
- **Sıralama hilesi:** Seviye yalnızca artar. Artış hızı da sınırlıdır: 3 seviye + her 15 saniyede
  1 seviye. Fazlası kırpılır ve `leaderboard_suspect` olarak işaretlenir. Üst sınır
  `LEADERBOARD_MAX_LEVEL`. Yasaklanan oyuncu sıralamadan silinir.
- **Hız sınırları:** IP başına (genel 600/dk, kayıt 40/saat, giriş 60/15 dk) ve oyuncu başına
  (120/dk, sıralama yazma 20/dk, satın alma 30/dk). Mobil ağlarda çok oyuncu aynı IP'yi
  paylaştığı için IP limitleri geniş tutuldu.
- **Girdi doğrulama:** Her gövde zod ile doğrulanır. Gövde sınırı 64 KB. İsimden kontrol
  karakterleri, sıfır genişlikli/bidi işaretleri ve `<>` temizlenir; isim en fazla 16 karakterdir.
- **Diğer:** helmet başlıkları, `x-powered-by` kapalı, istek zaman aşımı 30 sn. Üretimde hata
  ayrıntısı dışarı sızmaz. Admin uçları `ADMIN_API_KEY` yokken tamamen kapalıdır (404).
- Herkese açık sıralama yanıtında oyuncu kimlikleri **yer almaz**.

---

## 9. Darboğaz olmasın diye

- **Sıralama okuması** her oyuncu için Firestore'a gitmez. İlk 100 tek bir sorgudur ve
  `LEADERBOARD_CACHE_SECONDS` (30 sn) boyunca herkesle paylaşılır. Aynı anda gelen istekler de tek
  sorguyu bekler (single-flight). Oyuncunun kendi sırası iki ucuz `count()` sorgusuyla bulunur ve o da
  30 sn önbellekte durur.
- **Token kontrolü** oyuncunun durumunu (var mı, yasaklı mı) 60 sn önbellekten okur. `lastSeenAt`
  oyuncu başına en fazla 10 dakikada bir yazılır.
- **Firestore logları** isteğin yolunda yazılmaz. Bellekte biriktirilir ve 2 saniyede bir toplu
  (en fazla 450'lik batch) yazılır. Kuyruk dolarsa en eskiler atılır, istekler hiç yavaşlamaz.
  Kapanışta kalanlar yazılır.
- **Sıkıştırma** (gzip) açık. Keep-alive süresi Render proxy'sinden uzun tutuldu.
- **Yerel ölçüm** (emülatör, tek süreç): 10 oyuncu paralel 500 sıralama isteği, ~2000 istek/sn,
  p50 2,5 ms, p95 13 ms, hata 0. Seviye yazma p50 15 ms.

---

## 10. Oyun tarafı

`royal-smash/unity/RoyalSmash3D/Assets/Scripts`:

| Dosya | Ne |
|---|---|
| `UI/Data/Backend.cs` | İstemci: kimlik (kayıt/giriş/token yenileme), istekler (`X-Request-ID`, sürüm, cihaz başlıkları, 401'de kendiliğinden yeniden giriş), seviye ve profil gönderimi, dünya sıralaması, cihaz raporları |
| `UI/Data/Shop.cs` | Satın alma `Pending` tutulur → `/purchases/verify` → onaylanınca `Grant` + `ConfirmPendingPurchase`. Yanıt gelmezse her dakika ve bir sonraki açılışta yeniden sorulur. `Granted`, aynı satın almanın bu cihazda iki kez verilmesini önler |
| `UI/Screens/HomeTabs.cs` | `LeaderboardPage`: gerçek dünya sıralaması, oyuncunun kendi satırı ve sırası, yükleniyor/çevrimdışı durumları |
| `UI/Screens/HomeScreen.cs` | Sol üstte (avatarın altında) kupa düğmesi → sıralama |
| `UI/Screens/SplashScreen.cs` | Açılışta `Backend.Start()` |

Unity editöründe (sahte mağaza) satın almalar sunucuya gitmez; eskisi gibi doğrudan verilir.

---

## 11. Bilinen sınırlar

- **Altın ve booster bakiyesi hâlâ cihazdadır.** Sunucu satın almayı doğrular ve kaydını tutar,
  ama harcamayı yönetmez. Root'lu bir telefonda yerel kayıt düzenlenebilir. Bakiyenin sunucuya
  taşınması ayrı bir iştir: oyundaki her harcama noktası bir API çağrısına dönüşür.
- **Hız sınırları ve önbellek bellek içindedir.** Tek Render instance'ı için doğrudur. Birden fazla
  instance'a çıkılırsa sınırlar Redis'e (`rate-limit-redis`) taşınmalıdır; önbellekler instance başına
  kalabilir.
- **iOS makbuzu** henüz doğrulanmaz (`store_not_supported`). Oyun şimdilik yalnızca Android'de.
