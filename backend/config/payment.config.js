module.exports = {
  // Blockchain (Ganache + MetaMask)
  blockchain: {
    ganacheRpcUrl: process.env.GANACHE_RPC_URL || 'http://127.0.0.1:7545',
    // Contract address from Remix deploy (Step 4). If set, frontend pays via contract; otherwise direct to recipient.
    contractAddress: process.env.BEEBRIGHT_PAYMENTS_CONTRACT || '',
    recipientAddress: process.env.PAYMENT_RECIPIENT_ETH_ADDRESS || '',
    phpPerEth: Number(process.env.PHP_PER_ETH) || 250000, // 1 ETH = 250000 PHP (e.g. 4750 PHP = 0.019 ETH)
    // Use 1337 unless your Ganache UI shows Network ID 5777
    chainId: Number(process.env.GANACHE_CHAIN_ID) || 1337,
  },

  // Legacy GCash (no longer used in enrollment – kept for reference)
  gcash: {
    accountNumber: '09307517208',
    accountName: 'BeeBright',
    email: 'beebright@gmail.com',
    // Optional absolute URL (or /uploads/... path) when using a static uploaded QR image.
    qrImageUrl: process.env.GCASH_QR_IMAGE_URL || '',
    // Optional data URL override (e.g. data:image/png;base64,...)
    qrImageDataUrl: process.env.GCASH_QR_IMAGE_DATA_URL || '',
  },

  // Payment instructions
  instructions: {
    title: 'GCash Payment Instructions',
    steps: [
      'Step 1 - Open GCash App',
      'Step 2 - Send payment to the provided number or scan QR',
      'Step 3 - Enter exact amount shown in system',
      'Step 4 - Complete payment',
      'Step 5 - Upload payment screenshot as proof'
    ],
    warnings: [
      '⚠️ Send ONLY to 09307517208',
      '⚠️ Double-check amount before sending',
      '⚠️ Save transaction screenshot',
      '⚠️ Payments to other numbers will NOT be accepted'
    ]
  },
 
  // Verification
  verification: {
    email: 'payments@beebright.com',
    phone: '(02) 8123-4567',
    hours: '9AM-5PM Mon-Fri'
  },

  // QR Code settings
  qrCode: {
    expiryHours: 24, // QR code valid for 24 hours
    width: 300,
    errorCorrectionLevel: 'H'
  }
};