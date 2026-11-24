/*
 * Konfigurasi eksternal CNC Template Tracker (Offline-First).
 * Edit nilai di bawah atau ubah langsung lewat layar "Pengaturan Server" di aplikasi.
 * Skrip klasik (tanpa type="module") agar berjalan langsung lewat file:// (PC) dan Capacitor (Android).
 */
window.CNC_CONFIG = {
  appName: 'CNC Template Tracker',
  version: '5.0.0-offline',
  // URL Web App hasil Deploy > Web app dari apps-script/Code.gs (harus berakhiran /exec)
  apiUrl: '',
  // Opsional: ID Spreadsheet hanya untuk catatan admin (sync selalu lewat Apps Script, bukan OpenSheet)
  spreadsheetId: '',
  // Interval auto-sync saat online (ms)
  syncIntervalMs: 60000,
  // Batas ukuran maksimal per gambar sketch (1 MB)
  maxSketchBytes: 1024 * 1024,
  // Masa berlaku token perangkat offline (hari)
  tokenDays: 30
};
