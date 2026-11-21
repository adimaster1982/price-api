#!/data/data/com.termux/files/usr/bin/bash
# Runs the bot on an Android phone (Termux) and restarts it if it stops.
cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null   # keep running when the screen is off
while true; do
  npm start
  echo "bot stopped – restarting in 10s"
  sleep 10
done
