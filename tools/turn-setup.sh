#!/usr/bin/env bash
# Own relay (TURN) for the mog battle remote duel. Needed where free relays don't get through,
# e.g. mobile internet in Russia: then a server inside the country carries the video.
#
# Any small VPS with Ubuntu 22.04 / 24.04 and a public IP (1 vCPU, 1 GB is plenty).
# Run as root:
#   curl -fsSL https://nn-bor.github.io/mogg-battle/tools/turn-setup.sh | bash
# At the end it prints a line like  mog:1a2b3c4d5e6f7a8b@203.0.113.7  — paste it into
# js/turn-config.js (or add ?turn=<line> to the game's address to try it first).
#
# What it does: installs coturn; one user with a random password; STUN and TURN on 3478
# (UDP and TCP) and TCP 443 (redirected to 3478: passes strict firewalls); relay ports
# 49160–49999/UDP. Limits so a public password can't turn it into anyone's free proxy:
# 2 Mbit/s per session, 40 sessions in total, no relaying to private networks.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Запусти от root (sudo -i)"; exit 1; fi

IP="$(curl -fsS -4 --max-time 5 https://ifconfig.me || curl -fsS -4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
PASS="$(openssl rand -hex 8)"
PRIVATE_IP="$(hostname -I | awk '{print $1}')"
# Behind the cloud's NAT the relay must announce the public address.
EXTERNAL="$IP"; [ "$PRIVATE_IP" != "$IP" ] && EXTERNAL="$IP/$PRIVATE_IP"

echo "Публичный IP: $IP"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q coturn iptables-persistent

cat > /etc/turnserver.conf <<EOF
listening-port=3478
external-ip=$EXTERNAL
realm=mog
lt-cred-mech
user=mog:$PASS
fingerprint
no-tls
no-dtls
no-cli
no-multicast-peers
min-port=49160
max-port=49999
total-quota=40
max-bps=2000000
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
log-file=/var/log/turnserver.log
simple-log
EOF

# Debian/Ubuntu packages ship the service disabled.
if [ -f /etc/default/coturn ]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
fi

# TCP 443 → 3478: the relay is reachable even where only web ports are open.
iptables -t nat -C PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 3478 2>/dev/null \
  || iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 3478
netfilter-persistent save >/dev/null

if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 3478/udp; ufw allow 3478/tcp; ufw allow 443/tcp; ufw allow 49160:49999/udp
fi

systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 1
systemctl is-active --quiet coturn && echo "coturn работает."

echo
echo "Готово. Строка для игры:"
echo
echo "  mog:$PASS@$IP"
echo
echo "Проверка: https://nn-bor.github.io/mogg-battle/?nettest&turn=mog:$PASS@$IP"
echo "(строка «TURN $IP…» должна быть с ✓)"
echo "Не забудь открыть порты 3478 (UDP+TCP), 443 (TCP) и 49160-49999 (UDP)"
echo "в панели хостинга, если там есть свой файрвол."
