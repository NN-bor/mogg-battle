#!/usr/bin/env bash
# mog battle on your own server, one command: the site over HTTPS, the mask roulette
# (server/) and a relay for the video-link mode (coturn).
#
# Any small VPS with Ubuntu 24.04 and a public IP (1 vCPU, 1 GB). As root:
#   curl -fsSL https://nn-bor.github.io/mogg-battle/tools/server-setup.sh | bash
#   curl -fsSL https://nn-bor.github.io/mogg-battle/tools/server-setup.sh | bash -s -- mog.example.ru
# Without a domain the site gets <ip>.sslip.io: a free name for any IP, HTTPS included.
# With a domain: point its A record at the server first. Run the same line again to update.
#
# Layout: /opt/mog/releases/<time> (the last three), /opt/mog/site → the current one;
# systemd "mog" runs server/index.mjs on 127.0.0.1:8787; Caddy serves the site and proxies
# /ws and /api/ to it; /etc/mog.env holds the relay's password.
set -euo pipefail

SRC="${MOG_SRC:-https://nn-bor.github.io/mogg-battle}"
DOMAIN="${1:-}"

if [ "$(id -u)" -ne 0 ]; then echo "Запусти от root (sudo -i)"; exit 1; fi

IP="$(curl -fsS -4 --max-time 5 https://ifconfig.me || curl -fsS -4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
[ -n "$DOMAIN" ] || DOMAIN="$(echo "$IP" | tr . -).sslip.io"
echo "Сервер: $IP, адрес сайта: https://$DOMAIN"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates nodejs caddy
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Нужен Node.js 18+ (он есть в Ubuntu 24.04)"; exit 1
fi

# ───── the site: one archive of the published version ─────
REL="/opt/mog/releases/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REL"
curl -fsSL "$SRC/dist/site.tar.gz" | tar -xz -C "$REL"
test -f "$REL/server/index.mjs" && test -f "$REL/models/face_landmarker.task"
ln -sfn "$REL" /opt/mog/site
ls -1dt /opt/mog/releases/* | tail -n +4 | xargs -r rm -rf

# ───── relay for the video-link mode (once; 443 stays with the site) ─────
if [ ! -s /etc/mog.env ]; then
  MOG_NO_443=1 MOG_ENV=/etc/mog.env bash /opt/mog/site/tools/turn-setup.sh
fi

# ───── the roulette server ─────
id mog >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin mog
chgrp mog /etc/mog.env
cat > /etc/systemd/system/mog.service <<'EOF'
[Unit]
Description=mog battle: mask roulette
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/mog/site/server/index.mjs --port 8787
EnvironmentFile=-/etc/mog.env
User=mog
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

# ───── Caddy: HTTPS (Let's Encrypt, automatic), the site, /ws and /api/ ─────
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	@live path /ws /api/*
	reverse_proxy @live 127.0.0.1:8787
	@private path /server/*
	respond @private 404
	@fresh path / /index.html /sw.js
	header @fresh Cache-Control "no-cache"
	root * /opt/mog/site
	file_server
}
EOF

if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 80/tcp; ufw allow 443/tcp
fi

systemctl daemon-reload
systemctl enable mog >/dev/null 2>&1
systemctl restart mog
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
sleep 2
systemctl is-active --quiet mog && echo "Сервер игры работает."
systemctl is-active --quiet caddy && echo "Caddy работает."

echo
echo "Готово: https://$DOMAIN"
echo "Рулетка: https://$DOMAIN/?roulette"
echo "Первое открытие может занять ~10 с: Caddy получает сертификат."
echo "Реклама между играми (выключена): допиши в /etc/mog.env ADS_EVERY=3 и ADS_YANDEX=R-A-…,"
echo "Статистика (Яндекс Метрика, выключена): METRIKA_ID=номер_счётчика туда же."
echo "потом: systemctl restart mog"
echo "Если у хостинга есть свой файрвол в панели, открой там порты 80, 443 (TCP),"
echo "3478 (UDP+TCP) и 49160-49999 (UDP)."
