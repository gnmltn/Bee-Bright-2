// Shared allowed-origins list — used by both the REST API's cors() middleware in
// server.js and the Socket.io realtime server (utils/realtime.js), so the two never
// drift apart.
function getAllowedOrigins() {
  return new Set([
    'http://localhost:3000',
    'http://localhost:8080',
    'http://localhost:5173', // Vite default
    'http://localhost:5174',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
  ].filter(Boolean));
}

function isOriginAllowed(origin) {
  if (!origin) return true; // mobile apps, Postman, server-to-server, etc.
  return getAllowedOrigins().has(origin);
}

module.exports = { getAllowedOrigins, isOriginAllowed };
