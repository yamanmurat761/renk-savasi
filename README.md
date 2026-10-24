# Renk Savaşı 🎨

Tarayıcıda çalışan, **4 kişilik çevrimiçi** alan kapma oyunu. Kurulum yok, sunucu yok — oyuncular birbirine doğrudan WebRTC ([PeerJS](https://peerjs.com/)) ile bağlanır.

**Oyna:** https://yamanmurat761.github.io/renk-savasi/

## Nasıl oynanır

1. Biri **Oda Kur**'a basar ve 4 harfli oda kodunu (veya davet bağlantısını) arkadaşlarına gönderir.
2. Diğerleri kodu girip **Katıl**'a basar. Eksik yerler için **bot** eklenebilir.
3. Kurucu **Oyunu Başlat**'a basar.
4. **WASD / yön tuşları** ile (telefonda ekrandaki tuşlarla) hareket et; geçtiğin kareler senin rengine boyanır.
5. ⚡ hız verir, 💣 etrafını bir anda boyar. 90 saniye sonunda en çok kareye sahip olan kazanır.

## Teknik

- `index.html`, `style.css`, `game.js` — saf HTML/CSS/JS, derleme gerektirmez.
- Oda kuran oyuncu oyunu simüle eder (host), diğerleri yalnızca girdilerini gönderir ve durumu alır.
- Oyun sırasında bağlantısı kopan oyuncunun yerini bot alır.

Yerelde çalıştırmak için klasörü herhangi bir statik sunucuyla açman yeterli.
