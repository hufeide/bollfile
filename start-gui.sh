#!/usr/bin/env bash
# 一键启动 bollfile 的 Electron GUI（WSL / 无显示环境友好）
#
# 显示后端自动探测顺序:
#   1) 已设置 $DISPLAY            -> 直接使用
#   2) 检测到 VcXsrv (Windows 侧) -> 用 <WinIP>:0.0，窗口显示在 Windows 桌面
#   3) 否则回退 Xvfb 虚拟显示     -> 窗口不可见，仅用于无头验证
#
# 用法:
#   ./start-gui.sh
#   (装好 VcXsrv 并启动 XLaunch 后，无需任何 export 即可直接看到窗口)
set -e
cd "$(dirname "$0")"

# 探测 Windows 宿主上的 VcXsrv: X server 默认监听 TCP 6000 (display :0)
probe_vcxsrv() {
  local ip
  ip=$(grep -m1 '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}')
  [ -z "$ip" ] && return 1
  # 尝试连 X server 的 TCP 端口 6000 (display :0)
  if timeout 2 bash -c "echo > /dev/tcp/$ip/6000" 2>/dev/null; then
    echo "$ip:0.0"
    return 0
  fi
  return 1
}

if [ -z "$DISPLAY" ]; then
  if VD=$(probe_vcxsrv); then
    export DISPLAY="$VD"
    echo "[start-gui] 检测到 VcXsrv -> DISPLAY=$DISPLAY，窗口将显示在 Windows 桌面"
    echo "[start-gui] 若启动报 SIGSEGV(段错误): 请在 Windows 侧 VcXsrv 的 XLaunch"
    echo "           'Additional parameters for VcXsrv' 填入 -extension GLX 后重开 VcXsrv 再试"
  elif command -v Xvfb >/dev/null 2>&1; then
    XDISP=:99
    if [ ! -S "/tmp/.X11-unix/X${XDISP#:}" ]; then
      Xvfb "$XDISP" -screen 0 1280x1024x24 >/dev/null 2>&1 &
      sleep 1
    fi
    export DISPLAY="$XDISP"
    echo "[start-gui] 未检测到 VcXsrv，回退到虚拟显示 $DISPLAY (窗口不可见，仅无头验证)"
    echo "[start-gui] 要在 Windows 桌面看到窗口: 装 VcXsrv -> XLaunch (Disable access control) -> 重跑本脚本"
  else
    echo "[start-gui] 未设置 DISPLAY，且未找到 Xvfb，无法启动 GUI" >&2
    exit 1
  fi
else
  echo "[start-gui] 使用已有 DISPLAY=$DISPLAY"
fi

echo "[start-gui] 启动 Electron..."
exec ./node_modules/.bin/electron . --no-sandbox --disable-gpu "$@"
