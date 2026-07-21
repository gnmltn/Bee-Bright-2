const QRCode = require('qrcode');
const paymentConfig = require('../config/payment.config');

let cachedDetails = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

const DEFAULT_STEPS = [
  'Step 1 - Open GCash App',
  'Step 2 - Send payment to the provided number or scan QR',
  'Step 3 - Enter exact amount shown in system',
  'Step 4 - Complete payment',
  'Step 5 - Upload payment screenshot as proof'
];

async function buildQrImageDataUrl(accountNumber, accountName) {
  if (paymentConfig.gcash?.qrImageDataUrl) {
    return paymentConfig.gcash.qrImageDataUrl;
  }

  const qrPayload = `GCASH|${accountNumber}|${accountName}`;
  return QRCode.toDataURL(qrPayload, {
    width: paymentConfig.qrCode?.width || 300,
    errorCorrectionLevel: paymentConfig.qrCode?.errorCorrectionLevel || 'H',
    margin: 1,
  });
}

async function getGcashPublicDetails() {
  const now = Date.now();
  if (cachedDetails && now - cachedAt < CACHE_TTL_MS) {
    return cachedDetails;
  }

  const accountNumber = paymentConfig.gcash?.accountNumber || '09307517208';
  const accountName = paymentConfig.gcash?.accountName || 'BeeBright';
  const instructions = Array.isArray(paymentConfig.instructions?.steps) && paymentConfig.instructions.steps.length > 0
    ? paymentConfig.instructions.steps
    : DEFAULT_STEPS;

  const qrImageDataUrl = await buildQrImageDataUrl(accountNumber, accountName);

  cachedDetails = {
    accountNumber,
    accountName,
    qrImageDataUrl,
    qrImageUrl: paymentConfig.gcash?.qrImageUrl || '',
    instructions,
  };
  cachedAt = now;

  return cachedDetails;
}

module.exports = {
  getGcashPublicDetails,
};
