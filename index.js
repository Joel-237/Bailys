const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'change-this-key';
const AUTH_DIR = './auth';

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';

// ─── Middleware auth ──────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Connexion Baileys ────────────────────────────────────
async function connectWhatsApp() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // silencieux en prod
    printQRInTerminal: false,           // on gère le QR via API
    browser: ['Chatflow', 'Chrome', '1.0.0'],
    connectTimeoutMs: 30000,
    retryRequestDelayMs: 2000,
  });

  // Sauvegarde des credentials à chaque update
  sock.ev.on('creds.update', saveCreds);

  // Gestion de la connexion
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
      connectionStatus = 'qr_pending';
      console.log('[Baileys] QR Code généré — scanner via GET /qr');
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrCodeData = null;
      console.log('[Baileys] ✅ Connecté à WhatsApp');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[Baileys] Déconnecté (code: ${code}) — reconnexion: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => connectWhatsApp(), 5000);
      } else {
        // Logged out : effacer la session
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true });
        }
        console.log('[Baileys] Session supprimée — relancer et rescanner le QR');
      }
    }
  });
}

// ─── Routes API ───────────────────────────────────────────

// Health check (pas de auth — Railway l'utilise pour les health checks)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', connection: connectionStatus });
});

// Afficher le QR Code (page HTML simple)
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send('<h2>✅ Déjà connecté à WhatsApp</h2>');
  }
  if (!qrCodeData) {
    return res.send('<h2>⏳ QR Code pas encore généré — attendre quelques secondes et recharger</h2>');
  }
  res.send(`
    <html>
      <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:40px">
        <h2>📱 Scanner avec WhatsApp</h2>
        <p>WhatsApp → Appareils liés → Lier un appareil</p>
        <img src="${qrCodeData}" style="width:300px;border:1px solid #ccc;border-radius:8px"/>
        <p style="color:#888;font-size:13px">Ce QR expire en 60s — recharger la page si expiré</p>
      </body>
    </html>
  `);
});

// Envoyer un message (utilisé par n8n)
app.post('/send-message', requireApiKey, async (req, res) => {
  const { jid, message } = req.body;

  if (!jid || !message) {
    return res.status(400).json({ error: 'jid et message requis' });
  }

  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp non connecté', status: connectionStatus });
  }

  try {
    // Vérifier que le numéro existe sur WhatsApp avant d'envoyer
    const [result] = await sock.onWhatsApp(jid.replace('@s.whatsapp.net', ''));

    if (!result || !result.exists) {
      return res.status(404).json({ error: 'user not found — numéro non enregistré sur WhatsApp' });
    }

    await sock.sendMessage(jid, { text: message });

    return res.json({ status: 'ok', jid });

  } catch (err) {
    console.error('[Baileys] Erreur envoi:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Statut de la connexion
app.get('/status', requireApiKey, (req, res) => {
  res.json({
    status: connectionStatus,
    hasQR: !!qrCodeData
  });
});

// Déconnexion propre (logout)
app.post('/logout', requireApiKey, async (req, res) => {
  try {
    await sock?.logout();
    connectionStatus = 'disconnected';
    res.json({ status: 'logged_out' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Démarrage ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Chatflow Baileys API] Serveur sur port ${PORT}`);
  connectWhatsApp();
});
