import type { CSSProperties } from "react";

const BOOT_RAIN_COLUMNS = [
  { x: "3%", d: "12s", delay: "-4s", o: "0.46", text: "公安九係義体化電子脳接続GITS" },
  { x: "9%", d: "15s", delay: "-10s", o: "0.3", text: "自律脚機夢見る殻信号同期" },
  { x: "15%", d: "11s", delay: "-7s", o: "0.5", text: "殻機動隊零壱認証開始" },
  { x: "22%", d: "18s", delay: "-12s", o: "0.34", text: "神経網接続記憶防壁解除" },
  { x: "29%", d: "13s", delay: "-2s", o: "0.48", text: "義体公安殻夢接続端末" },
  { x: "36%", d: "16s", delay: "-9s", o: "0.28", text: "零壱零壱九係回線起動" },
  { x: "43%", d: "10s", delay: "-5s", o: "0.52", text: "電子脳殻認証同期確認" },
  { x: "50%", d: "14s", delay: "-11s", o: "0.4", text: "GITS自律提案監査承認" },
  { x: "58%", d: "17s", delay: "-3s", o: "0.32", text: "公安夢殻端末接続中" },
  { x: "66%", d: "12s", delay: "-8s", o: "0.5", text: "記憶領域照合義体制御" },
  { x: "74%", d: "19s", delay: "-13s", o: "0.3", text: "義殻起動深層回線開放" },
  { x: "82%", d: "13s", delay: "-6s", o: "0.45", text: "九係認証殻殻殻同期" },
  { x: "90%", d: "16s", delay: "-1s", o: "0.35", text: "端末起動義体通信確認" },
  { x: "97%", d: "11s", delay: "-9s", o: "0.5", text: "夢見る殻公安GITS零壱" },
] as const;

const BOOT_ROWS = [
  { label: "identity handshake", value: "OK" },
  { label: "motoko channel", value: "READY" },
  { label: "tailnet surface", value: "ONLINE" },
] as const;

function rainStyle(column: (typeof BOOT_RAIN_COLUMNS)[number]): CSSProperties {
  return {
    "--d": column.d,
    "--delay": column.delay,
    "--o": column.o,
    "--x": column.x,
  } as CSSProperties;
}

export function SplashScreen() {
  return (
    <div className="gits-boot min-h-screen">
      <div className="gits-boot-rain" aria-hidden="true">
        {BOOT_RAIN_COLUMNS.map((column) => (
          <span key={`${column.x}-${column.text}`} style={rainStyle(column)}>
            {column.text}
          </span>
        ))}
      </div>
      <div className="gits-boot-core" aria-label="GITS boot sequence">
        <div className="gits-boot-logo-frame">
          <img alt="GITS" className="gits-boot-logo" src="/apple-touch-icon.png" />
        </div>
        <div className="gits-boot-terminal" aria-hidden="true">
          <div className="gits-boot-terminal-header">
            <span className="gits-boot-kicker">公安九係 // SHELL LINK</span>
            <span className="gits-boot-title">GITS</span>
          </div>
          <div className="gits-boot-terminal-body">
            {BOOT_ROWS.map((row) => (
              <div key={row.label} className="gits-boot-terminal-row">
                <span>{row.label}</span>
                <b>{row.value}</b>
              </div>
            ))}
            <div className="gits-boot-progress">
              <span />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
