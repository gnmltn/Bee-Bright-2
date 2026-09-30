/**
 * Real-time push (Socket.io) — expanded from the admin-only pilot ("bug (16).pdf") to
 * Parent and Tutor dashboards too ("bug (17).pdf").
 *
 * Room model — one room per connection, chosen entirely from the caller's OWN verified
 * identity (never anything the client can request): admin/super_admin -> the single
 * shared 'admin' room (unchanged from the pilot); parent -> `parent:<their own userId>`;
 * tutor -> `tutor:<their own userId>`. Every OTHER role (student, or anyone unauthenticated/
 * invalid) is rejected at the handshake, same as the pilot's original admin-only gate.
 *
 * Scoping is enforced entirely on the EMIT side, not by dynamic room membership: a
 * connection only ever joins its own one room, and each call site below resolves exactly
 * which parent(s)/tutor(s) an event is relevant to (via Enrollment/Schedule, the same
 * resolution patterns already used for email notifications elsewhere in this codebase)
 * before targeting those specific rooms. This keeps the membership model trivial to
 * reason about — there is no code path that can accidentally subscribe a socket to
 * someone else's room.
 */
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getAllowedOrigins } = require('../config/corsOrigins');

const ADMIN_ROOM = 'admin';
const parentRoom = (userId) => `parent:${userId}`;
const tutorRoom = (userId) => `tutor:${userId}`;

let io = null;

/** Attaches the Socket.io server to the SAME http.Server instance Express already listens
 *  on (no separate port). Call once, right after `app.listen(...)`. */
function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: [...getAllowedOrigins()],
      credentials: true,
    },
    // Socket.io's own client already retries with backoff by default; nothing extra
    // needed here for "handle a dropped/slow connection gracefully."
  });

  // Auth handshake: the client sends its existing JWT (same token used for REST calls,
  // read from sessionStorage) as `auth.token`. The room a connection joins is decided
  // HERE, from the verified user's own role/id — never from anything the client asks for.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('unauthorized'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('role isActive isArchived');
      if (!user || !user.isActive || user.isArchived) return next(new Error('unauthorized'));
      if (!['admin', 'super_admin', 'parent', 'tutor'].includes(user.role)) return next(new Error('unauthorized'));
      socket.data.userId = String(user._id);
      socket.data.role = user.role;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.role === 'admin' || socket.data.role === 'super_admin') {
      socket.join(ADMIN_ROOM);
    } else if (socket.data.role === 'parent') {
      socket.join(parentRoom(socket.data.userId));
    } else if (socket.data.role === 'tutor') {
      socket.join(tutorRoom(socket.data.userId));
    }
    // No server-side logging of every connect/disconnect beyond this — same
    // low-noise convention as the rest of this backend's console output.
  });

  return io;
}

function emitToAdmins(event, payload) {
  if (!io) return; // realtime not initialized (e.g. under `node --test`) — never throw
  io.to(ADMIN_ROOM).emit(event, payload);
}

function emitToParent(parentId, event, payload) {
  if (!io || !parentId) return;
  io.to(parentRoom(String(parentId))).emit(event, payload);
}

/** Same event to several parents at once — one Socket.io broadcast, not N. */
function emitToParents(parentIds, event, payload) {
  if (!io) return;
  const rooms = [...new Set((parentIds || []).filter(Boolean).map((id) => parentRoom(String(id))))];
  if (rooms.length === 0) return;
  io.to(rooms).emit(event, payload);
}

function emitToTutor(tutorId, event, payload) {
  if (!io || !tutorId) return;
  io.to(tutorRoom(String(tutorId))).emit(event, payload);
}

function emitToTutors(tutorIds, event, payload) {
  if (!io) return;
  const rooms = [...new Set((tutorIds || []).filter(Boolean).map((id) => tutorRoom(String(id))))];
  if (rooms.length === 0) return;
  io.to(rooms).emit(event, payload);
}

/** New enrollment submitted by a parent (Admin Enrollments tab should refresh). */
function emitNewEnrollment(payload) {
  emitToAdmins('enrollment:new', payload);
}

/** New payment proof submitted — initial (down) or remaining-balance (Admin Payments
 *  tab's Pending Payment Verification list should refresh). */
function emitNewPayment(payload) {
  emitToAdmins('payment:new', payload);
}

module.exports = {
  initRealtime,
  emitToAdmins,
  emitToParent,
  emitToParents,
  emitToTutor,
  emitToTutors,
  emitNewEnrollment,
  emitNewPayment,
};
